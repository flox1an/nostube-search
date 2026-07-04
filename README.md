# nostube-search

Nostr video search engine — MeiliSearch-backed API with a built-in web UI.

## Architecture

```
[Internet] → API container (:3001)
                  ↓
             MeiliSearch container (internal :7700)
                  ↓
             ./data/meilisearch/   ← persistent indexes
             ./data/cache/         ← profile & trust-score caches
```

The **Indexer** is a one-shot job that pulls video events from Nostr relays and writes them into MeiliSearch. It is not a long-running service — run it once after deploy and then on a schedule as needed.

---

## Quick start

```bash
cp .env.example .env
# Edit .env — set MEILI_MASTER_KEY at minimum

docker compose up -d
```

The search API is available at `http://localhost:3001`.

The **indexer starts automatically** alongside the API. On first boot it runs a full re-index immediately, then keeps the index fresh on its own schedule.

---

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/search?q=<query>` | Full-text video search |
| `GET` | `/api/search/suggest?q=<query>` | Title suggestions (up to 5) |
| `GET` | `/api/search/completion?prefix=<prefix>` | Word-level prefix completion |
| `GET` | `/health` | API + MeiliSearch health check |
| `GET` | `/sitemap.xml` | SEO sitemap with top Nostube video/short URLs plus important authors |
| `GET` | `/` | Built-in search UI |

**Search parameters (`/api/search`):**

| Param | Default | Description |
|-------|---------|-------------|
| `q` | — | Search query (required) |
| `limit` | `20` | Results per page (non-negative integer) |
| `offset` | `0` | Pagination offset |
| `type` | `all` | One of: `all`, `videos`, `shorts`, `audio` |
| `kinds` | — | Comma-separated or repeatable Nostr video event kinds. Supported: `21`, `22`, `34235`, `34236` |
| `duration` | `any` | One of: `any`, `short` (`<180s`), `medium` (`180s..1200s`), `long` (`>1200s`) |
| `date` | `any` | One of: `any`, `today`, `week`, `month`, `year`; based on `published_at ?? created_at` |
| `available` | — | Optional media availability filter. Use `true` for only verified playable media, or `exclude-unavailable` to hide known-broken media while keeping unchecked videos. |
| `feature` | — | Repeatable or comma-separated. Values: `captions`, `hd`, `nostr` |
| `language` | — | Repeatable or comma-separated primary language filter, e.g. `de`, `en`, `pt-br` |
| `captionLanguage` | — | Repeatable or comma-separated caption language filter, e.g. `en` |
| `sort` | `relevance` | One of: `relevance`, `newest`, `oldest`, `duration`; raw Meili sorts such as `rankingScore:desc`, `created_at:desc`, `effectivePublishedAt:desc`, `duration:desc` are also accepted |

`sort=popularity` is intentionally not supported until the index has reliable popularity metrics such as views, likes/zaps, or replay data.

**Response shape (`/api/search`):**

```json
{
  "hits": [
    {
      "event_id": "abc123...",
      "title": "My Video",
      "content_preview": "First 200 chars of summary or content",
      "pubkey": "npub1...",
      "kind": 34235,
      "created_at": 1710000000,
      "published_at": 1710000000,
      "duration": 420,
      "thumbnail": "https://example.com/thumb.jpg",
      "videoUrl": "https://example.com/video.mp4",
      "tags": ["bitcoin", "nostr"],
      "authorDisplayName": "Alice",
      "rankingScore": 0.987,
      "nostrUrl": "https://nostu.be/v/naddr1...",
      "language": "en",
      "languageSource": "tag",
      "languageConfidence": 1,
      "captionLanguages": ["en"],
      "contentWarning": null,
      "textTracks": [{ "url": "https://example.com/captions.vtt", "lang": "en" }],
      "dimensions": "1920x1080",
      "mimeType": "video/mp4",
      "mediaType": "video",
      "availabilityStatus": "unknown",
      "hasPlayableMedia": false,
      "playableUrl": null,
      "mediaCheckedAt": null
    }
  ],
  "total": 42,
  "limit": 20,
  "offset": 0
}
```

`nostrUrl` points to `https://nostu.be/v/<nevent|naddr>` for horizontal video (kinds 21, 34235) or `https://nostu.be/short/<nevent|naddr>` for short-form (kinds 22, 34236). Parameterized replaceable events (kinds 34235, 34236) use `naddr` encoding; regular events use `nevent`.

The video index also stores filter-oriented metadata from Nostr tags and `imeta`, including `identifier`, `content_preview`, `duration`, `contentWarning`, `language`, `languageSource`, `languageConfidence`, `captionLanguages`, `hasCaptions`, `isHd`, `isShort`, `isVideo`, `isNostrNative`, `thumbnailBlurhash`, `size`, `hash`, `fallbackUrls`, `origins`, and denormalized media availability fields. Existing documents need a full re-index before all newly indexed fields are populated.

Primary `language` is read from `language`, `lang`, or `locale` tags first. If no locale tag exists, the indexer estimates the language locally from title/summary/content with `franc-min`; if that is inconclusive, it falls back to a single caption language when available.

`POST /api/recommendations/related` accepts an optional `language` body field. If omitted, related recommendations filter to the source video's language when known. Use `"language": "any"` to disable language filtering.

Media availability is stored durably in a separate MeiliSearch index named `media_availability`. The `videos` index is still disposable and rebuilt through `videos_next`; during re-indexing, availability snapshots are read from `media_availability` and copied into each video document. Recommendation candidates and title suggestions hide videos marked `availabilityStatus = "unavailable"` by default. Search keeps full recall unless `available` is supplied.

**Response shape (`/api/search/suggest`):**

```json
{ "suggestions": ["Bitcoin and Lightning", "Bitcoin Basics", "..."] }
```

Up to 5 distinct non-empty titles matching `q`.

**Response shape (`/api/search/completion`):**

```json
{ "completions": ["bitcoin", "blockchain", "..."] }
```

Up to 10 indexed words whose prefix matches the `prefix` parameter (minimum 1 character).

**Error responses:**

| Status | Body | Condition |
|--------|------|-----------|
| `400` | `{"error":"Missing query parameter q"}` | `q` is absent or blank on `/api/search` |
| `502` | `{"error":"Search engine unavailable"}` | MeiliSearch unreachable or returned an error |

---

## Environment variables

Copy `.env.example` to `.env` and adjust as needed.

### Required

| Variable | Description |
|----------|-------------|
| `MEILI_MASTER_KEY` | MeiliSearch master key. Use a strong random value in production. |

### API service

| Variable | Default | Description |
|----------|---------|-------------|
| `API_PORT` | `3001` | Host port the search API is published on. |
| `CORS_ORIGIN` | _(empty)_ | Allowed CORS origin for `/api/*` routes (e.g. `https://nostub.be`). Leave empty to disable CORS headers. |

### MeiliSearch service

| Variable | Default | Description |
|----------|---------|-------------|
| `MEILI_ENV` | `production` | MeiliSearch environment. Set to `development` to enable the MeiliSearch dashboard at `http://<host>:7700`. |
| `MEILI_PORT` | `7700` | Host port for MeiliSearch (only used when the `ports:` block is uncommented in `docker-compose.yml`). MeiliSearch is internal-only by default. |

### Indexer service

| Variable | Default | Description |
|----------|---------|-------------|
| `NOSTR_SOURCE_RELAYS` | `wss://relay.nostu.be` | Comma-separated relay URLs used to fetch video events (kinds 21, 22, 34235, 34236). |
| `NOSTR_INDEX_RELAYS` | `wss://relay.nostu.be` | Comma-separated relay URLs used to fetch author kind-0 profile events. |
| `NOSTR_SOURCE_MAX_WAIT_MS` | `30000` | Per-query timeout when fetching from source relays (ms). |
| `FETCH_TRUST_SCORES` | `true` | Set to `false` to skip ContextVM/relatr trust score lookups (all authors get score 0.5). |
| `PROFILE_CACHE_TTL_MS` | `86400000` | Author profile cache TTL (ms, default 24 h). Stored at `/data/cache/.profile-cache.json` in the `api_cache` volume. |
| `BLOSSOM_LIST_CACHE_TTL_MS` | `86400000` | Author Blossom server-list cache TTL (ms, default 24 h). Stored as one file per author under `/data/cache/blossom-lists/<npub>.json` in the `api_cache` volume. |
| `TRUST_CACHE_TTL_MS` | `86400000` | Trust score cache TTL (ms, default 24 h). Stored at `/data/cache/.trust-cache.json` in the `api_cache` volume. |
| `INDEXER_INCREMENTAL_INTERVAL_MS` | `600000` | How often the indexer fetches and upserts new events (ms, default 10 min). |
| `INDEXER_FULL_INTERVAL_MS` | `86400000` | How often a full re-index runs (ms, default 24 h). Uses a rolling index swap — the live index stays queryable throughout. |
| `MEDIA_AVAILABILITY_CHECK_INTERVAL_MS` | `600000` | How often the media availability checker runs (ms, default 10 min). |
| `MEDIA_AVAILABILITY_CHECK_BATCH_SIZE` | `100` | Maximum videos checked per availability run. |
| `MEDIA_AVAILABILITY_HEAD_TIMEOUT_MS` | `5000` | Timeout for each media `HEAD` request. |
| `MEDIA_AVAILABILITY_STALE_AFTER_MS` | `86400000` | Recheck verified available media after this age (ms, default 24 h). |
| `MEDIA_AVAILABILITY_RETRY_AFTER_MS` | `3600000` | Retry unavailable/error media after this delay (ms, default 1 h). |
| `MEDIA_AVAILABILITY_LOCK_STALE_MS` | `1800000` | Stale lock timeout for the availability checker lock file (ms, default 30 min). |
| `SITEMAP_SITE_ORIGIN` | `https://nostu.be` | Canonical Nostube origin used for sitemap URLs. |
| `SITEMAP_MAX_URLS` | `50000` | Maximum total sitemap entries. Capped at the protocol limit of 50,000. |
| `SITEMAP_MAX_AUTHORS` | `5000` | Maximum author profile URLs reserved inside the sitemap. |
| `SITEMAP_AUTHOR_MIN_VIDEOS` | `10` | Minimum indexed videos required for an author profile URL to enter the sitemap. |

The availability checker runs inside the scheduler every 10 minutes by default. Each run takes a lock at `/data/cache/.media-availability-check.lock`, selects due videos, builds candidate URLs from `videoUrl`, `fallbackUrls`, and the author's cached kind-10063 Blossom server list, then validates candidates with HTTP `HEAD`. Results are written to the durable `media_availability` index and patched back into `videos`.

---

## Coolify deployment

1. Add this repository as a **Docker Compose** application in Coolify.
2. Set the environment variables in Coolify's env UI (at minimum `MEILI_MASTER_KEY`).
3. Deploy — Coolify starts `meilisearch`, `api`, and `meilisearch-ui`.

The indexer runs a full re-index on first boot and then self-schedules. No manual trigger needed.

### Automatic deployment from GitHub Actions

The Docker workflow builds and pushes `ghcr.io/flox1an/nostube-search:latest` on pushes to `main`, then triggers a Coolify deployment webhook. Pull requests still build the image for validation, but do not push or deploy.

If Coolify is only reachable inside Tailscale, the deployment job must run from inside that Tailnet. Register a GitHub self-hosted runner on a machine that can reach the Coolify URL, and give it a `tailscale` label. The workflow keeps the Docker build on GitHub-hosted runners, then runs only the webhook call on `[self-hosted, tailscale]`.

In Coolify:

1. Enable API access under **Settings → Configuration → Advanced**.
2. Create an API token with deploy permission.
3. Open this Docker Compose resource's **Webhook** page and copy the deploy webhook URL.

In GitHub repository secrets, add:

| Secret | Value |
|--------|-------|
| `COOLIFY_WEBHOOK` | The Coolify deploy webhook URL reachable from the Tailscale runner |
| `COOLIFY_TOKEN` | The Coolify API token with deploy permission |

Coolify pulls the prebuilt API image from GHCR because the `api` service uses `image: ghcr.io/flox1an/nostube-search:latest`. The MeiliSearch services remain pinned to their own upstream images and are not rebuilt by this repository workflow.

### Exposing MeiliSearch (optional)

This compose file publishes MeiliSearch on `${MEILI_PORT:-7700}`. Keep a strong `MEILI_MASTER_KEY` in production, and remove the `ports:` block under `meilisearch` if you want it reachable only from the Docker network. Set `MEILI_ENV=development` only when you need the MeiliSearch dashboard for debugging.

---

## Data directory layout

```
Docker volumes:
├── meilisearch_data/
│   └── data.ms/              ← MeiliSearch indexes (videos, terms, media_availability)
└── api_cache/
    ├── .indexer-state.json   ← Scheduler timestamps (lastIncrementalAt, lastFullAt)
    ├── .media-availability-check.lock ← Availability checker lock (only present while running)
    ├── .profile-cache.json   ← Author profile cache
    ├── blossom-lists/         ← Author kind-10063 Blossom server-list cache
    └── .trust-cache.json     ← Trust score cache
```

All files are created automatically on first run. Back up the `meilisearch_data` Docker volume to preserve the index.
