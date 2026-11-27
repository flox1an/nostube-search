// Integration tests assert by panicking; `unwrap` is the intended failure mode here.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use futures_util::{SinkExt, StreamExt};
use nostr_sdk::prelude::*;
use nostube_search::net::{Meili, fetch_events, fetch_raw_page};
use serde_json::{Value, json};
use tokio_tungstenite::tungstenite::Message;

async fn relay(events: Vec<Value>) -> (String, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("ws://{}", listener.local_addr().unwrap());
    let task = tokio::spawn(async move {
        let (socket, _) = listener.accept().await.unwrap();
        let mut socket = tokio_tungstenite::accept_async(socket).await.unwrap();
        while let Some(Ok(message)) = socket.next().await {
            let Message::Text(text) = message else {
                continue;
            };
            let request: Value = serde_json::from_str(&text).unwrap();
            if request[0] != "REQ" {
                continue;
            }
            for event in &events {
                socket
                    .send(Message::Text(
                        json!(["EVENT", request[1], event]).to_string().into(),
                    ))
                    .await
                    .unwrap();
            }
            socket
                .send(Message::Text(
                    json!(["EOSE", request[1]]).to_string().into(),
                ))
                .await
                .unwrap();
        }
    });
    (url, task)
}
fn signed(keys: &Keys, at: u64) -> Value {
    let event = EventBuilder::new(Kind::Metadata, "{\"name\":\"Alice\"}")
        .custom_created_at(Timestamp::from(at))
        .finalize(keys)
        .unwrap();
    serde_json::to_value(event).unwrap()
}
#[tokio::test]
async fn profile_versions_from_two_relays_do_not_exceed_a_per_relay_limit() {
    let keys = Keys::generate();
    let (a, ta) = relay(vec![signed(&keys, 1)]).await;
    let (b, tb) = relay(vec![signed(&keys, 2)]).await;
    let events = fetch_events(
        &[a, b],
        json!({"authors":[keys.public_key().to_hex()],"kinds":[0],"limit":1}),
        2_000,
    )
    .await
    .unwrap();
    assert_eq!(events.len(), 2);
    assert_eq!(
        events.iter().filter_map(|v| v["created_at"].as_u64()).max(),
        Some(2)
    );
    ta.abort();
    tb.abort();
}
#[tokio::test]
async fn raw_cursor_keeps_invalid_events_but_does_not_index_them() {
    let keys = Keys::generate();
    let good = signed(&keys, 100);
    let mut bad = signed(&keys, 90);
    bad["content"] = json!("forged");
    let (url, task) = relay(vec![good, bad]).await;
    let page = fetch_raw_page(&url, json!({"kinds":[0],"limit":2}), 2_000)
        .await
        .unwrap();
    assert_eq!(page.raw_count, 2);
    assert_eq!(page.oldest, Some(90));
    assert_eq!(page.events.len(), 1);
    assert_eq!(page.events[0]["created_at"], 100);
    task.abort();
}
#[tokio::test]
async fn upstream_outage_does_not_create_or_delete_existing_indexes() {
    use axum::{Router, extract::Request, http::StatusCode, routing::any};
    let calls = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let observed = calls.clone();
    let app = Router::new().fallback(any(move |request: Request| {
        let observed = observed.clone();
        async move {
            observed.lock().unwrap().push(request.method().clone());
            (StatusCode::SERVICE_UNAVAILABLE, "temporarily offline")
        }
    }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let meili = Meili::new(url, "test".into());
    assert!(
        meili
            .ensure_index("videos", "id", &json!({}))
            .await
            .is_err()
    );
    assert_eq!(*calls.lock().unwrap(), vec![reqwest::Method::GET]);
    task.abort();
}
