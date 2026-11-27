#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn raw_reference_and_invalid_reference() {
        let id = "AB".repeat(32);
        assert_eq!(
            parse_video_ref(&id).unwrap(),
            json!({"type":"event","eventId":id.to_lowercase(),"relays":[]})
        );
        assert!(parse_video_ref("invalid").is_err());
    }

    #[test]
    fn reference_round_trips() {
        let hit = json!({"event_id":"11".repeat(32),"pubkey":"00".repeat(32),"kind":34235,"identifier":"intro"});
        let link = event_link(&hit).unwrap();
        let parsed = parse_video_ref(&link).unwrap();
        assert_eq!(parsed["identifier"], "intro");
        assert_eq!(parsed["kind"], 34235);
    }

    #[test]
    fn scores_and_personalization() {
        let hit = json!({"rankingScore":0.5});
        let base = score(&hit, 0.5, 0.0, 0.0, 0.0, true);
        assert!((score(&hit, 0.5, 0.0, 1.0, 0.0, true) - base - 0.05).abs() < 1e-9);
        assert!((score(&hit, 0.5, 0.0, 0.0, 1.0, true) - base - 0.03).abs() < 1e-9);
        let mut playlist = hit.clone();
        playlist["playlistScore"] = json!(1);
        assert!(
            (score(&playlist, 0.5, 0.0, 0.0, 0.0, false)
                - score(&hit, 0.5, 0.0, 0.0, 0.0, false)
                - 0.05)
                .abs()
                < 1e-9
        );
    }

    #[test]
    fn mapping_prefers_playable_and_deduplicates() {
        let hit = json!({"event_id":"11".repeat(32),"pubkey":"00".repeat(32),"kind":21,"videoUrl":"origin","playableUrl":"mirror","fallbackUrls":["mirror","backup"]});
        let mapped = map_hit(&hit, 0.42).unwrap();
        assert_eq!(mapped["urls"], json!(["mirror", "origin", "backup"]));
        assert_eq!(mapped["recommendationScore"], 0.42);
        assert_eq!(mapped["language"], Value::Null);
    }

    #[test]
    fn dedupe_source_addresses_and_warnings() {
        let source = json!({"event_id":"a","kind":34235,"pubkey":"p","identifier":"x"});
        let hits = vec![
            json!({"event_id":"b","kind":34235,"pubkey":"p","d_tag":"x"}),
            json!({"event_id":"c"}),
            json!({"event_id":"c"}),
            json!({"event_id":"d","contentWarning":"NSFW"}),
        ];
        assert_eq!(dedupe(&source, &hits, true).len(), 1);
    }
    #[test]
    fn profile_affinity_and_language_filters() {
        let id = "11".repeat(32);
        let events = vec![json!({"kind":7,"tags":[["e",id]]})];
        let videos =
            vec![json!({"event_id":id,"pubkey":"author","kind":21,"tags":["Nostr","music"]})];
        let p = profile("user", &events, &videos);
        assert_eq!(affinities(&json!({"kind":21,"tags":["nostr"]}), &p).0, 1.0);
        assert_eq!(
            affinities(&json!({"kind":22,"tags":["cooking"]}), &p).2,
            0.0
        );
        let source = json!({"kind":21,"language":"en"});
        assert!(
            filters(&source, &json!({"language":null}))
                .iter()
                .all(|f| !f.contains("language"))
        );
        assert!(
            filters(&source, &json!({}))
                .iter()
                .any(|f| f.contains("language"))
        );
    }
    fn encoded(prefix: &str, fields: &[(u8, &[u8])]) -> String {
        let mut bytes = Vec::new();
        for (tag, value) in fields {
            bytes.extend_from_slice(&[*tag, value.len() as u8]);
            bytes.extend_from_slice(value);
        }
        bech32::encode::<Nip19Checksum>(Hrp::parse(prefix).unwrap(), &bytes).unwrap()
    }

    #[test]
    fn raw_tlv_references_preserve_hints_and_validate_fields() {
        let id = [17u8; 32];
        let author = [0u8; 32];
        let kind = 34235u32.to_be_bytes();
        let hints: [&[u8]; 2] = [b"https://example.com", b"not a relay"];
        let event = encoded(
            "nevent",
            &[
                (0, &id),
                (1, hints[0]),
                (1, hints[1]),
                (2, &author),
                (3, &kind),
            ],
        );
        let addr = encoded(
            "naddr",
            &[
                (0, b"intro"),
                (1, hints[0]),
                (1, hints[1]),
                (2, &author),
                (3, &kind),
            ],
        );
        assert_eq!(
            parse_video_ref(&event).unwrap(),
            json!({"type":"event","eventId":hex::encode(id),"relays":["https://example.com","not a relay"]})
        );
        assert_eq!(
            parse_video_ref(&addr).unwrap(),
            json!({"type":"address","kind":34235,"pubkey":hex::encode(author),"identifier":"intro","relays":["https://example.com","not a relay"]})
        );
        for (prefix, fields) in [
            ("nevent", vec![(0, &id[..31])]),
            ("nevent", vec![(0, &id[..]), (2, &author[..31])]),
            ("nevent", vec![(0, &id[..]), (3, &kind[..3])]),
            ("nevent", vec![(0, &id[..]), (1, &[255][..])]),
            ("naddr", vec![(0, &b"intro"[..]), (2, &author[..])]),
            (
                "naddr",
                vec![(0, &[255][..]), (2, &author[..]), (3, &kind[..])],
            ),
        ] {
            assert!(
                parse_video_ref(&encoded(prefix, &fields)).is_err(),
                "{prefix} {fields:?}"
            );
        }
    }

    #[test]
    fn exact_original_link_encoding_and_user_errors() {
        let hit = json!({"event_id":"11".repeat(32),"pubkey":"00".repeat(32),"kind":21});
        assert_eq!(
            event_link(&hit).unwrap(),
            "nevent1qvzqqqqqz5pzqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqspzyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygkwe5va"
        );
        let mut no_kind = hit.clone();
        no_kind.as_object_mut().unwrap().remove("kind");
        assert_eq!(
            event_link(&no_kind).unwrap(),
            "nevent1qvzqqqqqqqpzqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqspzyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg0vuz87"
        );
        let mut address = hit;
        address["kind"] = json!(34235);
        address["identifier"] = json!("intro");
        assert_eq!(
            event_link(&address).unwrap(),
            "naddr1qvzqqqy9hvpzqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqzkjmn5wfhsv6fye5"
        );
        for invalid in ["not-bech32", "note1qqqq", "xyz"] {
            assert!(
                normalize_user(invalid)
                    .unwrap_err()
                    .to_string()
                    .starts_with("User must")
            );
        }
        assert_eq!(
            normalize_user(&"AB".repeat(32)).unwrap(),
            Some("ab".repeat(32))
        );
    }

    #[tokio::test]
    async fn indexed_hints_backfill_and_personalized_ranking() {
        use axum::{Json, Router, extract::State, routing::post};
        use std::sync::{Arc, Mutex};
        let requests = Arc::new(Mutex::new(Vec::<Value>::new()));
        let source = json!({"event_id":"11".repeat(32),"pubkey":"00".repeat(32),"kind":21,"title":"Nostr","tags":["nostr"],"language":"en"});
        let candidate = |id: u8, author: &str, rank: f64| json!({"event_id":format!("{id:02x}").repeat(32),"pubkey":author.repeat(32),"kind":21,"title":"Nostr","tags":["nostr"],"_rankingScore":rank});
        let c1 = candidate(2, "00", 0.9);
        let c2 = candidate(3, "22", 0.8);
        let c3 = candidate(4, "33", 0.7);
        let state = (
            requests.clone(),
            source.clone(),
            c1.clone(),
            c2.clone(),
            c3.clone(),
        );
        type HandlerState = (Arc<Mutex<Vec<Value>>>, Value, Value, Value, Value);
        let app = Router::new()
            .route(
                "/indexes/videos/search",
                post(
                    |State((requests, source, c1, c2, c3)): State<HandlerState>,
                     Json(body): Json<Value>| async move {
                        let mut requests = requests.lock().unwrap();
                        requests.push(body.clone());
                        let filters = body["filter"].to_string();
                        let hits =
                            if filters.contains("event_id =") || filters.contains("identifier =") {
                                vec![source]
                            } else if body.get("sort").is_none() {
                                vec![c1.clone(), c2.clone()]
                            } else if filters.contains("pubkey =") {
                                vec![c1, c3]
                            } else {
                                vec![c2]
                            };
                        Json(json!({"hits":hits}))
                    },
                ),
            )
            .with_state(state);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let service =
            RecommendationService::new(Meili::new(format!("http://{addr}"), String::new()));
        let user = "aa".repeat(32);
        let cached =
            json!({"tagAffinity":{},"authorAffinity":{("22".repeat(32)):1.0},"kindAffinity":{}});
        service
            .profiles
            .get_or_try_insert(user.clone(), 60_000, || async { Ok(cached) })
            .await
            .unwrap();
        let reference = encoded(
            "nevent",
            &[
                (0, &[17; 32]),
                (1, b"https://example.com"),
                (1, b"bad relay"),
            ],
        );
        let output = service.related(&json!({"videoRef":reference,"user":user,"limit":4,"excludeContentWarnings":true,"presetFilters":["safe = true"]})).await.unwrap().unwrap();
        assert_eq!(output.len(), 3);
        let authors: Vec<_> = output.iter().map(|v| s(v, "pubkey")).collect();
        assert!(
            authors.iter().position(|v| *v == "22".repeat(32)).unwrap()
                < authors.iter().position(|v| *v == "00".repeat(32)).unwrap()
        );
        {
            let requests = requests.lock().unwrap();
            assert_eq!(requests.len(), 4);
            assert_eq!(requests[1]["q"], "Nostr nostr Nostr nostr");
            assert!(requests[1]["filter"].to_string().contains("language = "));
            assert!(requests[1]["filter"].to_string().contains("safe = true"));
            assert_eq!(requests[2]["limit"], 2);
            assert_eq!(requests[3]["sort"], json!(["rankingScore:desc"]));
        }
        drop(requests);
        let address = encoded(
            "naddr",
            &[
                (0, b"intro"),
                (1, b"https://example.com"),
                (1, b"bad relay"),
                (2, &[0; 32]),
                (3, &34235u32.to_be_bytes()),
            ],
        );
        assert!(
            service
                .related(&json!({"videoRef":address,"limit":4}))
                .await
                .unwrap()
                .is_some()
        );
        server.abort();
    }
    #[tokio::test]
    async fn profile_uses_verified_relay_signals_and_indexed_videos() {
        use axum::{Json, Router, routing::post};
        use futures_util::{SinkExt, StreamExt};
        use nostr_sdk::prelude::{EventBuilder, EventId, FinalizeEvent, Keys, Kind, Tag};
        use tokio_tungstenite::tungstenite::Message;
        let keys = Keys::generate();
        let id = "11".repeat(32);
        let event = EventBuilder::new(Kind::from(7), "+")
            .tags([Tag::event(EventId::from_hex(&id).unwrap())])
            .finalize(&keys)
            .unwrap();
        let event = serde_json::to_value(event).unwrap();
        let relay_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let relay_addr = relay_listener.local_addr().unwrap();
        let relay = tokio::spawn(async move {
            let (stream, _) = relay_listener.accept().await.unwrap();
            let mut socket = tokio_tungstenite::accept_async(stream).await.unwrap();
            while let Some(Ok(message)) = socket.next().await {
                if let Message::Text(text) = message {
                    let request: Value = serde_json::from_str(&text).unwrap();
                    if request[0] == "REQ" {
                        let subscription = request[1].clone();
                        socket
                            .send(Message::Text(
                                json!(["EVENT", subscription, event]).to_string().into(),
                            ))
                            .await
                            .unwrap();
                        socket
                            .send(Message::Text(
                                json!(["EOSE", subscription]).to_string().into(),
                            ))
                            .await
                            .unwrap();
                    }
                }
            }
        });
        let video = json!({"event_id":id,"kind":21,"pubkey":"author","tags":["Nostr"]});
        let app = Router::new().route(
            "/indexes/videos/search",
            post(move |Json(body): Json<Value>| {
                let video = video.clone();
                async move {
                    assert!(body["filter"].to_string().contains("event_id ="));
                    Json(json!({"hits":[video]}))
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let service =
            RecommendationService::new(Meili::new(format!("http://{addr}"), String::new()));
        let profile = service
            .build_profile_from_relays(keys.public_key().to_hex(), &[format!("ws://{relay_addr}")])
            .await
            .unwrap();
        assert_eq!(profile["tagAffinity"]["nostr"], 1.0);
        assert_eq!(profile["authorAffinity"]["author"], 1.0);
        assert_eq!(profile["likedEventIds"], json!([id]));
        relay.abort();
        server.abort();
    }
}

use crate::nip19::Nip19Checksum;
use crate::{
    cache::AsyncCache,
    net::{Meili, fetch_events, video_search},
    util::{env_bool, env_list, env_u64, quote, truncate},
};
use anyhow::{Result, anyhow};
use bech32::{Hrp, primitives::decode::CheckedHrpstring};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};

fn s<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k).and_then(Value::as_str).unwrap_or("")
}
fn n(v: &Value, k: &str) -> f64 {
    v.get(k).and_then(Value::as_f64).unwrap_or(0.0)
}
fn arr(v: &Value, k: &str) -> Vec<String> {
    v.get(k)
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}
fn clamp(x: f64) -> f64 {
    if x.is_finite() {
        x.clamp(0.0, 1.0)
    } else {
        0.0
    }
}
fn identifier(v: &Value) -> &str {
    v.get("identifier")
        .and_then(Value::as_str)
        .or_else(|| v.get("d_tag").and_then(Value::as_str))
        .unwrap_or("")
}
fn address(v: &Value) -> Option<String> {
    let k = v.get("kind")?.as_u64()?;
    let p = s(v, "pubkey");
    let d = identifier(v);
    if k == 0 || p.is_empty() || d.is_empty() {
        None
    } else {
        Some(format!("{k}:{p}:{d}"))
    }
}

pub fn parse_video_ref(input: &str) -> Result<Value> {
    let input = input.trim();
    if input.len() == 64 && input.bytes().all(|c| c.is_ascii_hexdigit()) {
        return Ok(json!({"type":"event","eventId":input.to_lowercase(),"relays":[]}));
    }
    if input.len() > 5000 {
        return Err(anyhow!("videoRef too long"));
    }
    let decoded = CheckedHrpstring::new::<Nip19Checksum>(input)?;
    decoded.validate_segwit_padding()?;
    let prefix = decoded.hrp().to_string();
    if prefix != "nevent" && prefix != "naddr" {
        return Err(anyhow!(
            "Unsupported videoRef. Expected nevent, naddr, or raw event id."
        ));
    }
    let data: Vec<u8> = decoded.byte_iter().collect();
    let mut fields: HashMap<u8, Vec<&[u8]>> = HashMap::new();
    let mut rest = data.as_slice();
    while !rest.is_empty() {
        if rest.len() < 2 || rest.len() < 2 + rest[1] as usize {
            return Err(anyhow!("Invalid NIP-19 TLV"));
        }
        let len = rest[1] as usize;
        fields.entry(rest[0]).or_default().push(&rest[2..2 + len]);
        rest = &rest[2 + len..];
    }
    let first = |tag: u8| fields.get(&tag).and_then(|v| v.first()).copied();
    let special = first(0).ok_or_else(|| anyhow!("Missing NIP-19 TLV 0"))?;
    let relays = fields
        .get(&1)
        .into_iter()
        .flatten()
        .map(|bytes| std::str::from_utf8(bytes).map(str::to_owned))
        .collect::<std::result::Result<Vec<_>, _>>()?;
    if let Some(author) = first(2) {
        if author.len() != 32 {
            return Err(anyhow!("Invalid NIP-19 author"));
        }
    }
    if let Some(kind) = first(3) {
        if kind.len() != 4 {
            return Err(anyhow!("Invalid NIP-19 kind"));
        }
    }
    if prefix == "nevent" {
        if special.len() != 32 {
            return Err(anyhow!("Invalid NIP-19 event id"));
        }
        Ok(json!({"type":"event","eventId":hex::encode(special),"relays":relays}))
    } else {
        let author = first(2).ok_or_else(|| anyhow!("Missing NIP-19 author"))?;
        let kind = first(3).ok_or_else(|| anyhow!("Missing NIP-19 kind"))?;
        Ok(
            json!({"type":"address","kind":u32::from_be_bytes(kind.try_into()?),"pubkey":hex::encode(author),"identifier":std::str::from_utf8(special)?,"relays":relays}),
        )
    }
}
fn event_link(v: &Value) -> Result<String> {
    let kind = v.get("kind").and_then(Value::as_u64).unwrap_or(0) as u32;
    let address = matches!(kind, 34235 | 34236) && !identifier(v).is_empty();
    let mut data = Vec::new();
    let mut push = |tag: u8, bytes: &[u8]| -> Result<()> {
        let len = u8::try_from(bytes.len()).map_err(|_| anyhow!("NIP-19 TLV too long"))?;
        data.extend_from_slice(&[tag, len]);
        data.extend_from_slice(bytes);
        Ok(())
    };
    push(3, &kind.to_be_bytes())?;
    if address || !s(v, "pubkey").is_empty() {
        push(2, &hex::decode(s(v, "pubkey"))?)?;
    }
    if address {
        push(0, identifier(v).as_bytes())?;
    } else {
        push(0, &hex::decode(s(v, "event_id"))?)?;
    }
    Ok(bech32::encode::<Nip19Checksum>(
        Hrp::parse(if address { "naddr" } else { "nevent" })?,
        &data,
    )?)
}
fn normalize_user(input: &str) -> Result<Option<String>> {
    let input = input.trim();
    if input.is_empty() {
        return Ok(None);
    }
    if input.len() == 64 && input.bytes().all(|c| c.is_ascii_hexdigit()) {
        return Ok(Some(input.to_lowercase()));
    }
    let decoded = CheckedHrpstring::new::<Nip19Checksum>(input)
        .map_err(|_| anyhow!("User must be an npub or hex pubkey."))?;
    decoded
        .validate_segwit_padding()
        .map_err(|_| anyhow!("User must be an npub or hex pubkey."))?;
    let data: Vec<u8> = decoded.byte_iter().collect();
    if decoded.hrp().to_string() != "npub" || data.len() != 32 {
        return Err(anyhow!("User must be an npub or hex pubkey."));
    }
    Ok(Some(hex::encode(data)))
}
fn similarity(a: &Value, b: &Value) -> f64 {
    if let Some(x) = b.get("_rankingScore").and_then(Value::as_f64) {
        return clamp(x);
    }
    let tags = |v: &Value| -> HashSet<String> {
        arr(v, "tags")
            .into_iter()
            .map(|t| t.to_lowercase())
            .collect()
    };
    let words = |v: &Value| -> HashSet<String> {
        format!(
            "{} {} {}",
            s(v, "title"),
            s(v, "summary"),
            s(v, "content_preview")
        )
        .to_lowercase()
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|t| t.len() >= 3)
        .map(str::to_owned)
        .collect()
    };
    let overlap = |x: HashSet<String>, y: HashSet<String>| {
        let union = x.union(&y).count();
        if union == 0 {
            0.0
        } else {
            x.intersection(&y).count() as f64 / union as f64
        }
    };
    clamp(overlap(tags(a), tags(b)) * 0.65 + overlap(words(a), words(b)) * 0.35)
}
fn score(v: &Value, sim: f64, tag: f64, author: f64, kind: f64, logged: bool) -> f64 {
    let weighted = n(v, "reactionsCount") + n(v, "commentsCount") * 2.0 + n(v, "zapsCount") * 3.0;
    let engagement = clamp(1.0 - 1.0 / (1.0 + weighted / 10.0));
    let rank = clamp(n(v, "rankingScore"));
    let playlist = clamp(n(v, "playlistScore"));
    clamp(if logged {
        clamp(sim) * 0.48
            + clamp(tag) * 0.24
            + rank * 0.10
            + engagement * 0.05
            + clamp(author) * 0.05
            + clamp(kind) * 0.03
            + playlist * 0.05
    } else {
        clamp(sim) * 0.70 + rank * 0.15 + engagement * 0.10 + playlist * 0.05
    })
}
fn map_hit(v: &Value, score: f64) -> Result<Value> {
    let thumb = s(v, "thumbnail");
    let mut urls = Vec::new();
    for u in [s(v, "playableUrl").to_owned(), s(v, "videoUrl").to_owned()]
        .into_iter()
        .chain(arr(v, "fallbackUrls"))
    {
        if !u.is_empty() && !urls.contains(&u) {
            urls.push(u);
        }
    }
    let mut variants = vec![];
    if !thumb.is_empty() {
        let mut t = json!({"url":thumb,"fallbackUrls":[],"mediaType":"image"});
        if !s(v, "thumbnailBlurhash").is_empty() {
            t["blurhash"] = v["thumbnailBlurhash"].clone();
        }
        variants.push(t);
    }
    let kind = v.get("kind").and_then(Value::as_u64).unwrap_or(0);
    let mut out = json!({"id":s(v,"event_id"),"kind":kind,"pubkey":s(v,"pubkey"),"title":v.get("title").filter(|x| !x.is_null()).cloned().unwrap_or(json!("Untitled")),"images":if thumb.is_empty(){vec![]}else{vec![thumb]},"urls":urls,"duration":v.get("duration").filter(|x|!x.is_null()).cloned().unwrap_or(json!(0)),"created_at":v.get("created_at").filter(|x|!x.is_null()).cloned().unwrap_or(json!(0)),"link":event_link(v)?,"type":if kind==22||kind==34236 {"shorts"} else {"videos"},"language":v.get("language").cloned().unwrap_or(Value::Null),"languageSource":v.get("languageSource").cloned().unwrap_or(Value::Null),"languageConfidence":v.get("languageConfidence").cloned().unwrap_or(Value::Null),"captionLanguages":v.get("captionLanguages").filter(|x|x.is_array()).cloned().unwrap_or(json!([])),"contentWarning":v.get("contentWarning").cloned().unwrap_or(Value::Null),"thumbnailVariants":variants,"recommendationScore":score});
    if !identifier(v).is_empty() {
        out["identifier"] = json!(identifier(v));
    }
    for key in ["published_at", "mediaType"] {
        if let Some(x) = v.get(key).filter(|x| !x.is_null()) {
            out[key] = x.clone();
        }
    }
    Ok(out)
}
fn dedupe(source: &Value, hits: &[Value], exclude: bool) -> Vec<Value> {
    let mut seen = HashSet::new();
    let source_addr = address(source);
    hits.iter()
        .filter(|h| {
            if (!s(source, "event_id").is_empty() && s(source, "event_id") == s(h, "event_id"))
                || (source_addr.is_some() && source_addr == address(h))
                || (exclude && !s(h, "contentWarning").is_empty())
            {
                return false;
            }
            let key = address(h).unwrap_or_else(|| s(h, "event_id").to_owned());
            !key.is_empty() && seen.insert(key)
        })
        .cloned()
        .collect()
}

fn refs(events: &[Value]) -> (Vec<String>, Vec<String>, HashMap<String, f64>) {
    let mut ids = Vec::new();
    let mut addresses = Vec::new();
    let mut weights = HashMap::new();
    for e in events {
        let weight = match e.get("kind").and_then(Value::as_u64) {
            Some(7) => 1.0,
            Some(1) => 0.5,
            Some(9735) => 3.0,
            _ => continue,
        };
        for tag in crate::domain::tags(e) {
            if tag.len() < 2 {
                continue;
            }
            let value = &tag[1];
            let key = match tag[0].as_str() {
                "e" if value.len() == 64 && value.bytes().all(|x| x.is_ascii_hexdigit()) => {
                    let id = value.to_lowercase();
                    if !ids.contains(&id) {
                        ids.push(id.clone())
                    }
                    format!("e:{id}")
                }
                "a" if !value.is_empty() => {
                    if !addresses.contains(value) {
                        addresses.push(value.clone())
                    }
                    format!("a:{value}")
                }
                _ => continue,
            };
            *weights.entry(key).or_insert(0.0) += weight;
        }
    }
    (ids, addresses, weights)
}
fn profile(pubkey: &str, events: &[Value], videos: &[Value]) -> Value {
    let (ids, addresses, weights) = refs(events);
    let mut tags = HashMap::<String, f64>::new();
    let mut authors = HashMap::<String, f64>::new();
    let mut kinds = HashMap::<String, f64>::new();
    for v in videos {
        let e = *weights
            .get(&format!("e:{}", s(v, "event_id")))
            .unwrap_or(&0.0);
        let a = address(v)
            .and_then(|a| weights.get(&format!("a:{a}")).copied())
            .unwrap_or(0.0);
        let w = e.max(a);
        if w <= 0.0 {
            continue;
        }
        for t in arr(v, "tags") {
            *tags.entry(t.to_lowercase()).or_default() += w;
        }
        if !s(v, "pubkey").is_empty() {
            *authors.entry(s(v, "pubkey").to_owned()).or_default() += w;
        }
        if let Some(k) = v.get("kind").and_then(Value::as_u64) {
            *kinds.entry(k.to_string()).or_default() += w;
        }
    }
    fn normalize(mut m: HashMap<String, f64>) -> HashMap<String, f64> {
        let max = m.values().copied().fold(0.0, f64::max);
        if max > 0.0 {
            for v in m.values_mut() {
                *v = clamp(*v / max)
            }
        }
        m
    }
    json!({"pubkey":pubkey,"computedAt":crate::util::now_ms(),"tagAffinity":normalize(tags),"authorAffinity":normalize(authors),"kindAffinity":normalize(kinds),"likedEventIds":ids,"likedAddresses":addresses})
}
fn affinities(v: &Value, p: &Value) -> (f64, f64, f64) {
    let tags = arr(v, "tags");
    let tag = if tags.is_empty() {
        0.0
    } else {
        tags.iter()
            .map(|t| n(&p["tagAffinity"], &t.to_lowercase()))
            .sum::<f64>()
            / tags.len() as f64
    };
    (
        clamp(tag),
        clamp(n(&p["authorAffinity"], s(v, "pubkey"))),
        clamp(n(
            &p["kindAffinity"],
            &v.get("kind")
                .and_then(Value::as_u64)
                .unwrap_or(0)
                .to_string(),
        )),
    )
}
fn query(source: &Value) -> String {
    let title = s(source, "title");
    let title = if crate::domain::is_placeholder_title(Some(title)) {
        ""
    } else {
        title
    };
    let tags = arr(source, "tags");
    let mut primary = Vec::new();
    for _ in 0..2 {
        if !title.is_empty() {
            primary.push(title.to_owned())
        }
        primary.extend(tags.iter().filter(|x| !x.is_empty()).cloned());
    }
    let secondary = truncate(
        &[s(source, "summary"), s(source, "content_preview")]
            .into_iter()
            .filter(|x| !x.is_empty())
            .collect::<Vec<_>>()
            .join(" "),
        150,
    );
    if !secondary.is_empty() {
        primary.push(secondary)
    }
    truncate(&primary.join(" "), 600)
}
fn filters(source: &Value, input: &Value) -> Vec<String> {
    let mut f = Vec::new();
    match source.get("kind").and_then(Value::as_u64) {
        Some(22 | 34236) => f.push("(kind = 22 OR kind = 34236)".into()),
        Some(21 | 34235) => f.push("(kind = 21 OR kind = 34235)".into()),
        _ => {
            if !s(source, "mediaType").is_empty() {
                f.push(format!("mediaType = {}", quote(s(source, "mediaType"))))
            }
        }
    }
    let language = input.get("language");
    if !matches!(language, Some(Value::Null)) && language.and_then(Value::as_str) != Some("any") {
        let raw = match language {
            Some(Value::String(x)) => vec![x.clone()],
            Some(Value::Array(_)) => arr(input, "language"),
            _ => vec![],
        };
        let langs: Vec<_> = crate::domain::normalize_languages(&raw)
            .into_iter()
            .filter(|x| x != "any")
            .collect();
        if langs.len() == 1 {
            f.push(format!("language = {}", quote(&langs[0])))
        } else if langs.len() > 1 {
            f.push(format!(
                "({})",
                langs
                    .iter()
                    .map(|x| format!("language = {}", quote(x)))
                    .collect::<Vec<_>>()
                    .join(" OR ")
            ))
        } else if let Some(lang) = crate::domain::normalize_language(s(source, "language")) {
            f.push(format!("language = {}", quote(&lang)))
        }
    }
    f.extend(arr(input, "presetFilters"));
    f
}
fn hits(result: Value) -> Vec<Value> {
    result
        .get("hits")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}
fn cache_key(lookup: &Value) -> String {
    use sha2::{Digest, Sha256};
    let mut relays = arr(lookup, "relays");
    relays.sort();
    let digest = |x: &str| hex::encode(Sha256::digest(x.as_bytes()))[..16].to_owned();
    let r = if relays.is_empty() {
        String::new()
    } else {
        digest(&relays.join(","))
    };
    if s(lookup, "type") == "event" {
        format!("event:{}:{r}", s(lookup, "eventId"))
    } else {
        format!(
            "addr:{}:{}:{}:{r}",
            n(lookup, "kind"),
            s(lookup, "pubkey"),
            digest(s(lookup, "identifier"))
        )
    }
}

#[derive(Clone)]
pub struct RecommendationService {
    meili: Meili,
    source: AsyncCache,
    relay: AsyncCache,
    candidates: AsyncCache,
    profiles: AsyncCache,
}
impl RecommendationService {
    pub fn new(meili: Meili) -> Self {
        Self {
            meili,
            source: AsyncCache::default(),
            relay: AsyncCache::default(),
            candidates: AsyncCache::default(),
            profiles: AsyncCache::default(),
        }
    }
    async fn source_video(&self, reference: &str) -> Result<Value> {
        let mut lookup = parse_video_ref(reference)?;
        lookup["relays"] = json!(crate::relay_hints::sanitize_relay_hints(&arr(
            &lookup, "relays"
        )));
        let key = cache_key(&lookup);
        let this = self.clone();
        let hit = self
            .source
            .get_or_try_insert(
                key,
                env_u64("RECOMMENDATION_SOURCE_CACHE_TTL_MS", 300_000),
                move || async move { this.lookup(lookup).await },
            )
            .await?;
        if crate::domain::is_blocked_author(s(&hit, "pubkey")) {
            Ok(Value::Null)
        } else {
            Ok(hit)
        }
    }
    async fn lookup(&self, lookup: Value) -> Result<Value> {
        let mut f = if s(&lookup, "type") == "event" {
            vec![format!("event_id = {}", quote(s(&lookup, "eventId")))]
        } else {
            vec![
                format!("kind = {}", lookup["kind"]),
                format!("pubkey = {}", quote(s(&lookup, "pubkey"))),
                format!("identifier = {}", quote(s(&lookup, "identifier"))),
            ]
        };
        let found =
            hits(video_search(&self.meili, json!({"q":"","limit":1,"offset":0,"filter":f})).await?);
        if let Some(v) = found.into_iter().next() {
            return Ok(v);
        }
        if s(&lookup, "type") == "address" {
            f[2] = format!("d_tag = {}", quote(s(&lookup, "identifier")));
            let found = hits(
                video_search(&self.meili, json!({"q":"","limit":1,"offset":0,"filter":f})).await?,
            );
            if let Some(v) = found.into_iter().next() {
                return Ok(v);
            }
        }
        if arr(&lookup, "relays").is_empty() {
            return Ok(Value::Null);
        }
        let key = cache_key(&lookup);
        self.relay.get_or_try_insert(key,env_u64("RECOMMENDATION_REF_CACHE_TTL_MS",300_000),move || async move { let relays=crate::relay_hints::resolve_safe_relay_hints(&arr(&lookup,"relays")).await; if relays.is_empty(){return Ok(Value::Null)} let filter=if s(&lookup,"type")=="event" {json!({"ids":[lookup["eventId"]],"limit":1})} else {json!({"kinds":[lookup["kind"]],"authors":[lookup["pubkey"]],"#d":[lookup["identifier"]],"limit":1})}; let events=fetch_events(&relays,filter,env_u64("RECOMMENDATION_REF_MAX_WAIT_MS",5000)).await?; Ok(events.first().map(crate::domain::event_to_source_hit).unwrap_or(Value::Null)) }).await
    }
    async fn build_profile(&self, pubkey: String) -> Result<Value> {
        self.build_profile_from_relays(
            pubkey,
            &env_list("NOSTR_SOURCE_RELAYS", "wss://relay.nostu.be"),
        )
        .await
    }
    async fn build_profile_from_relays(&self, pubkey: String, relays: &[String]) -> Result<Value> {
        let events=fetch_events(relays,json!({"authors":[pubkey],"kinds":[7,1,9735],"limit":env_u64("RECOMMENDATION_SIGNAL_LIMIT",300)}),env_u64("RECOMMENDATION_SIGNAL_MAX_WAIT_MS",5000)).await?;
        let (ids, addresses, _) = refs(&events);
        let ef = ids
            .iter()
            .take(100)
            .map(|id| format!("event_id = {}", quote(id)))
            .collect::<Vec<_>>();
        let af = addresses
            .iter()
            .take(100)
            .filter_map(|a| {
                let mut p = a.splitn(3, ':');
                let kind = p.next()?.parse::<u64>().ok()?;
                let pk = p.next()?;
                let id = p.next()?;
                if pk.is_empty() || id.is_empty() {
                    return None;
                }
                Some(format!(
                    "(kind = {kind} AND pubkey = {} AND identifier = {})",
                    quote(pk),
                    quote(id)
                ))
            })
            .collect::<Vec<_>>();
        let mut videos = Vec::new();
        for f in [ef, af] {
            if !f.is_empty() {
                videos.extend(hits(video_search(&self.meili,json!({"q":"","limit":100,"offset":0,"filter":[format!("({})",f.join(" OR "))]})).await?));
            }
        }
        Ok(profile(&pubkey, &events, &videos))
    }
    async fn user_profile(&self, key: String) -> Option<Value> {
        if let Some(v) = self.profiles.get(&key).await {
            return Some(v);
        }
        let cache = self.profiles.clone();
        let this = self.clone();
        let ttl = env_u64("USER_RECOMMENDATION_PROFILE_TTL_MS", 1_800_000);
        if env_bool("RECOMMENDATION_BLOCK_ON_PROFILE_MISS") {
            let k = key.clone();
            cache
                .get_or_try_insert(key, ttl, move || async move { this.build_profile(k).await })
                .await
                .ok()
        } else {
            tokio::spawn(async move {
                let k = key.clone();
                if let Err(e) = cache
                    .get_or_try_insert(key, ttl, move || async move { this.build_profile(k).await })
                    .await
                {
                    eprintln!("Recommendation profile warmup failed: {e}");
                }
            });
            None
        }
    }
    async fn candidate_search(&self, source: &Value, input: &Value) -> Result<Vec<Value>> {
        let limit = input.get("limit").and_then(Value::as_u64).unwrap_or(10) as usize;
        let count = limit * 4;
        let filters = filters(source, input);
        let mut all=hits(video_search(&self.meili,json!({"q":query(source),"limit":count,"offset":0,"filter":filters,"showRankingScore":true})).await?);
        if all.len() < count && !s(source, "pubkey").is_empty() {
            let mut f = vec![format!("pubkey = {}", quote(s(source, "pubkey")))];
            f.extend(filters.clone());
            for mut hit in hits(video_search(&self.meili,json!({"q":"","limit":2.max((limit as f64*0.4).ceil() as usize),"offset":0,"filter":f,"sort":["rankingScore:desc"],"showRankingScore":true})).await?) {if let Some(o)=hit.as_object_mut(){o.remove("_rankingScore");} all.push(hit);}
        }
        let exclude = input
            .get("excludeContentWarnings")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let mut result = dedupe(source, &all, exclude);
        if result.len() < limit {
            for mut hit in hits(video_search(&self.meili,json!({"q":"","limit":count,"offset":0,"filter":filters,"sort":["rankingScore:desc"],"showRankingScore":true})).await?) {if let Some(o)=hit.as_object_mut(){o.remove("_rankingScore");} all.push(hit);}
            result = dedupe(source, &all, exclude);
        }
        Ok(result)
    }
    pub async fn related(&self, input: &Value) -> Result<Option<Vec<Value>>> {
        let source = self.source_video(s(input, "videoRef")).await?;
        if source.is_null() {
            return Ok(None);
        }
        let profile = if let Some(user) = normalize_user(s(input, "user"))? {
            self.user_profile(user).await
        } else {
            None
        };
        let identity = address(&source)
            .map(|a| format!("addr:{a}"))
            .unwrap_or_else(|| format!("event:{}", s(&source, "event_id")));
        let key = format!(
            "{}|{}|{}|{}|{}|{}|{}",
            identity,
            input.get("limit").unwrap_or(&Value::Null),
            input.get("language").unwrap_or(&Value::Null),
            input.get("excludeContentWarnings").unwrap_or(&Value::Null),
            input.get("presetPubkey").unwrap_or(&Value::Null),
            input.get("presetRevision").unwrap_or(&Value::Null),
            input.get("nsfwFilter").unwrap_or(&Value::Null)
        );
        let this = self.clone();
        let src = source.clone();
        let inp = input.clone();
        let candidates = self
            .candidates
            .get_or_try_insert(
                key,
                env_u64("RECOMMENDATION_CANDIDATE_CACHE_TTL_MS", 120_000),
                move || async move { Ok(json!(this.candidate_search(&src, &inp).await?)) },
            )
            .await?;
        let mut ranked: Vec<(Value, f64)> = candidates
            .as_array()
            .into_iter()
            .flatten()
            .filter(|c| s(c, "availabilityStatus") != "unavailable")
            .map(|c| {
                let (t, a, k) = profile
                    .as_ref()
                    .map(|p| affinities(c, p))
                    .unwrap_or((0.0, 0.0, 0.0));
                (
                    c.clone(),
                    score(c, similarity(&source, c), t, a, k, profile.is_some()),
                )
            })
            .collect();
        ranked.sort_by(|a, b| b.1.total_cmp(&a.1));
        let limit = input.get("limit").and_then(Value::as_u64).unwrap_or(10) as usize;
        let max = 2.max((limit as f64 * 0.3).floor() as usize);
        let mut selected = Vec::new();
        let mut deferred = Vec::new();
        let mut same = 0;
        for item in ranked {
            if selected.len() >= limit {
                break;
            }
            if s(&item.0, "pubkey") == s(&source, "pubkey") && same >= max {
                deferred.push(item)
            } else {
                if s(&item.0, "pubkey") == s(&source, "pubkey") {
                    same += 1
                }
                selected.push(item)
            }
        }
        for item in deferred {
            if selected.len() >= limit {
                break;
            }
            selected.push(item)
        }
        Ok(Some(
            selected
                .into_iter()
                .map(|(h, s)| map_hit(&h, s))
                .collect::<Result<Vec<_>>>()?,
        ))
    }
}
