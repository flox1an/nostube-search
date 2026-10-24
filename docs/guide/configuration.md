# Configuration

All runtime configuration is environment variables. Compose forwards selected variables from `.env` into containers; the source process reads `.env` directly at startup. See [Getting started](./getting-started) for setup and [How it works](./search-engine) for behavior.

::: warning Only forwarded variables take effect
`docker-compose.yml` is explicit about what it passes to the `api` container. Variables absent from that mapping do **not** reach the running API just because you add them to `.env`. Add them to `api.environment` or a Compose override. For existing `${VAR:-default}` mappings, set `VAR` in `.env` to override the fallback, then recreate the container with `docker compose up -d`. A plain `docker compose restart` does not reload container environment variables.
:::

## Required

| Variable | Used by | Description |
| --- | --- | --- |
| `MEILI_MASTER_KEY` | API and indexer | MeiliSearch admin key. Required by both processes. Grants full index and key management. Use a strong random value; never expose it to clients. |
| `MEILI_URL` | API and indexer | MeiliSearch base URL. Compose hard-codes `http://meilisearch:7700` (container-internal). The source process requires it explicitly; locally use `http://127.0.0.1:<MEILI_PORT>`. |
| `PORT` | API | Listen port inside the container or host process. Defaults to `3001`; Compose sets it to `3001`. |

## Compose and host ports

| Variable | Default | Description |
| --- | --- | --- |
| `API_PORT` | `3001` | Host port published for the `api` service. |
| `MEILI_PORT` | `7700` | Host port for MeiliSearch, bound to `127.0.0.1` only. |
| `MEILI_ENV` | `production` | `development` enables the MeiliSearch dashboard at `http://127.0.0.1:7700`. Keep `production` in production. |

## Relays and relay timeouts

| Variable | Default | Description |
| --- | --- | --- |
| `NOSTR_SOURCE_RELAYS` | `wss://relay.nostu.be` | Comma-separated relays for video events, relation counts and playlists. |
| `NOSTR_INDEX_RELAYS` | `wss://relay.nostu.be` in Compose; no built-in URL in source | Relays for kind-0 profiles and kind-10063 Blossom lists. Source code also accepts the legacy fallback `NOSTR_INDEX_NRELAY`. |
| `NOSTR_SOURCE_MAX_WAIT_MS` | `30000` | Per-query timeout for relay requests. |
| `NOSTR_PRESET_RELAYS` | falls back to `NOSTR_INDEX_RELAYS` | Relays used to fetch NIP-78 preset events (kind 30078). An explicitly empty value falls back too. |

The indexer queries each source relay individually and pages through it; add relays you trust and that carry video events.

## Indexing and scheduling

| Variable | Default | Description |
| --- | --- | --- |
| `INDEXER_INCREMENTAL_INTERVAL_MS` | `600000` (10 min) | How often the indexer fetches newly published video events and upserts them into the live index. |
| `INDEXER_FULL_INTERVAL_MS` | `86400000` (24 h) | How often a full re-index with rolling swap runs. |
| `INDEXER_FULL_RETRY_MS` | `900000` (15 min) | Minimum gap before a failed or interrupted full re-index (e.g. after a crash) is retried. The start of every full run is persisted in the scheduler state, so a container restart mid-run does not start a new full pass immediately. |
| `FORCE_FULL_REINDEX` | `false` | Set `true` to run one rolling-swap full re-index at process startup, then set it back to `false` and restart. Startup already runs a full pass when no saved scheduler state exists. |
| `MEILI_TASK_TIMEOUT_MS` | `120000` | Timeout for waiting on MeiliSearch write tasks. Too small a value can abort a long full re-index, which then retries from zero. |
| `FETCH_TRUST_SCORES` | `true` in Compose, off when unset in source | Fetch author trust scores via ContextVM/relatr. When disabled or unavailable, every author gets default `0.5`. |
| `PLAYLIST_SCORE_INTERVAL_MS` | `21600000` (6 h) | Interval for the playlist score pass. |
| `PLAYLIST_MIN_TRUST_SCORE` | `0.1` | Minimum trust score for a playlist author to contribute. |
| `PLAYLIST_FETCH_LIMIT` | `5000` | Pagination stopping threshold for accumulated playlist events; a full page can exceed it. |

Scheduler state (last run timestamps) lives at `INDEXER_STATE_PATH` (default `.indexer-state.json` in the working directory; Compose: `/data/cache/.indexer-state.json`). Deleting it makes the next startup run a full re-index.

## Media availability checking

| Variable | Default | Description |
| --- | --- | --- |
| `MEDIA_AVAILABILITY_CHECK_INTERVAL_MS` | `600000` (10 min) | How often the availability checker runs. |
| `MEDIA_AVAILABILITY_CHECK_BATCH_SIZE` | `100` | Videos checked per run. |
| `MEDIA_AVAILABILITY_HEAD_TIMEOUT_MS` | `5000` | Timeout per media `HEAD` request. |
| `MEDIA_AVAILABILITY_STALE_AFTER_MS` | `86400000` (24 h) | Recheck verified-available media after this age. |
| `MEDIA_AVAILABILITY_RETRY_AFTER_MS` | `3600000` (1 h) | Retry unavailable media after this delay. |
| `MEDIA_AVAILABILITY_LOCK_PATH` | `/data/cache/.media-availability-check.lock` in Compose, `.media-availability-check.lock` in the working directory otherwise | Lock file preventing concurrent availability checks. |
| `MEDIA_AVAILABILITY_LOCK_STALE_MS` | `1800000` (30 min) | Age after which a stale lock is broken. |

Availability results are durable (separate `media_availability` index); deleting the cache volume does not delete them. See [Operations](./operations#data-and-persistence).

## Caches

Cache files live in the `api_cache` Docker volume by default (paths below are the in-container values). TTLs are milliseconds.

| Variable | Default | Description |
| --- | --- | --- |
| `PROFILE_CACHE_PATH` | `/data/cache/.profile-cache.json` in Compose, `.profile-cache.json` locally | Author profile (kind 0) cache file. |
| `PROFILE_CACHE_TTL_MS` | `86400000` (24 h) | Author profile cache TTL. |
| `TRUST_CACHE_PATH` | `/data/cache/.trust-cache.json` in Compose, `.trust-cache.json` locally | Trust score cache file. |
| `TRUST_CACHE_TTL_MS` | `86400000` (24 h) | Trust score cache TTL. |
| `TRUST_CACHE_MAX_ENTRIES` | `100000` | Maximum trust score cache entries held in memory and on disk; oldest entries are evicted first. |
| `PROFILE_CACHE_MAX_ENTRIES` | `20000` | Maximum author profile cache entries held in memory and on disk; oldest entries are evicted first. |
| `BLOSSOM_LIST_CACHE_DIR` | `/data/cache/blossom-lists` in Compose, `./blossom-lists` locally | Directory caching authors' Blossom server lists (kind 10063). |
| `BLOSSOM_LIST_CACHE_TTL_MS` | `86400000` (24 h) | Blossom server-list cache TTL. |

## Trust score client

Only relevant when `FETCH_TRUST_SCORES=true`. The relatr server and relay (`wss://relay2.contextvm.org`) are currently fixed in `src/indexer/relatr.ts`, not configurable through environment variables. The optional timeout and batch controls below are not forwarded by the supplied Compose file.

| Variable | Default | Description |
| --- | --- | --- |
| `TRUST_SCORE_CHUNK_TIMEOUT_MS` | `10000` | Timeout per trust-score chunk request. |
| `TRUST_SCORE_MAX_FETCH_MS` | `60000` | Total time budget for one trust-score fetch batch. |
| `TRUST_SCORE_MAX_CONSECUTIVE_FAILURES` | `2` | Failures before the client stops for this batch. |
| `TRUST_SCORE_DISCONNECT_TIMEOUT_MS` | `2000` | Timeout when closing the client at shutdown. |
| `TRUST_SCORE_COOLDOWN_MS` | `300000` (5 min) | Cooldown after failures before new uncached lookups are attempted. |
| `TRUST_SCORE_CHUNK_SIZE` | `16` | Pubkeys per request. Larger chunks can exceed the NIP-44 plaintext limit and fail. |

## API behavior

### CORS

| Variable | Default | Description |
| --- | --- | --- |
| `CORS_ORIGIN` | _(empty)_ | Allowed origin for `/api/*`, e.g. `https://nostu.be`, or `*` for any. Empty disables CORS headers. |

### Rate limiting

Fixed-window, per client. Denied requests return `429` with `Retry-After`.

| Variable | Default | Description |
| --- | --- | --- |
| `RATE_LIMIT_ENABLED` | `true` | Set `false` to disable rate limiting (development only). |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Window length. |
| `RATE_LIMIT_MAX` | `300` | Shared per-client budget for all of `/api/*`. |
| `RATE_LIMIT_RECOMMENDATIONS_MAX` | `20` | Stricter budget for `POST /api/recommendations/related`. |
| `RATE_LIMIT_SITEMAP_MAX` | `10` | Budget for `/sitemap.xml`. |
| `TRUST_PROXY` | `false` | Set `true` only behind a controlled proxy that overwrites forwarded-IP headers and cannot be bypassed. Reads the first `X-Forwarded-For` hop; otherwise uses the socket peer address. |

### Response caching

Successful `GET /api/*` responses carry `Cache-Control: public, max-age=…, stale-while-revalidate=…` so a CDN or reverse proxy absorbs repeat traffic.

| Variable | Default | Description |
| --- | --- | --- |
| `API_CACHE_MAX_AGE_S` | `60` | `max-age` in seconds. |
| `API_CACHE_SWR_S` | `300` | `stale-while-revalidate` in seconds. |

### Relay hints (SSRF protection)

Client-supplied `nevent`/`naddr` relay hints are dialed server-side by the recommendations endpoint, so they are restricted and re-checked.

| Variable | Default | Description |
| --- | --- | --- |
| `RELAY_HINT_MAX` | `4` | Maximum relay hints honored. |
| `RELAY_HINT_ALLOW_INSECURE` | `false` | Allow plaintext `ws://` hints. Keep `false` in production. |
| `RELAY_HINT_ALLOW_PRIVATE` | `false` | Allow hints resolving to loopback/private/link-local addresses. Development only. |
| `RELAY_HINT_DNS_TIMEOUT_MS` | `2000` | DNS timeout when checking hints against private address space. |

### Recommendations

| Variable | Default | Description |
| --- | --- | --- |
| `RECOMMENDATION_SIGNAL_MAX_WAIT_MS` | `5000` | Relay wait for user recommendation signals. |
| `RECOMMENDATION_SIGNAL_LIMIT` | `300` | Maximum signal events fetched per request. |
| `USER_RECOMMENDATION_PROFILE_TTL_MS` | `1800000` (30 min) | Cache TTL for user recommendation profiles. |
| `RECOMMENDATION_BLOCK_ON_PROFILE_MISS` | `false` | If `true`, block on rebuilding a user profile from relays instead of using a fallback. |
| `RECOMMENDATION_SOURCE_CACHE_TTL_MS` | `300000` (5 min) | Cache TTL for source-video lookups. |
| `RECOMMENDATION_REF_CACHE_TTL_MS` | `300000` (5 min) | Cache TTL for videos resolved through relay hints. |
| `RECOMMENDATION_REF_MAX_WAIT_MS` | `5000` | Relay wait when resolving a source video. |
| `RECOMMENDATION_CANDIDATE_CACHE_TTL_MS` | `120000` (2 min) | Cache TTL for related-video candidate sets. |

### Sitemap

| Variable | Default | Description |
| --- | --- | --- |
| `SITEMAP_SITE_ORIGIN` | `https://nostu.be` | Canonical origin used in sitemap URLs. |
| `SITEMAP_MAX_URLS` | `50000` | Maximum total entries, capped at the sitemap protocol limit. |
| `SITEMAP_MAX_AUTHORS` | `5000` | Maximum author profile URLs. |
| `SITEMAP_AUTHOR_MIN_VIDEOS` | `10` | Strict lower bound: an author needs **more than** this many indexed videos (11 at the default). |

## Safety presets

NIP-78 preset events (kind 30078, d-tag `nostube-presets`) define per-client safety policies. See the [API reference](../reference/api#safety-parameters) for the request-side behavior.

| Variable | Default | Description |
| --- | --- | --- |
| `PRESET_CACHE_FRESH_TTL_MS` | `300000` (5 min) | A cached policy is returned without background refresh for this long. |
| `PRESET_CACHE_MAX_TTL_MS` | `1800000` (30 min) | Cache age at which refresh becomes blocking rather than background. If refresh fails, the implementation can still return a previously cached policy; this is not a hard expiry. |

## Blocked authors

| Variable | Default | Description |
| --- | --- | --- |
| `NOSTUBE_BLOCKED_AUTHORS` | no extra entries | Additional comma-separated hex pubkeys, npubs or nprofiles. `BLOCKED_AUTHOR_NPUBS` is a fallback alias. Extends the built-in blocklist for video search, suggestions, recommendations and sitemap; does not filter the people or completion endpoints. |

## Compose forwarding

The Compose file forwards the common relay, schedule, media-check, cache-TTL, CORS, rate-limit, HTTP-cache and preset variables listed above. It also reads `MEILI_MASTER_KEY`, `MEILI_ENV`, `MEILI_PORT` and `API_PORT` from the Compose environment.

The following application settings require adding entries to `api.environment` before `.env` can control them in Docker:

- `MEILI_TASK_TIMEOUT_MS`
- `PLAYLIST_SCORE_INTERVAL_MS`, `PLAYLIST_MIN_TRUST_SCORE`, `PLAYLIST_FETCH_LIMIT`
- the `TRUST_SCORE_*` tuning controls
- the `RECOMMENDATION_*` controls and `USER_RECOMMENDATION_PROFILE_TTL_MS`
- `SITEMAP_*`
- `NOSTUBE_BLOCKED_AUTHORS` / `BLOCKED_AUTHOR_NPUBS`
- `RELAY_HINT_ALLOW_INSECURE`, `RELAY_HINT_ALLOW_PRIVATE`, `RELAY_HINT_DNS_TIMEOUT_MS`

Compose fixes `PORT=3001`, `MEILI_URL=http://meilisearch:7700` and the cache/state/lock paths under `/data/cache`. Change those in Compose itself, not just in `.env`. Direct source execution via `npm start` loads `.env` before imports, so the application variables are available without container forwarding.
