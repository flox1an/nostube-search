#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn limits_and_namespaces() {
        let r = RateLimiter::default();
        assert_eq!(r.check("a", "/one", 2, 60000).remaining, 1);
        assert!(r.check("a", "/one", 2, 60000).allowed);
        assert!(!r.check("a", "/one", 2, 60000).allowed);
        assert!(r.check("a", "/two", 2, 60000).allowed);
        assert!(r.check("a", "/one", 5, 60000).allowed);
    }
    #[test]
    fn proxy_trust() {
        let mut h = axum::http::HeaderMap::new();
        h.insert(
            "x-forwarded-for",
            "::ffff:1.2.3.4, 5.6.7.8".parse().unwrap(),
        );
        assert_eq!(client_key(&h, None, false), "unknown");
        assert_eq!(client_key(&h, None, true), "1.2.3.4");
    }
    #[test]
    fn fixed_windows_sweep_and_eviction() {
        let r = RateLimiter::default();
        let a = r.check_at("a", "/", 2, 1500, 1000);
        assert!(a.allowed);
        assert_eq!((a.remaining, a.reset_seconds), (1, 2));
        assert!(r.check_at("a", "/", 2, 1500, 2499).allowed);
        let a = r.check_at("a", "/", 2, 1500, 2499);
        assert!(!a.allowed);
        assert_eq!((a.remaining, a.retry_after), (0, 1));
        assert!(r.check_at("a", "/", 2, 1500, 2500).allowed);
        for i in 0..20_001 {
            r.check_at(&format!("key{i}"), "/", 1, 1000, 3000);
        }
        assert_eq!(r.state.lock().unwrap().entries.len(), 20_000);
        assert!(r.check_at("key0", "/", 1, 1000, 3000).allowed);
        r.check_at("new", "/", 1, 1000, 4000);
        assert_eq!(r.state.lock().unwrap().entries.len(), 1);
        let disabled = r.check_at("off", "/", 0, 1000, 4000);
        assert!(disabled.allowed);
        assert_eq!(disabled.limit, 0);
    }
    #[test]
    fn proxy_fallbacks() {
        let mut h = HeaderMap::new();
        h.insert("x-forwarded-for", " , 2.2.2.2".parse().unwrap());
        h.insert("x-real-ip", "::FFFF:1.2.3.4".parse().unwrap());
        assert_eq!(client_key(&h, None, true), "1.2.3.4");
        assert_eq!(client_key(&h, Some("::1".parse().unwrap()), false), "::1");
        h.remove("x-real-ip");
        assert_eq!(client_key(&h, None, true), "unknown");
    }
}

use axum::http::HeaderMap;
use std::collections::{HashMap, VecDeque};
use std::net::IpAddr;
use std::sync::Mutex;

#[derive(Default)]
pub struct RateLimiter {
    state: Mutex<State>,
}
#[derive(Default)]
struct State {
    entries: HashMap<String, (u64, u64)>,
    order: VecDeque<String>,
    inserts: usize,
}
pub struct RateDecision {
    pub allowed: bool,
    pub limit: u64,
    pub remaining: u64,
    pub reset_seconds: u64,
    pub retry_after: u64,
}
impl RateLimiter {
    pub fn check(&self, client: &str, path: &str, max: u64, window_ms: u64) -> RateDecision {
        self.check_at(client, path, max, window_ms, crate::util::now_ms())
    }
    fn check_at(
        &self,
        client: &str,
        path: &str,
        max: u64,
        window_ms: u64,
        now: u64,
    ) -> RateDecision {
        if max == 0 {
            return RateDecision {
                allowed: true,
                limit: 0,
                remaining: 0,
                reset_seconds: 0,
                retry_after: 0,
            };
        }
        let key = format!("{client}|{path}");
        let mut state = crate::util::lock(&self.state);
        if !state.entries.contains_key(&key) {
            state.inserts += 1;
            if state.entries.len() >= 20_000 || state.inserts >= 1024 {
                state.inserts = 0;
                state.entries.retain(|_, entry| entry.1 > now);
                let State { entries, order, .. } = &mut *state;
                order.retain(|k| entries.contains_key(k));
                while entries.len() >= 20_000 {
                    if let Some(k) = order.pop_front() {
                        entries.remove(&k);
                    } else {
                        break;
                    }
                }
            }
            state.order.push_back(key.clone());
        }
        let entry = state
            .entries
            .entry(key)
            .or_insert((0, now.saturating_add(window_ms)));
        if now >= entry.1 {
            *entry = (0, now.saturating_add(window_ms));
        }
        entry.0 = entry.0.saturating_add(1);
        let seconds = entry.1.saturating_sub(now).saturating_add(999) / 1000;
        RateDecision {
            allowed: entry.0 <= max,
            limit: max,
            remaining: max.saturating_sub(entry.0),
            reset_seconds: seconds,
            retry_after: seconds,
        }
    }
}
pub fn client_key(headers: &HeaderMap, peer: Option<IpAddr>, trust_proxy: bool) -> String {
    let normalize = |s: &str| {
        let s = s.trim().to_lowercase();
        s.strip_prefix("::ffff:").unwrap_or(&s).to_string()
    };
    if trust_proxy {
        for (name, first) in [("x-forwarded-for", true), ("x-real-ip", false)] {
            if let Some(value) = headers.get(name).and_then(|v| v.to_str().ok()) {
                let value = if first {
                    value.split(',').next().unwrap_or("")
                } else {
                    value
                };
                if !value.trim().is_empty() {
                    return normalize(value);
                }
            }
        }
    }
    peer.map(|p| normalize(&p.to_string()))
        .unwrap_or_else(|| "unknown".into())
}
