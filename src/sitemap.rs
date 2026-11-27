#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn video() -> Value {
        json!({"event_id":"1".repeat(64),"pubkey":"0".repeat(64),"kind":21,"title":"Great & Video","thumbnail":"https://example.com/t?a=1&b=2","playableUrl":"https://example.com/v","hasPlayableMedia":true,"published_at":1700000000})
    }
    #[test]
    fn video_rules_and_encoding() {
        let mut v = video();
        let e = video_entry(&v, "https://nostu.be").unwrap();
        assert!(e.loc.starts_with("https://nostu.be/v/nevent1"));
        let xml = xml(&[e]);
        assert!(xml.contains("Great &amp; Video"));
        assert!(xml.contains("a=1&amp;b=2"));
        assert!(xml.contains("2023-11-14T22:13:20.000Z"));
        v["contentWarning"] = json!("nsfw");
        assert!(video_entry(&v, "https://nostu.be").is_none());
        v["contentWarning"] = json!(" ");
        v["kind"] = json!(34236);
        v["identifier"] = json!("abc");
        assert!(
            video_entry(&v, "https://nostu.be")
                .unwrap()
                .loc
                .contains("/short/naddr1")
        );
    }
    #[test]
    fn author_threshold_and_empty_xml() {
        let a = json!({"pubkey":"0".repeat(64),"videoCount":10});
        assert!(author_entry(&a, "https://nostu.be", 10).is_none());
        let a = json!({"pubkey":"0".repeat(64),"videoCount":11});
        assert!(
            author_entry(&a, "https://nostu.be", 10)
                .unwrap()
                .loc
                .contains("/p/nprofile1")
        );
        assert!(xml(&[]).ends_with("</urlset>\n"));
    }
    #[test]
    fn source_behavior_tables() {
        for (kind, path) in [
            (21, "/v/nevent1"),
            (22, "/short/nevent1"),
            (34235, "/v/naddr1"),
            (34236, "/short/naddr1"),
        ] {
            let mut hit = video();
            hit["kind"] = json!(kind);
            hit["identifier"] = json!("abc");
            assert!(
                video_entry(&hit, "https://example.com")
                    .unwrap()
                    .loc
                    .contains(path)
            );
        }
        for (key, value) in [
            ("kind", json!(1)),
            ("pubkey", json!("")),
            ("event_id", json!("")),
            ("contentWarning", json!("nsfw")),
            ("hasPlayableMedia", json!(false)),
            ("title", json!("Untitled")),
            ("title", json!("   ")),
            ("thumbnail", json!("  ")),
            ("playableUrl", Value::Null),
        ] {
            let mut hit = video();
            hit[key] = value;
            assert!(
                video_entry(&hit, "https://nostu.be").is_none(),
                "{key}: {hit}"
            );
        }
        let mut hit = video();
        hit["playableUrl"] = Value::Null;
        hit["videoUrl"] = json!(" https://example.com/fallback ");
        hit["duration"] = json!(124.7);
        hit["effectivePublishedAt"] = json!(1800000000);
        hit["summary"] = json!("x".repeat(250));
        let entry = video_entry(&hit, "https://nostu.be").unwrap();
        assert!(entry.lastmod.unwrap().starts_with("2027"));
        let v = entry.video.unwrap();
        assert_eq!(v.content, "https://example.com/fallback");
        assert_eq!(v.duration, Some(124));
        assert_eq!(v.description.len(), 200);
        for count in [0, 5, 10] {
            assert!(
                author_entry(
                    &json!({"pubkey":"0".repeat(64),"videoCount":count}),
                    "https://nostu.be",
                    10
                )
                .is_none()
            );
        }
        assert_eq!(
            author_entry(
                &json!({"npub":"nprofile1existing","videoCount":11}),
                "https://example.com",
                10
            )
            .unwrap()
            .loc,
            "https://example.com/p/nprofile1existing"
        );
    }
    #[tokio::test]
    async fn people_search_contract_has_no_sort() {
        use axum::{
            Json, Router,
            extract::{Path, State},
            routing::post,
        };
        let requests = std::sync::Arc::new(tokio::sync::Mutex::new(Vec::<(String, Value)>::new()));
        async fn search(
            State(requests): State<std::sync::Arc<tokio::sync::Mutex<Vec<(String, Value)>>>>,
            Path(index): Path<String>,
            Json(body): Json<Value>,
        ) -> Json<Value> {
            requests.lock().await.push((index.clone(), body));
            if index == "people" {
                Json(json!({"hits":[{"pubkey":"0".repeat(64),"videoCount":15}]}))
            } else {
                Json(json!({"hits":[]}))
            }
        }
        let app = Router::new()
            .route("/indexes/{index}/search", post(search))
            .with_state(requests.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let meili = crate::net::Meili::new(format!("http://{addr}"), "test-key".into());
        let output = build_sitemap(&meili).await.unwrap();
        server.abort();
        assert!(output.contains("/p/nprofile1"));
        let requests = requests.lock().await;
        let people = requests
            .iter()
            .find(|(index, _)| index == "people")
            .unwrap();
        assert!(people.1.get("sort").is_none());
        assert_eq!(people.1["filter"], json!(["videoCount > 10"]));
        assert!(requests.iter().any(|(index, body)| index == "videos"
            && body["sort"]
                == json!([
                    "rankingScore:desc",
                    "playlistScore:desc",
                    "effectivePublishedAt:desc"
                ])));
    }
}

use nostr::nips::nip19::{Nip19Profile, ToBech32};
use nostr_sdk::prelude::PublicKey;
use serde_json::{Value, json};
use std::collections::HashSet;

struct Entry {
    loc: String,
    lastmod: Option<String>,
    video: Option<Video>,
}
struct Video {
    title: String,
    description: String,
    thumbnail: String,
    content: String,
    duration: Option<u64>,
    published: Option<String>,
}
fn s<'a>(v: &'a Value, key: &str) -> &'a str {
    v[key].as_str().unwrap_or("")
}
fn date(v: &Value) -> Option<String> {
    let n = v.as_f64()?;
    if !n.is_finite() || n <= 0.0 {
        return None;
    }
    chrono::DateTime::from_timestamp_millis((n * 1000.0) as i64)
        .map(|d| d.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
}
fn first<'a>(v: &'a Value, keys: &[&str]) -> &'a Value {
    keys.iter()
        .map(|k| &v[*k])
        .find(|x| !x.is_null())
        .unwrap_or(&Value::Null)
}
fn video_entry(hit: &Value, origin: &str) -> Option<Entry> {
    let kind = hit["kind"].as_u64()?;
    if ![21, 22, 34235, 34236].contains(&kind) {
        return None;
    }
    let title = s(hit, "title").trim();
    let thumb = s(hit, "thumbnail").trim();
    if !s(hit, "contentWarning").trim().is_empty()
        || hit["hasPlayableMedia"] != true
        || title.is_empty()
        || title == "Untitled"
        || thumb.is_empty()
        || (s(hit, "playableUrl").trim().is_empty() && s(hit, "videoUrl").trim().is_empty())
    {
        return None;
    }
    let content = first(hit, &["playableUrl", "videoUrl"]).as_str()?.trim();
    if content.is_empty() {
        return None;
    }
    PublicKey::from_hex(s(hit, "pubkey")).ok()?;
    let encoded = if kind >= 30000 {
        let id = first(hit, &["identifier", "d_tag"]).as_str()?;
        if id.is_empty() {
            return None;
        }
        crate::nip19::address(id, s(hit, "pubkey"), kind as u32).ok()?
    } else {
        crate::nip19::event(s(hit, "event_id"), s(hit, "pubkey")).ok()?
    };
    let path = if kind == 22 || kind == 34236 {
        "short"
    } else {
        "v"
    };
    let desc = first(hit, &["summary", "content_preview"])
        .as_str()
        .unwrap_or("")
        .trim();
    let duration = hit["duration"]
        .as_f64()
        .filter(|v| *v > 0.0)
        .map(|v| v.floor() as u64);
    Some(Entry {
        loc: format!("{origin}/{path}/{encoded}"),
        lastmod: date(first(
            hit,
            &["effectivePublishedAt", "published_at", "created_at"],
        )),
        video: Some(Video {
            title: title.into(),
            description: crate::util::truncate(desc, 200),
            thumbnail: thumb.into(),
            content: content.into(),
            duration,
            published: date(first(hit, &["published_at", "created_at"])),
        }),
    })
}
fn author_entry(hit: &Value, origin: &str, min: u64) -> Option<Entry> {
    if hit["videoCount"].as_f64().unwrap_or(0.0) <= min as f64 {
        return None;
    }
    let npub = s(hit, "npub");
    let profile = if npub.starts_with("nprofile") {
        npub.to_string()
    } else {
        Nip19Profile::new(PublicKey::from_hex(s(hit, "pubkey")).ok()?, [])
            .to_bech32()
            .ok()?
    };
    Some(Entry {
        loc: format!("{origin}/p/{profile}"),
        lastmod: date(&hit["updatedAt"]),
        video: None,
    })
}
fn escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}
fn xml(entries: &[Entry]) -> String {
    let mut lines=vec!["<?xml version=\"1.0\" encoding=\"UTF-8\"?>".to_string(),"<urlset xmlns=\"http://www.sitemaps.org/schemas/sitemap/0.9\" xmlns:video=\"http://www.google.com/schemas/sitemap-video/1.1\">".into()];
    for e in entries {
        lines.push("  <url>".into());
        lines.push(format!("    <loc>{}</loc>", escape(&e.loc)));
        if let Some(d) = &e.lastmod {
            lines.push(format!("    <lastmod>{}</lastmod>", escape(d)));
        }
        if let Some(v) = &e.video {
            lines.push("    <video:video>".into());
            for (tag, value) in [
                ("thumbnail_loc", v.thumbnail.as_str()),
                ("title", v.title.as_str()),
                (
                    "description",
                    if v.description.is_empty() {
                        &v.title
                    } else {
                        &v.description
                    },
                ),
                ("content_loc", v.content.as_str()),
            ] {
                lines.push(format!(
                    "      <video:{tag}>{}</video:{tag}>",
                    escape(value)
                ));
            }
            if let Some(d) = v.duration.filter(|d| *d > 0) {
                lines.push(format!("      <video:duration>{d}</video:duration>"));
            }
            if let Some(d) = &v.published {
                lines.push(format!(
                    "      <video:publication_date>{}</video:publication_date>",
                    escape(d)
                ));
            }
            lines.push("    </video:video>".into());
        }
        lines.push("  </url>".into());
    }
    lines.push("</urlset>".into());
    lines.push(String::new());
    lines.join("\n")
}
pub async fn build_sitemap(meili: &crate::net::Meili) -> anyhow::Result<String> {
    let origin = std::env::var("SITEMAP_SITE_ORIGIN").unwrap_or_else(|_| "https://nostu.be".into());
    let origin = origin.trim_end_matches('/');
    let max = crate::util::env_u64("SITEMAP_MAX_URLS", 50000).min(50000) as usize;
    let min = crate::util::env_u64("SITEMAP_AUTHOR_MIN_VIDEOS", 10);
    let authors = crate::util::env_u64("SITEMAP_MAX_AUTHORS", 5000).min(max as u64);
    let result=meili.search("people",&json!({"q":"","limit":authors,"offset":0,"filter":[format!("videoCount > {min}")],"attributesToRetrieve":["pubkey","npub","videoCount","globalTrustScore","updatedAt"]})).await?;
    let mut entries: Vec<Entry> = result["hits"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|h| author_entry(h, origin, min))
        .collect();
    let mut seen = HashSet::new();
    let mut offset = 0;
    let mut filters = vec![
        "(kind = 21 OR kind = 22 OR kind = 34235 OR kind = 34236)".to_string(),
        "hasPlayableMedia = true".into(),
    ];
    filters.extend(
        crate::domain::blocked_author_pubkeys()
            .iter()
            .map(|p| format!("pubkey != {}", crate::util::quote(p))),
    );
    while entries.len() < max {
        let response=meili.search("videos",&json!({"q":"","limit":1000,"offset":offset,"filter":filters,"sort":["rankingScore:desc","playlistScore:desc","effectivePublishedAt:desc"],"attributesToRetrieve":["event_id","pubkey","kind","d_tag","identifier","title","summary","content_preview","thumbnail","videoUrl","playableUrl","mimeType","duration","published_at","created_at","effectivePublishedAt","contentWarning","hasPlayableMedia"]})).await?;
        let Some(hits) = response["hits"].as_array() else {
            break;
        };
        if hits.is_empty() {
            break;
        }
        for hit in hits {
            if entries.len() >= max {
                break;
            }
            if let Some(entry) = video_entry(hit, origin) {
                if seen.insert(entry.loc.clone()) {
                    entries.push(entry);
                }
            }
        }
        offset += hits.len();
        if hits.len() < 1000 {
            break;
        }
    }
    Ok(xml(&entries))
}
