# How the search engine works

Nostube Search turns Nostr video events into searchable documents: it pulls signed events from relays, extracts media metadata, enriches each document, builds MeiliSearch indices and serves filtered, ranked results over HTTP. This page follows the pipeline from event to result.

## Ingestion

The indexer connects to the relays in `NOSTR_SOURCE_RELAYS` using a Nostr client and requests only video event kinds:

| Kind | Meaning |
| --- | --- |
| `21` | NIP-71 horizontal video (regular event) |
| `22` | NIP-71 short-form video (regular event) |
| `34235` | Parameterized replaceable video event |
| `34236` | Parameterized replaceable short event |

Events are signature-verified; invalid ones are dropped. For parameterized replaceable events (kind 34xxx), the indexer deduplicates by `kind:pubkey:d-tag` and keeps only the newest version, so republished or edited videos replace rather than duplicate their document.

Pagination walks each source relay backwards in time, requesting pages of 500 events, then merges the verified events and deduplicates them. Discovery is limited to the history those configured relays return, not all of Nostr.

## Metadata extraction

For every event, the indexer parses tags and `imeta` entries to build a search document:

- **Title** from the `title` tag; `Untitled` as fallback.
- **Summary** from `summary` or `alt`, falling back to the event content.
- **Media URL** from the first video-MIME `imeta` entry (`url` + `m`), or the `url` tag as fallback. Audio `imeta` entries are used when no video entry exists.
- **Thumbnail** from `thumb`, then `image`, then `imeta` image URLs.
- **Duration** from the event's `duration` tag. **Dimensions, MIME type, size, hash and blurhash** come from the selected playable `imeta` entry.
- **Fallback/mirror URLs** from `imeta` `fallback`/`mirror` values.
- **Captions** from `text-track` tags, including their languages.
- **Language** from the `language`/`lang`/`locale` tag first. If absent, a local detector classifies title/summary/content; if still unknown, a single caption language is used. Source and confidence are stored (`tag`, `local`, or `caption`).
- **Content warnings** from explicit tags plus platform-detected NSFW attributes (see [`nsfw-platform-detection.ts`](https://github.com/flox1an/nostube-search/blob/main/src/nsfw-platform-detection.ts)).
- **Origins** from `origin` tags (e.g. mirrored YouTube content), used for the `isNostrNative` flag.
- **`nostrUrl`** — a canonical `https://nostu.be/v/...` or `/short/...` link built from the event's `nevent`/`naddr`.

Documents are upserted: addressable events use a stable document ID derived from `kind`, `pubkey` and `d-tag`, so re-indexing the same logical video overwrites instead of duplicating.

Author identity is stored as hex `pubkey` plus an npub-encoded `npub`. Ordinary search responses currently return the hex `pubkey`; people responses include both.

## Enrichment

Each document is enriched with data fetched per batch:

| Signal | Source |
| --- | --- |
| Author profile (name, picture, NIP-05, Lightning address) | kind-0 events, cached in `PROFILE_CACHE_PATH` |
| Engagement counts (reactions, comments, zaps, notes referencing the video) | relation events on the source relays |
| Trust score per author | ContextVM/relatr client when `FETCH_TRUST_SCORES=true`; default `0.5` when disabled or unavailable |
| Media availability | `media_availability` index (see below) |

From these, a `rankingScore` in `[0,1]` is computed as a weighted blend:

| Signal | Weight |
| --- | --- |
| Author profile completeness | 0.25 |
| Video metadata completeness | 0.25 |
| Related engagement (reactions/comments/zaps/notes) | 0.20 |
| Author trust score | 0.20 |
| URL availability ratio | 0.10 |

`playlistScore` is computed separately: kind-30005 playlists contribute the trust scores of unique qualifying authors who listed each video. Scores are log-normalized against the highest accumulated video score, not the strongest individual playlist.

The URL-availability component of `rankingScore` is currently zero: the batch indexer supplies no URL statistics to that calculation. The separate media checker updates availability fields, not this score. Do not interpret `rankingScore` as proof of playability.

## Indexing

MeiliSearch holds four indices:

| Index | Content |
| --- | --- |
| `videos` | One searchable document per unique video |
| `terms` | Word counts for prefix completion (`/api/search/completion`) |
| `people` | Author profiles for people search |
| `media_availability` | Durable per-media availability records |

The `videos` index is configured with searchable attributes (`title`, `tags`, `summary`, `content_preview`, `content`, `authorDisplayName`), filterable fields (kind, duration, dates, language, captions, availability, content warnings, tags, media type and more) and sortable fields including `rankingScore` and `playlistScore`.

### Rolling swap

A full re-index never deletes the live index. The indexer:

1. Builds complete new indices under `videos_next` and `terms_next`.
2. Waits for all writes to finish.
3. Atomically swaps `videos` ↔ `videos_next` and `terms` ↔ `terms_next` (a MeiliSearch swap task).
4. Deletes the old data now living in the `_next` indices.

Search traffic keeps hitting the old index until the swap, so rebuilds don't interrupt service. If a rebuild crashes, orphaned `_next` indices are cleaned up on the next run.

Between full rebuilds, incremental updates (default every 10 minutes) fetch only events newer than the last run (with a 5-minute overlap for safety) and upsert them directly into the live index, along with people and term updates.

The people index is upserted after a full swap, not swapped atomically alongside video/term indices. Its `videoCount` currently counts indexing batches containing the author, not an exact lifetime video total. Term counts in incremental passes describe that update batch rather than an accumulated global count. These are implementation limits, not view or popularity metrics.

## Serving search

`GET /api/search` queries MeiliSearch with `q`, pagination, sort and filters for type, duration, date, kinds, languages, features and availability. The process also caches safety policies, recommendation inputs/results and the sitemap in memory. Successful `GET /api/*` responses carry `Cache-Control` so a reverse proxy can absorb repeat traffic. See the [API reference](../reference/api) for parameters and defaults.

MeiliSearch's default ranking rules run first (`words`, `typo`, `proximity`, `attribute`, `exactness`), then `sort`, then the custom signals:

```
words → typo → proximity → attribute → exactness → sort
      → rankingScore:desc → playlistScore:desc → created_at:desc
```

Text match quality dominates; among equally good matches and requested sort values, the custom metadata/engagement/trust score, playlist score and creation time break ties. Returned `rankingScore` is the stored custom score, not MeiliSearch's query-dependent `_rankingScore`. Explicit sorts still follow the preceding text-ranking rules.

Page size is capped at 100 and offset at 1000; MeiliSearch itself caps deep pagination at `maxTotalHits` (1000).

## Safety filtering

Every safety-aware endpoint resolves a policy before searching:

- **Default path** (no `presetPubkey`): an empty built-in policy plus the content-warning exclusion. With `nsfwFilter=hide` (the default), every document carrying a `contentWarning` — including platform-detected NSFW — is filtered out.
- **Preset path**: the requested author's NIP-78 kind-30078 event (d-tag `nostube-presets`) supplies `blockedPubkeys`, `nsfwPubkeys` and `blockedEvents`. Blocked entries remain excluded regardless of `nsfwFilter`. NSFW authors are excluded on `hide`, annotated with `contentWarning: "NSFW"` on `warning`, and included without adding that annotation on `show`. Existing explicit warnings are not erased by `show`. Presets are cached: fresh hits return immediately, stale hits refresh in the background, and older/missing entries refresh synchronously. Failed refreshes can retain a cached policy beyond the configured maximum age.
- **Operator blocklist**: a built-in list plus `NOSTUBE_BLOCKED_AUTHORS` (or fallback `BLOCKED_AUTHOR_NPUBS`) applies to video search, title suggestions, recommendation source/candidates and sitemap. It does not filter people search or word completion.

`/api/people` searches the `people` index, which has no `contentWarning` field, so the default content-warning exclusion cannot apply there — only a supplied preset's pubkey lists are enforced.

## Media availability

The availability checker runs on a schedule (default every 10 minutes, serialized via a lock file). For each due video it builds candidate URLs from the primary `videoUrl`, `fallbackUrls` and the author's cached Blossom server list (kind 10063), then sends HTTP `HEAD` requests. Results — `available`, `unavailable`, `error` or `unknown`, with a `playableUrl` — are written to the durable `media_availability` index and patched into the video documents.

Here “available” means a successful `HEAD` response, not a codec, streaming or full playback test. `unknown` is the initial state; request failures can yield `error`.

Search keeps full recall unless the caller passes `available=true` (only verified-playable media) or `available=exclude-unavailable` (hide known-broken media). Suggestions and recommendation candidates hide known-unavailable media by default.

## Recommendations

`POST /api/recommendations/related` resolves the given `videoRef` (hex event ID, `nevent` or `naddr`), finds the source document and combines:

- **tag, author and kind affinity** from the source video,
- **user affinity** (optional `user` parameter): the caller's recent reactions/likes/zaps, fetched from relays and cached briefly,
- **language match** with the source video, unless `language` is passed explicitly (`"any"` disables it),
- safety filters identical to search,
- exclusion of known-unavailable media by default.

The result is a scored, deduplicated list of related videos. It is not a collaborative-filtering model; it is a deterministic blend of content overlap, user signal and safety filters.

## Built-in web UI

The API serves a small static search UI at `/` from `src/api/public`. It uses the same public endpoints documented in the [API reference](../reference/api) and is a starting point for your own client, not a required component.
