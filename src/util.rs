use std::time::{SystemTime, UNIX_EPOCH};

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
pub fn now_secs() -> u64 {
    now_ms() / 1_000
}
/// Lock a std `Mutex`, continuing with the data after another thread panicked
/// while holding it. Every guarded value here (caches, counters, request
/// windows) stays internally consistent between statements, so one panic must
/// not turn into a failure of every later request.
pub fn lock<T>(mutex: &std::sync::Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}
pub fn number(value: &str) -> Option<f64> {
    let value = value.trim();
    if value.is_empty() {
        return Some(0.0);
    }
    let radix = [
        ("0x", 16),
        ("0X", 16),
        ("0o", 8),
        ("0O", 8),
        ("0b", 2),
        ("0B", 2),
    ];
    for (prefix, base) in radix {
        if let Some(rest) = value.strip_prefix(prefix) {
            return u64::from_str_radix(rest, base).ok().map(|v| v as f64);
        }
    }
    value.parse::<f64>().ok().filter(|v| v.is_finite())
}
pub fn nonnegative(input: Option<&str>, fallback: u64) -> u64 {
    input
        .and_then(number)
        .filter(|v| *v >= 0.0)
        .map(|v| v.floor() as u64)
        .unwrap_or(fallback)
}
pub fn env_u64(name: &str, fallback: u64) -> u64 {
    std::env::var(name)
        .ok()
        .as_deref()
        .and_then(number)
        .filter(|v| *v > 0.0)
        .map(|v| v.floor() as u64)
        .unwrap_or(fallback)
}
fn rate_number(raw: Option<&str>, fallback: u64) -> u64 {
    match raw.map(str::trim).filter(|s| !s.is_empty()) {
        Some(value) => nonnegative(Some(value), fallback),
        None => fallback,
    }
}
pub fn rate_env(name: &str, fallback: u64) -> u64 {
    rate_number(std::env::var(name).ok().as_deref(), fallback)
}
pub fn env_nonnegative(name: &str, fallback: u64) -> u64 {
    nonnegative(std::env::var(name).ok().as_deref(), fallback)
}
pub fn env_bool(name: &str) -> bool {
    std::env::var(name).is_ok_and(|v| v == "true")
}
pub fn env_list(name: &str, fallback: &str) -> Vec<String> {
    std::env::var(name)
        .unwrap_or_else(|_| fallback.to_owned())
        .split(',')
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(str::to_owned)
        .collect()
}
pub fn quote(value: &str) -> String {
    format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
}
pub fn truncate(value: &str, n: usize) -> String {
    let mut units = 0;
    let end = value
        .char_indices()
        .find_map(|(index, c)| {
            units += c.len_utf16();
            (units > n).then_some(index)
        })
        .unwrap_or(value.len());
    value[..end].to_owned()
}

/// Environment-dependent scenarios run alone in a child process: changing a
/// process environment while unrelated tests/HTTP clients run is not safe.
#[cfg(test)]
pub(crate) fn isolated_test(name: &str, environment: &[(&str, &std::ffi::OsStr)]) -> bool {
    if std::env::var("NOSTUBE_ISOLATED_TEST").ok().as_deref() == Some(name) {
        return true;
    }
    let mut command = std::process::Command::new(std::env::current_exe().unwrap());
    command
        .args(["--exact", name, "--nocapture"])
        .env("NOSTUBE_ISOLATED_TEST", name);
    for (key, value) in environment {
        command.env(key, value);
    }
    assert!(
        command.status().unwrap().success(),
        "isolated scenario {name} failed"
    );
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn numbers_match_query_coercion() {
        for (input, expected) in [
            ("", 0),
            (" 2.9 ", 2),
            ("-1", 20),
            ("NaN", 20),
            ("Infinity", 20),
            ("0x10", 16),
            ("1e2", 100),
        ] {
            assert_eq!(nonnegative(Some(input), 20), expected);
        }
        assert_eq!(nonnegative(None, 20), 20);
    }
    #[test]
    fn blank_rate_configuration_keeps_protection_enabled() {
        for input in [None, Some(""), Some("  "), Some("garbage"), Some("-1")] {
            assert_eq!(rate_number(input, 300), 300);
        }
        assert_eq!(rate_number(Some("0"), 300), 0);
        assert_eq!(rate_number(Some("2"), 300), 2);
    }
    #[test]
    fn filter_literals_cannot_escape_quotes() {
        assert_eq!(quote("x\" OR true \\"), "\"x\\\" OR true \\\\\"");
    }
    #[test]
    fn query_truncation_counts_utf16_units() {
        assert_eq!(truncate("ä😀z", 3), "ä😀");
        assert_eq!(truncate("abcd", 2), "ab");
        assert_eq!(truncate("", 2), "");
    }
    #[test]
    fn a_poisoned_lock_is_still_usable() {
        let shared = std::sync::Arc::new(std::sync::Mutex::new(41));
        let crashed = shared.clone();
        let _ = std::thread::spawn(move || {
            let _guard = crashed.lock().unwrap();
            panic!("simulated panic while holding the lock");
        })
        .join();
        assert!(shared.is_poisoned());
        *lock(&shared) += 1;
        assert_eq!(*lock(&shared), 42);
    }
    #[test]
    fn json_scores_keep_javascript_double_precision() {
        // IEEE-754 bit patterns captured from Node's JSON.parse/DataView.
        for (text, bits) in [
            ("0.5461538461538462", 4603094536061327266_u64),
            ("0.20516480595427963", 4596559861439697295_u64),
            ("0.6333333333333333", 4603879779073279044_u64),
        ] {
            let value: serde_json::Value = serde_json::from_str(text).unwrap();
            assert_eq!(value.as_f64().unwrap().to_bits(), bits);
        }
    }
}
