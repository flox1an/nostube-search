use crate::{
    domain, media,
    net::{self, Meili},
    relatr, storage,
    util::{env_bool, env_list, env_u64, now_ms},
};
use anyhow::{Result, anyhow};
use reqwest::Method;
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    time::Duration,
};

fn adoption_timestamps(
    state_exists: bool,
    count: u64,
    newest: Option<u64>,
    now: u64,
) -> Option<(u64, u64)> {
    if state_exists || count == 0 {
        None
    } else {
        Some((
            now,
            newest
                .map(|v| v.saturating_mul(1000).min(now))
                .unwrap_or(now),
        ))
    }
}
fn video_settings() -> Value {
    json!({
        "searchableAttributes":["title","tags","summary","content_preview","content","authorDisplayName"],
        "filterableAttributes":["event_id","kind","pubkey","published_at","created_at","duration","hasCaptions","effectivePublishedAt","isHd","isShort","isVideo","isNostrNative","mediaType","identifier","d_tag","mediaAvailabilityKey","availabilityStatus","hasPlayableMedia","mediaCheckedAt","mediaRetryAfter","language","languageSource","captionLanguages","contentWarning","tags"],
        "sortableAttributes":["rankingScore","playlistScore","created_at","published_at","effectivePublishedAt","duration","mediaCheckedAt","mediaRetryAfter"],
        "rankingRules":["words","typo","proximity","attribute","exactness","sort","rankingScore:desc","playlistScore:desc","created_at:desc"]
    })
}
fn terms_settings() -> Value {
    json!({"searchableAttributes":["word"],"sortableAttributes":["count"],"rankingRules":["words","typo","proximity","attribute","exactness","count:desc"],"typoTolerance":{"minWordSizeForTypos":{"oneTypo":100,"twoTypos":100}}})
}
fn text<'a>(v: &'a Value, field: &str) -> &'a str {
    v[field].as_str().unwrap_or("")
}
fn timestamp(v: &Value) -> u64 {
    v["created_at"].as_u64().unwrap_or(0)
}
fn address(v: &Value) -> String {
    format!(
        "{}:{}:{}",
        v["kind"],
        text(v, "pubkey"),
        domain::first_tag(&domain::tags(v), "d").unwrap_or_default()
    )
}
fn playlist_scores(
    events: &[Value],
    trust: &HashMap<String, f64>,
    minimum: f64,
) -> HashMap<String, f64> {
    let mut refs: HashMap<String, HashSet<String>> = HashMap::new();
    for event in events {
        let author = text(event, "pubkey");
        if trust.get(author).copied().unwrap_or(0.5) < minimum {
            continue;
        }
        for tag in domain::tags(event) {
            if tag.len() < 2 {
                continue;
            }
            let id = match tag[0].as_str() {
                "e" => tag[1].clone(),
                "a" => {
                    let mut parts = tag[1].splitn(3, ':');
                    match (parts.next(), parts.next(), parts.next()) {
                        (Some(k), Some(p), Some(d)) => format!("{k}_{p}_{}", hex::encode(d)),
                        _ => continue,
                    }
                }
                _ => continue,
            };
            if !id.is_empty() {
                refs.entry(id).or_default().insert(author.to_owned());
            }
        }
    }
    let mut scores: HashMap<String, f64> = refs
        .into_iter()
        .map(|(id, authors)| {
            (
                id,
                authors
                    .iter()
                    .map(|a| trust.get(a).copied().unwrap_or(0.5))
                    .sum(),
            )
        })
        .collect();
    let max = scores.values().copied().fold(0.0, f64::max).ln_1p();
    for score in scores.values_mut() {
        *score = if max > 0.0 { score.ln_1p() / max } else { 0.0 };
    }
    scores
}

async fn page(
    relay: &str,
    kinds: Value,
    since: Option<u64>,
    until: Option<u64>,
) -> Result<net::RelayPage> {
    let mut filter = json!({"kinds":kinds,"limit":500});
    if let Some(s) = since {
        filter["since"] = json!(s);
    }
    if let Some(u) = until {
        filter["until"] = json!(u);
    }
    net::fetch_raw_page(relay, filter, env_u64("NOSTR_SOURCE_MAX_WAIT_MS", 30_000)).await
}
async fn relations(relays: &[String], events: &[Value]) -> Result<HashMap<String, Value>> {
    let ids: HashSet<String> = events.iter().map(|e| text(e, "id").to_owned()).collect();
    let addresses: HashMap<String, String> = events
        .iter()
        .filter(|e| e["kind"].as_u64().unwrap_or(0) >= 30000)
        .map(|e| (address(e), text(e, "id").to_owned()))
        .collect();
    let mut all = HashMap::new();
    for (tag, values) in [
        ("#e", ids.iter().cloned().collect::<Vec<_>>()),
        ("#a", addresses.keys().cloned().collect()),
    ] {
        for chunk in values.chunks(50) {
            let mut filter = json!({"kinds":[7,1,9734,9735]});
            filter[tag] = json!(chunk);
            for event in
                net::fetch_events(relays, filter, env_u64("NOSTR_SOURCE_MAX_WAIT_MS", 30_000))
                    .await?
            {
                all.insert(text(&event, "id").to_owned(), event);
            }
        }
    }
    let mut counts: HashMap<String, Value> = HashMap::new();
    for event in all.values() {
        let mut targets = HashSet::new();
        for tag in domain::tags(event) {
            if tag.len() < 2 {
                continue;
            }
            if tag[0] == "e" && ids.contains(&tag[1]) {
                targets.insert(tag[1].clone());
            } else if tag[0] == "a" {
                if let Some(id) = addresses.get(&tag[1]) {
                    targets.insert(id.clone());
                }
            }
        }
        for id in targets {
            let c = counts.entry(id).or_insert_with(|| json!({"relatedEventsTotal":0,"reactionsCount":0,"commentsCount":0,"zapsCount":0,"notesCount":0}));
            c["relatedEventsTotal"] = json!(c["relatedEventsTotal"].as_u64().unwrap_or(0) + 1);
            let field = match event["kind"].as_u64() {
                Some(7) => "reactionsCount",
                Some(1) => "commentsCount",
                Some(9734 | 9735) => "zapsCount",
                _ => continue,
            };
            c[field] = json!(c[field].as_u64().unwrap_or(0) + 1);
        }
    }
    Ok(counts)
}
#[derive(Default)]
struct Accum {
    words: HashMap<String, u64>,
    counts: HashMap<String, u64>,
    profiles: HashMap<String, Value>,
    trust: HashMap<String, f64>,
    last: Option<Value>,
}
async fn batch(
    meili: &Meili,
    index: &str,
    relays: &[String],
    events: &[Value],
    acc: &mut Accum,
) -> Result<()> {
    let keys: Vec<String> = events
        .iter()
        .map(|e| text(e, "pubkey").to_owned())
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    let counts = relations(relays, events).await.unwrap_or_else(|e| {
        eprintln!("relations: {e:#}");
        HashMap::new()
    });
    let trust = if env_bool("FETCH_TRUST_SCORES") {
        relatr::fetch_trust_scores(&keys).await
    } else {
        HashMap::new()
    };
    let profiles = storage::get_profiles(&keys).await?;
    let preliminary: Vec<Value> = events
        .iter()
        .map(|e| {
            domain::event_to_document(
                e,
                profiles.get(text(e, "pubkey")),
                counts.get(text(e, "id")),
                None,
                *trust.get(text(e, "pubkey")).unwrap_or(&0.5),
                None,
            )
        })
        .collect();
    let availability_keys: Vec<String> = preliminary
        .iter()
        .filter_map(|doc| doc["mediaAvailabilityKey"].as_str().map(str::to_owned))
        .collect();
    let availability = media::load_availability(meili, &availability_keys).await?;
    let playlist = storage::read_playlist_scores();
    let docs: Vec<Value> = events
        .iter()
        .zip(preliminary.iter())
        .map(|(e, pre)| {
            let key = pre["mediaAvailabilityKey"].as_str();
            let mut doc = domain::event_to_document(
                e,
                profiles.get(text(e, "pubkey")),
                counts.get(text(e, "id")),
                None,
                *trust.get(text(e, "pubkey")).unwrap_or(&0.5),
                key.and_then(|k| availability.get(k)),
            );
            // Rewriting a video must not reset its playlist link.
            let score = doc["id"].as_str().and_then(|id| playlist.get(id)).copied();
            doc["playlistScore"] = json!(score.unwrap_or(0.0));
            doc
        })
        .collect();
    for (word, count) in domain::collect_words(&docs) {
        *acc.words.entry(word).or_default() += count;
    }
    for key in keys {
        *acc.counts.entry(key).or_default() += 1;
    }
    acc.profiles.extend(profiles);
    acc.trust.extend(trust);
    acc.last = Some(meili.upsert(index, &docs).await?);
    Ok(())
}
async fn write_terms(meili: &Meili, index: &str, words: &HashMap<String, u64>) -> Result<()> {
    let docs: Vec<Value> = words
        .iter()
        .map(|(word, count)| json!({"id":word,"word":word,"count":count}))
        .collect();
    let mut last = None;
    for chunk in docs.chunks(10_000) {
        last = Some(meili.upsert(index, chunk).await?);
    }
    if let Some(task) = last {
        meili.wait(&task).await?;
    }
    Ok(())
}
async fn ingest(meili: &Meili, relays: &[String], full: bool, since: u64) -> Result<()> {
    let video_index = if full { "videos_next" } else { "videos" };
    let terms_index = if full { "terms_next" } else { "terms" };
    if full {
        for index in [video_index, terms_index] {
            meili.delete_index(index).await?;
        }
        meili
            .ensure_index(video_index, "id", &video_settings())
            .await?;
        meili
            .ensure_index(terms_index, "id", &terms_settings())
            .await?;
    }
    let mut seen = HashSet::new();
    let mut newest: HashMap<String, u64> = HashMap::new();
    let mut no_d: HashMap<String, Value> = HashMap::new();
    let mut batch_events = Vec::new();
    let mut acc = Accum::default();
    let mut incremental_events = Vec::new();
    for relay in relays {
        let mut until = None;
        let mut was_full = false;
        let mut retried = false;
        loop {
            let page = page(
                relay,
                json!([21, 22, 34235, 34236]),
                if full { None } else { Some(since) },
                until,
            )
            .await?;
            if page.raw_count == 0 {
                if full && was_full && !retried {
                    retried = true;
                    continue;
                }
                break;
            }
            retried = false;
            was_full = page.raw_count >= 500;
            for event in page.events {
                if !seen.insert(text(&event, "id").to_owned()) {
                    continue;
                }
                if !full {
                    incremental_events.push(event);
                    continue;
                }
                if (30000..40000).contains(&event["kind"].as_u64().unwrap_or(0)) {
                    let addr = address(&event);
                    let ts = timestamp(&event);
                    if domain::first_tag(&domain::tags(&event), "d").is_none() {
                        if no_d.get(&addr).is_none_or(|old| timestamp(old) < ts) {
                            no_d.insert(addr, event);
                        }
                        continue;
                    }
                    if newest.get(&addr).is_some_and(|old| *old >= ts) {
                        continue;
                    }
                    newest.insert(addr, ts);
                }
                batch_events.push(event);
                if batch_events.len() >= 500 {
                    batch(meili, video_index, relays, &batch_events, &mut acc).await?;
                    batch_events.clear();
                }
            }
            let Some(min) = page.oldest else { break };
            if !was_full || min == 0 || (!full && min - 1 <= since) {
                break;
            }
            until = Some(min - 1);
        }
    }
    if !full {
        let mut addressable: HashMap<String, Value> = HashMap::new();
        for event in incremental_events {
            if (30000..40000).contains(&event["kind"].as_u64().unwrap_or(0)) {
                let addr = address(&event);
                if addressable
                    .get(&addr)
                    .is_none_or(|old| timestamp(old) < timestamp(&event))
                {
                    addressable.insert(addr, event);
                }
            } else {
                batch_events.push(event);
            }
        }
        batch_events.extend(addressable.into_values());
        batch_events.sort_by_key(timestamp);
        for chunk in batch_events.chunks(500) {
            batch(meili, video_index, relays, chunk, &mut acc).await?;
        }
        batch_events.clear();
    }
    for event in no_d.into_values() {
        batch_events.push(event);
        if batch_events.len() >= 500 {
            batch(meili, video_index, relays, &batch_events, &mut acc).await?;
            batch_events.clear();
        }
    }
    if !batch_events.is_empty() {
        batch(meili, video_index, relays, &batch_events, &mut acc).await?;
    }
    write_terms(meili, terms_index, &acc.words).await?;
    if let Some(task) = &acc.last {
        meili.wait(task).await?;
    }
    if full {
        let live = meili
            .request(Method::GET, "/indexes/videos/stats", None)
            .await?["numberOfDocuments"]
            .as_u64()
            .unwrap_or(0);
        let next = meili
            .request(Method::GET, "/indexes/videos_next/stats", None)
            .await?["numberOfDocuments"]
            .as_u64()
            .unwrap_or(0);
        if live > 1000 && next.saturating_mul(10) < live.saturating_mul(9) {
            return Err(anyhow!("refusing to swap truncated index: {next}/{live}"));
        }
        let task=meili.request(Method::POST,"/swap-indexes",Some(&json!([{"indexes":["videos","videos_next"],"rename":false},{"indexes":["terms","terms_next"],"rename":false}]))).await?;
        meili.wait(&task).await?;
        meili.delete_index("videos_next").await?;
        meili.delete_index("terms_next").await?;
        let mut state = storage::read_state();
        let now = now_ms();
        state.last_incremental_at = now;
        state.last_full_at = now;
        storage::write_state(&state)?;
    }
    storage::ensure_people_index(meili).await?;
    storage::upsert_people(meili, "people", &acc.counts, &acc.profiles, &acc.trust).await?;
    if !full {
        let mut state = storage::read_state();
        state.last_incremental_at = now_ms();
        storage::write_state(&state)?;
    }
    if full {
        playlist_pass(meili, relays).await?;
    }
    Ok(())
}
async fn playlist_pass(meili: &Meili, relays: &[String]) -> Result<()> {
    let mut events = HashMap::new();
    let limit = env_u64("PLAYLIST_FETCH_LIMIT", 5000) as usize;
    let mut seen = HashSet::new();
    for relay in relays {
        let mut until = None;
        loop {
            let page = page(relay, json!([30005]), None, until).await?;
            if page.raw_count == 0 {
                break;
            }
            let len = page.raw_count;
            for e in page.events {
                if !seen.insert(text(&e, "id").to_owned()) {
                    continue;
                }
                let addr = address(&e);
                if events
                    .get(&addr)
                    .is_none_or(|old| timestamp(old) < timestamp(&e))
                {
                    events.insert(addr, e);
                }
            }
            let Some(min) = page.oldest else { break };
            if len < 500 || seen.len() >= limit || min == 0 {
                break;
            }
            until = Some(min - 1);
        }
    }
    let events: Vec<Value> = events.into_values().collect();
    let authors: Vec<String> = events
        .iter()
        .map(|e| text(e, "pubkey").to_owned())
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    let trust = if env_bool("FETCH_TRUST_SCORES") {
        relatr::fetch_trust_scores(&authors).await
    } else {
        HashMap::new()
    };
    let minimum = std::env::var("PLAYLIST_MIN_TRUST_SCORE")
        .ok()
        .and_then(|v| v.parse::<f64>().ok())
        .filter(|v| *v != 0.0)
        .unwrap_or(0.1);
    let scores = playlist_scores(&events, &trust, minimum);
    // Persist first: videos indexed after this pass pick their score up from
    // here. IDs that left every playlist are written back as 0 below.
    let previous = storage::read_playlist_scores();
    storage::write_playlist_scores(&scores)?;
    let mut docs: Vec<Value> = scores
        .iter()
        .map(|(id, score)| json!({"id":id,"playlistScore":score}))
        .collect();
    docs.extend(
        previous
            .keys()
            .filter(|id| !scores.contains_key(*id))
            .map(|id| json!({"id":id,"playlistScore":0.0})),
    );
    let mut last = None;
    for chunk in docs.chunks(1000) {
        // skipCreation: a playlist may reference videos that are not indexed
        // (yet); those must not become empty stub documents.
        last = Some(
            meili
                .request(
                    Method::PUT,
                    "/indexes/videos/documents?skipCreation=true",
                    Some(&json!(chunk)),
                )
                .await?,
        );
    }
    if let Some(task) = last {
        meili.wait(&task).await?;
    }
    let mut state = storage::read_state();
    state.last_playlist_score_at = now_ms();
    storage::write_state(&state)?;
    Ok(())
}
pub async fn run_until(meili: Meili, mut stop: tokio::sync::watch::Receiver<bool>) -> Result<()> {
    if let Err(error) = storage::prune_caches() {
        eprintln!("cache pruning: {error:#}");
    }
    meili
        .ensure_index("videos", "id", &video_settings())
        .await?;
    meili.ensure_index("terms", "id", &terms_settings()).await?;
    media::ensure_index(&meili).await?;
    storage::ensure_people_index(&meili).await?;
    let state_path =
        std::env::var("INDEXER_STATE_PATH").unwrap_or_else(|_| ".indexer-state.json".into());
    let exists = std::fs::read(&state_path)
        .ok()
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
        .is_some_and(|v| v.is_object());
    let stats = meili
        .request(Method::GET, "/indexes/videos/stats", None)
        .await?;
    let count = stats["numberOfDocuments"].as_u64().unwrap_or(0);
    if !exists && count > 0 {
        let result=meili.search("videos",&json!({"q":"","sort":["created_at:desc"],"limit":1,"attributesToRetrieve":["created_at"]})).await?;
        let newest = result["hits"][0]["created_at"].as_u64();
        if let Some((full, incr)) = adoption_timestamps(false, count, newest, now_ms()) {
            let mut state = storage::read_state();
            state.last_full_at = full;
            state.last_incremental_at = incr;
            storage::write_state(&state)?;
        }
    }
    let relays = env_list("NOSTR_SOURCE_RELAYS", "wss://relay.nostu.be");
    if env_bool("FORCE_FULL_REINDEX") {
        let mut state = storage::read_state();
        state.last_full_start_at = now_ms();
        storage::write_state(&state)?;
        ingest(&meili, &relays, true, 0).await?;
    }
    loop {
        if *stop.borrow() {
            break;
        }
        let mut state = storage::read_state();
        let now = now_ms();
        let full = storage::needs_full_reindex(
            &state,
            now,
            env_u64("INDEXER_FULL_INTERVAL_MS", 86_400_000),
            env_u64("INDEXER_FULL_RETRY_MS", 900_000),
        );
        let result = if full {
            state.last_full_start_at = now;
            storage::write_state(&state)?;
            ingest(&meili, &relays, true, 0).await
        } else if state.last_full_at > 0
            && now.saturating_sub(state.last_incremental_at)
                >= env_u64("INDEXER_INCREMENTAL_INTERVAL_MS", 600_000)
        {
            ingest(
                &meili,
                &relays,
                false,
                state.last_incremental_at.saturating_sub(300_000) / 1000,
            )
            .await
        } else {
            Ok(())
        };
        if let Err(e) = result {
            eprintln!("indexer: {e:#}");
        }
        if !full
            && state.last_full_at > 0
            && now.saturating_sub(state.last_availability_check_at)
                >= env_u64("MEDIA_AVAILABILITY_CHECK_INTERVAL_MS", 600_000)
        {
            match media::check_once(&meili).await {
                Ok(()) => {
                    let mut current = storage::read_state();
                    current.last_availability_check_at = now_ms();
                    storage::write_state(&current)?;
                }
                Err(e) => eprintln!("availability: {e:#}"),
            }
        }
        if !full
            && state.last_full_at > 0
            && now.saturating_sub(state.last_playlist_score_at)
                >= env_u64("PLAYLIST_SCORE_INTERVAL_MS", 21_600_000)
        {
            if let Err(e) = playlist_pass(&meili, &relays).await {
                eprintln!("playlist: {e:#}");
            }
        }
        if *stop.borrow() {
            break;
        }
        tokio::select! { _=tokio::time::sleep(Duration::from_secs(60))=>{}, changed=stop.changed()=>{ if changed.is_err() || *stop.borrow() { break; } } }
    }
    Ok(())
}
pub async fn run(meili: Meili) -> Result<()> {
    let (sender, receiver) = tokio::sync::watch::channel(false);
    let signal = tokio::spawn(async move {
        let _ = tokio::signal::ctrl_c().await;
        let _ = sender.send(true);
    });
    let result = run_until(meili, receiver).await;
    signal.abort();
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    use futures_util::{SinkExt, StreamExt};
    use nostr_sdk::prelude::{EventBuilder, FinalizeEvent, Keys, Kind, Tag, Timestamp};
    use std::sync::{Arc, Mutex};

    fn signed(keys: &Keys, kind: u16, time: u64, content: &str, tags: Vec<Vec<&str>>) -> Value {
        let tags = tags
            .into_iter()
            .map(|t| Tag::parse(t).unwrap())
            .collect::<Vec<_>>();
        serde_json::to_value(
            EventBuilder::new(Kind::from(kind), content)
                .tags(tags)
                .custom_created_at(Timestamp::from(time))
                .finalize(keys)
                .unwrap(),
        )
        .unwrap()
    }

    async fn relay(
        pages: Vec<Vec<Value>>,
        playlist: Vec<Value>,
        empty_retry: bool,
    ) -> (String, Arc<Mutex<Vec<Value>>>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let requests = Arc::new(Mutex::new(Vec::new()));
        let captured = requests.clone();
        tokio::spawn(async move {
            let mut retried = false;
            loop {
                let Ok((stream, _)) = listener.accept().await else {
                    break;
                };
                let Ok(mut ws) = tokio_tungstenite::accept_async(stream).await else {
                    continue;
                };
                while let Some(Ok(message)) = ws.next().await {
                    let Ok(text) = message.to_text() else {
                        continue;
                    };
                    let Ok(frame) = serde_json::from_str::<Value>(text) else {
                        continue;
                    };
                    if frame[0] != "REQ" {
                        continue;
                    }
                    let filter = frame[2].clone();
                    captured.lock().unwrap().push(filter.clone());
                    let kinds = filter["kinds"].as_array().cloned().unwrap_or_default();
                    let video = kinds.iter().any(|v| v == 21 || v == 34235);
                    let until = filter["until"].as_u64();
                    let page = if !video {
                        if kinds.contains(&json!(30005)) {
                            playlist.clone()
                        } else {
                            Vec::new()
                        }
                    } else if until.is_none() {
                        pages[0].clone()
                    } else if empty_retry && !retried {
                        retried = true;
                        Vec::new()
                    } else {
                        pages.get(1).cloned().unwrap_or_default()
                    };
                    for event in page {
                        ws.send(tokio_tungstenite::tungstenite::Message::Text(
                            json!(["EVENT", frame[1], event]).to_string().into(),
                        ))
                        .await
                        .unwrap();
                    }
                    ws.send(tokio_tungstenite::tungstenite::Message::Text(
                        json!(["EOSE", frame[1]]).to_string().into(),
                    ))
                    .await
                    .unwrap();
                }
            }
        });
        (format!("ws://{addr}"), requests)
    }

    #[derive(Default)]
    struct FakeMeili {
        requests: Vec<(String, String, Value)>,
        docs: HashMap<String, HashMap<String, Value>>,
    }

    async fn fake_meili() -> (Meili, Arc<Mutex<FakeMeili>>) {
        use axum::{
            Router,
            body::Bytes,
            extract::{Request, State},
            routing::any,
        };
        async fn handle(
            State(state): State<Arc<Mutex<FakeMeili>>>,
            request: Request,
        ) -> axum::Json<Value> {
            let (parts, body) = request.into_parts();
            let bytes = axum::body::to_bytes(body, usize::MAX)
                .await
                .unwrap_or_else(|_| Bytes::new());
            let body: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
            let path = parts.uri.path().to_owned();
            let logged = parts
                .uri
                .path_and_query()
                .map_or(path.clone(), |p| p.as_str().to_owned());
            let method = parts.method.to_string();
            let mut state = state.lock().unwrap();
            state.requests.push((method.clone(), logged, body.clone()));
            let segments: Vec<_> = path.trim_matches('/').split('/').collect();
            if segments.first() == Some(&"tasks") {
                return axum::Json(json!({"status":"succeeded"}));
            }
            if segments.len() == 3 && segments[0] == "indexes" && segments[2] == "documents" {
                for doc in body.as_array().into_iter().flatten() {
                    let id = doc["id"]
                        .as_str()
                        .or_else(|| doc["pubkey"].as_str())
                        .unwrap()
                        .to_owned();
                    let docs = state.docs.entry(segments[1].to_owned()).or_default();
                    if method == "PUT" {
                        // Real Meili: PUT updates in place but creates missing IDs
                        // unless `?skipCreation=true` is given.
                        let skip = parts
                            .uri
                            .query()
                            .is_some_and(|q| q.contains("skipCreation=true"));
                        if let Some(old) = docs.get_mut(&id) {
                            if let (Some(old), Some(update)) =
                                (old.as_object_mut(), doc.as_object())
                            {
                                old.extend(update.clone());
                            }
                        } else if !skip {
                            docs.insert(id, doc.clone());
                        }
                    } else {
                        docs.insert(id, doc.clone());
                    }
                }
            }
            if segments.len() == 3 && segments[2] == "stats" {
                return axum::Json(
                    json!({"numberOfDocuments":state.docs.get(segments[1]).map_or(0,|d|d.len())}),
                );
            }
            if segments.len() == 3 && segments[2] == "search" {
                let newest = state
                    .docs
                    .get(segments[1])
                    .into_iter()
                    .flat_map(|d| d.values())
                    .max_by_key(|d| d["created_at"].as_u64().unwrap_or(0));
                return axum::Json(json!({"hits":newest.into_iter().collect::<Vec<_>>()}));
            }
            if path == "/swap-indexes" {
                for pair in body.as_array().into_iter().flatten() {
                    let a = pair["indexes"][0].as_str().unwrap();
                    let b = pair["indexes"][1].as_str().unwrap();
                    let left = state.docs.remove(a).unwrap_or_default();
                    let right = state.docs.remove(b).unwrap_or_default();
                    state.docs.insert(a.to_owned(), right);
                    state.docs.insert(b.to_owned(), left);
                }
            }
            if method == "DELETE" && segments.len() == 2 {
                state.docs.remove(segments[1]);
            }
            axum::Json(json!({"taskUid":1}))
        }
        let state = Arc::new(Mutex::new(FakeMeili::default()));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let app = Router::new()
            .fallback(any(handle))
            .with_state(state.clone());
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        (Meili::new(format!("http://{addr}"), String::new()), state)
    }

    #[tokio::test]
    async fn raw_pages_preserve_verified_events_replacements_retry_and_checkpoint() {
        let temp = tempfile::tempdir().unwrap();
        if !crate::util::isolated_test(
            "indexer::tests::raw_pages_preserve_verified_events_replacements_retry_and_checkpoint",
            &[
                (
                    "INDEXER_STATE_PATH",
                    temp.path().join("state.json").as_os_str(),
                ),
                ("NOSTR_INDEX_RELAYS", std::ffi::OsStr::new("")),
                (
                    "PLAYLIST_SCORES_PATH",
                    temp.path().join("playlists.json").as_os_str(),
                ),
            ],
        ) {
            return;
        }
        let state_path = std::path::PathBuf::from(std::env::var_os("INDEXER_STATE_PATH").unwrap());
        let keys = Keys::parse("0000000000000000000000000000000000000000000000000000000000000001")
            .unwrap();
        let old = signed(&keys, 34235, 1000, "old", vec![vec!["d", "video"]]);
        let newer = signed(&keys, 34235, 1100, "new", vec![vec!["d", "video"]]);
        let missing_old = signed(&keys, 34235, 498, "missing old", vec![]);
        let missing_new = signed(&keys, 34235, 1200, "missing new", vec![]);
        let last = signed(&keys, 21, 497, "last", vec![]);
        let mut first = vec![old.clone()];
        for i in 0..499 {
            let mut invalid = old.clone();
            invalid["id"] = json!(format!("{i:064x}"));
            invalid["created_at"] = json!(500);
            first.push(invalid);
        }
        let playlist = signed(
            &keys,
            30005,
            1300,
            "playlist",
            vec![vec!["d", "list"], vec!["e", last["id"].as_str().unwrap()]],
        );
        let (relay1, requests1) = relay(
            vec![first, vec![missing_old, last.clone()]],
            vec![playlist],
            true,
        )
        .await;
        let (relay2, _) = relay(
            vec![vec![newer.clone(), missing_new.clone()]],
            vec![],
            false,
        )
        .await;
        let (meili, state) = fake_meili().await;
        ingest(&meili, &[relay1.clone(), relay2.clone()], true, 0)
            .await
            .unwrap();
        let state_guard = state.lock().unwrap();
        let docs = &state_guard.docs["videos"];
        assert_eq!(docs.len(), 3);
        assert_eq!(
            docs[&format!(
                "34235_{}_{}",
                newer["pubkey"].as_str().unwrap(),
                hex::encode("video")
            )]["event_id"],
            newer["id"]
        );
        assert!(docs.contains_key(missing_new["id"].as_str().unwrap()));
        assert!(docs.contains_key(last["id"].as_str().unwrap()));
        assert_eq!(docs[last["id"].as_str().unwrap()]["playlistScore"], 1.0);
        assert!(
            state_guard
                .requests
                .iter()
                .any(|(method, path, body)| method == "PATCH"
                    && path == "/indexes/videos_next/settings"
                    && body == &video_settings())
        );
        assert!(
            state_guard
                .requests
                .iter()
                .any(|(method, path, body)| method == "PATCH"
                    && path == "/indexes/terms_next/settings"
                    && body == &terms_settings())
        );
        let settings = state_guard
            .requests
            .iter()
            .find(|(_, path, _)| path == "/indexes/videos_next/settings")
            .unwrap()
            .2
            .clone();
        assert!(
            settings["filterableAttributes"]
                .as_array()
                .unwrap()
                .contains(&json!("mediaAvailabilityKey"))
        );
        assert!(
            settings["sortableAttributes"]
                .as_array()
                .unwrap()
                .contains(&json!("playlistScore"))
        );
        let terms = state_guard
            .requests
            .iter()
            .find(|(_, path, _)| path == "/indexes/terms_next/settings")
            .unwrap()
            .2
            .clone();
        assert_eq!(
            terms["typoTolerance"]["minWordSizeForTypos"],
            json!({"oneTypo":100,"twoTypos":100})
        );
        drop(state_guard);
        let filters = requests1.lock().unwrap();
        let cursors: Vec<_> = filters
            .iter()
            .filter(|v| {
                v["kinds"]
                    .as_array()
                    .is_some_and(|k| k.contains(&json!(21)))
            })
            .map(|v| v["until"].as_u64())
            .collect();
        assert_eq!(cursors, vec![None, Some(499), Some(499)]);
        drop(filters);
        ingest(&meili, &[relay1, relay2], false, 400).await.unwrap();
        let state_guard = state.lock().unwrap();
        assert_eq!(state_guard.docs["videos"].len(), 3);
        assert_eq!(
            state_guard.docs["videos"][&format!(
                "34235_{}_{}",
                newer["pubkey"].as_str().unwrap(),
                hex::encode("video")
            )]["event_id"],
            newer["id"]
        );
        drop(state_guard);
        assert!(
            requests1
                .lock()
                .unwrap()
                .iter()
                .any(|v| v["since"] == 400 && v["until"] == 499)
        );
        let saved = storage::read_state();
        assert!(
            saved.last_full_at > 0
                && saved.last_incremental_at > 0
                && saved.last_playlist_score_at > 0
        );
        std::fs::remove_file(&state_path).unwrap();
        let (stop, receiver) = tokio::sync::watch::channel(true);
        run_until(meili.clone(), receiver).await.unwrap();
        drop(stop);
        let adopted = storage::read_state();
        assert!(adopted.last_full_at > 0);
        assert_eq!(adopted.last_incremental_at, 1_200_000);
        let state_guard = state.lock().unwrap();
        assert_eq!(
            state_guard
                .requests
                .iter()
                .filter(|(_, path, _)| path == "/swap-indexes")
                .count(),
            1
        );
        assert!(
            state_guard
                .requests
                .iter()
                .any(|(method, path, body)| method == "PATCH"
                    && path == "/indexes/videos/settings"
                    && body == &video_settings())
        );
        assert!(
            state_guard
                .requests
                .iter()
                .any(|(method, path, body)| method == "PATCH"
                    && path == "/indexes/terms/settings"
                    && body == &terms_settings())
        );
        drop(state_guard);
    }
    #[test]
    fn adopts_existing_index_only_without_state() {
        assert_eq!(
            adoption_timestamps(false, 5, Some(100), 200_000),
            Some((200_000, 100_000))
        );
        assert_eq!(
            adoption_timestamps(false, 5, Some(300), 200_000),
            Some((200_000, 200_000))
        );
        assert_eq!(adoption_timestamps(true, 5, Some(100), 200_000), None);
        assert_eq!(adoption_timestamps(false, 0, None, 200_000), None);
    }

    #[tokio::test]
    async fn playlist_scores_link_in_both_orders_and_never_create_stub_documents() {
        let temp = tempfile::tempdir().unwrap();
        let name =
            "indexer::tests::playlist_scores_link_in_both_orders_and_never_create_stub_documents";
        if !crate::util::isolated_test(
            name,
            &[
                (
                    "INDEXER_STATE_PATH",
                    temp.path().join("state.json").as_os_str(),
                ),
                (
                    "PLAYLIST_SCORES_PATH",
                    temp.path().join("playlists.json").as_os_str(),
                ),
                ("NOSTR_INDEX_RELAYS", std::ffi::OsStr::new("")),
            ],
        ) {
            return;
        }
        let keys = Keys::parse("0000000000000000000000000000000000000000000000000000000000000001")
            .unwrap();
        let early = signed(&keys, 21, 1000, "listed before it was indexed", vec![]);
        let late = signed(&keys, 21, 2000, "indexed before the playlist", vec![]);
        let unlisted = signed(&keys, 21, 3000, "in no playlist", vec![]);
        let playlist = signed(
            &keys,
            30005,
            4000,
            "list",
            vec![
                vec!["d", "list"],
                vec!["e", early["id"].as_str().unwrap()],
                vec!["e", late["id"].as_str().unwrap()],
            ],
        );
        let (meili, state) = fake_meili().await;
        // 1. The playlist is read while only `late` exists in the index.
        let (relay_a, _) = relay(vec![vec![late.clone()]], vec![playlist.clone()], false).await;
        ingest(&meili, &[relay_a.clone()], true, 0).await.unwrap();
        {
            let guard = state.lock().unwrap();
            let docs = &guard.docs["videos"];
            assert_eq!(docs.len(), 1, "a playlist reference must not create a stub");
            assert!(docs[late["id"].as_str().unwrap()]["event_id"].is_string());
            assert_eq!(docs[late["id"].as_str().unwrap()]["playlistScore"], 1.0);
            assert!(
                guard
                    .requests
                    .iter()
                    .any(|(m, p, _)| m == "PUT"
                        && p == "/indexes/videos/documents?skipCreation=true")
            );
        }
        // 2. `early` is indexed later (also rewriting `late`): both keep their link.
        let (relay_b, _) = relay(
            vec![vec![early.clone(), late.clone(), unlisted.clone()]],
            vec![],
            false,
        )
        .await;
        ingest(&meili, &[relay_b], false, 0).await.unwrap();
        let guard = state.lock().unwrap();
        let docs = &guard.docs["videos"];
        assert_eq!(docs.len(), 3);
        assert_eq!(docs[early["id"].as_str().unwrap()]["playlistScore"], 1.0);
        assert_eq!(docs[late["id"].as_str().unwrap()]["playlistScore"], 1.0);
        assert_eq!(docs[unlisted["id"].as_str().unwrap()]["playlistScore"], 0.0);
    }
    #[test]
    fn playlist_scores_deduplicate_author_and_normalize() {
        let events = vec![
            json!({"pubkey":"a","tags":[["e","one"],["e","one"],["a","34235:abc:x:y"]]}),
            json!({"pubkey":"b","tags":[["e","one"]]}),
        ];
        let scores = playlist_scores(
            &events,
            &HashMap::from([("a".into(), 0.4), ("b".into(), 0.8)]),
            0.1,
        );
        assert_eq!(scores["one"], 1.0);
        assert!(scores["34235_abc_783a79"] < 1.0);
    }
}
