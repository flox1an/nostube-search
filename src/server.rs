use crate::{
    cache::AsyncCache,
    domain,
    net::{Meili, video_search},
    rate_limit::{self, RateDecision, RateLimiter},
    recommendations::RecommendationService,
    safety::{self, PresetStore, SafetyInput},
    util::{env_bool, env_nonnegative, nonnegative, now_secs, quote, truncate},
};
use axum::{
    Json, Router,
    body::{Body, to_bytes},
    extract::{ConnectInfo, OriginalUri, RawQuery, Request, State},
    http::{HeaderValue, Method, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde_json::{Value, json};
use std::{collections::HashMap, net::SocketAddr, sync::Arc};
use tower_http::{
    compression::CompressionLayer,
    cors::{Any, CorsLayer},
};

const HIT_ATTRIBUTES: &[&str] = &[
    "event_id",
    "title",
    "content_preview",
    "summary",
    "pubkey",
    "kind",
    "created_at",
    "published_at",
    "rankingScore",
    "thumbnail",
    "videoUrl",
    "d_tag",
    "tags",
    "mimeType",
    "mediaType",
    "dimensions",
    "textTracks",
    "contentWarning",
];
struct AppState {
    meili: Meili,
    presets: PresetStore,
    suggestions: AsyncCache,
    completions: AsyncCache,
    sitemap: AsyncCache,
    limiter: RateLimiter,
    recommendations: RecommendationService,
}

pub fn router(meili: Meili) -> Router {
    let state = Arc::new(AppState {
        recommendations: RecommendationService::new(meili.clone()),
        meili,
        presets: PresetStore::default(),
        suggestions: AsyncCache::new(1_000),
        completions: AsyncCache::new(2_000),
        sitemap: AsyncCache::new(1),
        limiter: RateLimiter::default(),
    });
    let mut api = Router::new()
        .route("/api/search", get(data))
        .route("/api/tags", get(data))
        .route("/api/people", get(data))
        .route("/api/search/suggest", get(data))
        .route("/api/search/completion", get(data))
        .route("/api/recommendations/related", post(related))
        .layer(middleware::from_fn_with_state(
            state.clone(),
            public_middleware,
        ));
    let origin = std::env::var("CORS_ORIGIN")
        .unwrap_or_default()
        .trim_matches(['\'', '"'])
        .to_owned();
    if !origin.is_empty() {
        let cors = if origin == "*" {
            CorsLayer::new().allow_origin(Any)
        } else {
            CorsLayer::new()
                .allow_origin(origin.parse::<HeaderValue>().expect("Invalid CORS_ORIGIN"))
        };
        api = api.layer(
            cors.allow_methods([
                Method::GET,
                Method::HEAD,
                Method::PUT,
                Method::POST,
                Method::DELETE,
                Method::PATCH,
            ])
            .allow_headers(Any),
        );
    }
    Router::new()
        .route("/", get(ui))
        .route("/health", get(health))
        .route("/healthz", get(|| async { Json(json!({"ok":true})) }))
        .route("/sitemap.xml", get(sitemap))
        .layer(middleware::from_fn_with_state(
            state.clone(),
            public_middleware,
        ))
        .merge(api)
        .with_state(state)
        .layer(CompressionLayer::new())
}
fn json_response(status: u16, value: Value) -> Response {
    (StatusCode::from_u16(status).unwrap(), Json(value)).into_response()
}
fn rate_headers(response: &mut Response, decision: &RateDecision) {
    for (key, value) in [
        ("ratelimit-limit", decision.limit),
        ("ratelimit-remaining", decision.remaining),
        ("ratelimit-reset", decision.reset_seconds),
    ] {
        response
            .headers_mut()
            .insert(key, HeaderValue::from_str(&value.to_string()).unwrap());
    }
    if !decision.allowed {
        response.headers_mut().insert(
            "retry-after",
            HeaderValue::from_str(&decision.retry_after.to_string()).unwrap(),
        );
    }
}
async fn public_middleware(
    State(state): State<Arc<AppState>>,
    request: Request,
    next: Next,
) -> Response {
    let path = request.uri().path();
    let method = request.method().to_string();
    let is_api = path.starts_with("/api/");
    let is_get = request.method() == Method::GET;
    let mut decision = None;
    if std::env::var("RATE_LIMIT_ENABLED").ok().as_deref() != Some("false") {
        let peer = request
            .extensions()
            .get::<ConnectInfo<SocketAddr>>()
            .map(|p| p.0.ip());
        let client = rate_limit::client_key(request.headers(), peer, env_bool("TRUST_PROXY"));
        let mut rules = Vec::new();
        if is_api {
            rules.push(("/api/*", "RATE_LIMIT_MAX", 300));
        }
        if path == "/sitemap.xml" {
            rules.push(("/sitemap.xml", "RATE_LIMIT_SITEMAP_MAX", 10));
        }
        if path == "/api/recommendations/related" && method == "POST" {
            rules.push((
                "/api/recommendations/related",
                "RATE_LIMIT_RECOMMENDATIONS_MAX",
                20,
            ));
        }
        for (route, var, default) in rules {
            let max = crate::util::rate_env(var, default);
            if max == 0 {
                continue;
            }
            let d = state.limiter.check(
                &client,
                &format!("{method}|{route}"),
                max,
                crate::util::rate_env("RATE_LIMIT_WINDOW_MS", 60_000),
            );
            if !d.allowed {
                let mut r = json_response(429, json!({"error":"Too many requests"}));
                rate_headers(&mut r, &d);
                return r;
            }
            decision = Some(d);
        }
    }
    let mut response = next.run(request).await;
    if let Some(d) = decision {
        rate_headers(&mut response, &d);
    }
    if is_api
        && is_get
        && response.status() == StatusCode::OK
        && !response.headers().contains_key("cache-control")
    {
        let value = format!(
            "public, max-age={}, stale-while-revalidate={}",
            env_nonnegative("API_CACHE_MAX_AGE_S", 60),
            env_nonnegative("API_CACHE_SWR_S", 300)
        );
        response
            .headers_mut()
            .insert("cache-control", HeaderValue::from_str(&value).unwrap());
    }
    response
}
#[derive(Default)]
struct Params(HashMap<String, Vec<String>>);
impl Params {
    fn parse(raw: Option<String>) -> Self {
        let mut out = Self::default();
        for (k, v) in url::form_urlencoded::parse(raw.as_deref().unwrap_or("").as_bytes()) {
            out.0
                .entry(k.into_owned())
                .or_default()
                .push(v.into_owned());
        }
        out
    }
    fn first(&self, key: &str) -> Option<&str> {
        self.0.get(key).and_then(|v| v.first()).map(String::as_str)
    }
    fn list(&self, key: &str) -> Vec<String> {
        self.0.get(key).cloned().unwrap_or_default()
    }
    fn text(&self, key: &str) -> String {
        truncate(self.first(key).unwrap_or("").trim(), 256)
    }
}
async fn policy(
    state: &AppState,
    preset: &str,
    nsfw: &str,
) -> Result<(SafetyInput, Value), Response> {
    let safety =
        safety::resolve_safety_input(preset, nsfw).map_err(|(s, v)| json_response(s, v))?;
    let policy = match &safety.preset_pubkey {
        Some(pk) => state.presets.get_preset(pk).await,
        None => Some(safety::default_policy()),
    }
    .ok_or_else(|| json_response(503, json!({"code":"preset_unavailable"})))?;
    Ok((safety, policy))
}
fn preset_filters(safety: &SafetyInput, policy: &Value) -> Vec<String> {
    let mut filters = safety::default_filters(&safety.nsfw_filter);
    if safety.preset_pubkey.is_some() {
        filters.extend(safety::build_preset_filters(policy, &safety.nsfw_filter));
    }
    filters
}
fn group_filters(values: impl Iterator<Item = String>) -> Option<String> {
    let values: Vec<_> = values.collect();
    match values.len() {
        0 => None,
        1 => values.into_iter().next(),
        _ => Some(format!("({})", values.join(" OR "))),
    }
}
fn language_filter(languages: &[String], field: &str) -> Option<String> {
    group_filters(
        domain::normalize_languages(languages)
            .into_iter()
            .filter(|s| s != "any")
            .map(|s| format!("{field} = {}", quote(&s))),
    )
}
fn search_filters(p: &Params) -> Vec<String> {
    let mut out = Vec::new();
    for (key, options) in [
        (
            "type",
            vec![
                ("videos", "isVideo = true"),
                ("shorts", "isShort = true"),
                ("audio", "mediaType = \"audio\""),
            ],
        ),
        (
            "duration",
            vec![
                ("short", "duration < 180"),
                ("medium", "duration >= 180 AND duration <= 1200"),
                ("long", "duration > 1200"),
            ],
        ),
    ] {
        if let Some((_, filter)) = options
            .iter()
            .find(|(value, _)| Some(*value) == p.first(key))
        {
            out.push((*filter).to_owned());
        }
    }
    let days = match p.first("date") {
        Some("today") => Some(1),
        Some("week") => Some(7),
        Some("month") => Some(30),
        Some("year") => Some(365),
        _ => None,
    };
    if let Some(days) = days {
        out.push(format!(
            "effectivePublishedAt >= {}",
            now_secs().saturating_sub(days * 86_400)
        ));
    }
    match p.first("available") {
        Some("true") => out.push("hasPlayableMedia = true".into()),
        Some("exclude-unavailable") => out.push("availabilityStatus != \"unavailable\"".into()),
        _ => {}
    }
    let mut kinds = Vec::new();
    for value in p.list("kinds") {
        for k in value.split(',') {
            if let Some(n) = crate::util::number(k)
                .filter(|n| n.fract() == 0.0 && [21.0, 22.0, 34235.0, 34236.0].contains(n))
            {
                let n = n as u64;
                if !kinds.contains(&n) {
                    kinds.push(n);
                }
            }
        }
    }
    if let Some(filter) = group_filters(kinds.into_iter().map(|n| format!("kind = {n}"))) {
        out.push(filter);
    }
    for (key, field) in [
        ("language", "language"),
        ("captionLanguage", "captionLanguages"),
    ] {
        if let Some(filter) = language_filter(&p.list(key), field) {
            out.push(filter);
        }
    }
    for value in p.list("feature") {
        for feature in value.split(',') {
            if let Some(filter) = match feature.trim() {
                "captions" => Some("hasCaptions = true"),
                "hd" => Some("isHd = true"),
                "nostr" => Some("isNostrNative = true"),
                _ => None,
            } {
                out.push(filter.into());
            }
        }
    }
    out
}
fn sort(input: Option<&str>) -> Option<String> {
    let input = input?;
    let value = match input {
        "relevance" => return None,
        "newest" => "effectivePublishedAt:desc",
        "oldest" => "effectivePublishedAt:asc",
        "duration" => "duration:desc",
        other => other,
    };
    let (field, dir) = value.split_once(':')?;
    ([
        "rankingScore",
        "created_at",
        "published_at",
        "effectivePublishedAt",
        "duration",
    ]
    .contains(&field)
        && ["asc", "desc"].contains(&dir))
    .then(|| value.to_owned())
}
fn annotate(hits: &mut [Value], policy: &Value, mode: &str) {
    if mode != "warning" {
        return;
    }
    for hit in hits {
        let key = hit["pubkey"].as_str().unwrap_or("").to_lowercase();
        if policy["nsfwPubkeys"]
            .as_array()
            .is_some_and(|keys| keys.iter().any(|k| k.as_str() == Some(&key)))
        {
            hit["contentWarning"] = json!("NSFW");
        }
    }
}
fn nullable(hit: &Value, key: &str) -> Value {
    hit.get(key).cloned().unwrap_or(Value::Null)
}
fn map_hit(hit: &Value) -> Value {
    let preview = ["content_preview", "summary", "content"]
        .iter()
        .find_map(|key| hit.get(*key).and_then(Value::as_str))
        .unwrap_or("");
    let mut out = json!({"event_id":hit["event_id"].as_str().unwrap_or(""),"title":hit["title"].as_str().unwrap_or("Untitled"),"content_preview":truncate(preview,200),"pubkey":hit["pubkey"].as_str().unwrap_or(""),"kind":hit["kind"].as_u64().unwrap_or(0),"created_at":hit["created_at"].as_u64().unwrap_or(0),"published_at":nullable(hit,"published_at"),"thumbnail":nullable(hit,"thumbnail"),"videoUrl":nullable(hit,"videoUrl"),"nostrUrl":domain::nostube_url(hit),"tags":hit.get("tags").filter(|v|v.is_array()).cloned().unwrap_or(json!([])),"mimeType":nullable(hit,"mimeType"),"mediaType":nullable(hit,"mediaType"),"dimensions":nullable(hit,"dimensions"),"contentWarning":nullable(hit,"contentWarning")});
    if hit["rankingScore"].is_number() {
        out["rankingScore"] = hit["rankingScore"].clone();
    }
    out["textTracks"] = json!(
        hit["textTracks"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|t| t["url"].as_str().is_some_and(|u| !u.is_empty()))
            .map(|t| json!({"url":t["url"],"lang":nullable(t,"lang")}))
            .collect::<Vec<_>>()
    );
    out
}
async fn data(
    State(state): State<Arc<AppState>>,
    OriginalUri(uri): OriginalUri,
    RawQuery(raw): RawQuery,
) -> Response {
    let params = Params::parse(raw);
    let path = uri.path();
    if path == "/api/search/completion" {
        let prefix = truncate(
            params
                .first("prefix")
                .unwrap_or("")
                .trim()
                .to_lowercase()
                .as_str(),
            256,
        );
        if prefix.is_empty() {
            return Json(json!({"completions":[]})).into_response();
        }
        let key = prefix.clone();
        let result = state
            .completions
            .get_or_try_insert(key, 300_000, || async {
                let result = state
                    .meili
                    .search(
                        "terms",
                        &json!({"q":prefix,"limit":10,"attributesToRetrieve":["word"]}),
                    )
                    .await?;
                Ok(json!(
                    result["hits"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .map(|v| nullable(v, "word"))
                        .collect::<Vec<_>>()
                ))
            })
            .await;
        return match result {
            Ok(values) => Json(json!({"completions":values})).into_response(),
            Err(_) => json_response(502, json!({"error":"Search engine unavailable"})),
        };
    }
    let (safety, policy) = match policy(
        &state,
        params.first("presetPubkey").unwrap_or(""),
        params.first("nsfwFilter").unwrap_or(""),
    )
    .await
    {
        Ok(p) => p,
        Err(r) => return r,
    };
    let is_tags = path == "/api/tags";
    let q = if is_tags {
        truncate(&params.first("t").unwrap_or("").trim().to_lowercase(), 256)
    } else {
        params.text("q")
    };
    if q.is_empty() {
        return if path == "/api/search/suggest" {
            Json(json!({"suggestions":[]})).into_response()
        } else {
            json_response(
                400,
                json!({"error":format!("Missing query parameter {}",if is_tags{"t"}else{"q"})}),
            )
        };
    }
    let safety_filters = preset_filters(&safety, &policy);
    if path == "/api/search/suggest" {
        let key = format!(
            "{}|{}|{}",
            safety.nsfw_filter,
            safety.preset_pubkey.as_deref().unwrap_or(""),
            q
        );
        let result=state.suggestions.get_or_try_insert(key,60_000,||async{
            let mut body=json!({"q":q,"limit":10,"offset":0,"attributesToRetrieve":["title","availabilityStatus"]});if !safety_filters.is_empty(){body["filter"]=json!(safety_filters);}
            let result=video_search(&state.meili,body).await?;let mut titles=Vec::new();
            for hit in result["hits"].as_array().into_iter().flatten(){if hit["availabilityStatus"]=="unavailable"{continue;}let title=hit["title"].as_str().unwrap_or("").trim();if !title.is_empty()&&!titles.iter().any(|v|v==title){titles.push(title.to_owned());}if titles.len()==5{break;}}
            Ok(json!(titles))
        }).await;
        return match result {
            Ok(values) => Json(json!({"suggestions":values})).into_response(),
            Err(_) => json_response(502, json!({"error":"Search engine unavailable"})),
        };
    }
    let is_people = path == "/api/people";
    let limit = nonnegative(
        params.first("limit"),
        if is_people {
            10
        } else if is_tags {
            50
        } else {
            20
        },
    )
    .min(100);
    let offset = nonnegative(params.first("offset"), 0).min(1_000);
    let mut body = json!({"q":if is_tags{""}else{&q},"limit":limit,"offset":offset});
    if is_people {
        body["sort"] = json!(["videoCount:desc"]);
        body["attributesToRetrieve"] = json!([
            "pubkey",
            "npub",
            "name",
            "display_name",
            "username",
            "about",
            "picture",
            "nip05",
            "lud16",
            "videoCount",
            "globalTrustScore"
        ]);
        let mut keys = policy["blockedPubkeys"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        if safety.nsfw_filter == "hide" {
            keys.extend(
                policy["nsfwPubkeys"]
                    .as_array()
                    .cloned()
                    .unwrap_or_default(),
            );
        }
        let clauses: Vec<_> = keys
            .iter()
            .filter_map(Value::as_str)
            .map(|key| format!("pubkey != {}", quote(key)))
            .collect();
        if !clauses.is_empty() {
            body["filter"] = json!([format!("({})", clauses.join(" AND "))]);
        }
    } else {
        let mut filters = search_filters(&params);
        if is_tags {
            filters.insert(0, format!("tags = {}", quote(&q)));
        }
        filters.extend(safety_filters);
        if !filters.is_empty() {
            body["filter"] = json!(filters);
        }
        if let Some(sort) = sort(params.first("sort")) {
            body["sort"] = json!([sort]);
        }
        body["attributesToRetrieve"] = json!(HIT_ATTRIBUTES);
    }
    let result = if is_people {
        state.meili.search("people", &body).await
    } else {
        video_search(&state.meili, body).await
    };
    match result {
        Ok(result) => {
            let raw = result["hits"].as_array().cloned().unwrap_or_default();
            let mut hits = if is_people {
                raw
            } else {
                raw.iter().map(map_hit).collect()
            };
            if !is_people {
                annotate(&mut hits, &policy, &safety.nsfw_filter);
            }
            let total = result
                .get("estimatedTotalHits")
                .or_else(|| result.get("totalHits"))
                .cloned()
                .unwrap_or(json!(hits.len()));
            Json(json!({"hits":hits,"total":total,"limit":limit,"offset":offset})).into_response()
        }
        Err(err) => {
            eprintln!("[API] Search request failed: {err:#}");
            json_response(502, json!({"error":"Search engine unavailable"}))
        }
    }
}
async fn related(State(state): State<Arc<AppState>>, request: Request) -> Response {
    let bytes = match to_bytes(request.into_body(), 16 * 1_024).await {
        Ok(b) => b,
        Err(_) => return json_response(413, json!({"error":"Request body too large"})),
    };
    let body: Value = match serde_json::from_slice(&bytes) {
        Ok(b) => b,
        Err(_) => return json_response(400, json!({"error":"Invalid JSON body"})),
    };
    let (safety, policy) = match policy(
        &state,
        body["presetPubkey"].as_str().unwrap_or(""),
        body["nsfwFilter"].as_str().unwrap_or(""),
    )
    .await
    {
        Ok(p) => p,
        Err(r) => return r,
    };
    let reference = match body["videoRef"].as_str().filter(|s| !s.trim().is_empty()) {
        Some(r) => r,
        None => return json_response(400, json!({"error":"Missing videoRef"})),
    };
    if reference.encode_utf16().count() > 4_096 {
        return json_response(400, json!({"error":"videoRef too long"}));
    }
    let raw_limit = body["limit"]
        .as_str()
        .map(str::to_owned)
        .or_else(|| body["limit"].as_number().map(ToString::to_string));
    let limit = nonnegative(raw_limit.as_deref(), 20).clamp(1, 50);
    let mut input = json!({"videoRef":reference,"user":body["user"].as_str(),"limit":limit,"excludeContentWarnings":body["excludeContentWarnings"].as_bool().unwrap_or(true),"presetFilters":preset_filters(&safety,&policy),"presetPubkey":safety.preset_pubkey,"presetRevision":policy["revision"],"nsfwFilter":safety.nsfw_filter});
    if body["language"].is_string()
        || body["language"]
            .as_array()
            .is_some_and(|a| a.iter().all(Value::is_string))
    {
        input["language"] = body["language"].clone();
    }
    match state.recommendations.related(&input).await {
        Ok(Some(mut hits)) => {
            annotate(&mut hits, &policy, &safety.nsfw_filter);
            Json(json!({"total":hits.len(),"hits":hits,"limit":limit})).into_response()
        }
        Ok(None) => json_response(404, json!({"error":"Video not found"})),
        Err(err) => {
            let message = err.to_string();
            if message.starts_with("Unsupported videoRef") || message.starts_with("User must") {
                json_response(400, json!({"error":message}))
            } else {
                eprintln!("[API] Related recommendations failed: {err:#}");
                json_response(502, json!({"error":"Recommendations unavailable"}))
            }
        }
    }
}
async fn health(State(state): State<Arc<AppState>>) -> Response {
    match state
        .meili
        .request(reqwest::Method::GET, "/health", None)
        .await
    {
        Ok(_) => Json(json!({"ok":true})).into_response(),
        Err(_) => json_response(502, json!({"ok":false})),
    }
}
async fn ui() -> Response {
    (
        StatusCode::OK,
        [("content-type", "text/html; charset=utf-8")],
        include_str!("api/public/index.html"),
    )
        .into_response()
}
async fn sitemap(State(state): State<Arc<AppState>>) -> Response {
    match state
        .sitemap
        .get_or_try_insert("sitemap".into(), 6 * 60 * 60_000, || async {
            Ok(json!(crate::sitemap::build_sitemap(&state.meili).await?))
        })
        .await
    {
        Ok(xml) => (
            StatusCode::OK,
            [
                ("content-type", "application/xml; charset=utf-8"),
                (
                    "cache-control",
                    "public, max-age=3600, stale-while-revalidate=86400",
                ),
            ],
            Body::from(xml.as_str().unwrap_or("").to_owned()),
        )
            .into_response(),
        Err(err) => {
            eprintln!("[API] Sitemap failed: {err:#}");
            json_response(500, json!({"error":"Internal Server Error"}))
        }
    }
}
