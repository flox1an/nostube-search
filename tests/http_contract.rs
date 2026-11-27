// Integration tests assert by panicking; `unwrap` is the intended failure mode here.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use axum::{
    Router,
    body::Body,
    extract::{Request, State},
    http::{Method, StatusCode},
    response::IntoResponse,
    routing::any,
};
use nostube_search::{net::Meili, server::router};
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};
use tower::ServiceExt;

#[derive(Clone)]
struct Upstream {
    calls: Arc<Mutex<Vec<(String, Value)>>>,
    hits: Value,
    fail: Arc<Mutex<usize>>,
}
struct Harness {
    app: Router,
    upstream: Upstream,
    task: tokio::task::JoinHandle<()>,
}
impl Drop for Harness {
    fn drop(&mut self) {
        self.task.abort();
    }
}
impl Harness {
    async fn new(hits: Value) -> Self {
        let upstream = Upstream {
            calls: Default::default(),
            hits,
            fail: Default::default(),
        };
        let fake = Router::new()
            .fallback(any(fake_meili))
            .with_state(upstream.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let task = tokio::spawn(async move {
            axum::serve(listener, fake).await.unwrap();
        });
        Self {
            app: router(Meili::new(url, "test".into())),
            upstream,
            task,
        }
    }
    async fn request(
        &self,
        method: Method,
        path: &str,
        body: &str,
    ) -> (StatusCode, axum::http::HeaderMap, Value) {
        let response = self
            .app
            .clone()
            .oneshot(
                axum::http::Request::builder()
                    .method(method)
                    .uri(path)
                    .header("content-type", "application/json")
                    .body(Body::from(body.to_owned()))
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = response.status();
        let headers = response.headers().clone();
        let bytes = axum::body::to_bytes(response.into_body(), 2_000_000)
            .await
            .unwrap();
        let value = serde_json::from_slice(&bytes)
            .unwrap_or_else(|_| json!(String::from_utf8_lossy(&bytes)));
        (status, headers, value)
    }
    async fn get(&self, path: &str) -> (StatusCode, axum::http::HeaderMap, Value) {
        self.request(Method::GET, path, "").await
    }
    fn calls(&self) -> Vec<(String, Value)> {
        self.upstream.calls.lock().unwrap().clone()
    }
}
async fn fake_meili(State(state): State<Upstream>, request: Request) -> axum::response::Response {
    let path = request.uri().path().to_owned();
    let bytes = axum::body::to_bytes(request.into_body(), 2_000_000)
        .await
        .unwrap();
    let body: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    state
        .calls
        .lock()
        .unwrap()
        .push((path.clone(), body.clone()));
    {
        let mut fail = state.fail.lock().unwrap();
        if *fail > 0 {
            *fail -= 1;
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                axum::Json(json!({"error":"offline"})),
            )
                .into_response();
        }
    }
    if path == "/health" {
        return axum::Json(json!({"status":"available"})).into_response();
    }
    let mut hits = state.hits.as_array().cloned().unwrap_or_default();
    if let Some(attrs) = body["attributesToRetrieve"].as_array() {
        for hit in &mut hits {
            if let Some(obj) = hit.as_object_mut() {
                obj.retain(|key, _| attrs.iter().any(|v| v.as_str() == Some(key)));
            }
        }
    }
    axum::Json(json!({"hits":hits,"estimatedTotalHits":42})).into_response()
}
fn video() -> Value {
    json!({"event_id":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","pubkey":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","kind":34235,"d_tag":"hello","title":"Nostr Video","summary":"Summary","content_preview":"Preview","created_at":1700000000,"published_at":1699999999,"rankingScore":0.9,"thumbnail":"https://img.example/video.jpg","videoUrl":"https://media.example/video.mp4","mimeType":"video/mp4","mediaType":"video","dimensions":"1920x1080","tags":["nostr"],"textTracks":[{"url":"https://media.example/en.vtt","lang":"en"}],"contentWarning":null,"availabilityStatus":"available","raw_event":{"content":"unused"},"content":"large text not needed"})
}

#[tokio::test]
async fn health_and_liveness_have_distinct_upstream_contracts() {
    let h = Harness::new(json!([])).await;
    assert_eq!(h.get("/healthz").await.2, json!({"ok":true}));
    assert!(h.calls().is_empty());
    assert_eq!(h.get("/health").await.2, json!({"ok":true}));
    *h.upstream.fail.lock().unwrap() = 1;
    let (status, _, body) = h.get("/health").await;
    assert_eq!(status, 502);
    assert_eq!(body, json!({"ok":false}));
}
#[tokio::test]
async fn root_returns_not_found() {
    let h = Harness::new(json!([])).await;
    let (status, _, _) = h.get("/").await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert!(h.calls().is_empty());
}
#[tokio::test]
async fn query_validation_does_not_query_meili() {
    let h = Harness::new(json!([])).await;
    for (path, body) in [
        ("/api/search", json!({"error":"Missing query parameter q"})),
        (
            "/api/tags?t=%20",
            json!({"error":"Missing query parameter t"}),
        ),
        ("/api/people", json!({"error":"Missing query parameter q"})),
        (
            "/api/search?q=a&presetPubkey=npub123",
            json!({"code":"preset_required"}),
        ),
    ] {
        let (s, _, v) = h.get(path).await;
        assert_eq!(s, 400);
        assert_eq!(v, body);
    }
    assert!(h.calls().is_empty());
}
#[tokio::test]
async fn invalid_nsfw_mode_fails_closed() {
    let h = Harness::new(json!([])).await;
    let (s, _, v) = h.get("/api/search?q=a&nsfwFilter=bad").await;
    assert_eq!(s, 400);
    assert_eq!(
        v["error"],
        "Invalid nsfwFilter: expected hide|warning|show, got \"bad\""
    );
    assert!(h.calls().is_empty());
}
#[tokio::test]
async fn search_keeps_client_shape_and_limits_retrieval() {
    let h = Harness::new(json!([video()])).await;
    let (s, headers, b) = h
        .get("/api/search?q=nostr&limit=900&offset=2000&sort=newest")
        .await;
    assert_eq!(s, 200);
    assert_eq!(b["limit"], 100);
    assert_eq!(b["offset"], 1000);
    assert_eq!(b["total"], 42);
    assert_eq!(b["hits"][0]["content_preview"], "Preview");
    assert!(
        b["hits"][0]["nostrUrl"]
            .as_str()
            .unwrap()
            .starts_with("https://nostu.be/v/naddr1")
    );
    assert!(b["hits"][0].get("raw_event").is_none());
    assert!(b["hits"][0].get("content").is_none());
    assert_eq!(b["hits"][0]["textTracks"], video()["textTracks"]);
    assert_eq!(
        headers["cache-control"],
        "public, max-age=60, stale-while-revalidate=300"
    );
    let calls = h.calls();
    assert_eq!(calls[0].1["sort"], json!(["effectivePublishedAt:desc"]));
    assert!(
        !calls[0].1["attributesToRetrieve"]
            .as_array()
            .unwrap()
            .contains(&json!("raw_event"))
    );
    assert!(
        calls[0].1["filter"]
            .as_array()
            .unwrap()
            .iter()
            .any(|v| v.as_str().unwrap().contains("contentWarning"))
    );
}
#[tokio::test]
async fn search_filters_accept_repeated_lists_without_filter_injection() {
    let h = Harness::new(json!([])).await;
    h.get("/api/search?q=n&type=shorts&duration=medium&available=true&kinds=21,22&kinds=34235&feature=hd,captions&feature=nostr&language=DE,en&captionLanguage=pt_BR&language=bad%22OR%20true").await;
    let calls = h.calls();
    let filters = calls[0].1["filter"].as_array().unwrap();
    for expected in [
        "isShort = true",
        "duration >= 180 AND duration <= 1200",
        "hasPlayableMedia = true",
        "(kind = 21 OR kind = 22 OR kind = 34235)",
        "(language = \"de\" OR language = \"en\")",
        "captionLanguages = \"pt-br\"",
        "isHd = true",
        "hasCaptions = true",
        "isNostrNative = true",
    ] {
        assert!(
            filters.contains(&json!(expected)),
            "missing {expected}: {filters:?}"
        );
    }
}
#[tokio::test]
async fn show_mode_and_invalid_sort_preserve_relevance() {
    let h = Harness::new(json!([])).await;
    h.get("/api/search?q=n&nsfwFilter=show&sort=popularity")
        .await;
    let c = h.calls();
    assert!(c[0].1.get("sort").is_none());
    assert!(!c[0].1["filter"].to_string().contains("contentWarning"));
}
#[tokio::test]
async fn tags_normalize_case_and_return_search_shape() {
    let h = Harness::new(json!([video()])).await;
    let (s, _, b) = h.get("/api/tags?t=NoStR").await;
    assert_eq!(s, 200);
    assert_eq!(b["limit"], 50);
    assert_eq!(b["hits"][0]["title"], "Nostr Video");
    assert!(
        h.calls()[0].1["filter"]
            .as_array()
            .unwrap()
            .contains(&json!("tags = \"nostr\""))
    );
}
#[tokio::test]
async fn people_search_preserves_fields_and_sort() {
    let h =
        Harness::new(json!([{"pubkey":"aa","display_name":"Alice","videoCount":7,"updatedAt":42}]))
            .await;
    let (s, _, b) = h.get("/api/people?q=alice").await;
    assert_eq!(s, 200);
    assert_eq!(b["hits"][0]["display_name"], "Alice");
    assert!(b["hits"][0].get("updatedAt").is_none());
    assert_eq!(h.calls()[0].1["sort"], json!(["videoCount:desc"]));
}
#[tokio::test]
async fn suggestion_deduplication_availability_and_five_item_limit() {
    let h=Harness::new(json!([{"title":" A "},{"title":"A"},{"title":"Broken","availabilityStatus":"unavailable"},{"title":""},{"title":"B"},{"title":"C"},{"title":"D"},{"title":"E"},{"title":"F"}])).await;
    let (s, _, b) = h.get("/api/search/suggest?q=n").await;
    assert_eq!(s, 200);
    assert_eq!(b, json!({"suggestions":["A","B","C","D","E"]}));
    assert_eq!(
        h.calls()[0].1["attributesToRetrieve"],
        json!(["title", "availabilityStatus"])
    );
}
#[tokio::test]
async fn suggestions_cache_by_safety_mode_and_share_concurrent_misses() {
    let h = Harness::new(json!([video()])).await;
    let (a, b) = tokio::join!(
        h.get("/api/search/suggest?q=n"),
        h.get("/api/search/suggest?q=n")
    );
    assert_eq!(a.2, b.2);
    assert_eq!(h.calls().len(), 1);
    h.get("/api/search/suggest?q=n&nsfwFilter=show").await;
    assert_eq!(h.calls().len(), 2);
}
#[tokio::test]
async fn completions_normalize_prefix_and_cache_results() {
    let h = Harness::new(json!([{"word":"nostr"},{"word":"nostube"}])).await;
    let (s, _, b) = h.get("/api/search/completion?prefix=%20NO%20").await;
    assert_eq!(s, 200);
    assert_eq!(b, json!({"completions":["nostr","nostube"]}));
    h.get("/api/search/completion?prefix=no").await;
    let c = h.calls();
    assert_eq!(c.len(), 1);
    assert_eq!(c[0].1["q"], "no");
    assert_eq!(c[0].1["attributesToRetrieve"], json!(["word"]));
}
#[tokio::test]
async fn empty_autocomplete_requests_are_local() {
    let h = Harness::new(json!([])).await;
    assert_eq!(
        h.get("/api/search/completion").await.2,
        json!({"completions":[]})
    );
    assert_eq!(
        h.get("/api/search/suggest?q=%20").await.2,
        json!({"suggestions":[]})
    );
    assert!(h.calls().is_empty());
}
#[tokio::test]
async fn failed_completion_is_not_cached() {
    let h = Harness::new(json!([{"word":"nostr"}])).await;
    *h.upstream.fail.lock().unwrap() = 1;
    assert_eq!(h.get("/api/search/completion?prefix=n").await.0, 502);
    assert_eq!(
        h.get("/api/search/completion?prefix=n").await.2,
        json!({"completions":["nostr"]})
    );
    assert_eq!(h.calls().len(), 2);
}
#[tokio::test]
async fn search_upstream_failure_is_not_reported_as_an_empty_success() {
    let h = Harness::new(json!([])).await;
    *h.upstream.fail.lock().unwrap() = 1;
    let (s, _, b) = h.get("/api/search?q=n").await;
    assert_eq!(s, 502);
    assert_eq!(b, json!({"error":"Search engine unavailable"}));
}
#[tokio::test]
async fn recommendation_input_validation_preserves_error_shapes() {
    let h = Harness::new(json!([])).await;
    for (body, expected) in [
        ("{", json!({"error":"Invalid JSON body"})),
        ("{}", json!({"error":"Missing videoRef"})),
        ("{\"videoRef\":7}", json!({"error":"Missing videoRef"})),
    ] {
        let (s, _, b) = h
            .request(Method::POST, "/api/recommendations/related", body)
            .await;
        assert_eq!(s, 400);
        assert_eq!(b, expected);
    }
    assert!(h.calls().is_empty());
}
#[tokio::test]
async fn recommendation_request_body_limit_is_enforced() {
    let h = Harness::new(json!([])).await;
    let body = json!({"videoRef":"x".repeat(17*1024)}).to_string();
    let (s, _, b) = h
        .request(Method::POST, "/api/recommendations/related", &body)
        .await;
    assert_eq!(s, 413);
    assert_eq!(b, json!({"error":"Request body too large"}));
    assert!(h.calls().is_empty());
}
#[tokio::test]
async fn unresolved_recommendation_is_not_an_empty_success() {
    let h = Harness::new(json!([])).await;
    let body = json!({"videoRef":"aa".repeat(32)}).to_string();
    let (s, _, b) = h
        .request(Method::POST, "/api/recommendations/related", &body)
        .await;
    assert_eq!(s, 404);
    assert_eq!(b, json!({"error":"Video not found"}));
}
#[tokio::test]
async fn clients_can_negotiate_compressed_search_responses() {
    let h = Harness::new(json!([video()])).await;
    let r = h
        .app
        .clone()
        .oneshot(
            axum::http::Request::builder()
                .uri("/api/search?q=n")
                .header("accept-encoding", "gzip")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(r.status(), 200);
    assert_eq!(r.headers()["content-encoding"], "gzip");
    let bytes = axum::body::to_bytes(r.into_body(), 1_000_000)
        .await
        .unwrap();
    let mut decoder = flate2::read::GzDecoder::new(bytes.as_ref());
    let mut decoded = String::new();
    std::io::Read::read_to_string(&mut decoder, &mut decoded).unwrap();
    let v: Value = serde_json::from_str(&decoded).unwrap();
    assert_eq!(v["hits"][0]["title"], "Nostr Video");
}

#[tokio::test]
async fn unicode_tag_expansion_stays_within_normalized_query_limit() {
    let h = Harness::new(json!([])).await;
    let tag = "İ".repeat(256);
    let path = format!(
        "/api/tags?t={}",
        url::form_urlencoded::byte_serialize(tag.as_bytes()).collect::<String>()
    );
    assert_eq!(h.get(&path).await.0, 200);
    let calls = h.calls();
    let filter = calls[0].1["filter"][0].as_str().unwrap();
    assert_eq!(filter, format!("tags = \"{}\"", "i\u{307}".repeat(128)));
}
#[tokio::test]
async fn rate_limit_is_shared_across_api_routes_and_returns_retry_headers() {
    let h = Harness::new(json!([])).await;
    for index in 0..300 {
        let path = if index % 2 == 0 {
            "/api/search"
        } else {
            "/api/people"
        };
        let (status, headers, _) = h.get(path).await;
        assert_eq!(status, 400);
        if index == 0 {
            assert_eq!(headers["ratelimit-limit"], "300");
            assert_eq!(headers["ratelimit-remaining"], "299");
        }
    }
    let (status, headers, body) = h.get("/api/search").await;
    assert_eq!(status, 429);
    assert_eq!(body, json!({"error":"Too many requests"}));
    assert!(
        headers["retry-after"]
            .to_str()
            .unwrap()
            .parse::<u64>()
            .unwrap()
            > 0
    );
    assert!(!headers.contains_key("cache-control"));
    assert!(h.calls().is_empty());
}
