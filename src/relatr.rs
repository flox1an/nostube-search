use crate::{
    storage,
    util::{env_u64, now_ms},
};
use anyhow::{Result, anyhow};
use futures_util::StreamExt;
use nostr::nips::nip44;
use nostr_sdk::prelude::*;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    sync::atomic::{AtomicU64, Ordering},
    time::Duration,
};

const SERVER: &str = "d3aa7e54cc5fc3e2390984bfc6faabfa1a9316118c30dff53b47e3dabe655aef";
static COOLDOWN: AtomicU64 = AtomicU64::new(0);

fn request_frame(id: u64, keys: &[String]) -> Value {
    json!({"jsonrpc":"2.0","id":id,"method":"tools/call","params":{"name":"calculate_trust_scores","arguments":{"targetPubkeys":keys}}})
}
fn global_score(item: &Value) -> Option<f64> {
    let validators = item.pointer("/components/validators")?.as_object()?;
    let scores: Vec<f64> = validators
        .iter()
        .filter_map(|(key, value)| {
            let name = key.split_once(':').map(|(_, s)| s).unwrap_or(key);
            if matches!(
                name,
                "video_creator_activity" | "video_viewer_engagement" | "video_creator_comments"
            ) {
                value["score"].as_f64()
            } else {
                None
            }
        })
        .collect();
    if scores.is_empty() {
        None
    } else {
        Some(scores.iter().sum::<f64>() / scores.len() as f64)
    }
}
fn should_cooldown(timeout: bool, failures: u64, maximum: u64) -> bool {
    timeout || failures >= maximum
}
fn extract_scores(result: &Value) -> Vec<Value> {
    if let Some(items) = result
        .pointer("/structuredContent/trustScores")
        .and_then(Value::as_array)
    {
        return items.clone();
    }
    let text = result["content"]
        .as_array()
        .and_then(|a| a.iter().find(|v| v["type"] == "text"))
        .and_then(|v| v["text"].as_str());
    match text.and_then(|s| serde_json::from_str::<Value>(s).ok()) {
        Some(Value::Array(a)) => a,
        Some(v) => vec![v],
        None => vec![],
    }
}

struct ClientGuard(Option<Client>);

impl Drop for ClientGuard {
    fn drop(&mut self) {
        if let Some(client) = self.0.take() {
            if let Ok(handle) = tokio::runtime::Handle::try_current() {
                handle.spawn(async move {
                    let timeout =
                        Duration::from_millis(env_u64("TRUST_SCORE_DISCONNECT_TIMEOUT_MS", 2_000));
                    let _ = tokio::time::timeout(timeout, client.shutdown()).await;
                });
            }
        }
    }
}

pub async fn call_tool(pubkeys: &[String]) -> Result<Value> {
    call_tool_at(
        pubkeys,
        "wss://relay2.contextvm.org",
        PublicKey::parse(SERVER)?,
    )
    .await
}

async fn call_tool_at(pubkeys: &[String], relay: &str, server: PublicKey) -> Result<Value> {
    let keys = Keys::generate();
    let mut guard = ClientGuard(Some(Client::new()));
    let client = guard.0.as_ref().unwrap();
    let result = async {
        client.add_relay(relay).await?;
        client.connect().await;
        let mut notifications = client.notifications();
        let filter = Filter::new()
            .pubkey(keys.public_key())
            .kinds([Kind::Custom(1059), Kind::Custom(21059), Kind::Custom(25910)])
            .since(Timestamp::now());
        client.subscribe(filter).await?;
        let inner = EventBuilder::new(Kind::Custom(25910), request_frame(1, pubkeys).to_string())
            .tags([Tag::public_key(server)])
            .finalize(&keys)?;
        let wrapping = Keys::generate();
        let ciphertext = nip44::encrypt(
            wrapping.secret_key(),
            &server,
            inner.as_json(),
            nip44::Version::V2,
        )?;
        let outer = EventBuilder::new(Kind::Custom(1059), ciphertext)
            .tags([Tag::public_key(server)])
            .finalize(&wrapping)?;
        client.send_event(&outer).await?;
        let request_id = inner.id.to_hex();
        while let Some(notification) = notifications.next().await {
            let ClientNotification::Event { event, .. } = notification else {
                continue;
            };
            let decoded = if event.kind == Kind::Custom(1059) || event.kind == Kind::Custom(21059) {
                if event.content.len() > 100_000 {
                    continue;
                }
                let Ok(text) = nip44::decrypt(keys.secret_key(), &event.pubkey, &event.content)
                else {
                    continue;
                };
                let Ok(value) = serde_json::from_str::<Value>(&text) else {
                    continue;
                };
                value
            } else {
                serde_json::to_value(&*event)?
            };
            if decoded["pubkey"].as_str() != Some(server.to_hex().as_str())
                || decoded["kind"] != 25910
                || !crate::domain::verify_event(&decoded)
            {
                continue;
            }
            if !crate::domain::tags(&decoded).iter().any(|t| {
                t.first().map(String::as_str) == Some("e") && t.get(1) == Some(&request_id)
            }) {
                continue;
            }
            let Ok(response) =
                serde_json::from_str::<Value>(decoded["content"].as_str().unwrap_or(""))
            else {
                continue;
            };
            if response["jsonrpc"] != "2.0" || response["id"] != 1 {
                continue;
            }
            if let Some(error) = response.get("error") {
                return Err(anyhow!("MCP error: {error}"));
            }
            if let Some(result) = response.get("result") {
                return Ok(result.clone());
            }
        }
        Err(anyhow!("ContextVM connection closed"))
    }
    .await;
    let _ = tokio::time::timeout(
        Duration::from_millis(env_u64("TRUST_SCORE_DISCONNECT_TIMEOUT_MS", 2_000)),
        guard.0.as_ref().unwrap().shutdown(),
    )
    .await;
    guard.0.take();
    result
}

pub async fn fetch_trust_scores(pubkeys: &[String]) -> HashMap<String, f64> {
    fetch_trust_scores_at(
        pubkeys,
        "wss://relay2.contextvm.org",
        PublicKey::parse(SERVER).expect("valid relatr pubkey"),
    )
    .await
}

async fn fetch_trust_scores_at(
    pubkeys: &[String],
    relay: &str,
    server: PublicKey,
) -> HashMap<String, f64> {
    let started = now_ms();
    let mut scores = storage::trust_get_many(pubkeys);
    let missing: Vec<String> = pubkeys
        .iter()
        .filter(|p| !scores.contains_key(*p))
        .cloned()
        .collect();
    let mut fresh = HashMap::new();
    let deadline = started.saturating_add(env_u64("TRUST_SCORE_MAX_FETCH_MS", 60_000));
    let size = env_u64("TRUST_SCORE_CHUNK_SIZE", 16) as usize;
    let mut failures = 0;
    for chunk in missing.chunks(size) {
        let now = now_ms();
        if now < COOLDOWN.load(Ordering::Relaxed) {
            break;
        }
        if now >= deadline {
            COOLDOWN.store(
                now.saturating_add(env_u64("TRUST_SCORE_COOLDOWN_MS", 300_000)),
                Ordering::Relaxed,
            );
            break;
        }
        let timeout = env_u64("TRUST_SCORE_CHUNK_TIMEOUT_MS", 10_000).min(deadline - now);
        match tokio::time::timeout(
            Duration::from_millis(timeout),
            call_tool_at(chunk, relay, server),
        )
        .await
        {
            Ok(Ok(result)) => {
                failures = 0;
                for item in extract_scores(&result) {
                    if let Some(key) = item["targetPubkey"].as_str() {
                        let score = global_score(&item).unwrap_or(0.5).clamp(0.0, 1.0);
                        fresh.insert(key.to_owned(), score);
                        scores.insert(key.to_owned(), score);
                    }
                }
            }
            outcome => {
                failures += 1;
                let timeout = match &outcome {
                    Err(_) => true,
                    Ok(Err(e)) => {
                        let s = e.to_string().to_lowercase();
                        s.contains("timeout") || s.contains("timed out") || s.contains("-32001")
                    }
                    _ => false,
                };
                if should_cooldown(
                    timeout,
                    failures,
                    env_u64("TRUST_SCORE_MAX_CONSECUTIVE_FAILURES", 2),
                ) {
                    COOLDOWN.store(
                        now_ms().saturating_add(env_u64("TRUST_SCORE_COOLDOWN_MS", 300_000)),
                        Ordering::Relaxed,
                    );
                }
            }
        }
    }
    if !fresh.is_empty() {
        if let Err(error) = storage::trust_set_many(&fresh) {
            eprintln!("trust cache: {error:#}");
        }
    }
    scores
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::{SinkExt, StreamExt};
    use serde_json::json;
    use tokio::{net::TcpListener, sync::oneshot};
    use tokio_tungstenite::{accept_async, tungstenite::Message};

    async fn relay(
        result: Value,
        wrap_kind: u16,
        respond: bool,
    ) -> (String, PublicKey, oneshot::Receiver<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("ws://{}", listener.local_addr().unwrap());
        let server = Keys::generate();
        let public = server.public_key();
        let (closed_tx, closed_rx) = oneshot::channel();
        tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            let mut ws = accept_async(socket).await.unwrap();
            let mut subscription = String::new();
            while let Some(Ok(message)) = ws.next().await {
                let Ok(text) = message.to_text() else {
                    continue;
                };
                let Ok(frame) = serde_json::from_str::<Value>(text) else {
                    continue;
                };
                match frame[0].as_str() {
                    Some("REQ") => {
                        subscription = frame[1].as_str().unwrap().to_owned();
                        ws.send(Message::Text(
                            json!(["EOSE", subscription]).to_string().into(),
                        ))
                        .await
                        .unwrap();
                    }
                    Some("EVENT") => {
                        let outer: Event = Event::from_json(frame[1].to_string()).unwrap();
                        assert_eq!(outer.kind, Kind::Custom(1059));
                        outer.verify().unwrap();
                        let plaintext =
                            nip44::decrypt(server.secret_key(), &outer.pubkey, &outer.content)
                                .unwrap();
                        let inner = Event::from_json(plaintext).unwrap();
                        inner.verify().unwrap();
                        assert_eq!(inner.kind, Kind::Custom(25910));
                        assert_eq!(
                            serde_json::from_str::<Value>(&inner.content).unwrap(),
                            request_frame(1, &["target".into()])
                        );
                        ws.send(Message::Text(
                            json!(["OK", outer.id.to_hex(), true, ""])
                                .to_string()
                                .into(),
                        ))
                        .await
                        .unwrap();
                        if respond {
                            for (index, (signer, tag, id)) in [(Keys::generate(), inner.id, 1), (server.clone(), EventId::from_hex("0000000000000000000000000000000000000000000000000000000000000000").unwrap(), 1), (server.clone(), inner.id, 2), (server.clone(), inner.id, 1), (server.clone(), inner.id, 1)].into_iter().enumerate() {
                                let payload = if index == 4 { result.clone() } else { json!({"forged":true}) };
                                let response = EventBuilder::new(Kind::Custom(25910), json!({"jsonrpc":"2.0","id":id,"result":payload}).to_string()).tags([Tag::public_key(inner.pubkey), Tag::event(tag)]).finalize(&signer).unwrap();
                                let mut response = serde_json::to_value(response).unwrap();
                                if index == 3 { response["sig"] = json!("00".repeat(64)); }
                                let ephemeral = Keys::generate();
                                let encrypted = nip44::encrypt(ephemeral.secret_key(), &inner.pubkey, response.to_string(), nip44::Version::V2).unwrap();
                                let wrapped = EventBuilder::new(Kind::Custom(wrap_kind), encrypted).tags([Tag::public_key(inner.pubkey)]).finalize(&ephemeral).unwrap();
                                ws.send(Message::Text(json!(["EVENT",subscription,serde_json::to_value(wrapped).unwrap()]).to_string().into())).await.unwrap();
                            }
                        }
                    }
                    _ => {}
                }
            }
            let _ = closed_tx.send(());
        });
        (url, public, closed_rx)
    }

    #[tokio::test]
    async fn encrypted_roundtrip_checks_identity_event_and_rpc_correlation() {
        for kind in [1059, 21059] {
            let result = json!({"structuredContent":{"trustScores":[{"targetPubkey":"target"}]}});
            let (url, server, closed) = relay(result.clone(), kind, true).await;
            let received = tokio::time::timeout(
                Duration::from_secs(5),
                call_tool_at(&["target".into()], &url, server),
            )
            .await
            .unwrap()
            .unwrap();
            assert_eq!(received, result);
            assert_eq!(extract_scores(&received)[0]["targetPubkey"], "target");
            tokio::time::timeout(Duration::from_secs(5), closed)
                .await
                .unwrap()
                .unwrap();
        }
        assert_eq!(
            extract_scores(
                &json!({"content":[{"type":"text","text":"[{\"targetPubkey\":\"target\"}]"}]})
            )[0]["targetPubkey"],
            "target"
        );
    }

    #[tokio::test]
    async fn cancelled_request_closes_relay_connection() {
        let (url, server, closed) = relay(json!({}), 1059, false).await;
        assert!(
            tokio::time::timeout(
                Duration::from_millis(500),
                call_tool_at(&["target".into()], &url, server)
            )
            .await
            .is_err()
        );
        tokio::time::timeout(Duration::from_secs(5), closed)
            .await
            .unwrap()
            .unwrap();
    }

    #[tokio::test]
    async fn concurrent_fetch_timeout_stops_chunks_and_retries_after_cooldown() {
        use std::sync::{
            Arc,
            atomic::{AtomicBool, AtomicUsize},
        };
        let directory = tempfile::tempdir().unwrap();
        if !crate::util::isolated_test(
            "relatr::tests::concurrent_fetch_timeout_stops_chunks_and_retries_after_cooldown",
            &[
                (
                    "TRUST_CACHE_PATH",
                    directory.path().join("trust.json").as_os_str(),
                ),
                ("TRUST_SCORE_CHUNK_SIZE", std::ffi::OsStr::new("1")),
                ("TRUST_SCORE_CHUNK_TIMEOUT_MS", std::ffi::OsStr::new("250")),
                ("TRUST_SCORE_MAX_FETCH_MS", std::ffi::OsStr::new("500")),
                ("TRUST_SCORE_COOLDOWN_MS", std::ffi::OsStr::new("400")),
            ],
        ) {
            return;
        }
        COOLDOWN.store(0, Ordering::Relaxed);
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("ws://{}", listener.local_addr().unwrap());
        let server = Keys::generate();
        let public = server.public_key();
        let count = Arc::new(AtomicUsize::new(0));
        let respond = Arc::new(AtomicBool::new(false));
        let task = tokio::spawn({
            let count = count.clone();
            let respond = respond.clone();
            async move {
                while let Ok((socket, _)) = listener.accept().await {
                    let server = server.clone();
                    let count = count.clone();
                    let respond = respond.clone();
                    tokio::spawn(async move {
                        let mut ws = accept_async(socket).await.unwrap();
                        let mut subscription = String::new();
                        while let Some(Ok(message)) = ws.next().await {
                            let Ok(text) = message.to_text() else {
                                continue;
                            };
                            let Ok(frame) = serde_json::from_str::<Value>(text) else {
                                continue;
                            };
                            match frame[0].as_str() {
                                Some("REQ") => {
                                    subscription = frame[1].as_str().unwrap().to_owned();
                                    let _ = ws
                                        .send(Message::Text(
                                            json!(["EOSE", subscription]).to_string().into(),
                                        ))
                                        .await;
                                }
                                Some("EVENT") => {
                                    let outer = Event::from_json(frame[1].to_string()).unwrap();
                                    let inner = Event::from_json(
                                        nip44::decrypt(
                                            server.secret_key(),
                                            &outer.pubkey,
                                            &outer.content,
                                        )
                                        .unwrap(),
                                    )
                                    .unwrap();
                                    count.fetch_add(1, Ordering::SeqCst);
                                    let _ = ws
                                        .send(Message::Text(
                                            json!(["OK", outer.id.to_hex(), true, ""])
                                                .to_string()
                                                .into(),
                                        ))
                                        .await;
                                    if respond.load(Ordering::SeqCst) {
                                        let request: Value =
                                            serde_json::from_str(&inner.content).unwrap();
                                        let target =
                                            &request["params"]["arguments"]["targetPubkeys"][0];
                                        let payload = json!({"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":json!({"targetPubkey":target,"components":{"validators":{"video_creator_activity":{"score":0.8}}}}).to_string()}]}});
                                        let inner_response = EventBuilder::new(
                                            Kind::Custom(25910),
                                            payload.to_string(),
                                        )
                                        .tags([Tag::public_key(inner.pubkey), Tag::event(inner.id)])
                                        .finalize(&server)
                                        .unwrap();
                                        let ephemeral = Keys::generate();
                                        let encrypted = nip44::encrypt(
                                            ephemeral.secret_key(),
                                            &inner.pubkey,
                                            inner_response.as_json(),
                                            nip44::Version::V2,
                                        )
                                        .unwrap();
                                        let wrapped =
                                            EventBuilder::new(Kind::Custom(1059), encrypted)
                                                .tags([Tag::public_key(inner.pubkey)])
                                                .finalize(&ephemeral)
                                                .unwrap();
                                        let _ = ws
                                            .send(Message::Text(
                                                json!([
                                                    "EVENT",
                                                    subscription,
                                                    serde_json::to_value(wrapped).unwrap()
                                                ])
                                                .to_string()
                                                .into(),
                                            ))
                                            .await;
                                    }
                                }
                                _ => {}
                            }
                        }
                    });
                }
            }
        });
        let a = vec!["a".to_owned(), "b".to_owned()];
        let b = vec!["c".to_owned(), "d".to_owned()];
        let (one, two) = tokio::join!(
            fetch_trust_scores_at(&a, &url, public),
            fetch_trust_scores_at(&b, &url, public)
        );
        assert!(one.is_empty() && two.is_empty());
        assert_eq!(count.load(Ordering::SeqCst), 2);
        assert!(
            fetch_trust_scores_at(&["e".into()], &url, public)
                .await
                .is_empty()
        );
        assert_eq!(count.load(Ordering::SeqCst), 2);
        tokio::time::sleep(Duration::from_millis(450)).await;
        respond.store(true, Ordering::SeqCst);
        assert_eq!(
            fetch_trust_scores_at(&["a".into()], &url, public)
                .await
                .get("a"),
            Some(&0.8)
        );
        assert_eq!(count.load(Ordering::SeqCst), 3);
        task.abort();
        COOLDOWN.store(0, Ordering::Relaxed);
    }

    #[test]
    fn request_frame_is_mcp_tool_call() {
        assert_eq!(
            request_frame(7, &["abc".into()]),
            json!({"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"calculate_trust_scores","arguments":{"targetPubkeys":["abc"]}}})
        );
    }
    #[test]
    fn scores_ignore_personalized_validators() {
        let item = json!({"components":{"validators":{"x:video_creator_activity":{"score":0.2},"video_viewer_engagement":{"score":0.8},"other":{"score":1.0}}}});
        assert_eq!(global_score(&item), Some(0.5));
        assert_eq!(global_score(&json!({})), None);
    }
    #[test]
    fn timeout_or_failure_threshold_starts_cooldown() {
        assert!(should_cooldown(true, 1, 2));
        assert!(!should_cooldown(false, 1, 2));
        assert!(should_cooldown(false, 2, 2));
    }
}
