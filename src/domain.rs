// The `expect` calls in this file parse constant patterns and data embedded at
// compile time (`include_str!`). A failure is a build-time programming error that
// every test hits immediately, never a runtime condition.
#![allow(
    clippy::expect_used,
    reason = "embedded data and constant patterns; failure is a build-time bug"
)]

use nostr_sdk::prelude::{Event, FromBech32, Nip19, PublicKey, ToBech32};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};

pub fn normalize_language(value: &str) -> Option<String> {
    let s = value.trim().replace('_', "-").to_lowercase();
    let mut parts = s.split('-');
    let first = parts.next()?;
    if !(2..=3).contains(&first.len()) || !first.bytes().all(|b| b.is_ascii_lowercase()) {
        return None;
    }
    if parts.any(|p| {
        !(2..=8).contains(&p.len())
            || !p
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
    }) {
        return None;
    }
    Some(s)
}
pub fn normalize_languages(input: &[String]) -> Vec<String> {
    let mut out = Vec::new();
    for s in input.iter().flat_map(|s| s.split(',')) {
        if let Some(s) = normalize_language(s) {
            if !out.contains(&s) {
                out.push(s);
            }
        }
    }
    out
}
pub fn tags(event: &Value) -> Vec<Vec<String>> {
    event
        .get("tags")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|v| {
                    v.as_array()?
                        .iter()
                        .map(|x| x.as_str().map(str::to_owned))
                        .collect()
                })
                .collect()
        })
        .unwrap_or_default()
}
pub fn first_tag(tags: &[Vec<String>], name: &str) -> Option<String> {
    tags.iter()
        .find(|t| t.first().map(String::as_str) == Some(name) && t.len() > 1)
        .map(|t| t[1].clone())
}
pub fn first_language_tag(tags: &[Vec<String>]) -> Option<String> {
    ["language", "lang", "locale"]
        .iter()
        .find_map(|n| first_tag(tags, n).and_then(|v| normalize_language(&v)))
}
pub fn derive_video_title(tags: &[Vec<String>], content: Option<&str>) -> String {
    if let Some(title) = first_tag(tags, "title").filter(|s| !s.is_empty()) {
        return title;
    }
    let alt = tags
        .iter()
        .find(|t| t.first().map(String::as_str) == Some("imeta"))
        .and_then(|t| t.iter().find_map(|s| s.strip_prefix("alt ")))
        .map(str::trim)
        .filter(|s| !s.is_empty());
    static URLS: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
        regex::Regex::new(r"https?://[^\s)]+").expect("constant URL pattern")
    });
    URLS.replace_all(alt.or(content).unwrap_or(""), " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}
pub fn is_placeholder_title(title: Option<&str>) -> bool {
    matches!(
        title.unwrap_or("").trim().to_lowercase().as_str(),
        "" | "untitled" | "untitled video"
    )
}
pub fn verify_event(value: &Value) -> bool {
    <Event as serde::Deserialize>::deserialize(value).is_ok_and(|e| e.verify().is_ok())
}
pub fn normalize_author_pubkey(input: &str) -> Option<String> {
    let s = input.trim();
    if s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Some(s.to_ascii_lowercase());
    }
    match Nip19::from_bech32(s).ok()? {
        Nip19::Pubkey(p) => Some(p.to_hex()),
        Nip19::Profile(p) => Some(p.public_key.to_hex()),
        _ => None,
    }
}
pub fn blocked_author_pubkeys() -> Vec<String> {
    let env = std::env::var("NOSTUBE_BLOCKED_AUTHORS")
        .or_else(|_| std::env::var("BLOCKED_AUTHOR_NPUBS"))
        .unwrap_or_default();
    let mut out = Vec::new();
    for s in std::iter::once("npub1jz42cy8qxw6dres86sn0cr42hww24pnjqssa4k9wxqvzm5l0mvqsq2f5ku")
        .chain(env.split(','))
    {
        if let Some(p) = normalize_author_pubkey(s) {
            if !out.contains(&p) {
                out.push(p);
            }
        }
    }
    out
}
pub fn is_blocked_author(pubkey: &str) -> bool {
    blocked_author_pubkeys().iter().any(|p| p == pubkey)
}
pub fn nostube_url(hit: &Value) -> String {
    let id = hit["event_id"].as_str().unwrap_or("");
    let pubkey = hit["pubkey"].as_str().unwrap_or("");
    let kind = hit["kind"].as_u64().unwrap_or(0);
    let base = if kind == 21 || kind == 34235 {
        "https://nostu.be/v"
    } else {
        "https://nostu.be/short"
    };
    let encoded = match hit["d_tag"].as_str() {
        Some(d_tag) if (30000..40000).contains(&kind) => {
            crate::nip19::address(d_tag, pubkey, kind as u32)
        }
        _ => crate::nip19::event(id, pubkey),
    }
    .unwrap_or_default();
    if kind == 21 {
        format!("{base}/{encoded}")
    } else {
        format!("{base}/{encoded}?author={pubkey}&video={id}")
    }
}
fn positive(s: Option<String>) -> Option<u64> {
    let s = s?;
    if s.is_empty() {
        return None;
    }
    let t = s.trim();
    let n = if t.is_empty() {
        0.0
    } else if let Some(x) = t.strip_prefix("0x").or_else(|| t.strip_prefix("0X")) {
        u64::from_str_radix(x, 16).ok()? as f64
    } else {
        t.parse::<f64>().ok()?
    };
    if n.is_finite() && n >= 0.0 {
        Some(n.floor() as u64)
    } else {
        None
    }
}
fn fields(tag: &[String]) -> HashMap<String, String> {
    tag.iter()
        .skip(1)
        .filter_map(|s| {
            s.split_once(' ')
                .map(|(k, v)| (k.to_owned(), v.trim().to_owned()))
        })
        .collect()
}
fn nsfw(tags: &[Vec<String>]) -> bool {
    tags.iter().any(|t| {
        let Some(v) = t.get(1) else {
            return false;
        };
        let v = v.trim().to_lowercase();
        match t.first().map(String::as_str) {
            Some("d") => ["xhamster", "porntubeai", "pmvhaven"]
                .iter()
                .any(|p| v.starts_with(p)),
            Some("source") => v == "xhamster",
            Some("client") => v == "porntubeai" || v == "pmvhaven",
            _ => false,
        }
    })
}
fn clamp(n: f64) -> f64 {
    if n.is_finite() {
        n.clamp(0.0, 1.0)
    } else {
        0.0
    }
}
fn has(v: Option<&Value>, key: &str) -> bool {
    v.and_then(|v| v.get(key))
        .and_then(Value::as_str)
        .is_some_and(|s| !s.trim().is_empty())
}
fn num(v: Option<&Value>, key: &str) -> f64 {
    v.and_then(|v| v.get(key))
        .and_then(Value::as_f64)
        .unwrap_or(0.0)
}
pub fn collect_words(docs: &[Value]) -> HashMap<String, u64> {
    static STOPWORDS: std::sync::LazyLock<HashSet<&str>> = std::sync::LazyLock::new(|| {
        "the and for are but not you all can was one our out get has him his how its new now see two who did let say she too use via this that with from have been will they what when your more than then into some also about after other their there these which would".split_whitespace().collect()
    });
    let mut counts = HashMap::new();
    for doc in docs {
        let mut seen = HashSet::new();
        let mut sources = vec![doc["title"].as_str().unwrap_or("")];
        if let Some(a) = doc["tags"].as_array() {
            sources.extend(a.iter().filter_map(Value::as_str));
        }
        if let Some(a) = doc["authorDisplayName"].as_str() {
            sources.push(a);
        }
        for s in sources {
            for word in s.to_lowercase().split(|c: char| !c.is_ascii_alphanumeric()) {
                if word.len() >= 3 && !STOPWORDS.contains(word) {
                    seen.insert(word.to_owned());
                }
            }
        }
        for word in seen {
            *counts.entry(word).or_insert(0) += 1;
        }
    }
    counts
}

// franc-min and trigram-utils model and algorithm: MIT, see franc-LICENSE.
fn detect_language(title: &str, summary: &str, content: Option<&str>) -> Option<(String, f64)> {
    use std::sync::LazyLock;
    type Model = HashMap<String, Vec<(String, HashMap<Vec<u16>, usize>)>>;
    static MODEL: LazyLock<Model> = LazyLock::new(|| {
        let raw: HashMap<String, Vec<(String, String)>> =
            serde_json::from_str(include_str!("franc_model.json"))
                .expect("embedded franc_model.json is valid");
        raw.into_iter()
            .map(|(script, languages)| {
                let languages = languages
                    .into_iter()
                    .map(|(language, model)| {
                        let mut trigrams = HashMap::new();
                        for (rank, trigram) in model.split('|').enumerate() {
                            trigrams
                                .entry(trigram.encode_utf16().collect())
                                .or_insert(rank);
                        }
                        (language, trigrams)
                    })
                    .collect();
                (script, languages)
            })
            .collect()
    });
    type ScriptRanges = Vec<(String, Vec<(u32, u32)>)>;
    static SCRIPTS: LazyLock<ScriptRanges> = LazyLock::new(|| {
        let raw: HashMap<String, Vec<(u32, u32)>> =
            serde_json::from_str(include_str!("franc_scripts.json"))
                .expect("embedded franc_scripts.json is valid");
        [
            "cmn",
            "Latin",
            "Cyrillic",
            "Arabic",
            "ben",
            "Devanagari",
            "jpn",
            "jav",
            "kor",
            "tel",
            "tam",
            "guj",
            "kan",
            "mal",
            "mya",
            "pan",
            "amh",
            "tha",
            "sin",
            "ell",
        ]
        .iter()
        .map(|s| (s.to_string(), raw.get(*s).cloned().unwrap_or_default()))
        .collect()
    });
    let model = &*MODEL;
    let scripts = &*SCRIPTS;
    let joined = [title, summary, content.unwrap_or("")]
        .iter()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    let text = crate::util::truncate(&joined, 2000);
    let len = text.encode_utf16().count();
    if len < 40 {
        return None;
    }
    let mut top = "";
    let mut count = 0;
    for (name, ranges) in scripts {
        let n = text
            .chars()
            .filter(|c| ranges.iter().any(|(a, b)| (*a..=*b).contains(&(*c as u32))))
            .count();
        if n > count {
            count = n;
            top = name;
        }
    }
    if count == 0 {
        return None;
    }
    if !model.contains_key(top) {
        return iso_language(top).map(|s| (s, 1.0));
    }
    let clean = text
        .chars()
        .map(|c| {
            if ('\u{21}'..='\u{40}').contains(&c) {
                ' '
            } else {
                c
            }
        })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase();
    let padded: Vec<u16> = format!(" {clean} ").encode_utf16().collect();
    let mut trigrams: Vec<(Vec<u16>, usize)> = Vec::new();
    for tri in padded.windows(3) {
        if let Some((_, n)) = trigrams.iter_mut().find(|(t, _)| t == tri) {
            *n += 1;
        } else {
            trigrams.push((tri.to_vec(), 1));
        }
    }
    trigrams.sort_by_key(|(_, n)| *n);
    let mut distances: Vec<(&str, usize)> = model[top]
        .iter()
        .map(|(lang, m)| {
            let distance = trigrams
                .iter()
                .map(|(t, n)| {
                    m.get(t)
                        .map(|rank| (*n as isize - *rank as isize - 1).unsigned_abs())
                        .unwrap_or(300)
                })
                .sum();
            (lang.as_str(), distance)
        })
        .collect();
    distances.sort_by_key(|(_, d)| *d);
    let (language, min) = *distances.first()?;
    let denominator = len as f64 * 300.0 - min as f64;
    let second = distances
        .get(1)
        .map(|(_, d)| *d as f64)
        .unwrap_or(len as f64 * 300.0);
    let confidence = clamp((second - min as f64) / denominator);
    if confidence < 0.08 {
        return None;
    }
    iso_language(language).map(|s| (s, confidence))
}
fn iso_language(s: &str) -> Option<String> {
    static LANGUAGES: std::sync::LazyLock<HashMap<String, String>> =
        std::sync::LazyLock::new(|| {
            serde_json::from_str(include_str!("franc_languages.json"))
                .expect("embedded franc_languages.json is valid")
        });
    normalize_language(LANGUAGES.get(s).map(String::as_str).unwrap_or(s))
}

pub fn event_to_source_hit(event: &Value) -> Value {
    let ts = tags(event);
    let kind = event["kind"].as_u64().unwrap_or(0);
    let content = event["content"].as_str();
    let mut image = None;
    let mut blur = None;
    let mut url = None;
    let mut media = None;
    for t in ts
        .iter()
        .filter(|t| t.first().map(String::as_str) == Some("imeta"))
    {
        let f = fields(t);
        if image.is_none() {
            image = f.get("image").filter(|s| !s.is_empty()).cloned();
        }
        if blur.is_none() {
            blur = f.get("blurhash").filter(|s| !s.is_empty()).cloned();
        }
        if url.is_none() {
            if let (Some(u), Some(m)) = (f.get("url").filter(|s| !s.is_empty()), f.get("m")) {
                if m.starts_with("video/") || m.starts_with("audio/") {
                    url = Some(u.clone());
                    media = Some(if m.starts_with("video/") {
                        "video"
                    } else {
                        "audio"
                    });
                }
            }
        }
    }
    let thumbnail = first_tag(&ts, "thumb")
        .or_else(|| first_tag(&ts, "image"))
        .or(image);
    let url = url.or_else(|| first_tag(&ts, "url"));
    let media = media.or_else(|| url.as_ref().filter(|s| !s.is_empty()).map(|_| "video"));
    let summary = first_tag(&ts, "summary")
        .or_else(|| first_tag(&ts, "alt"))
        .unwrap_or_else(|| content.unwrap_or("").to_owned());
    let published = positive(first_tag(&ts, "published_at"));
    let language = first_language_tag(&ts);
    let d = first_tag(&ts, "d");
    let topics: Vec<String> = ts
        .iter()
        .filter(|t| t.first().map(String::as_str) == Some("t"))
        .filter_map(|t| t.get(1).filter(|s| !s.is_empty()).cloned())
        .collect();
    json!({"event_id":event["id"],"pubkey":event["pubkey"],"kind":kind,"created_at":event["created_at"],"published_at":published,"effectivePublishedAt":published.map(Value::from).unwrap_or_else(||event["created_at"].clone()),"identifier":d,"d_tag":d,"title":derive_video_title(&ts,content),"summary":summary,"content_preview":crate::util::truncate(&summary,200),"content":event["content"],"tags":topics,"duration":positive(first_tag(&ts,"duration")),"thumbnail":thumbnail,"thumbnailBlurhash":blur,"videoUrl":url,"mediaType":media,"isShort":kind==22||kind==34236,"isVideo":kind==21||kind==34235,"contentWarning":first_tag(&ts,"content-warning"),"language":language,"languageSource":if language.is_some(){Some("tag")}else{None},"languageConfidence":if language.is_some(){Some(1)}else{None},"captionLanguages":[],"rankingScore":0,"reactionsCount":0,"commentsCount":0,"zapsCount":0})
}

fn youtube(url: Option<&str>) -> bool {
    let Some(s) = url else {
        return false;
    };
    if let Ok(u) = url::Url::parse(s) {
        let h = u.host_str().unwrap_or("").to_lowercase();
        return h == "youtube.com"
            || h.ends_with(".youtube.com")
            || h == "youtu.be"
            || h.ends_with(".youtu.be");
    }
    static YOUTUBE: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
        regex::Regex::new(r"(?i)(^|//|\.)(youtube\.com|youtu\.be)(/|$)")
            .expect("constant YouTube pattern")
    });
    YOUTUBE.is_match(s)
}
fn media_from_url(url: Option<&str>) -> Option<&'static str> {
    let url = url?;
    if youtube(Some(url)) {
        return Some("video");
    }
    let s = url.split(['?', '#']).next().unwrap_or("").to_lowercase();
    let ext = s.rsplit('.').next().unwrap_or("");
    if ["mp3", "m4a", "aac", "ogg", "oga", "opus", "wav", "flac"].contains(&ext) && s.contains('.')
    {
        Some("audio")
    } else if ["mp4", "m4v", "webm", "mov", "mkv", "avi"].contains(&ext) && s.contains('.') {
        Some("video")
    } else {
        None
    }
}

pub fn event_to_document(
    event: &Value,
    profile: Option<&Value>,
    counts: Option<&Value>,
    url_stats: Option<&Value>,
    trust: f64,
    availability: Option<&Value>,
) -> Value {
    let ts = tags(event);
    let id = event["id"].as_str().unwrap_or("");
    let pubkey = event["pubkey"].as_str().unwrap_or("");
    let kind = event["kind"].as_u64().unwrap_or(0);
    let content = event["content"].as_str().filter(|s| !s.is_empty());
    let title = derive_video_title(&ts, content);
    let summary = first_tag(&ts, "summary")
        .or_else(|| first_tag(&ts, "alt"))
        .unwrap_or_else(|| content.unwrap_or("").to_owned());
    let mut candidates = Vec::new();
    for key in ["thumb", "image"] {
        if let Some(s) = first_tag(&ts, key).filter(|s| !s.is_empty()) {
            candidates.push(s);
        }
    }
    let mut images = Vec::new();
    let mut fallbacks = Vec::new();
    let mut video: Option<HashMap<String, String>> = None;
    let mut audio = None;
    for t in ts
        .iter()
        .filter(|t| t.first().map(String::as_str) == Some("imeta"))
    {
        for s in t.iter().skip(1) {
            if let Some((key, v)) = s.split_once(' ') {
                let v = v.trim();
                if !v.is_empty() {
                    if key == "image" {
                        images.push(v.to_owned());
                    } else if key == "fallback" || key == "mirror" {
                        fallbacks.push(v.to_owned());
                    }
                }
            }
        }
        let f = fields(t);
        if f.get("url").is_none_or(|v| v.is_empty()) {
            continue;
        }
        match f.get("m").map(String::as_str) {
            Some(m) if m.starts_with("video/") && video.is_none() => video = Some(f),
            Some(m) if m.starts_with("audio/") && audio.is_none() => audio = Some(f),
            _ => {}
        }
    }
    for image in images {
        if !candidates.contains(&image) {
            candidates.push(image);
        }
    }
    let playable = video.or(audio).unwrap_or_default();
    let video_url = playable
        .get("url")
        .cloned()
        .or_else(|| first_tag(&ts, "url"));
    let mime = playable.get("m").cloned();
    let media = mime
        .as_deref()
        .and_then(|s| {
            if s.starts_with("video/") {
                Some("video")
            } else if s.starts_with("audio/") {
                Some("audio")
            } else {
                None
            }
        })
        .or_else(|| media_from_url(video_url.as_deref()));
    let dimensions = playable.get("dim").and_then(|s| {
        let (w, h) = s.split_once(['x', 'X'])?;
        if !w.is_empty()
            && !h.is_empty()
            && w.bytes().all(|b| b.is_ascii_digit())
            && h.bytes().all(|b| b.is_ascii_digit())
        {
            Some((
                format!("{w}x{h}"),
                w.parse::<u64>().ok()?,
                h.parse::<u64>().ok()?,
            ))
        } else {
            None
        }
    });
    let mut tracks = Vec::new();
    let mut captions = Vec::new();
    let mut origins = Vec::new();
    for t in &ts {
        match t.first().map(String::as_str) {
            Some("text-track") => {
                let (u, l) = if t.get(1).is_some_and(|s| s.contains(' ')) {
                    let f = fields(t);
                    (
                        f.get("url").cloned().unwrap_or_default(),
                        f.get("lang").or_else(|| f.get("language")).cloned(),
                    )
                } else {
                    (t.get(1).cloned().unwrap_or_default(), t.get(2).cloned())
                };
                if !u.is_empty() {
                    if let Some(lang) = l.as_deref().and_then(normalize_language) {
                        if !captions.contains(&lang) {
                            captions.push(lang);
                        }
                    }
                    tracks.push(json!({"url":u,"lang":l}));
                }
            }
            Some("origin") => {
                let mut platform = t.get(1).cloned();
                let mut external = t.get(2).cloned();
                let mut url = t.get(3).cloned();
                let mut metadata = serde_json::Map::new();
                for s in t.iter().skip(1) {
                    let pair = if s.contains('=') {
                        s.split_once('=')
                    } else {
                        s.split_once(' ')
                    };
                    if let Some((k, v)) = pair {
                        let v = v.trim();
                        if k.is_empty() || v.is_empty() {
                            continue;
                        }
                        metadata.insert(k.to_owned(), json!(v));
                        match k {
                            "platform" => platform = Some(v.into()),
                            "id" | "externalId" | "external_id" => external = Some(v.into()),
                            "url" | "originalUrl" | "original_url" => url = Some(v.into()),
                            _ => {}
                        }
                    }
                }
                origins.push(json!({"platform":platform,"externalId":external,"originalUrl":url,"metadata":metadata}));
            }
            _ => {}
        }
    }
    let tag_language = first_language_tag(&ts);
    let local = if tag_language.is_none() {
        detect_language(&title, &summary, content)
    } else {
        None
    };
    let language = tag_language
        .clone()
        .or_else(|| local.as_ref().map(|x| x.0.clone()))
        .or_else(|| {
            if captions.len() == 1 {
                captions.first().cloned()
            } else {
                None
            }
        });
    let language_source = if tag_language.is_some() {
        Some("tag")
    } else if local.is_some() {
        Some("local")
    } else if captions.len() == 1 {
        Some("caption")
    } else {
        None
    };
    let confidence = match language_source {
        Some("tag") => Some(1.0),
        Some("local") => local.map(|x| x.1),
        Some("caption") => Some(0.8),
        _ => None,
    };
    let d = first_tag(&ts, "d");
    let doc_id = match d.as_deref() {
        Some(d) if (30000..40000).contains(&kind) => {
            format!("{kind}_{pubkey}_{}", hex::encode(d.as_bytes()))
        }
        _ => id.to_owned(),
    };
    let npub = PublicKey::from_hex(pubkey)
        .ok()
        .and_then(|p| p.to_bech32().ok())
        .unwrap_or_else(|| pubkey.to_owned());
    let thumbnail = candidates.first().cloned();
    let width = dimensions.as_ref().map(|x| x.1);
    let height = dimensions.as_ref().map(|x| x.2);
    let author_score = clamp(
        (if has(profile, "name") { 0.3 } else { 0.0 })
            + (if has(profile, "display_name") || has(profile, "username") {
                0.2
            } else {
                0.0
            })
            + (if has(profile, "about") { 0.2 } else { 0.0 })
            + (if has(profile, "picture") { 0.1 } else { 0.0 })
            + (if has(profile, "nip05") { 0.1 } else { 0.0 })
            + (if has(profile, "lud16") { 0.1 } else { 0.0 }),
    );
    let metadata_score = clamp(
        (if !title.is_empty() && title.trim() != "Untitled" {
            0.2
        } else {
            0.0
        }) + (if !summary.trim().is_empty() { 0.2 } else { 0.0 })
            + (if thumbnail.as_ref().is_some_and(|s| !s.trim().is_empty()) {
                0.2
            } else {
                0.0
            })
            + (if video_url.as_ref().is_some_and(|s| !s.trim().is_empty()) {
                0.2
            } else {
                0.0
            })
            + (if kind == 34235 || kind == 34236 {
                0.1
            } else {
                0.0
            })
            + (if width.unwrap_or(0) > 0 && height.unwrap_or(0) > 0 {
                0.1
            } else {
                0.0
            }),
    );
    let weighted = num(counts, "reactionsCount")
        + 2.0 * num(counts, "commentsCount")
        + 3.0 * num(counts, "zapsCount")
        + 0.5 * num(counts, "notesCount");
    let engagement = clamp(1.0 - 1.0 / (1.0 + weighted / 10.0));
    let total = num(url_stats, "urlsTotal");
    let available = num(url_stats, "urlsAvailable");
    let url_score = if total <= 0.0 {
        0.0
    } else {
        clamp(available / total)
    };
    let ranking = clamp(
        author_score * 0.25
            + metadata_score * 0.25
            + engagement * 0.2
            + clamp(trust) * 0.2
            + url_score * 0.1,
    );
    let hash = playable.get("x").cloned();
    let key = crate::media::media_availability_key(
        &json!({"hash":hash,"videoUrl":video_url,"fallbackUrls":fallbacks}),
    );
    let snapshot = crate::media::snapshot_from_availability(key.as_deref(), availability);
    let topics: Vec<String> = ts
        .iter()
        .filter(|t| t.first().map(String::as_str) == Some("t"))
        .filter_map(|t| t.get(1))
        .map(|s| s.trim().to_lowercase())
        .filter(|s| !s.is_empty())
        .collect();
    let warning = first_tag(&ts, "content-warning")
        .filter(|s| !s.trim().is_empty())
        .or_else(|| {
            if nsfw(&ts) {
                Some("NSFW".to_owned())
            } else {
                None
            }
        });
    let published = positive(first_tag(&ts, "published_at"));
    let created = event["created_at"].clone();
    let native = !origins.iter().any(|o| {
        o["platform"]
            .as_str()
            .is_some_and(|s| s.to_lowercase() == "youtube")
    }) && !youtube(video_url.as_deref());
    let author_name = profile
        .and_then(|p| {
            p.get("display_name")
                .filter(|v| !v.is_null())
                .or_else(|| p.get("username").filter(|v| !v.is_null()))
                .or_else(|| p.get("name").filter(|v| !v.is_null()))
        })
        .cloned();
    json!({"id":doc_id,"event_id":id,"pubkey":pubkey,"npub":npub,"kind":kind,"identifier":d,"title":title,"summary":summary,"content_preview":crate::util::truncate(&summary,200),"content":content,"created_at":created,"published_at":published,"effectivePublishedAt":published.map(Value::from).unwrap_or(created),"duration":positive(first_tag(&ts,"duration")),"tags":topics,"thumbnail":thumbnail,"candidateThumbnails":candidates,"thumbnailBlurhash":playable.get("blurhash"),"videoUrl":video_url,"mimeType":mime,"mediaType":media,"dimensions":dimensions.as_ref().map(|x|&x.0),"width":width,"height":height,"isHd":height.unwrap_or(0)>=720,"isShort":kind==22||kind==34236,"isVideo":kind==21||kind==34235,"isNostrNative":native,"size":positive(playable.get("size").cloned()),"hash":hash,"fallbackUrls":fallbacks,"mediaAvailabilityKey":snapshot["mediaAvailabilityKey"],"availabilityStatus":snapshot["availabilityStatus"],"hasPlayableMedia":snapshot["hasPlayableMedia"],"playableUrl":snapshot["playableUrl"],"mediaCheckedAt":snapshot["mediaCheckedAt"],"mediaRetryAfter":snapshot["mediaRetryAfter"],"contentWarning":warning,"language":language,"languageSource":language_source,"languageConfidence":confidence,"captionLanguages":captions,"textTracks":tracks,"hasCaptions":!tracks.is_empty(),"origins":origins,"nostrUrl":nostube_url(&json!({"event_id":id,"pubkey":pubkey,"kind":kind,"d_tag":d})),"d_tag":d,"authorDisplayName":author_name,"relatedEventsTotal":num(counts,"relatedEventsTotal"),"reactionsCount":num(counts,"reactionsCount"),"commentsCount":num(counts,"commentsCount"),"zapsCount":num(counts,"zapsCount"),"urlsAvailable":available,"urlsTotal":total,"authorProfileCompleteness":author_score,"videoMetadataCompleteness":metadata_score,"globalTrustScore":trust,"rankingScore":ranking,"playlistScore":0})
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn language_normalization_and_precedence() {
        assert_eq!(normalize_language(" PT_BR ").as_deref(), Some("pt-br"));
        assert_eq!(
            normalize_language("zh-Hant-TW").as_deref(),
            Some("zh-hant-tw")
        );
        for s in ["", "e", "english", "en OR true", "en-"] {
            assert_eq!(normalize_language(s), None);
        }
        assert_eq!(
            normalize_languages(&["en,DE".into(), "de, pt_BR".into(), "invalid!".into()]),
            vec!["en", "de", "pt-br"]
        );
        let t = vec![
            vec!["locale".into(), "fr".into()],
            vec!["lang".into(), "en".into()],
            vec!["language".into(), "DE".into()],
        ];
        assert_eq!(first_language_tag(&t).as_deref(), Some("de"));
    }
    #[test]
    fn title_and_malformed_tags() {
        let e = json!({"tags":[["title","猫"],["bad",1],["imeta","alt Watch https://x.y/v now"]]});
        let t = tags(&e);
        assert_eq!(t.len(), 2);
        assert_eq!(derive_video_title(&t, Some("content")), "猫");
        assert_eq!(derive_video_title(&t[1..], None), "Watch now");
        assert_eq!(
            derive_video_title(&[], Some("跳个舞 https://x.y/v #美女")),
            "跳个舞 #美女"
        );
        assert!(is_placeholder_title(Some(" Untitled Video ")));
    }
    #[test]
    fn metadata_precedence_and_unicode_identifier() {
        let event = json!({"id":"11".repeat(32),"pubkey":"22".repeat(32),"kind":34235,"created_at":123,"content":"hello", "tags":[["d","猫"],["thumb","first"],["image","second"],["imeta","url https://a/audio.mp3","m audio/mpeg","image third"],["imeta","url https://a/video.mp4","m video/mp4","dim 1920x1080","image fourth","fallback https://a/backup"],["language","DE"],["text-track","url https://a/sub","lang en"],["source","xhamster"]]});
        let doc = event_to_document(&event, None, None, None, 0.5, None);
        assert_eq!(doc["id"], format!("34235_{}_e78cab", "22".repeat(32)));
        assert_eq!(doc["thumbnail"], "first");
        assert_eq!(doc["videoUrl"], "https://a/video.mp4");
        assert_eq!(doc["language"], "de");
        assert_eq!(doc["contentWarning"], "NSFW");
        assert_eq!(doc["captionLanguages"], json!(["en"]));
        assert_eq!(doc["isHd"], true);
        let source = event_to_source_hit(&event);
        assert_eq!(source["videoUrl"], "https://a/audio.mp3");
    }
    #[test]
    fn nip19_blocked_and_invalid_events() {
        let pubkey = "90aaac10e033b4d1e607d426fc0eaabb9caa86720421dad8ae30182dd3efdb01";
        assert_eq!(
            normalize_author_pubkey(
                "npub1jz42cy8qxw6dres86sn0cr42hww24pnjqssa4k9wxqvzm5l0mvqsq2f5ku"
            )
            .as_deref(),
            Some(pubkey)
        );
        assert!(is_blocked_author(pubkey));
        assert_eq!(normalize_author_pubkey("npub1invalid"), None);
        assert!(!verify_event(&json!({"id":"bad"})));
    }
    #[test]
    fn nip19_profile_and_signed_event_validation() {
        let profile = "nprofile1qyxhwumn8ghj7mn0wvhxcmmvqy28wumn8ghj7un9d3shjtnyv9kh2uewd9hsz9nhwden5te0wfjkccte9ec8y6tdv9kzumn9wsq3gamnwvaz7tmwdaehgu3wdau8gu3wv3jhvqgcwaehxw309aex2mrp0yhxg6tkd9hx2tnkd9jx2mcqyzg24tqsuqemf50xql2zdlqw42aee25xwgzzrkkc4ccpstwnaldszz9qqn5";
        assert_eq!(
            normalize_author_pubkey(profile).as_deref(),
            Some("90aaac10e033b4d1e607d426fc0eaabb9caa86720421dad8ae30182dd3efdb01")
        );
        use nostr_sdk::prelude::FinalizeEvent;
        let keys = nostr_sdk::prelude::Keys::generate();
        let event =
            nostr_sdk::prelude::EventBuilder::new(nostr_sdk::prelude::Kind::from(1), "hello")
                .finalize(&keys)
                .unwrap();
        let mut value = serde_json::to_value(event).unwrap();
        assert!(verify_event(&value));
        value["content"] = json!("tampered");
        assert!(!verify_event(&value));
    }
    #[test]
    fn vocabulary_counts_once_per_document() {
        let docs = vec![
            json!({"title":"Nostr NOSTR search","tags":["nostr","bitcoin"],"authorDisplayName":"Nostr Alice"}),
            json!({"title":"Nostr videos","tags":[],"authorDisplayName":null}),
        ];
        let words = collect_words(&docs);
        assert_eq!(words.get("nostr"), Some(&2));
        assert_eq!(words.get("alice"), Some(&1));
        assert!(!words.contains_key("the"));
    }
    #[test]
    fn franc_language_detection_and_single_scripts() {
        assert_eq!(
            detect_language(
                "Dies ist ein Video ueber Nostr und Bitcoin",
                "Eine laengere Beschreibung hilft dabei, die Sprache eindeutig zu erkennen.",
                None
            )
            .map(|x| x.0)
            .as_deref(),
            Some("de")
        );
        assert_eq!(
            detect_language(
                "This is a video about Nostr and Bitcoin",
                "A longer description helps the detector identify the language reliably.",
                None
            )
            .map(|x| x.0)
            .as_deref(),
            Some("en")
        );
        assert!(detect_language("Nostr update", "", None).is_none());
        assert_eq!(
            detect_language(&"한글".repeat(25), "", None)
                .map(|x| x.0)
                .as_deref(),
            Some("ko")
        );
    }
    #[test]
    fn scoring_and_metadata_fallback() {
        let event = json!({"id":"11".repeat(32),"pubkey":"22".repeat(32),"kind":21,"created_at":1,"content":"", "tags":[["title","Video"],["summary","Description"],["thumb","https://image"],["url","https://video.mp4"],["text-track","u","pt_BR"]]});
        let doc = event_to_document(
            &event,
            Some(
                &json!({"name":"A","username":"a","about":"b","picture":"c","nip05":"d","lud16":"e"}),
            ),
            Some(&json!({"reactionsCount":1,"commentsCount":1,"zapsCount":2,"notesCount":2})),
            Some(&json!({"urlsAvailable":1,"urlsTotal":4})),
            0.5,
            None,
        );
        assert!((doc["authorProfileCompleteness"].as_f64().unwrap() - 1.0).abs() < 1e-12);
        assert!((doc["videoMetadataCompleteness"].as_f64().unwrap() - 0.8).abs() < 1e-12);
        assert_eq!(doc["language"], "pt-br");
        assert_eq!(doc["languageSource"], "caption");
        assert!((doc["rankingScore"].as_f64().unwrap() - 0.675).abs() < 1e-12);
    }
}
