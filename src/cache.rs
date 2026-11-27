use serde_json::Value;
use std::{
    collections::HashMap,
    future::Future,
    sync::{Arc, Mutex, Weak},
    time::{Duration, Instant},
};

#[derive(Clone)]
pub struct AsyncCache {
    inner: Arc<Inner>,
}
struct Inner {
    max: usize,
    state: Mutex<State>,
}
#[derive(Default)]
struct State {
    values: HashMap<String, Entry>,
    flights: HashMap<String, Weak<tokio::sync::Mutex<()>>>,
    sequence: u64,
}
struct Entry {
    value: Value,
    expires: Instant,
    order: u64,
}
impl Default for AsyncCache {
    fn default() -> Self {
        Self::new(5_000)
    }
}
impl AsyncCache {
    pub fn new(max_entries: usize) -> Self {
        Self {
            inner: Arc::new(Inner {
                max: max_entries.max(1),
                state: Mutex::new(State::default()),
            }),
        }
    }
    pub async fn get(&self, key: &str) -> Option<Value> {
        let mut state = crate::util::lock(&self.inner.state);
        if state
            .values
            .get(key)
            .is_some_and(|v| v.expires <= Instant::now())
        {
            state.values.remove(key);
        }
        state.values.get(key).map(|v| v.value.clone())
    }
    pub async fn get_or_try_insert<F, Fut>(
        &self,
        key: String,
        ttl_ms: u64,
        factory: F,
    ) -> anyhow::Result<Value>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = anyhow::Result<Value>>,
    {
        if let Some(value) = self.get(&key).await {
            return Ok(value);
        }
        let flight = {
            let mut state = crate::util::lock(&self.inner.state);
            if state.flights.len() >= self.inner.max {
                state.flights.retain(|_, v| v.strong_count() > 0);
            }
            match state.flights.get(&key).and_then(Weak::upgrade) {
                Some(lock) => lock,
                None => {
                    let lock = Arc::new(tokio::sync::Mutex::new(()));
                    state.flights.insert(key.clone(), Arc::downgrade(&lock));
                    lock
                }
            }
        };
        let _guard = flight.lock().await;
        if let Some(value) = self.get(&key).await {
            return Ok(value);
        }
        let value = factory().await?;
        let mut state = crate::util::lock(&self.inner.state);
        if !state.values.contains_key(&key) && state.values.len() >= self.inner.max {
            state
                .values
                .retain(|_, entry| entry.expires > Instant::now());
            if state.values.len() >= self.inner.max {
                if let Some(oldest) = state
                    .values
                    .iter()
                    .min_by_key(|(_, entry)| entry.order)
                    .map(|(k, _)| k.clone())
                {
                    state.values.remove(&oldest);
                }
            }
        }
        state.sequence += 1;
        let order = state
            .values
            .get(&key)
            .map(|e| e.order)
            .unwrap_or(state.sequence);
        state.values.insert(
            key,
            Entry {
                value: value.clone(),
                expires: Instant::now() + Duration::from_millis(ttl_ms),
                order,
            },
        );
        Ok(value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::atomic::{AtomicUsize, Ordering};
    #[tokio::test]
    async fn simultaneous_misses_share_one_fetch() {
        let cache = AsyncCache::new(2);
        let calls = AtomicUsize::new(0);
        let fetch = || async {
            calls.fetch_add(1, Ordering::SeqCst);
            tokio::task::yield_now().await;
            Ok(json!(["nostr"]))
        };
        let (a, b) = tokio::join!(
            cache.get_or_try_insert("n".into(), 1_000, fetch),
            cache.get_or_try_insert("n".into(), 1_000, fetch)
        );
        assert_eq!(a.unwrap(), json!(["nostr"]));
        assert_eq!(b.unwrap(), json!(["nostr"]));
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }
    #[tokio::test]
    async fn evicts_oldest_and_caches_missing_results() {
        let cache = AsyncCache::new(2);
        for (key, value) in [("a", json!(1)), ("b", Value::Null), ("c", json!(3))] {
            cache
                .get_or_try_insert(key.into(), 1_000, || async { Ok(value) })
                .await
                .unwrap();
        }
        assert_eq!(cache.get("a").await, None);
        assert_eq!(cache.get("b").await, Some(Value::Null));
        assert_eq!(cache.get("c").await, Some(json!(3)));
    }
    #[tokio::test]
    async fn failure_and_expiry_allow_retry() {
        let cache = AsyncCache::new(1);
        assert!(
            cache
                .get_or_try_insert("a".into(), 1_000, || async {
                    anyhow::bail!("upstream offline")
                })
                .await
                .is_err()
        );
        cache
            .get_or_try_insert("a".into(), 0, || async { Ok(json!(1)) })
            .await
            .unwrap();
        assert_eq!(cache.get("a").await, None);
        assert_eq!(
            cache
                .get_or_try_insert("a".into(), 1_000, || async { Ok(json!(2)) })
                .await
                .unwrap(),
            json!(2)
        );
    }
    #[tokio::test]
    async fn cancellation_does_not_strand_a_key() {
        let cache = AsyncCache::new(1);
        let cloned = cache.clone();
        let (started, ready) = tokio::sync::oneshot::channel();
        let task = tokio::spawn(async move {
            cloned
                .get_or_try_insert("key".into(), 100, || async {
                    let _ = started.send(());
                    std::future::pending::<anyhow::Result<Value>>().await
                })
                .await
        });
        ready.await.unwrap();
        task.abort();
        let _ = task.await;
        let value = tokio::time::timeout(
            Duration::from_secs(1),
            cache.get_or_try_insert("key".into(), 100, || async { Ok(json!(7)) }),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(value, json!(7));
    }
}
