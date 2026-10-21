# HTTP API

The API is unauthenticated. All data endpoints live under `/api/*`; responses are JSON. Successful `GET /api/*` responses carry `Cache-Control` headers for CDN/reverse-proxy caching. The built-in web UI is served at `/`; `/health` checks MeiliSearch connectivity.

Base URL in the default Compose setup: `http://localhost:3001`.

## Conventions

| Rule | Value |
| --- | --- |
| Query text | `q`, `t` and `prefix` are trimmed and truncated to 256 characters; this is not a cap on the entire URL |
| `limit` | max 100 |
| `offset` | max 1000 |
| `videoRef` (recommendations) | max 4096 characters |
| Recommendations body | max 16 KiB |
| Rate limiting | Per client, fixed window: 300 req/min on `/api/*`, 20/min on `POST /api/recommendations/related`, 10/min on `/sitemap.xml`. Exceeded → `429` with `Retry-After`. Disable in dev with `RATE_LIMIT_ENABLED=false`. |

## Search

### `GET /api/search`

Full-text video search.

```bash
curl --fail --get http://localhost:3001/api/search \
  --data-urlencode 'q=nostr' \
  --data-urlencode 'type=videos' \
  --data-urlencode 'duration=medium' \
  --data-urlencode 'language=en' \
  --data-urlencode 'limit=5' \
  --data-urlencode 'sort=newest'
```

| Parameter | Default | Description |
| --- | --- | --- |
| `q` | — (required) | Search query. Blank/missing → `400`. |
| `limit` | `20` | Page size, capped at 100. |
| `offset` | `0` | Pagination offset, capped at 1000. |
| `type` | `all` | `all`, `videos`, `shorts`, `audio`. |
| `kinds` | — | Comma-separated or repeatable Nostr kinds: `21`, `22`, `34235`, `34236`. |
| `duration` | `any` | `any`, `short` (<180 s), `medium` (180–1200 s), `long` (>1200 s). |
| `date` | `any` | `today`, `week`, `month`, `year` select the last 1/7/30/365 days (not calendar periods). Based on `published_at` falling back to `created_at`. |
| `available` | — | `true` → only verified playable media. `exclude-unavailable` → hide known-broken media, keep unchecked ones. |
| `feature` | — | Repeatable/comma-separated: `captions`, `hd`, `nostr`. |
| `language` | — | Repeatable/comma-separated primary language, e.g. `de`, `en`, `pt-br`. |
| `captionLanguage` | — | Repeatable/comma-separated caption language. |
| `sort` | `relevance` | `relevance`, `newest`, `oldest`, `duration`; raw `rankingScore`, `created_at`, `published_at`, `effectivePublishedAt`, `duration` with `:asc` or `:desc`. Other values (including `popularity`) fall back to relevance. Text ranking still precedes sorting. |
| `presetPubkey` | — | Optional 64-char hex pubkey whose NIP-78 safety preset is applied. Invalid non-empty value → `400 preset_required`. |
| `nsfwFilter` | `hide` | `hide`, `warning`, `show`. Invalid non-empty value → `400`. |

Illustrative response (IDs and URLs abbreviated):

```json
{
  "hits": [
    {
      "event_id": "abc123…",
      "title": "My Video",
      "content_preview": "First 200 characters…",
      "pubkey": "hex-public-key…",
      "kind": 34235,
      "created_at": 1710000000,
      "published_at": 1710000000,
      "rankingScore": 0.98,
      "thumbnail": "https://…/thumb.jpg",
      "videoUrl": "https://…/video.mp4",
      "nostrUrl": "https://nostu.be/v/naddr1…",
      "tags": ["bitcoin", "nostr"],
      "mimeType": "video/mp4",
      "mediaType": "video",
      "dimensions": "1920x1080",
      "textTracks": [{ "url": "https://…/captions.vtt", "lang": "en" }],
      "contentWarning": null
    }
  ],
  "total": 42,
  "limit": 20,
  "offset": 0
}
```

`nostrUrl` links to `https://nostu.be/v/<nevent|naddr>` (kinds 21, 34235) or `https://nostu.be/short/…` (kinds 22, 34236).

`pubkey` is hex, not npub. The stored document also has `npub`, but this route does not return it. `rankingScore` is the custom stored score, not MeiliSearch's query relevance score. The search response currently omits duration, language, author display name and availability fields even though those fields can be indexed or filtered. `total` uses MeiliSearch's estimated count when available.

### `GET /api/search/suggest`

Title suggestions for a query prefix.

```bash
curl --fail --get http://localhost:3001/api/search/suggest --data-urlencode 'q=bitcoin'
```

```json
{ "suggestions": ["Bitcoin Basics", "Bitcoin and Lightning"] }
```

Up to 5 distinct non-empty titles matching `q`. Accepts the same safety parameters as search (see below). Known-unavailable media are excluded.

### `GET /api/search/completion`

Word-level prefix completion from the `terms` index. Unfiltered: no safety parameters, no availability exclusion.

```bash
curl --fail --get http://localhost:3001/api/search/completion --data-urlencode 'prefix=blo'
```

```json
{ "completions": ["blockchain", "block"] }
```

## Tags and people

### `GET /api/tags`

Browse videos by topic tag.

```bash
curl --fail --get http://localhost:3001/api/tags \
  --data-urlencode 't=nostr' \
  --data-urlencode 'limit=10'
```

| Parameter | Default | Description |
| --- | --- | --- |
| `t` | — (required) | Tag value, lowercased. |
| `limit` | `50` | Page size, capped at 100. |
| `offset` | `0` | Pagination offset. |

Also accepts the same filter and safety parameters as `/api/search` (`type`, `duration`, `date`, `available`, `feature`, `kinds`, `language`, `captionLanguage`, `sort`, `presetPubkey`, `nsfwFilter`). Response shape matches search.

### `GET /api/people`

Author search over the `people` index.

```bash
curl --fail --get http://localhost:3001/api/people \
  --data-urlencode 'q=alice' \
  --data-urlencode 'limit=10'
```

| Parameter | Default | Description |
| --- | --- | --- |
| `q` | — (required) | Name or about-text query. |
| `limit` | `10` | Page size, capped at 100. |
| `offset` | `0` | Pagination offset. |
| `presetPubkey`, `nsfwFilter` | — | Same safety semantics as search. |

Returns authors sorted by `videoCount` descending:

```json
{
  "hits": [
    {
      "pubkey": "hex…",
      "npub": "npub1…",
      "name": "alice",
      "display_name": "Alice",
      "about": "Video creator",
      "picture": "https://…/alice.jpg",
      "nip05": "alice@example.com",
      "lud16": "alice@wallet.example",
      "videoCount": 42,
      "globalTrustScore": 0.87
    }
  ],
  "total": 1,
  "limit": 10,
  "offset": 0
}
```

Limitation: the people index has no `contentWarning` field, so the default content-warning exclusion does not apply; only a supplied preset's pubkey lists are enforced.

## Recommendations

### `POST /api/recommendations/related`

Related videos for a given video, optionally personalized.

Take an actual `event_id` from a search response:

```bash
VIDEO_EVENT_ID='<64-character event_id from your search result>'
curl --fail http://localhost:3001/api/recommendations/related \
  -H 'Content-Type: application/json' \
  -d "{\"videoRef\":\"$VIDEO_EVENT_ID\",\"limit\":10}"
```

Optionally add `user` (npub or hex pubkey), `language`, `presetPubkey` or the other body fields below. On a cold user-profile cache, the default behavior returns anonymous ranking while warming that profile in the background.

| Body field | Default | Description |
| --- | --- | --- |
| `videoRef` | — (required) | Hex event ID, `nevent` or `naddr`. Checked in the index, then through permitted relay hints and configured source relays. Missing/too long → `400`; a supported but unresolved reference → `404`. Unsupported decoded NIP-19 types → `400`; malformed encodings can currently produce `502`. |
| `user` | — | Optional npub/hex pubkey for personalized ranking; not an authenticated identity. |
| `limit` | `20` | Clamped to 1–50. |
| `language` | source video's language | Language or string-array filter; `"any"` disables language matching. |
| `excludeContentWarnings` | `true` | Additional warning exclusion. Set `false` **and** use `nsfwFilter=warning` or `show` to allow warning-marked candidates; `hide` still excludes them. |
| `presetPubkey`, `nsfwFilter` | — | Same safety semantics as search, supplied in the body. |

Returns `{ "hits": [...], "total": <n>, "limit": <n> }`; hits follow the recommendation shape (`id`, `title`, `urls`, `images`, `duration`, `link`, `type`, `recommendationScore`, language/caption fields, `thumbnailVariants`).

## Other endpoints

### `GET /health`

```bash
curl --fail http://localhost:3001/health
```

`{"ok":true}` on `200`; `502` when MeiliSearch is unreachable. Does not verify index contents.

### `GET /sitemap.xml`

SEO sitemap with top video and author URLs. Cached for 6 hours in-process. Related variables: `SITEMAP_SITE_ORIGIN`, `SITEMAP_MAX_URLS` (cap 50 000), `SITEMAP_MAX_AUTHORS`, `SITEMAP_AUTHOR_MIN_VIDEOS`.

### `GET /`

Built-in search UI (static HTML/JS from `src/api/public`).

## Safety parameters

Optional on `/api/search`, `/api/tags`, `/api/people`, `/api/search/suggest` and `POST /api/recommendations/related`:

| Parameter | Values | Behavior |
| --- | --- | --- |
| `presetPubkey` | 64-char hex | Fetches the author's NIP-78 kind-30078 preset (d-tag `nostube-presets`) and applies its `blockedPubkeys`, `nsfwPubkeys` and `blockedEvents`. Invalid non-empty value → `400 {"code":"preset_required"}`. Valid but unloadable → `503 {"code":"preset_unavailable"}`. Omitted → empty built-in policy. |
| `nsfwFilter` | `hide` (default), `warning`, `show` | `hide`: exclude everything with a `contentWarning` (including platform-detected NSFW) and all preset-flagged NSFW authors. `warning`: include NSFW-author hits annotated with `contentWarning: "NSFW"`. `show`: no annotation. |

Blocked pubkeys and events from a preset remain excluded regardless of `nsfwFilter`. Existing explicit content warnings remain present on `show`. Presets are fresh for 5 minutes by default; after that they refresh in the background until 30 minutes old, then refresh synchronously. If refresh fails, a cached policy can still be returned beyond that age. A supplied preset with no usable cached or fetched policy returns `503`.

`/api/search/completion` ignores safety parameters entirely.

## Error responses

| Status | Body | Meaning |
| --- | --- | --- |
| `400` | `{"error":"Missing query parameter q"}` | Required parameter absent/blank |
| `400` | `{"code":"preset_required"}` | `presetPubkey` is not a 64-char hex string |
| `400` | `{"error":"Invalid nsfwFilter: …"}` | Not one of `hide\|warning\|show` |
| `404` | `{"error":"Video not found"}` | Recommendation `videoRef` unknown |
| `413` | `{"error":"Request body too large"}` | Recommendations body over 16 KiB |
| `429` | `{"error":"Too many requests"}` | Rate limit exceeded; see `Retry-After` |
| `502` | `{"error":"Search engine unavailable"}` | MeiliSearch unreachable or errored |
| `503` | `{"code":"preset_unavailable"}` | Preset could not be loaded from relays or cache |

## ContextVM

The **indexer** calls relatr's `calculate_trust_scores` MCP tool through ContextVM's Nostr client transport. This project does not expose an MCP/ContextVM search server; its public search interface is HTTP. See [Configuration](../guide/configuration#trust-score-client) for controls and [How it works](../guide/search-engine#enrichment) for ranking.
