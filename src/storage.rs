#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn legacy_state_defaults_and_retry_window() {
        let state: IndexerState = serde_json::from_value(json!({"lastIncrementalAt":1,"lastFullAt":2,"lastAvailabilityCheckAt":3,"lastPlaylistScoreAt":4})).unwrap();
        assert_eq!(state.last_full_start_at, 0);
        assert_eq!(state.last_availability_check_at, 3);
        assert!(!needs_full_reindex(&state, 100, 200, 10));
        let state = IndexerState {
            last_full_start_at: 100,
            ..Default::default()
        };
        assert!(!needs_full_reindex(&state, 109, 50, 10));
        assert!(needs_full_reindex(&state, 110, 50, 10));
    }

    #[test]
    fn profiles_only_keep_string_fields_and_alias_display_name() {
        assert_eq!(
            parse_profile(r#"{"name":"a","displayName":"b","about":2}"#),
            Some(json!({"name":"a","display_name":"b"}))
        );
        assert_eq!(parse_profile("bad"), None);
    }

    #[test]
    fn server_origins_and_people_defaults() {
        assert_eq!(
            server_origin("https://Blossom.Example/path").as_deref(),
            Some("https://blossom.example")
        );
        let doc = people_document("bad", 2, None, None, 42);
        assert_eq!(doc["npub"], "bad");
        assert_eq!(doc["globalTrustScore"], 0.5);
        assert_eq!(doc["updatedAt"], 42);
    }

    #[test]
    fn existing_cache_files_retain_timestamp_and_payload() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("cache.json");
        std::fs::write(
            &path,
            br#"{"a":{"score":0.25,"cachedAt":123},"b":{"profile":null,"cachedAt":100}}"#,
        )
        .unwrap();
        let mut map = read_map(&path);
        assert_eq!(map["a"]["score"], 0.25);
        assert!(map["b"]["profile"].is_null());
        trim_cache(&mut map, 1);
        write_map(&path, &map).unwrap();
        let restored = read_map(&path);
        assert_eq!(restored.len(), 1);
        assert_eq!(restored["a"]["cachedAt"], 123);
    }

    #[test]
    fn state_serializes_all_legacy_names() {
        let value = serde_json::to_value(IndexerState::default()).unwrap();
        assert_eq!(
            value,
            json!({"lastIncrementalAt":0,"lastFullAt":0,"lastFullStartAt":0,"lastAvailabilityCheckAt":0,"lastPlaylistScoreAt":0})
        );
    }

    #[test]
    fn playlist_scores_survive_in_their_own_file_and_default_to_zero() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("playlists.json");
        assert!(read_playlist_scores_at(&path).is_empty());
        let scores = HashMap::from([("a".to_owned(), 0.8), ("b".to_owned(), 0.0)]);
        write_playlist_scores_at(&path, &scores).unwrap();
        assert_eq!(read_playlist_scores_at(&path), scores);
        std::fs::write(&path, b"not json").unwrap();
        assert!(read_playlist_scores_at(&path).is_empty());
        // Non-numeric and non-finite entries must never reach a Meili document.
        std::fs::write(&path, br#"{"a":0.5,"b":"x","c":null,"d":-1}"#).unwrap();
        assert_eq!(
            read_playlist_scores_at(&path),
            HashMap::from([("a".to_owned(), 0.5), ("d".to_owned(), 0.0)])
        );
    }
    #[test]
    fn blossom_origins_preserve_url_authority_and_default_ports() {
        for (input, expected) in [
            ("HTTPS://Example.COM:443/path?q=1", "https://example.com"),
            ("http://user:pass@[::1]:8080/path", "http://[::1]:8080"),
            ("ftp://Example.com/a", "ftp://example.com"),
        ] {
            assert_eq!(server_origin(input).as_deref(), Some(expected));
        }
        assert_eq!(server_origin("not a url"), None);
    }
    #[test]
    fn npub_encoding_accepts_all_32_byte_pubkeys() {
        assert_eq!(
            npub(&"0".repeat(64)).as_deref(),
            Some("npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqzqujme")
        );
        assert!(npub("bad").is_none());
    }
    #[test]
    fn latest_profile_events_prefer_newer_versions() {
        let events = vec![
            json!({"pubkey":"a","created_at":2,"content":"new"}),
            json!({"pubkey":"a","created_at":1,"content":"old"}),
            json!({"pubkey":"b","created_at":3}),
        ];
        let latest = latest_events(events);
        assert_eq!(latest["a"]["content"], "new");
        assert_eq!(latest.len(), 2);
    }
}

use crate::{
    net::{self, Meili},
    util::{env_u64, now_ms, now_secs},
};
use anyhow::Result;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{LazyLock, Mutex},
};

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct IndexerState {
    pub last_incremental_at: u64,
    pub last_full_at: u64,
    pub last_full_start_at: u64,
    pub last_availability_check_at: u64,
    pub last_playlist_score_at: u64,
}

fn env_path(name: &str, default: &str) -> PathBuf {
    std::env::var_os(name)
        .map(PathBuf::from)
        .unwrap_or_else(|| default.into())
}
pub fn read_state() -> IndexerState {
    std::fs::read(env_path("INDEXER_STATE_PATH", ".indexer-state.json"))
        .ok()
        .and_then(|v| serde_json::from_slice(&v).ok())
        .unwrap_or_default()
}
pub fn write_state(state: &IndexerState) -> Result<()> {
    let path = env_path("INDEXER_STATE_PATH", ".indexer-state.json");
    if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(path, serde_json::to_vec_pretty(state)?)?;
    Ok(())
}

// Playlist scores live outside the video documents so that rewriting a video
// (every incremental/full pass rebuilds it) cannot reset them, and so a video
// indexed after its playlist still receives its score.
fn playlist_scores_path() -> PathBuf {
    env_path("PLAYLIST_SCORES_PATH", ".playlist-scores.json")
}
fn read_playlist_scores_at(path: &Path) -> HashMap<String, f64> {
    read_map(path)
        .into_iter()
        .filter_map(|(id, v)| v.as_f64().map(|s| (id, s.clamp(0.0, 1.0))))
        .collect()
}
fn write_playlist_scores_at(path: &Path, scores: &HashMap<String, f64>) -> Result<()> {
    let map: HashMap<String, Value> = scores.iter().map(|(k, v)| (k.clone(), json!(v))).collect();
    write_map(path, &map)
}
pub fn read_playlist_scores() -> HashMap<String, f64> {
    let _guard = cache_lock();
    read_playlist_scores_at(&playlist_scores_path())
}
pub fn write_playlist_scores(scores: &HashMap<String, f64>) -> Result<()> {
    let _guard = cache_lock();
    write_playlist_scores_at(&playlist_scores_path(), scores)
}
pub fn needs_full_reindex(
    state: &IndexerState,
    now: u64,
    full_interval: u64,
    retry_interval: u64,
) -> bool {
    now.saturating_sub(state.last_full_at) >= full_interval
        && now.saturating_sub(state.last_full_start_at) >= retry_interval
}

// Cache operations are serialized across callers; files retain the TS object format.
static CACHE_LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));
fn cache_lock() -> std::sync::MutexGuard<'static, ()> {
    crate::util::lock(&CACHE_LOCK)
}
fn read_map(path: &Path) -> HashMap<String, Value> {
    std::fs::read(path)
        .ok()
        .and_then(|v| serde_json::from_slice(&v).ok())
        .unwrap_or_default()
}
fn write_map(path: &Path, data: &HashMap<String, Value>) -> Result<()> {
    if let Some(p) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
        std::fs::create_dir_all(p)?;
    }
    let tmp = PathBuf::from(format!("{}.tmp", path.display()));
    std::fs::write(&tmp, serde_json::to_vec(data)?)?;
    std::fs::rename(tmp, path)?;
    Ok(())
}
fn fresh(entry: &Value, ttl: u64) -> bool {
    entry
        .get("cachedAt")
        .and_then(Value::as_u64)
        .is_some_and(|t| now_ms().saturating_sub(t) <= ttl)
}
fn trim_cache(data: &mut HashMap<String, Value>, max: usize) {
    if data.len() <= max {
        return;
    }
    let mut keys: Vec<_> = data
        .iter()
        .map(|(k, v)| (k.clone(), v["cachedAt"].as_u64().unwrap_or(0)))
        .collect();
    keys.sort_by_key(|v| v.1);
    for (k, _) in keys.into_iter().take(data.len() - max) {
        data.remove(&k);
    }
}
pub fn trust_get_many(pubkeys: &[String]) -> HashMap<String, f64> {
    let _guard = cache_lock();
    let data = read_map(&env_path("TRUST_CACHE_PATH", ".trust-cache.json"));
    let ttl = env_u64("TRUST_CACHE_TTL_MS", 86_400_000);
    pubkeys
        .iter()
        .filter_map(|k| {
            data.get(k)
                .filter(|v| fresh(v, ttl))
                .and_then(|v| v["score"].as_f64())
                .map(|score| (k.clone(), score))
        })
        .collect()
}
pub fn trust_set_many(scores: &HashMap<String, f64>) -> Result<()> {
    if scores.is_empty() {
        return Ok(());
    }
    let _guard = cache_lock();
    let path = env_path("TRUST_CACHE_PATH", ".trust-cache.json");
    let mut data = read_map(&path);
    let now = now_ms();
    for (k, score) in scores {
        data.insert(k.clone(), json!({"score":score,"cachedAt":now}));
    }
    trim_cache(
        &mut data,
        env_u64("TRUST_CACHE_MAX_ENTRIES", 100_000) as usize,
    );
    if let Err(err) = write_map(&path, &data) {
        eprintln!("[TrustCache] Failed to write cache file: {err}");
    }
    Ok(())
}
fn relay_urls() -> Vec<String> {
    std::env::var("NOSTR_INDEX_RELAYS")
        .or_else(|_| std::env::var("NOSTR_INDEX_NRELAY"))
        .unwrap_or_default()
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .collect()
}
fn parse_profile(content: &str) -> Option<Value> {
    let value: Value = serde_json::from_str(content).ok()?;
    if value.is_null() {
        return None;
    }
    let mut out = serde_json::Map::new();
    for field in ["name", "username", "about", "picture", "nip05", "lud16"] {
        if let Some(v) = value.get(field).and_then(Value::as_str) {
            out.insert(field.into(), json!(v));
        }
    }
    if let Some(v) = value
        .get("display_name")
        .and_then(Value::as_str)
        .or_else(|| value.get("displayName").and_then(Value::as_str))
    {
        out.insert("display_name".into(), json!(v));
    }
    Some(Value::Object(out))
}
fn latest_events(events: Vec<Value>) -> HashMap<String, Value> {
    let mut latest: HashMap<String, Value> = HashMap::new();
    for event in events {
        let Some(key) = event["pubkey"].as_str() else {
            continue;
        };
        if latest.get(key).is_none_or(|old| {
            event["created_at"].as_u64().unwrap_or(0) > old["created_at"].as_u64().unwrap_or(0)
        }) {
            latest.insert(key.to_owned(), event);
        }
    }
    latest
}
pub async fn get_profiles(pubkeys: &[String]) -> Result<HashMap<String, Value>> {
    let unique: HashSet<_> = pubkeys.iter().filter(|p| !p.is_empty()).cloned().collect();
    let path = env_path("PROFILE_CACHE_PATH", ".profile-cache.json");
    let ttl = env_u64("PROFILE_CACHE_TTL_MS", 86_400_000);
    let (mut profiles, missing) = {
        let _guard = cache_lock();
        let data = read_map(&path);
        let mut profiles = HashMap::new();
        let mut missing = Vec::new();
        for k in unique {
            match data.get(&k).filter(|v| fresh(v, ttl)) {
                Some(v) => {
                    if !v["profile"].is_null() {
                        profiles.insert(k, v["profile"].clone());
                    }
                }
                None => missing.push(k),
            }
        }
        (profiles, missing)
    };
    let relays = relay_urls();
    if missing.is_empty() || relays.is_empty() {
        return Ok(profiles);
    }
    let events = match net::fetch_events(
        &relays,
        json!({"kinds":[0],"authors":missing,"limit":missing.len()}),
        env_u64("NOSTR_INDEX_PROFILE_FETCH_MAX_WAIT_MS", 6000),
    )
    .await
    {
        Ok(events) => events,
        Err(err) => {
            eprintln!("[Profiles] relay fetch failed: {err}");
            return Ok(profiles);
        }
    };
    let found: HashMap<_, _> = latest_events(events)
        .into_iter()
        .filter_map(|(k, e)| {
            e["content"]
                .as_str()
                .and_then(parse_profile)
                .map(|p| (k, p))
        })
        .collect();
    {
        let _guard = cache_lock();
        let mut data = read_map(&path);
        let now = now_ms();
        for k in &missing {
            data.insert(k.clone(), json!({"profile":found.get(k),"cachedAt":now}));
        }
        trim_cache(
            &mut data,
            env_u64("PROFILE_CACHE_MAX_ENTRIES", 20_000) as usize,
        );
        if let Err(err) = write_map(&path, &data) {
            eprintln!("[ProfileCache] Failed to write cache file: {err}");
        }
    }
    profiles.extend(found);
    Ok(profiles)
}
fn npub(key: &str) -> Option<String> {
    let bytes = hex::decode(key).ok()?;
    if bytes.len() != 32 {
        return None;
    }
    bech32::encode::<bech32::Bech32>(bech32::Hrp::parse("npub").ok()?, &bytes).ok()
}
pub(crate) fn server_origin(s: &str) -> Option<String> {
    let u = url::Url::parse(s).ok()?;
    let host = match u.host()? {
        url::Host::Ipv6(ip) => format!("[{ip}]"),
        other => other.to_string(),
    };
    Some(format!(
        "{}://{}{}",
        u.scheme(),
        host,
        u.port().map(|p| format!(":{p}")).unwrap_or_default()
    ))
}
pub(crate) async fn blossom_servers(pubkeys: &[String]) -> HashMap<String, Vec<String>> {
    let unique: HashSet<_> = pubkeys.iter().filter(|p| !p.is_empty()).cloned().collect();
    let dir = env_path("BLOSSOM_LIST_CACHE_DIR", "blossom-lists");
    let ttl = env_u64("BLOSSOM_LIST_CACHE_TTL_MS", 86_400_000);
    let mut found = HashMap::new();
    let mut missing = Vec::new();
    for k in unique {
        let entry = npub(&k)
            .and_then(|n| std::fs::read(dir.join(format!("{n}.json"))).ok())
            .and_then(|v| serde_json::from_slice::<Value>(&v).ok());
        let cached = entry
            .as_ref()
            .filter(|e| e["pubkey"] == k && fresh(e, ttl))
            .and_then(|e| e["servers"].as_array());
        if let Some(servers) = cached {
            found.insert(
                k,
                servers
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect(),
            );
        } else {
            missing.push(k);
        }
    }
    let relays = relay_urls();
    if missing.is_empty() || relays.is_empty() {
        return found;
    }
    let events = match net::fetch_events(
        &relays,
        json!({"kinds":[10063],"authors":missing,"limit":missing.len()}),
        env_u64("NOSTR_INDEX_BLOSSOM_LIST_FETCH_MAX_WAIT_MS", 6000),
    )
    .await
    {
        Ok(v) => v,
        Err(e) => {
            eprintln!("[BlossomLists] relay fetch failed: {e}");
            return found;
        }
    };
    let events = latest_events(events);
    for k in missing {
        let Some(n) = npub(&k) else { continue };
        let event = events.get(&k);
        let mut servers = Vec::new();
        if let Some(tags) = event.and_then(|e| e["tags"].as_array()) {
            for tag in tags {
                if tag.get(0).and_then(Value::as_str) == Some("server") {
                    if let Some(s) = tag.get(1).and_then(Value::as_str).and_then(server_origin) {
                        if !servers.contains(&s) {
                            servers.push(s);
                        }
                    }
                }
            }
        }
        let entry = json!({"pubkey":k,"npub":n,"servers":servers,"cachedAt":now_ms(),"eventCreatedAt":event.and_then(|e| e.get("created_at"))});
        let written = serde_json::to_vec_pretty(&entry)
            .map_err(std::io::Error::other)
            .and_then(|bytes| {
                std::fs::create_dir_all(&dir)?;
                std::fs::write(dir.join(format!("{n}.json")), bytes)
            });
        if let Err(e) = written {
            eprintln!("[BlossomLists] cache write failed: {e}");
        }
        if event.is_some() {
            found.insert(k, servers);
        }
    }
    found
}
fn people_document(
    pubkey: &str,
    count: u64,
    profile: Option<&Value>,
    trust: Option<f64>,
    now: u64,
) -> Value {
    let field = |name: &str| {
        profile
            .and_then(|p| p.get(name))
            .cloned()
            .unwrap_or(Value::Null)
    };
    json!({"pubkey":pubkey,"npub":npub(pubkey).unwrap_or_else(||pubkey.to_owned()),"name":field("name"),"display_name":field("display_name"),"username":field("username"),"about":field("about"),"picture":field("picture"),"nip05":field("nip05"),"lud16":field("lud16"),"videoCount":count,"globalTrustScore":trust.unwrap_or(0.5),"updatedAt":now})
}
pub async fn ensure_people_index(meili: &Meili) -> Result<()> {
    meili.ensure_index("people", "pubkey", &json!({"searchableAttributes":["name","display_name","username","about","nip05","npub","pubkey"],"filterableAttributes":["pubkey","videoCount"],"sortableAttributes":["videoCount","globalTrustScore","updatedAt"],"rankingRules":["words","typo","proximity","attribute","exactness","sort","videoCount:desc","globalTrustScore:desc"]})).await
}
pub async fn upsert_people(
    meili: &Meili,
    index: &str,
    counts: &HashMap<String, u64>,
    profiles: &HashMap<String, Value>,
    trust: &HashMap<String, f64>,
) -> Result<()> {
    let now = now_secs();
    let docs: Vec<_> = counts
        .iter()
        .map(|(k, n)| people_document(k, *n, profiles.get(k), trust.get(k).copied(), now))
        .collect();
    for chunk in docs.chunks(500) {
        let task = meili.upsert(index, chunk).await?;
        meili.wait(&task).await?;
    }
    Ok(())
}

pub fn prune_caches() -> Result<()> {
    let _guard = cache_lock();
    for (path_name, default_path, ttl_name) in [
        (
            "TRUST_CACHE_PATH",
            ".trust-cache.json",
            "TRUST_CACHE_TTL_MS",
        ),
        (
            "PROFILE_CACHE_PATH",
            ".profile-cache.json",
            "PROFILE_CACHE_TTL_MS",
        ),
    ] {
        let path = env_path(path_name, default_path);
        if !path.exists() {
            continue;
        }
        let mut entries = read_map(&path);
        let before = entries.len();
        entries.retain(|_, entry| fresh(entry, env_u64(ttl_name, 86_400_000)));
        if entries.len() != before {
            write_map(&path, &entries)?;
        }
    }
    let dir = env_path("BLOSSOM_LIST_CACHE_DIR", "blossom-lists");
    if dir.exists() {
        let ttl = env_u64("BLOSSOM_LIST_CACHE_TTL_MS", 86_400_000);
        for item in std::fs::read_dir(dir)? {
            let path = item?.path();
            if path.extension().and_then(|v| v.to_str()) != Some("json") {
                continue;
            }
            let entry = std::fs::read(&path)
                .ok()
                .and_then(|v| serde_json::from_slice::<Value>(&v).ok());
            if !entry
                .as_ref()
                .is_some_and(|v| v["cachedAt"].as_u64().is_some_and(|t| t != 0) && fresh(v, ttl))
            {
                std::fs::remove_file(path)?;
            }
        }
    }
    Ok(())
}
