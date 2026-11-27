use crate::{
    net::Meili,
    storage,
    util::{env_u64, now_ms, quote},
};
use anyhow::Result;
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
    time::Duration,
};

fn normalize_hash(s: &str) -> Option<String> {
    let s = s.trim();
    (s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit())).then(|| s.to_ascii_lowercase())
}
fn blossom_file(s: &str) -> Option<(String, Option<String>)> {
    let url = url::Url::parse(s).ok()?;
    let name = url.path_segments()?.next_back()?;
    let (hash, ext) = name
        .split_once('.')
        .map_or((name, None), |(h, e)| (h, Some(e.to_owned())));
    if ext
        .as_deref()
        .is_some_and(|e| e.is_empty() || e.contains('.'))
    {
        return None;
    }
    Some((normalize_hash(hash)?, ext))
}
pub fn media_availability_key(hit: &Value) -> Option<String> {
    let hash = hit["hash"]
        .as_str()
        .and_then(normalize_hash)
        .or_else(|| hit["videoUrl"].as_str().and_then(blossom_file).map(|v| v.0));
    if let Some(hash) = hash {
        return Some(format!("sha256:{hash}"));
    }
    let urls = hit["videoUrl"].as_str().into_iter().chain(
        hit["fallbackUrls"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str),
    );
    for s in urls {
        if let Ok(mut url) = url::Url::parse(s) {
            url.set_fragment(None);
            return Some(format!("url:{url}"));
        }
    }
    None
}
pub fn snapshot_from_availability(key: Option<&str>, doc: Option<&Value>) -> Value {
    let key = key.filter(|key| !key.is_empty());
    let doc = doc.filter(|_| key.is_some());
    let status = doc.and_then(|v| v["status"].as_str()).unwrap_or("unknown");
    let playable = doc
        .and_then(|v| v.get("playableUrl"))
        .cloned()
        .unwrap_or(Value::Null);
    json!({"mediaAvailabilityKey":key,"availabilityStatus":status,"hasPlayableMedia":status == "available" && playable.as_str().is_some_and(|s| !s.is_empty()),"playableUrl":playable,"mediaCheckedAt":doc.and_then(|v|v.get("checkedAt")),"mediaRetryAfter":doc.and_then(|v|v.get("retryAfter"))})
}
pub async fn ensure_index(meili: &Meili) -> Result<()> {
    meili.ensure_index("media_availability", "id", &json!({"filterableAttributes":["id","mediaKey","status","checkedAt","retryAfter"],"sortableAttributes":["checkedAt","retryAfter","attempts"]})).await
}
pub async fn load_availability(meili: &Meili, keys: &[String]) -> Result<HashMap<String, Value>> {
    let unique: HashSet<_> = keys.iter().filter(|k| !k.is_empty()).collect();
    let keys: Vec<_> = unique.into_iter().collect();
    let mut out = HashMap::new();
    for chunk in keys.chunks(80) {
        let filter = chunk
            .iter()
            .map(|k| format!("mediaKey = {}", quote(k)))
            .collect::<Vec<_>>()
            .join(" OR ");
        let result = meili
            .search(
                "media_availability",
                &json!({"q":"","limit":chunk.len(),"filter":filter}),
            )
            .await?;
        for hit in result["hits"].as_array().into_iter().flatten() {
            if let Some(key) = hit["mediaKey"].as_str() {
                out.insert(key.to_owned(), hit.clone());
            }
        }
    }
    Ok(out)
}
fn candidate_urls(hit: &Value, servers: &[String]) -> Vec<String> {
    let mut urls = Vec::new();
    for s in hit["videoUrl"].as_str().into_iter().chain(
        hit["fallbackUrls"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str),
    ) {
        let s = s.trim();
        if !s.is_empty() && !urls.iter().any(|v| v == s) {
            urls.push(s.to_owned());
        }
    }
    let fallback = hit["hash"].as_str().or_else(|| {
        hit["mediaAvailabilityKey"].as_str().and_then(|k| {
            k.get(..7)
                .filter(|p| p.eq_ignore_ascii_case("sha256:"))
                .and_then(|_| k.get(7..))
        })
    });
    let file = urls.iter().find_map(|s| blossom_file(s)).or_else(|| {
        fallback
            .filter(|s| s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit()))
            .map(|s| (s.to_ascii_lowercase(), None))
    });
    if let Some((hash, ext)) = file {
        for server in servers {
            let s = format!(
                "{}/{}.{}",
                server.trim_end_matches('/'),
                hash,
                ext.as_deref().unwrap_or("mp4")
            );
            if !urls.contains(&s) {
                urls.push(s);
            }
        }
    }
    urls
}
struct Lock(PathBuf);
impl Drop for Lock {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}
fn acquire_lock() -> Option<Lock> {
    use std::io::Write;
    let path = std::env::var_os("MEDIA_AVAILABILITY_LOCK_PATH")
        .map(PathBuf::from)
        .unwrap_or_else(|| ".media-availability-check.lock".into());
    if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
        std::fs::create_dir_all(parent).ok()?;
    }
    if let Ok(meta) = std::fs::metadata(&path) {
        if meta
            .modified()
            .ok()
            .and_then(|t| t.elapsed().ok())
            .is_some_and(|age| {
                age.as_millis() > env_u64("MEDIA_AVAILABILITY_LOCK_STALE_MS", 1_800_000) as u128
            })
        {
            let _ = std::fs::remove_file(&path);
        }
    }
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .ok()?;
    if write!(
        file,
        "{}",
        json!({"pid":std::process::id(),"lockedAt":now_ms()})
    )
    .is_err()
    {
        let _ = std::fs::remove_file(&path);
        return None;
    }
    Some(Lock(path))
}
async fn check_urls(
    client: &reqwest::Client,
    urls: &[String],
    timeout: u64,
) -> (String, Option<String>, Vec<Value>) {
    let mut checked = Vec::new();
    let at = now_ms();
    let mut unavailable = false;
    for url in urls {
        let mut row = json!({"url":url,"status":"error","checkedAt":at});
        if let Ok(response) = client
            .head(url)
            .timeout(Duration::from_millis(timeout))
            .send()
            .await
        {
            let status = response.status();
            let available = status.is_success();
            unavailable |= !available;
            row["status"] = json!(if available {
                "available"
            } else {
                "unavailable"
            });
            row["statusCode"] = json!(status.as_u16());
            if let Some(v) = response
                .headers()
                .get(reqwest::header::CONTENT_TYPE)
                .and_then(|v| v.to_str().ok())
            {
                row["contentType"] = json!(v);
            }
            if let Some(v) = response
                .headers()
                .get(reqwest::header::CONTENT_LENGTH)
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.parse::<u64>().ok())
            {
                row["contentLength"] = json!(v);
            }
            checked.push(row);
            if available {
                return ("available".into(), Some(url.clone()), checked);
            }
        } else {
            checked.push(row);
        }
    }
    (
        if unavailable { "unavailable" } else { "error" }.into(),
        None,
        checked,
    )
}
/// What one availability probe found; the values that always travel together.
struct ProbeOutcome<'a> {
    status: &'a str,
    playable: Option<&'a str>,
    checked: Vec<Value>,
    source_count: usize,
}
fn availability_document(
    key: &str,
    previous: Option<&Value>,
    outcome: ProbeOutcome<'_>,
    at: u64,
    retry_ms: u64,
) -> Value {
    use sha2::{Digest, Sha256};
    let ProbeOutcome {
        status,
        playable,
        checked,
        source_count,
    } = outcome;
    // Meili document IDs cannot contain the colon present in every TS media key.
    let id = previous
        .and_then(|v| v["id"].as_str())
        .map(str::to_owned)
        .unwrap_or_else(|| hex::encode(Sha256::digest(key.as_bytes())));
    json!({"id":id,"mediaKey":key,"status":status,"playableUrl":playable,"checkedAt":at,"retryAfter":if status == "available" { None } else { Some(at + retry_ms) },"attempts":previous.and_then(|v|v["attempts"].as_u64()).unwrap_or(0)+1,"checkedUrls":checked,"sourceUrlCount":source_count})
}
fn shared_patches(key: &str, doc: &Value, hits: &[Value]) -> Vec<Value> {
    hits.iter()
        .filter_map(|hit| hit["id"].as_str())
        .map(|id| {
            let mut patch = snapshot_from_availability(Some(key), Some(doc));
            patch["id"] = json!(id);
            patch
        })
        .collect()
}
pub async fn check_once(meili: &Meili) -> Result<()> {
    let Some(_lock) = acquire_lock() else {
        return Ok(());
    };
    let now = now_ms();
    let stale = now.saturating_sub(env_u64("MEDIA_AVAILABILITY_STALE_AFTER_MS", 86_400_000));
    let response = meili.search("videos", &json!({"q":"","limit":env_u64("MEDIA_AVAILABILITY_CHECK_BATCH_SIZE",100),"filter":["mediaAvailabilityKey EXISTS",format!("(mediaCheckedAt IS NULL OR mediaCheckedAt <= {stale} OR mediaRetryAfter <= {now})")],"sort":["mediaCheckedAt:asc"],"attributesToRetrieve":["id","event_id","pubkey","hash","videoUrl","fallbackUrls","mediaAvailabilityKey","mediaCheckedAt","mediaRetryAfter"]})).await?;
    let hits = response["hits"].as_array().cloned().unwrap_or_default();
    if hits.is_empty() {
        return Ok(());
    }
    let authors: Vec<_> = hits
        .iter()
        .filter_map(|h| h["pubkey"].as_str().map(str::to_owned))
        .collect();
    let servers = storage::blossom_servers(&authors).await;
    let keys: Vec<_> = hits
        .iter()
        .filter_map(|h| {
            h["mediaAvailabilityKey"]
                .as_str()
                .map(str::to_owned)
                .or_else(|| media_availability_key(h))
        })
        .collect();
    let existing = load_availability(meili, &keys).await?;
    let mut docs: HashMap<String, Value> = HashMap::new();
    for hit in hits {
        let Some(key) = hit["mediaAvailabilityKey"]
            .as_str()
            .map(str::to_owned)
            .or_else(|| media_availability_key(&hit))
        else {
            continue;
        };
        if hit["id"].as_str().is_none() {
            continue;
        }
        let author_servers = hit["pubkey"]
            .as_str()
            .and_then(|p| servers.get(p))
            .map(Vec::as_slice)
            .unwrap_or(&[]);
        let urls = candidate_urls(&hit, author_servers);
        let (status, playable, checked) = check_urls(
            &meili.http,
            &urls,
            env_u64("MEDIA_AVAILABILITY_HEAD_TIMEOUT_MS", 5000),
        )
        .await;
        let doc = availability_document(
            &key,
            docs.get(&key).or_else(|| existing.get(&key)),
            ProbeOutcome {
                status: &status,
                playable: playable.as_deref(),
                checked,
                source_count: urls.len(),
            },
            now_ms(),
            env_u64("MEDIA_AVAILABILITY_RETRY_AFTER_MS", 3_600_000),
        );
        docs.insert(key, doc);
    }
    if !docs.is_empty() {
        let values: Vec<_> = docs.values().cloned().collect();
        let task = meili.upsert("media_availability", &values).await?;
        meili.wait(&task).await?;
        for (key, doc) in &docs {
            let mut offset = 0;
            loop {
                let response = meili.request(reqwest::Method::POST, "/indexes/videos/documents/fetch", Some(&json!({"filter":format!("mediaAvailabilityKey = {}",quote(key)),"limit":1000,"offset":offset,"fields":["id"]}))).await?;
                let hits = response["results"].as_array().cloned().unwrap_or_default();
                if hits.is_empty() {
                    break;
                }
                let patches = shared_patches(key, doc, &hits);
                if !patches.is_empty() {
                    let task = meili
                        .request(
                            reqwest::Method::PUT,
                            "/indexes/videos/documents?skipCreation=true",
                            Some(&json!(patches)),
                        )
                        .await?;
                    meili.wait(&task).await?;
                }
                if hits.len() < 1000 {
                    break;
                }
                offset += hits.len();
            }
        }
    }
    Ok(())
}
pub async fn run_checker(meili: &Meili) -> Result<()> {
    loop {
        if let Err(e) = check_once(meili).await {
            eprintln!("[AvailabilityChecker] {e:#}");
        }
        tokio::time::sleep(Duration::from_millis(env_u64(
            "MEDIA_AVAILABILITY_CHECK_INTERVAL_MS",
            600_000,
        )))
        .await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn media_keys_and_snapshots_match_existing_documents() {
        let hash = "a".repeat(64);
        assert_eq!(
            media_availability_key(&json!({"videoUrl":format!("https://x/{hash}.mp4")})),
            Some(format!("sha256:{hash}"))
        );
        assert_eq!(
            media_availability_key(&json!({"videoUrl":"HTTPS://Media.Example.com/video.mp4#frag"}))
                .as_deref(),
            Some("url:https://media.example.com/video.mp4")
        );
        let snap = snapshot_from_availability(
            Some("key"),
            Some(
                &json!({"status":"available","playableUrl":"https://x","checkedAt":10,"retryAfter":null}),
            ),
        );
        assert_eq!(
            snap,
            json!({"mediaAvailabilityKey":"key","availabilityStatus":"available","hasPlayableMedia":true,"playableUrl":"https://x","mediaCheckedAt":10,"mediaRetryAfter":null})
        );
    }

    #[test]
    fn candidates_include_deduplicated_author_mirrors() {
        let hash = "a".repeat(64);
        let origin = format!("https://origin/{hash}.webm");
        let hit = json!({"videoUrl":origin,"fallbackUrls":[origin],"mediaAvailabilityKey":format!("sha256:{hash}")});
        assert_eq!(
            candidate_urls(&hit, &["https://mirror/".into()]),
            vec![origin, format!("https://mirror/{hash}.webm")]
        );
    }
    #[test]
    fn durable_documents_keep_history_and_valid_ids() {
        let key = format!("sha256:{}", "a".repeat(64));
        let previous = json!({"id":"legacy_valid_id","mediaKey":key,"status":"unavailable","attempts":7,"checkedAt":100,"retryAfter":200,"playableUrl":null,"checkedUrls":[],"sourceUrlCount":1});
        let doc = availability_document(
            &key,
            Some(&previous),
            ProbeOutcome {
                status: "error",
                playable: None,
                checked: vec![],
                source_count: 0,
            },
            300,
            1000,
        );
        assert_eq!(doc["id"], "legacy_valid_id");
        assert_eq!(doc["mediaKey"], key);
        assert_eq!(doc["attempts"], 8);
        assert_eq!(doc["retryAfter"], 1300);
        let new_doc = availability_document(
            &key,
            None,
            ProbeOutcome {
                status: "available",
                playable: Some("https://x"),
                checked: vec![],
                source_count: 1,
            },
            300,
            1000,
        );
        assert!(
            new_doc["id"]
                .as_str()
                .unwrap()
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        );
        assert_eq!(new_doc["retryAfter"], Value::Null);
    }

    #[tokio::test]
    async fn head_checks_distinguish_http_failure_from_network_error_and_stop_at_success() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            for response in [
                "HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\n\r\n",
                "HTTP/1.1 200 OK\r\nContent-Type: video/mp4\r\nContent-Length: 42\r\n\r\n",
            ] {
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut buf = [0; 1024];
                let _ = stream.read(&mut buf).await.unwrap();
                stream.write_all(response.as_bytes()).await.unwrap();
            }
        });
        let urls = vec![
            format!("http://{addr}/unavailable"),
            format!("http://{addr}/available"),
        ];
        let (status, playable, checked) = check_urls(&reqwest::Client::new(), &urls, 2000).await;
        assert_eq!(status, "available");
        assert_eq!(playable.as_deref(), Some(urls[1].as_str()));
        assert_eq!(checked[0]["status"], "unavailable");
        assert_eq!(checked[0]["statusCode"], 503);
        assert_eq!(checked[1]["contentType"], "video/mp4");
        assert_eq!(checked[1]["contentLength"], 42);
        server.await.unwrap();
        let (status, _, checked) =
            check_urls(&reqwest::Client::new(), &["not a url".into()], 200).await;
        assert_eq!(status, "error");
        assert_eq!(checked[0]["status"], "error");
    }
    #[tokio::test]
    async fn load_finds_existing_document_by_media_key_not_legacy_id() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            let mut buf = [0; 4096];
            loop {
                let n = stream.read(&mut buf).await.unwrap();
                if n == 0 {
                    break;
                }
                request.extend_from_slice(&buf[..n]);
                if let Some(pos) = request.windows(4).position(|w| w == b"\r\n\r\n") {
                    let headers = String::from_utf8_lossy(&request[..pos]);
                    let len = headers
                        .lines()
                        .find_map(|l| {
                            l.to_ascii_lowercase()
                                .strip_prefix("content-length: ")
                                .and_then(|s| s.parse::<usize>().ok())
                        })
                        .unwrap_or(0);
                    if request.len() >= pos + 4 + len {
                        break;
                    }
                }
            }
            let request = String::from_utf8(request).unwrap();
            assert!(request.contains("mediaKey ="));
            let body =
                json!({"hits":[{"id":"legacy_valid_id","mediaKey":"sha256:abc","attempts":7}] })
                    .to_string();
            stream
                .write_all(
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                        body.len(),
                        body
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();
        });
        let meili = Meili::new(format!("http://{addr}"), String::new());
        let docs = load_availability(&meili, &["sha256:abc".into()])
            .await
            .unwrap();
        assert_eq!(docs["sha256:abc"]["attempts"], 7);
        server.await.unwrap();
    }
    #[test]
    fn shared_media_receives_the_final_durable_snapshot() {
        let key = "sha256:abc";
        let doc = json!({"mediaKey":key,"status":"available","playableUrl":"https://mirror/video","checkedAt":100,"retryAfter":null});
        let patches = shared_patches(key, &doc, &[json!({"id":"first"}), json!({"id":"second"})]);
        assert_eq!(patches.len(), 2);
        for (patch, id) in patches.iter().zip(["first", "second"]) {
            assert_eq!(patch["id"], id);
            assert_eq!(patch["mediaAvailabilityKey"], key);
            assert_eq!(patch["hasPlayableMedia"], true);
            assert_eq!(patch["playableUrl"], "https://mirror/video");
        }
    }
    #[test]
    fn mirrors_respect_hash_precedence_and_normalization() {
        let hash = "a".repeat(64);
        let key = format!("sha256:{hash}");
        assert_eq!(
            candidate_urls(
                &json!({"hash":"invalid", "mediaAvailabilityKey":key}),
                &["https://mirror".into()]
            ),
            Vec::<String>::new()
        );
        assert_eq!(
            candidate_urls(
                &json!({"mediaAvailabilityKey":format!("SHA256:{hash}")}),
                &["https://mirror/".into()]
            ),
            vec![format!("https://mirror/{hash}.mp4")]
        );
        assert_eq!(
            media_availability_key(
                &json!({"fallbackUrls":["bad", " HTTPS://Example.com/video#x "]})
            )
            .as_deref(),
            Some("url:https://example.com/video")
        );
    }
    #[tokio::test]
    async fn failed_http_responses_are_unavailable_while_transport_failures_are_errors() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            for status in [404, 503] {
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut buf = [0; 1024];
                let _ = stream.read(&mut buf).await.unwrap();
                stream.write_all(format!("HTTP/1.1 {status} Failure\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").as_bytes()).await.unwrap();
            }
        });
        let urls = vec![
            "not a url".into(),
            format!("http://{addr}/missing"),
            format!("http://{addr}/failure"),
        ];
        let (status, playable, checked) = check_urls(&reqwest::Client::new(), &urls, 2000).await;
        assert_eq!(status, "unavailable");
        assert!(playable.is_none());
        assert_eq!(
            checked
                .iter()
                .map(|v| v["status"].as_str().unwrap())
                .collect::<Vec<_>>(),
            vec!["error", "unavailable", "unavailable"]
        );
        let doc = availability_document(
            "url:https://example/",
            None,
            ProbeOutcome {
                status: &status,
                playable: None,
                checked,
                source_count: 3,
            },
            100,
            50,
        );
        assert_eq!(doc["retryAfter"], 150);
        assert_eq!(doc["sourceUrlCount"], 3);
        server.await.unwrap();
    }
    #[test]
    fn shared_snapshots_preserve_all_matching_ids() {
        let hits: Vec<_> = (0..1200)
            .map(|i| json!({"id":format!("video_{i}")}))
            .collect();
        let doc = json!({"status":"unavailable","playableUrl":null,"checkedAt":9,"retryAfter":19});
        let patches = shared_patches("url:https://x/", &doc, &hits);
        assert_eq!(patches.len(), 1200);
        assert_eq!(patches[1199]["mediaRetryAfter"], 19);
    }
    #[test]
    fn empty_key_is_unknown_even_if_document_exists() {
        assert_eq!(
            snapshot_from_availability(
                Some(""),
                Some(&json!({"status":"available","playableUrl":"https://x"}))
            ),
            json!({"mediaAvailabilityKey":null,"availabilityStatus":"unknown","hasPlayableMedia":false,"playableUrl":null,"mediaCheckedAt":null,"mediaRetryAfter":null})
        );
    }
}
