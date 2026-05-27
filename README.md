# nostube-search

Nostr video search engine — MeiliSearch-backed API with a built-in web UI.

## Architecture

```
[Internet] → API container (:3001)
                  ↓
             MeiliSearch container (internal :7700)
                  ↓
             ./data/meilisearch/   ← persistent index
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
| `GET` | `/` | Built-in search UI |

**Search parameters:**

| Param | Default | Description |
|-------|---------|-------------|
| `q` | — | Search query (required) |
| `limit` | `20` | Results per page |
| `offset` | `0` | Pagination offset |
| `sort` | — | `rankingScore:desc`, `rankingScore:asc`, `created_at:desc`, `created_at:asc` |

---

## Environment variables

Copy `.env.example` to `.env` and adjust as needed.

### Required

| Variable | Description |
|----------|-------------|
| `MEILI_MASTER_KEY` | MeiliSearch master key. Use a strong random value in production. |

### Data & storage

| Variable | Default | Description |
|----------|---------|-------------|
| `DATA_PATH` | `./data` | Host path for all persistent data. Contains `meilisearch/` (index) and `cache/` (JSON caches). Set to an absolute path when using Coolify named volumes. |

### API service

| Variable | Default | Description |
|----------|---------|-------------|
| `API_PORT` | `3001` | Host port the search API is published on. |

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
| `PROFILE_CACHE_TTL_MS` | `86400000` | Author profile cache TTL (ms, default 24 h). Stored at `DATA_PATH/cache/.profile-cache.json`. |
| `TRUST_CACHE_TTL_MS` | `86400000` | Trust score cache TTL (ms, default 24 h). Stored at `DATA_PATH/cache/.trust-cache.json`. |
| `INDEXER_INCREMENTAL_INTERVAL_MS` | `600000` | How often the indexer fetches and upserts new events (ms, default 10 min). |
| `INDEXER_FULL_INTERVAL_MS` | `86400000` | How often a full re-index runs (ms, default 24 h). Uses a rolling index swap — the live index stays queryable throughout. |

---

## Coolify deployment

1. Add this repository as a **Docker Compose** application in Coolify.
2. Set the environment variables in Coolify's env UI (at minimum `MEILI_MASTER_KEY`).
3. Set `DATA_PATH` to a Coolify-managed persistent volume path, e.g. `/data/nostube-search`.
4. Deploy — Coolify starts all three services: `meilisearch`, `api`, and `indexer`.

The indexer runs a full re-index on first boot and then self-schedules. No manual trigger needed.

### Exposing MeiliSearch (optional)

By default MeiliSearch is only reachable inside the Docker network. To expose it for debugging, uncomment the `ports:` block in `docker-compose.yml` under the `meilisearch` service and set `MEILI_ENV=development`.

---

## Data directory layout

```
DATA_PATH/
├── meilisearch/
│   └── data.ms/              ← MeiliSearch index (managed by MeiliSearch)
└── cache/
    ├── .indexer-state.json   ← Scheduler timestamps (lastIncrementalAt, lastFullAt)
    ├── .profile-cache.json   ← Author profile cache
    └── .trust-cache.json     ← Trust score cache
```

All files are created automatically on first run. Back up `DATA_PATH/meilisearch/` to preserve the index.
