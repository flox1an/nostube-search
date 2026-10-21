# Getting started

Nostube Search reads video events from Nostr relays and serves a MeiliSearch-backed HTTP API with a small built-in search UI. It indexes metadata and links to media; it does not host or transcode video files.

## Run with Docker Compose

Install Docker with the Compose plugin, then clone the repository:

```bash
git clone https://github.com/flox1an/nostube-search.git
cd nostube-search
cp .env.example .env
openssl rand -hex 32
```

Set `MEILI_MASTER_KEY` in `.env` to the generated value. The template value is an example, not a production secret. Adjust `NOSTR_SOURCE_RELAYS` and `NOSTR_INDEX_RELAYS` if you want to use other relays.

```bash
docker compose up -d

docker compose logs -f api
```

Compose starts three services:

| Service | Purpose | Default access |
| --- | --- | --- |
| `api` | HTTP API, web UI and background indexer in one process | `http://localhost:3001` |
| `meilisearch` | Search indices and durable availability records | `http://127.0.0.1:7700`, loopback only |
| `meilisearch-ui` | Administrative dashboard | `http://127.0.0.1:24900`, loopback only |

The API uses the published image `ghcr.io/flox1an/nostube-search:latest`; Compose does **not** build your local source checkout. For local source changes, use the development setup below.

::: warning Administrative access
Keep MeiliSearch and its dashboard bound to loopback. Never expose the master key to browsers or API clients. The API itself is unauthenticated: use HTTPS and a trusted reverse proxy for a public deployment. See [Operations](./operations#network-and-api-security).
:::

### Verify the instance

```bash
curl --fail http://localhost:3001/health
# {"ok":true}

curl --fail --get http://localhost:3001/api/search \
  --data-urlencode 'q=nostr' \
  --data-urlencode 'limit=5'
```

Open `http://localhost:3001` to use the built-in search UI. If you changed `API_PORT`, use that port instead.

The indexer runs automatically, not as a separate one-shot job. Without saved scheduler state, it starts a full index build; subsequent runs use the persisted timestamps. Wait for `Full re-index complete` in the logs before expecting the first full set of results. On the first boot, health requests may fail briefly while MeiliSearch starts; `/health` checks connectivity, **not indexing completion**. An empty result set can also mean the configured relays contain no matching videos.

Default background intervals are 10 minutes for incremental updates and media checks, 24 hours for full rebuilds, and 6 hours for playlist scoring. The scheduler checks due work once per minute and runs jobs serially. See [How it works](./search-engine) and [Configuration](./configuration).

## Run the source locally

Use Node.js 24 (matching the application Dockerfile) and npm. From the repository root:

```bash
cp .env.example .env
# Set a strong MEILI_MASTER_KEY in .env before starting MeiliSearch.
docker compose up -d meilisearch
npm ci
```

Add the host-side MeiliSearch URL to `.env`:

```dotenv
MEILI_URL=http://127.0.0.1:7700
PORT=3001
```

If you changed `MEILI_PORT`, adjust the URL. Stop the containerized API first if it is already running, so you do not compete for the same port or run two indexers against the same indices:

```bash
docker compose stop api
npm start
```

`npm start` loads `.env` before importing the API and starts both API and indexer. Unlike Compose, the source process requires `MEILI_URL` explicitly and only enables trust lookups when `FETCH_TRUST_SCORES=true`. Local caches and scheduler state live in the working directory by default, not in the Compose cache volume.

To verify application changes with the existing checks:

```bash
npm test
npx tsc --project tsconfig.json
```

## Work on this documentation

The docs use the same VitePress setup as Nostube and Almond. Dependencies are isolated from the application:

```bash
cd docs
npm ci
npm run docs:dev
```

Open the URL printed by VitePress, including `/nostube-search/`. Build and preview the static site with:

```bash
npm run docs:build
npm run docs:preview
```

The build checks internal links. Output is written to `docs/.vitepress/dist` (relative to the repository root). Agent workflow notes under `docs/agents/` are excluded from the public site.

The `Docs` GitHub Actions workflow builds documentation pull requests and deploys changes on `main` to GitHub Pages. In repository **Settings → Pages**, set **Source** to **GitHub Actions** before the first deployment. The intended public address is `https://flox1an.github.io/nostube-search/`; the API container does not serve the docs.
