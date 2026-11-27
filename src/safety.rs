#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn input_and_filters() {
        assert_eq!(resolve_safety_input("", "").unwrap().nsfw_filter, "hide");
        assert_eq!(
            resolve_safety_input("bad", "").unwrap_err().1,
            json!({"code":"preset_required"})
        );
        assert_eq!(
            resolve_safety_input("", "banana").unwrap_err().1,
            json!({"error":"Invalid nsfwFilter: expected hide|warning|show, got \"banana\""})
        );
        assert_eq!(
            resolve_safety_input(&"A".repeat(64), "show")
                .unwrap()
                .preset_pubkey,
            Some("a".repeat(64))
        );
        assert_eq!(
            default_filters("hide"),
            vec!["(contentWarning IS NULL OR contentWarning IS EMPTY)"]
        );
        assert!(default_filters("show").is_empty());
        let p = json!({"blockedPubkeys":["a"],"blockedEvents":["b"],"nsfwPubkeys":["c"]});
        assert_eq!(
            build_preset_filters(&p, "hide"),
            vec![
                "(pubkey != \"a\")",
                "(event_id != \"b\")",
                "(pubkey != \"c\")"
            ]
        );
        assert_eq!(build_preset_filters(&p, "warning").len(), 2);
    }
    #[test]
    fn parses_and_validates_preset() {
        let a = "A".repeat(64);
        let mut e = json!({"kind":30078,"tags":[["d","nostube-presets"]],"content":json!({"blockedPubkeys":[a,a],"nsfwPubkeys":[],"blockedEvents":[],"extra":1}).to_string(),"created_at":123,"id":"id"});
        assert_eq!(
            parse_preset_event(&e).unwrap()["blockedPubkeys"],
            json!(["a".repeat(64)])
        );
        e["kind"] = json!(1);
        assert!(parse_preset_event(&e).is_none());
        e["kind"] = json!(30078);
        e["content"] = json!("{}");
        assert!(parse_preset_event(&e).is_none());
    }
    #[tokio::test]
    async fn cache_fresh_stale_failure_and_singleflight() {
        use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
        let now = Arc::new(AtomicU64::new(0));
        let calls = Arc::new(AtomicUsize::new(0));
        let gate = Arc::new(tokio::sync::Semaphore::new(0));
        let responses = Arc::new(std::sync::Mutex::new(std::collections::VecDeque::from([
            Some(json!({"revision":1})),
            None,
            None,
            Some(json!({"revision":2})),
            None,
            Some(json!({"revision":3})),
        ])));
        let fetch: Fetch = {
            let calls = calls.clone();
            let gate = gate.clone();
            let responses = responses.clone();
            Arc::new(move |_| {
                let calls = calls.clone();
                let gate = gate.clone();
                let responses = responses.clone();
                Box::pin(async move {
                    calls.fetch_add(1, Ordering::SeqCst);
                    gate.acquire().await.unwrap().forget();
                    responses.lock().unwrap().pop_front().unwrap()
                })
            })
        };
        let clock: Clock = {
            let now = now.clone();
            Arc::new(move || now.load(Ordering::SeqCst))
        };
        let store = PresetStore::new(fetch, clock, 10, 30);
        gate.add_permits(1);
        assert_eq!(store.get_preset("a").await, Some(json!({"revision":1})));
        assert_eq!(store.get_preset("a").await, Some(json!({"revision":1})));
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        now.store(10, Ordering::SeqCst);
        assert_eq!(store.get_preset("a").await, Some(json!({"revision":1})));
        assert_eq!(store.get_preset("a").await, Some(json!({"revision":1})));
        tokio::task::yield_now().await;
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        gate.add_permits(1);
        while store.state.lock().await.pending.contains_key("a") {
            tokio::task::yield_now().await;
        }
        now.store(30, Ordering::SeqCst);
        let a = store.get_preset("a");
        let b = store.get_preset("a");
        let release = async {
            tokio::task::yield_now().await;
            gate.add_permits(1);
        };
        let (a, b, _) = tokio::join!(a, b, release);
        assert_eq!(a, Some(json!({"revision":1})));
        assert_eq!(b, a);
        assert_eq!(calls.load(Ordering::SeqCst), 3);
        gate.add_permits(1);
        assert_eq!(store.get_preset("a").await, Some(json!({"revision":2})));
        let a = store.get_preset("missing");
        let b = store.get_preset("missing");
        let release = async {
            tokio::task::yield_now().await;
            gate.add_permits(1);
        };
        let (a, b, _) = tokio::join!(a, b, release);
        assert_eq!((a, b), (None, None));
        assert_eq!(calls.load(Ordering::SeqCst), 5);
        gate.add_permits(1);
        assert_eq!(
            store.get_preset("missing").await,
            Some(json!({"revision":3}))
        );
        assert_eq!(calls.load(Ordering::SeqCst), 6);
    }
}

use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use tokio::sync::{Mutex, watch};

#[derive(Debug, Clone)]
pub struct SafetyInput {
    pub preset_pubkey: Option<String>,
    pub nsfw_filter: String,
}
pub fn resolve_safety_input(preset: &str, nsfw: &str) -> Result<SafetyInput, (u16, Value)> {
    let preset = preset.trim().to_ascii_lowercase();
    let nsfw = nsfw.trim();
    let nsfw = if nsfw.is_empty() { "hide" } else { nsfw };
    if !preset.is_empty() && !valid_hex(&preset) {
        return Err((400, json!({"code":"preset_required"})));
    }
    if !["hide", "warning", "show"].contains(&nsfw) {
        return Err((
            400,
            json!({"error":format!("Invalid nsfwFilter: expected hide|warning|show, got {}", serde_json::to_string(nsfw).unwrap())}),
        ));
    }
    Ok(SafetyInput {
        preset_pubkey: (!preset.is_empty()).then_some(preset),
        nsfw_filter: nsfw.into(),
    })
}
fn valid_hex(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|c| c.is_ascii_hexdigit())
}
pub fn default_policy() -> Value {
    json!({"blockedPubkeys":[],"nsfwPubkeys":[],"blockedEvents":[],"revision":0,"eventId":""})
}
pub fn default_filters(nsfw: &str) -> Vec<String> {
    if nsfw == "hide" {
        vec!["(contentWarning IS NULL OR contentWarning IS EMPTY)".into()]
    } else {
        vec![]
    }
}
pub fn build_preset_filters(policy: &Value, nsfw: &str) -> Vec<String> {
    let mut result = Vec::new();
    for (key, field, enabled) in [
        ("blockedPubkeys", "pubkey", true),
        ("blockedEvents", "event_id", true),
        ("nsfwPubkeys", "pubkey", nsfw == "hide"),
    ] {
        if !enabled {
            continue;
        }
        let clauses: Vec<_> = policy[key]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(|v| format!("{field} != {}", crate::util::quote(v)))
            .collect();
        if !clauses.is_empty() {
            result.push(format!("({})", clauses.join(" AND ")));
        }
    }
    result
}
fn parse_preset_event(event: &Value) -> Option<Value> {
    if event["kind"].as_u64()? != 30078 {
        return None;
    }
    let d = event["tags"].as_array()?.iter().find(|tag| tag[0] == "d")?;
    if d[1] != "nostube-presets" {
        return None;
    }
    let content: Value = serde_json::from_str(event["content"].as_str()?).ok()?;
    if !content.is_object() {
        return None;
    }
    let mut policy = default_policy();
    for field in ["blockedPubkeys", "nsfwPubkeys", "blockedEvents"] {
        let mut seen = HashSet::new();
        let mut values = Vec::new();
        for item in content[field].as_array()? {
            let s = item.as_str()?;
            if !valid_hex(s) {
                return None;
            }
            let s = s.to_ascii_lowercase();
            if seen.insert(s.clone()) {
                values.push(s);
            }
        }
        if values.len() > 1000 {
            return None;
        }
        policy[field] = json!(values);
    }
    policy["revision"] = event["created_at"].clone();
    policy["eventId"] = json!(event["id"].as_str().unwrap_or(""));
    Some(policy)
}
async fn fetch_preset(pubkey: &str) -> Option<Value> {
    let relays = ["NOSTR_PRESET_RELAYS", "NOSTR_INDEX_RELAYS"]
        .iter()
        .find_map(|name| std::env::var(name).ok().filter(|v| !v.trim().is_empty()))
        .unwrap_or_else(|| "wss://relay.nostu.be".into());
    let relays: Vec<String> = relays
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect();
    if relays.is_empty() {
        return None;
    }
    let events = crate::net::fetch_events(
        &relays,
        json!({"authors":[pubkey],"kinds":[30078],"#d":["nostube-presets"],"limit":10}),
        crate::util::env_u64("NOSTR_SOURCE_MAX_WAIT_MS", 30000),
    )
    .await
    .ok()?;
    events
        .iter()
        .filter(|e| e["pubkey"] == pubkey)
        .filter_map(parse_preset_event)
        .max_by(|a, b| {
            a["revision"]
                .as_i64()
                .cmp(&b["revision"].as_i64())
                .then_with(|| a["eventId"].as_str().cmp(&b["eventId"].as_str()))
        })
}
#[derive(Clone)]
struct Entry {
    policy: Value,
    fresh_until: u64,
    stale_until: u64,
}
type Fetch =
    Arc<dyn Fn(String) -> Pin<Box<dyn Future<Output = Option<Value>> + Send>> + Send + Sync>;
type Clock = Arc<dyn Fn() -> u64 + Send + Sync>;
#[derive(Default)]
struct StoreState {
    entries: HashMap<String, Entry>,
    pending: HashMap<String, watch::Receiver<Option<Option<Value>>>>,
}
#[derive(Clone)]
pub struct PresetStore {
    state: Arc<Mutex<StoreState>>,
    fetch: Fetch,
    now: Clock,
    fresh_ttl: u64,
    max_ttl: u64,
}
impl Default for PresetStore {
    fn default() -> Self {
        Self::new(
            Arc::new(|key| Box::pin(async move { fetch_preset(&key).await })),
            Arc::new(crate::util::now_ms),
            crate::util::env_u64("PRESET_CACHE_FRESH_TTL_MS", 300_000),
            crate::util::env_u64("PRESET_CACHE_MAX_TTL_MS", 1_800_000),
        )
    }
}
impl PresetStore {
    fn new(fetch: Fetch, now: Clock, fresh_ttl: u64, max_ttl: u64) -> Self {
        Self {
            state: Arc::new(Mutex::new(StoreState::default())),
            fetch,
            now,
            fresh_ttl,
            max_ttl,
        }
    }
    pub async fn get_preset(&self, pubkey: &str) -> Option<Value> {
        let now = (self.now)();
        let mut state = self.state.lock().await;
        if let Some(entry) = state.entries.get(pubkey) {
            if now < entry.fresh_until {
                return Some(entry.policy.clone());
            }
            if now < entry.stale_until {
                let policy = entry.policy.clone();
                self.start_refresh(&mut state, pubkey);
                return Some(policy);
            }
        }
        let mut result = self.start_refresh(&mut state, pubkey);
        drop(state);
        loop {
            if let Some(value) = result.borrow_and_update().clone() {
                return value;
            }
            if result.changed().await.is_err() {
                return None;
            }
        }
    }
    fn start_refresh(
        &self,
        state: &mut StoreState,
        pubkey: &str,
    ) -> watch::Receiver<Option<Option<Value>>> {
        if let Some(pending) = state.pending.get(pubkey) {
            return pending.clone();
        }
        let (sender, receiver) = watch::channel(None);
        state.pending.insert(pubkey.to_string(), receiver.clone());
        let this = self.clone();
        let key = pubkey.to_string();
        tokio::spawn(async move {
            let policy = (this.fetch)(key.clone()).await;
            let mut state = this.state.lock().await;
            if let Some(policy) = policy {
                let now = (this.now)();
                if state.entries.len() >= 20_000 && !state.entries.contains_key(&key) {
                    if let Some(oldest) = state
                        .entries
                        .iter()
                        .min_by_key(|(_, e)| e.stale_until)
                        .map(|(k, _)| k.clone())
                    {
                        state.entries.remove(&oldest);
                    }
                }
                state.entries.insert(
                    key.clone(),
                    Entry {
                        policy,
                        fresh_until: now.saturating_add(this.fresh_ttl),
                        stale_until: now.saturating_add(this.max_ttl),
                    },
                );
            }
            let result = state.entries.get(&key).map(|e| e.policy.clone());
            sender.send_replace(Some(result));
            state.pending.remove(&key);
        });
        receiver
    }
}
