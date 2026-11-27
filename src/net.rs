use crate::util::{env_u64, quote};
use anyhow::{Context, Result, bail};
use futures_util::{SinkExt, StreamExt};
use nostr_sdk::prelude::*;
use reqwest::Method;
use serde_json::{Value, json};
use std::time::{Duration, Instant};

#[derive(Clone)]
pub struct Meili {
    pub http: reqwest::Client,
    pub url: String,
    pub key: String,
}
impl Meili {
    pub fn new(url: String, key: String) -> Self {
        Self {
            http: reqwest::Client::builder()
                .timeout(Duration::from_millis(env_u64(
                    "MEILI_TASK_TIMEOUT_MS",
                    120_000,
                )))
                .build()
                .expect("TLS client initialization"),
            url: url.trim_end_matches('/').to_owned(),
            key,
        }
    }
    pub fn from_env() -> Result<Self> {
        Ok(Self::new(
            std::env::var("MEILI_URL").context("Missing MEILI_URL environment variable")?,
            std::env::var("MEILI_MASTER_KEY")
                .context("Missing MEILI_MASTER_KEY environment variable")?,
        ))
    }
    pub async fn request(&self, method: Method, path: &str, body: Option<&Value>) -> Result<Value> {
        let mut request = self
            .http
            .request(method, format!("{}{}", self.url, path))
            .bearer_auth(&self.key);
        if let Some(body) = body {
            request = request.json(body);
        }
        let response = request.send().await?;
        let status = response.status();
        let text = response.text().await?;
        if !status.is_success() {
            bail!(
                "MeiliSearch request failed with status {}: {}",
                status.as_u16(),
                text
            );
        }
        if text.is_empty() {
            return Ok(Value::Null);
        }
        Ok(serde_json::from_str(&text)?)
    }
    pub async fn search(&self, index: &str, body: &Value) -> Result<Value> {
        self.request(
            Method::POST,
            &format!("/indexes/{index}/search"),
            Some(body),
        )
        .await
    }
    pub async fn wait(&self, task: &Value) -> Result<Value> {
        let uid = task
            .get("taskUid")
            .or_else(|| task.get("uid"))
            .and_then(Value::as_u64)
            .context("Missing Meili task UID")?;
        let started = Instant::now();
        let deadline = Duration::from_millis(env_u64("MEILI_TASK_TIMEOUT_MS", 120_000));
        loop {
            let task = self
                .request(Method::GET, &format!("/tasks/{uid}"), None)
                .await?;
            match task["status"].as_str() {
                Some("succeeded") => return Ok(task),
                Some("failed" | "canceled") => {
                    bail!("MeiliSearch task {uid} failed: {}", task["error"])
                }
                _ => {}
            }
            if started.elapsed() >= deadline {
                bail!("MeiliSearch task {uid} timed out");
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }
    pub async fn upsert(&self, index: &str, docs: &[Value]) -> Result<Value> {
        self.request(
            Method::POST,
            &format!("/indexes/{index}/documents"),
            Some(&json!(docs)),
        )
        .await
    }
    pub async fn ensure_index(&self, uid: &str, primary_key: &str, settings: &Value) -> Result<()> {
        let response = self
            .http
            .get(format!("{}/indexes/{uid}", self.url))
            .bearer_auth(&self.key)
            .send()
            .await?;
        if response.status() == reqwest::StatusCode::NOT_FOUND {
            let task = self
                .request(
                    Method::POST,
                    "/indexes",
                    Some(&json!({"uid":uid,"primaryKey":primary_key})),
                )
                .await?;
            self.wait(&task).await?;
        } else {
            response.error_for_status()?;
        }
        let task = self
            .request(
                Method::PATCH,
                &format!("/indexes/{uid}/settings"),
                Some(settings),
            )
            .await?;
        self.wait(&task).await?;
        Ok(())
    }
    pub async fn delete_index(&self, uid: &str) -> Result<()> {
        let response = self
            .http
            .delete(format!("{}/indexes/{uid}", self.url))
            .bearer_auth(&self.key)
            .send()
            .await?;
        if response.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(());
        }
        let response = response.error_for_status()?;
        self.wait(&response.json().await?).await?;
        Ok(())
    }
}
pub async fn video_search(meili: &Meili, mut body: Value) -> Result<Value> {
    let mut filters = body
        .get("filter")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    filters.extend(
        crate::domain::blocked_author_pubkeys()
            .iter()
            .map(|key| json!(format!("pubkey != {}", quote(key)))),
    );
    if !filters.is_empty() {
        body["filter"] = Value::Array(filters);
    }
    meili.search("videos", &body).await
}
pub async fn fetch_events(relays: &[String], filter: Value, timeout_ms: u64) -> Result<Vec<Value>> {
    if relays.is_empty() {
        return Ok(Vec::new());
    }
    let client = Client::default();
    for relay in relays {
        client.add_relay(relay).await?;
    }
    client.connect().await;
    let parsed = Filter::from_json(filter.to_string())?;
    let max = filter["limit"]
        .as_u64()
        .map(|v| (v as usize).saturating_mul(relays.len()))
        .unwrap_or(100_000);
    let result = client
        .fetch_events(parsed)
        .timeout(Duration::from_millis(timeout_ms))
        .max_events(max)
        .await;
    client.disconnect().await;
    let events = result?;
    events
        .into_iter()
        .map(|event| Ok(serde_json::to_value(event)?))
        .collect()
}

/// Cursor metadata must include invalid events: filtering a full wire page
/// before calculating its size would incorrectly terminate pagination.
#[derive(Default)]
pub struct RelayPage {
    pub events: Vec<Value>,
    pub raw_count: usize,
    pub oldest: Option<u64>,
}
pub async fn fetch_raw_page(relay: &str, filter: Value, timeout_ms: u64) -> Result<RelayPage> {
    use tokio_tungstenite::tungstenite::Message;
    let deadline = tokio::time::Instant::now() + Duration::from_millis(timeout_ms);
    let (mut socket, _) =
        tokio::time::timeout_at(deadline, tokio_tungstenite::connect_async(relay)).await??;
    let subscription = "nostube-page";
    socket
        .send(Message::Text(
            json!(["REQ", subscription, filter]).to_string().into(),
        ))
        .await?;
    let parsed = Filter::from_json(filter.to_string())?;
    let mut page = RelayPage::default();
    loop {
        let frame = match tokio::time::timeout_at(deadline, socket.next()).await {
            Ok(Some(Ok(frame))) => frame,
            Ok(Some(Err(error))) => return Err(error.into()),
            Ok(None) | Err(_) => break,
        };
        let Message::Text(text) = frame else { continue };
        let Ok(mut message) = serde_json::from_str::<Value>(&text) else {
            continue;
        };
        if message[1] != subscription {
            continue;
        }
        match message[0].as_str() {
            Some("EOSE") => break,
            Some("CLOSED") => bail!("Relay closed subscription: {}", message[2]),
            Some("EVENT") => {
                let value = message[2].take();
                page.raw_count += 1;
                if let Some(timestamp) = value["created_at"].as_u64() {
                    page.oldest = Some(page.oldest.map_or(timestamp, |old| old.min(timestamp)));
                }
                if let Ok(event) = <Event as serde::Deserialize>::deserialize(&value) {
                    if parsed.match_event(&event, Default::default()) && event.verify().is_ok() {
                        page.events.push(value);
                    }
                }
            }
            _ => {}
        }
    }
    let _ = socket.close(None).await;
    Ok(page)
}
