# Operations

Day-to-day running of a Nostube Search instance: verifying health, maintaining the index, preserving data and protecting the administrative surfaces. See [Getting started](./getting-started) for the first run and [Configuration](./configuration) for all variables.

## Health and monitoring

```bash
# API and MeiliSearch connectivity
curl --fail http://localhost:3001/health

# Index status without authentication to the API
docker compose logs --tail 50 api
```

`GET /health` returns `{"ok":true}` when MeiliSearch answers, and `502` otherwise. It does **not** verify that indexing has completed or that search returns useful results. For end-to-end checks, query the API:

`GET /healthz` is a pure liveness check: it answers immediately without contacting any upstream service and is the right probe for container health, since it stays fast while a full re-index is running.

```bash
curl --fail --get http://localhost:3001/api/search \
  --data-urlencode 'q=nostr' \
  --data-urlencode 'limit=1'
```

Indexing progress and scheduler activity are written to the `api` container logs with `[Indexer]`, `[Scheduler]`, `[PlaylistScore]` and availability-check prefixes. A full re-index logs `Full re-index complete — <n> events live` when done.

### Service checks

| Check | Command | Healthy when |
| --- | --- | --- |
| API reachable | `curl http://localhost:3001/healthz` | `200` with `{"ok":true}` (no upstream calls) |
| Search returns hits | `GET /api/search?q=nostr&limit=1` | `200`, `total` reflects indexed content |
| Indexer running | `docker compose ps api` and `docker compose logs api` | No repeated fatal errors; logs show successful passes. An idle scheduler does not emit a per-minute heartbeat. |
| MeiliSearch reachable | `curl http://127.0.0.1:7700/health` | `200` (loopback only) |

## Scheduling and triggering rebuilds

The scheduler inside the `api` process checks every 60 seconds whether work is due and runs jobs serially:

| Job | Default cadence | Trigger |
| --- | --- | --- |
| Full re-index (rolling swap) | 24 h | `INDEXER_FULL_INTERVAL_MS`, or immediately at startup with `FORCE_FULL_REINDEX=true` |
| Incremental update | 10 min | `INDEXER_INCREMENTAL_INTERVAL_MS`, after the first full index exists |
| Media availability check | 10 min | `MEDIA_AVAILABILITY_CHECK_INTERVAL_MS`, after the first full index exists |
| Playlist score pass | 6 h | `PLAYLIST_SCORE_INTERVAL_MS` (also runs inline after each full re-index) |

Last-run timestamps persist in `.indexer-state.json` (the `api_cache` volume inside Compose). With no state file, startup runs a full re-index first.

### Forcing a full re-index

Set `FORCE_FULL_REINDEX=true` in `.env` (replace an existing value rather than appending duplicates), or in your deployment's environment UI. Recreate the API:

```bash
docker compose up -d api
docker compose logs -f api
```

Wait for the full pass, including its people update and playlist scoring, to finish. Set `FORCE_FULL_REINDEX=false` again and run `docker compose up -d api` to apply it. A plain `restart` does not reload environment variables.

Do not leave the flag enabled: every process startup would trigger another full crawl. Rebuild duration depends on relay history, enrichment and MeiliSearch write throughput. On a scheduled failure, the scheduler retries next cycle; a failure in the forced startup pass exits the process and Compose's restart policy retries it. The previous video/term indices stay queryable until the atomic swap.

### Restarting

```bash
docker compose restart api          # API and indexer restart; scheduler state persists
docker compose restart meilisearch  # brief API downtime; data persists in the volume
docker compose down                 # stops all services; named volumes survive
```

To upgrade the API, pull the image and recreate the service. Back up first and check release changes; newly indexed fields may require a full re-index. Do not assume a MeiliSearch version change can reuse an old database without its documented migration procedure.

```bash
docker compose pull api
docker compose up -d
docker compose logs -f api   # watch the first scheduler cycle
```

## Data and persistence

Two named Docker volumes hold all persistent state:

| Volume | Content | Disposable? |
| --- | --- | --- |
| `meilisearch_data` | MeiliSearch indices: `videos`, `terms`, `people` and `media_availability` | **No.** Video/term documents can be rebuilt from relays, but local availability history cannot. Losing this volume while retaining recent scheduler state does not force an immediate full rebuild. |
| `api_cache` | Scheduler state, profile/trust/Blossom caches, availability lock file | Mostly. Deleting it costs a full re-index (lost scheduler state), re-fetched profiles, and re-run trust/Blossom lookups. The `media_availability` index survives in `meilisearch_data`. |

### Cold backup

Use a maintenance window. Stop both writers before copying; a live database-directory copy is not a consistent backup. These commands copy both mounted data directories from the existing, stopped containers:

```bash
docker compose stop api meilisearch
mkdir -p backups/instance
docker compose cp meilisearch:/meili_data backups/instance/
docker compose cp api:/data/cache backups/instance/
docker compose start meilisearch api
```

Use a new backup destination for each backup and verify that both copies succeeded before restarting. Preserve the matching MeiliSearch version and deployment configuration with the backup. Store `.env` separately and securely; it contains the master key.

To restore, stop the same services and restore both volume contents from a matching backup using your volume-backup tooling. Do not merge database directories from different instances or copy a live database. Keep API/indexer stopped until MeiliSearch data **and** scheduler state are restored. If only the search data was lost, explicitly force a full rebuild rather than waiting for saved timestamps to expire.

::: warning
Back up `meilisearch_data` before deleting volumes, upgrading MeiliSearch major versions or restructuring indices. A full re-index repopulates video documents from relays, but **not** from your local disk: availability check results, scheduler state and caches are gone after volume deletion.
:::

### Availability vs. cache

Media availability results live in the `media_availability` index (durable, in `meilisearch_data`). Scheduler state and caches live in `api_cache`. Do not treat the cache volume as the availability source of truth.

## Network and API security

The API is unauthenticated by design. Protect it with layers rather than opening it raw:

- Keep MeiliSearch and the MeiliSearch UI bound to `127.0.0.1`. Both are administrative surfaces: the master key grants index deletion and key minting, the dashboard has no auth at all. Reach them via SSH tunnel, not a public interface.
- Terminate TLS at a reverse proxy (Caddy, Traefik, nginx). Enable `TRUST_PROXY=true` only if clients cannot bypass that proxy and it overwrites forwarded-IP headers; otherwise clients can forge rate-limit identities.
- Leave rate limits enabled; tune `RATE_LIMIT_*` based on observed traffic.
- `CORS_ORIGIN` controls browser-readable responses, not authentication or access by scripts and non-browser clients.
- Rotate `MEILI_MASTER_KEY` if it ever leaves the server; it grants full index control.

See [Configuration](./configuration#api-behavior) for the related variables.

## Troubleshooting

| Symptom | Likely cause | Action |
| --- | --- | --- |
| `/health` returns `502` | MeiliSearch not up or wrong `MEILI_URL` | `docker compose logs meilisearch`; verify the container-internal URL is `http://meilisearch:7700` |
| Search returns `{"total":0}` | Indexing not finished yet, or source relays carry no matching events | Check logs for `Full re-index complete`; verify `NOSTR_SOURCE_RELAYS` |
| Results look stale | Incremental interval too long or indexer stuck | Check `[Scheduler]` logs; shorten `INDEXER_INCREMENTAL_INTERVAL_MS` or force a full re-index |
| Full re-index restarts from zero | MeiliSearch task timeout too short | Raise `MEILI_TASK_TIMEOUT_MS`; do not set it below the default `120000` |
| All trust scores are `0.5` | `FETCH_TRUST_SCORES=false`, trust client unreachable, or in cooldown | Check logs for `[TrustScore]` warnings; verify ContextVM connectivity |
| `429 Too many requests` | Client hit a rate-limit bucket | Expected behavior; raise the relevant `RATE_LIMIT_*` or fix the caller |
| Slow search responses | Missing `Cache-Control` pass-through at proxy, or MeiliSearch underprovisioned | Keep API cache headers intact; give the MeiliSearch container more memory |
| Videos missing thumbnails or duration | Upstream events lack `imeta`/`thumb`/`duration` tags | Not an indexer defect; data quality depends on what publishers emit |
| Availability stays unknown | Check not yet due, backlog, missing media key, or an interrupted pass | Inspect `[AvailabilityChecker]` logs and the configured interval/batch size. A successful `HEAD` is only a reachability check, not a playback guarantee. |

## Coolify and image deployment

Use this repository as a Docker Compose application, set `MEILI_MASTER_KEY` and relay settings in Coolify, and deploy the three services. Preserve both named volumes across redeployments.

The existing Docker workflow builds pull requests without publishing. Pushes to `main` publish the API image to GHCR, join the deployment Tailnet and call Coolify's API. Its configuration uses the repository variable `COOLIFY_TAILNET_HOST` and secrets `TS_AUTHKEY`, `COOLIFY_DEPLOY_TOKEN` and `KUMA_PUSH_TOKEN` (deploy monitoring). This workflow is specific to the maintainer's infrastructure; a self-hosted installation should configure its own deployment rather than reuse private host/resource identifiers.

## Where to look in the source

| Area | File |
| --- | --- |
| Scheduler, full/incremental rebuilds, rolling swap | `src/indexer/index.ts` |
| Relay fetching and pagination | `src/indexer/relay-source.ts` |
| Metadata parsing and document building | `src/indexer/index.ts` (`toSearchDocument`) |
| Media availability checker | `src/indexer/availability-checker.ts`, `src/indexer/media-availability.ts` |
| Trust score client | `src/indexer/relatr.ts` |
| HTTP API routes | `src/api/server.ts` |
| Safety presets and NSFW filtering | `src/api/preset-safety.ts` |
| Recommendations | `src/api/recommendations.ts` |
| Sitemap | `src/api/sitemap.ts` |
| Rate limiting | `src/api/rate-limit.ts` |
| Blocked authors | `src/api/blocked-authors.ts` |
