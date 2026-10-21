# nostube-search

Nostr video search engine — MeiliSearch-backed HTTP API, built-in web UI and automatic background indexing.

## Documentation

**[Documentation website](https://flox1an.github.io/nostube-search/)** — VitePress, matching the Nostube and Almond documentation sites.

- [Getting started](docs/guide/getting-started.md) — Docker Compose and local source setup
- [Configuration](docs/guide/configuration.md) — environment variables, defaults and Compose forwarding
- [Operations](docs/guide/operations.md) — health, scheduling, rebuilds, backups and deployment
- [How the search engine works](docs/guide/search-engine.md) — event ingestion, metadata, ranking and safety
- [HTTP API](docs/reference/api.md) — search, filters, suggestions, people and recommendations

## Quick start

```bash
cp .env.example .env
# Set MEILI_MASTER_KEY to a strong random value in .env.
docker compose up -d
curl --fail http://localhost:3001/health
```

Open `http://localhost:3001` for the search UI. The API and indexer run together: full rebuilds default to every 24 hours, incremental updates to every 10 minutes. On a fresh instance, wait for the initial full index build before expecting results. `/health` checks MeiliSearch connectivity, not indexing completion.

Compose uses the published API image and stores data in the `meilisearch_data` and `api_cache` named volumes. MeiliSearch (`127.0.0.1:7700`) and its admin UI (`127.0.0.1:24900`) are loopback-only; do not expose them publicly. For source development, see [Getting started](docs/guide/getting-started.md#run-the-source-locally).

## Documentation development

The docs are a separate npm package; application dependencies and Docker builds are unchanged.

```bash
cd docs
npm ci
npm run docs:dev
# Production build and preview:
npm run docs:build
npm run docs:preview
```

Open the printed URL including `/nostube-search/`. Builds fail on broken internal page links. Public docs exclude the existing `docs/agents/` workflow notes.

The `Docs` workflow checks documentation pull requests and deploys `main` to GitHub Pages. Before the first deployment, select **GitHub Actions** under repository **Settings → Pages → Source**. The site is deployed separately from the search API.
