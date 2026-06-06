import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { MeiliSearch, type Index } from 'meilisearch';
import { nip19, type Event } from 'nostr-tools';

import {
  computeAuthorProfileCompleteness,
  computeRankingScore,
  computeRelatedEngagementScore,
  computeUrlAvailabilityScore,
  computeVideoMetadataCompleteness,
  type AuthorProfile,
} from './scoring.js';
import { collectWords, mergeWordCounts } from './words.js';
import { connectTrustScoreClient, disconnectTrustScoreClient, fetchTrustScores } from './relatr.js';
import { prune as pruneCache, stats as cacheStats } from './trust-cache.js';
import { fetchAuthorProfiles, profileCache } from './profiles.js';
import {
  sourceRelaysFromEnv,
  fetchAllVideoEvents,
  fetchVideoEventsSince,
  fetchRelationCountsForBatch,
  defaultRelationCounts,
  type EventRelationCounts,
} from './relay-source.js';
import { readState, writeState, setStatePath } from './state.js';

// ── Constants ─────────────────────────────────────────────────────────────────

const BATCH_SIZE = 500;
const TERMS_BATCH_SIZE = 10_000;
const INDEX_UID = 'videos';
const INDEX_NEXT_UID = 'videos_next';
const TERMS_INDEX_UID = 'terms';
const TERMS_NEXT_UID = 'terms_next';

// ── Types ─────────────────────────────────────────────────────────────────────

type VideoEventRow = {
  event_id: string;
  pubkey: string;
  kind: number;
  created_at: number;
  content: string | null;
  raw_event: Event;
};

type EventUrlStats = { urlsTotal: number; urlsAvailable: number };

type TextTrack = { url: string; lang: string | null };
type Origin = {
  platform: string | null;
  externalId: string | null;
  originalUrl: string | null;
  metadata: Record<string, string>;
};
type ParsedImeta = {
  videoUrl: string | null;
  mimeType: string | null;
  dimensions: string | null;
  width: number | null;
  height: number | null;
  imageUrls: string[];
  thumbnail: string | null;
  size: number | null;
  hash: string | null;
  fallbackUrls: string[];
  thumbnailBlurhash: string | null;
  mediaType: 'video' | 'audio' | null;
};

type PlayableImeta = {
  url: string;
  mimeType: string;
  mediaType: 'video' | 'audio';
  dimensions: string | null;
  width: number | null;
  height: number | null;
  thumbnail: string | null;
  size: number | null;
  hash: string | null;
  thumbnailBlurhash: string | null;
};

type SearchDocument = {
  id: string;
  event_id: string;
  pubkey: string;
  npub: string;
  kind: number;
  identifier: string | null;
  title: string;
  summary: string;
  content_preview: string;
  content: string | null;
  created_at: number;
  published_at: number | null;
  effectivePublishedAt: number;
  duration: number | null;
  tags: string[];
  thumbnail: string | null;
  candidateThumbnails: string[];
  thumbnailBlurhash: string | null;
  videoUrl: string | null;
  mimeType: string | null;
  mediaType: 'video' | 'audio' | null;
  dimensions: string | null;
  width: number | null;
  height: number | null;
  isHd: boolean;
  isShort: boolean;
  isVideo: boolean;
  isNostrNative: boolean;
  size: number | null;
  hash: string | null;
  fallbackUrls: string[];
  contentWarning: string | null;
  textTracks: TextTrack[];
  hasCaptions: boolean;
  origins: Origin[];
  nostrUrl: string;
  d_tag: string | null;
  authorDisplayName: string | null;
  relatedEventsTotal: number;
  reactionsCount: number;
  commentsCount: number;
  zapsCount: number;
  urlsAvailable: number;
  urlsTotal: number;
  authorProfileCompleteness: number;
  videoMetadataCompleteness: number;
  globalTrustScore: number;
  rankingScore: number;
  raw_event: Event;
};

// ── Env helpers ───────────────────────────────────────────────────────────────

function loadEnvFromDotEnv(): void {
  const envPath = resolve(process.cwd(), '.env');
  if (!existsSync(envPath)) return;

  const raw = readFileSync(envPath, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const sep = trimmed.indexOf('=');
    if (sep <= 0) continue;
    const key = trimmed.slice(0, sep).trim();
    let value = trimmed.slice(sep + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}

function getRequiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

// ── Event helpers ─────────────────────────────────────────────────────────────

function eventToVideoRow(event: Event): VideoEventRow {
  return {
    event_id: event.id,
    pubkey: event.pubkey,
    kind: event.kind,
    created_at: event.created_at,
    content: event.content || null,
    raw_event: event,
  };
}

function getTags(rawEvent: VideoEventRow['raw_event']): string[][] {
  const maybeTags = rawEvent?.tags;
  if (!Array.isArray(maybeTags)) return [];
  return maybeTags.filter((tag): tag is string[] =>
    Array.isArray(tag) && tag.every(item => typeof item === 'string'),
  );
}

function firstTagValue(tags: string[][], tagName: string): string | null {
  const tag = tags.find(entry => entry[0] === tagName && typeof entry[1] === 'string');
  return tag?.[1] ?? null;
}

function parsePositiveInt(value: string | null): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : null;
}

function parseDimensions(dim: string | null): { dimensions: string | null; width: number | null; height: number | null } {
  const match = dim?.match(/^(\d+)x(\d+)$/i);
  if (!match) return { dimensions: null, width: null, height: null };
  return { dimensions: `${match[1]}x${match[2]}`, width: Number(match[1]), height: Number(match[2]) };
}

function collectTopicTags(tags: string[][]): string[] {
  return tags
    .filter(entry => entry[0] === 't' && typeof entry[1] === 'string' && entry[1].trim().length > 0)
    .map(entry => entry[1]);
}

function parseImetaTags(tags: string[][]): ParsedImeta {
  let videoUrl: string | null = null;
  let mimeType: string | null = null;
  let dimensions: string | null = null;
  let width: number | null = null;
  let height: number | null = null;
  let thumbnail: string | null = null;
  let size: number | null = null;
  let hash: string | null = null;
  let thumbnailBlurhash: string | null = null;
  let mediaType: 'video' | 'audio' | null = null;
  const imageUrls: string[] = [];
  const fallbackUrls: string[] = [];
  let firstAudio: PlayableImeta | null = null;

  for (const imeta of tags.filter(t => t[0] === 'imeta')) {
    const values = new Map<string, string>();
    for (let i = 1; i < imeta.length; i++) {
      const firstSpace = imeta[i].indexOf(' ');
      if (firstSpace !== -1) {
        const key = imeta[i].slice(0, firstSpace);
        const value = imeta[i].slice(firstSpace + 1).trim();
        values.set(key, value);
        if (key === 'image' && value) imageUrls.push(value);
        if ((key === 'fallback' || key === 'mirror') && value) fallbackUrls.push(value);
      }
    }

    const url = values.get('url');
    const m = values.get('m');
    const dim = values.get('dim');
    const type = m?.startsWith('video/') ? 'video' : m?.startsWith('audio/') ? 'audio' : null;

    if (!type || !url || !m) continue;

    const parsedDim = parseDimensions(dim ?? null);
    const playable: PlayableImeta = {
      url,
      mimeType: m,
      mediaType: type,
      dimensions: parsedDim.dimensions,
      width: parsedDim.width,
      height: parsedDim.height,
      thumbnail: values.get('image') ?? null,
      size: parsePositiveInt(values.get('size') ?? null),
      hash: values.get('x') ?? null,
      thumbnailBlurhash: values.get('blurhash') ?? null,
    };

    if (type === 'audio' && !firstAudio) firstAudio = playable;
    if (type === 'video' && !videoUrl) {
      videoUrl = playable.url;
      mimeType = playable.mimeType;
      mediaType = playable.mediaType;
      dimensions = playable.dimensions;
      width = playable.width;
      height = playable.height;
      thumbnail = playable.thumbnail;
      size = playable.size;
      hash = playable.hash;
      thumbnailBlurhash = playable.thumbnailBlurhash;
    }
  }

  if (!videoUrl && firstAudio) {
    videoUrl = firstAudio.url;
    mimeType = firstAudio.mimeType;
    mediaType = firstAudio.mediaType;
    dimensions = firstAudio.dimensions;
    width = firstAudio.width;
    height = firstAudio.height;
    thumbnail = firstAudio.thumbnail;
    size = firstAudio.size;
    hash = firstAudio.hash;
    thumbnailBlurhash = firstAudio.thumbnailBlurhash;
  }

  return {
    videoUrl,
    mimeType,
    dimensions,
    width,
    height,
    imageUrls,
    thumbnail,
    size,
    hash,
    fallbackUrls,
    thumbnailBlurhash,
    mediaType,
  };
}

function parseTextTracks(tags: string[][]): TextTrack[] {
  return tags
    .filter(entry => entry[0] === 'text-track')
    .map(entry => {
      if (entry[1]?.includes(' ')) {
        const values = new Map<string, string>();
        for (let i = 1; i < entry.length; i++) {
          const firstSpace = entry[i].indexOf(' ');
          if (firstSpace !== -1) values.set(entry[i].slice(0, firstSpace), entry[i].slice(firstSpace + 1).trim());
        }
        return { url: values.get('url') ?? '', lang: values.get('lang') ?? values.get('language') ?? null };
      }
      return { url: entry[1] ?? '', lang: entry[2] ?? null };
    })
    .filter(track => track.url.length > 0);
}

function parseOrigins(tags: string[][]): Origin[] {
  return tags
    .filter(entry => entry[0] === 'origin')
    .map(entry => {
      const metadata: Record<string, string> = {};
      let platform = entry[1] ?? null;
      let externalId = entry[2] ?? null;
      let originalUrl = entry[3] ?? null;

      for (let i = 1; i < entry.length; i++) {
        const value = entry[i];
        const separator = value.includes('=') ? '=' : value.includes(' ') ? ' ' : null;
        if (!separator) continue;
        const index = value.indexOf(separator);
        const key = value.slice(0, index);
        const metadataValue = value.slice(index + 1).trim();
        if (!key || !metadataValue) continue;
        metadata[key] = metadataValue;
        if (key === 'platform') platform = metadataValue;
        if (key === 'id' || key === 'externalId' || key === 'external_id') externalId = metadataValue;
        if (key === 'url' || key === 'originalUrl' || key === 'original_url') originalUrl = metadataValue;
      }

      return { platform, externalId, originalUrl, metadata };
    });
}

function isYouTubeUrl(url: string | null): boolean {
  if (!url) return false;
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return hostname === 'youtu.be' || hostname.endsWith('.youtu.be') ||
      hostname === 'youtube.com' || hostname.endsWith('.youtube.com');
  } catch {
    return /(^|\/\/|\.)(youtube\.com|youtu\.be)(\/|$)/i.test(url);
  }
}

function mediaTypeFromUrl(url: string | null): 'video' | 'audio' | null {
  if (!url) return null;
  if (isYouTubeUrl(url)) return 'video';
  const cleanUrl = url.split(/[?#]/, 1)[0]?.toLowerCase() ?? '';
  if (/\.(mp3|m4a|aac|ogg|oga|opus|wav|flac)$/.test(cleanUrl)) return 'audio';
  if (/\.(mp4|m4v|webm|mov|mkv|avi)$/.test(cleanUrl)) return 'video';
  return null;
}

function generateNostubeUrl(row: { event_id: string; pubkey: string; kind: number; d_tag: string | null }): string {
  const isHorizontal = row.kind === 21 || row.kind === 34235;
  const baseUrl = isHorizontal ? 'https://nostu.be/v' : 'https://nostu.be/short';

  if (row.kind >= 30000 && row.kind < 40000 && row.d_tag != null) {
    const naddr = nip19.naddrEncode({
      identifier: row.d_tag,
      pubkey: row.pubkey,
      kind: row.kind,
    });
    return `${baseUrl}/${naddr}?author=${row.pubkey}&video=${row.event_id}`;
  }

  const nevent = nip19.neventEncode({ id: row.event_id, author: row.pubkey });
  if (row.kind === 21) return `${baseUrl}/${nevent}`;
  return `${baseUrl}/${nevent}?author=${row.pubkey}&video=${row.event_id}`;
}

function toSearchDocument(
  row: VideoEventRow,
  profileByPubkey: Map<string, AuthorProfile>,
  relationCountsByEventId: Map<string, EventRelationCounts>,
  urlStatsByEventId: Map<string, EventUrlStats>,
  trustScoreByPubkey: Map<string, number>,
): SearchDocument {
  const tags = getTags(row.raw_event);

  const title = firstTagValue(tags, 'title') ?? 'Untitled';
  const summary = firstTagValue(tags, 'summary') ?? firstTagValue(tags, 'alt') ?? row.content ?? '';
  const contentPreview = summary.slice(0, 200);

  const candidateThumbnails: string[] = [];
  const thumbTag = firstTagValue(tags, 'thumb');
  if (thumbTag) candidateThumbnails.push(thumbTag);
  const imageTag = firstTagValue(tags, 'image');
  if (imageTag) candidateThumbnails.push(imageTag);

  const imeta = parseImetaTags(tags);
  for (const imgUrl of imeta.imageUrls) {
    if (!candidateThumbnails.includes(imgUrl)) candidateThumbnails.push(imgUrl);
  }

  const videoUrl = imeta.videoUrl ?? firstTagValue(tags, 'url');
  const dimensions = imeta.dimensions;
  const mediaType = imeta.mediaType ?? mediaTypeFromUrl(videoUrl);
  const duration = parsePositiveInt(firstTagValue(tags, 'duration'));
  const publishedAt = parsePositiveInt(firstTagValue(tags, 'published_at'));
  const textTracks = parseTextTracks(tags);
  const origins = parseOrigins(tags);

  let npub = '';
  try { npub = nip19.npubEncode(row.pubkey); }
  catch { npub = row.pubkey; }

  const dTag = firstTagValue(tags, 'd');
  const isAddressable = row.kind >= 30000 && row.kind < 40000;
  const docId = isAddressable && dTag !== null ? `${row.kind}:${row.pubkey}:${dTag}` : row.event_id;
  const nostrUrl = generateNostubeUrl({ event_id: row.event_id, pubkey: row.pubkey, kind: row.kind, d_tag: dTag });
  const thumbnail = candidateThumbnails[0] ?? null;
  const contentWarning = firstTagValue(tags, 'content-warning');
  const isShort = row.kind === 22 || row.kind === 34236;
  const isVideo = row.kind === 21 || row.kind === 34235;
  const isNostrNative = !origins.some(origin => origin.platform?.toLowerCase() === 'youtube') && !isYouTubeUrl(videoUrl);

  const authorProfile = profileByPubkey.get(row.pubkey);
  const relationCounts = relationCountsByEventId.get(row.event_id) ?? defaultRelationCounts();
  const urlStats = urlStatsByEventId.get(row.event_id) ?? { urlsTotal: 0, urlsAvailable: 0 };
  const globalTrustScore = trustScoreByPubkey.get(row.pubkey) ?? 0.5;

  const authorProfileCompleteness = computeAuthorProfileCompleteness(authorProfile);
  const videoMetadataCompleteness = computeVideoMetadataCompleteness({
    title, summary, thumbnail, videoUrl, kind: row.kind, width: imeta.width, height: imeta.height,
  });
  const relatedEngagementScore = computeRelatedEngagementScore({
    reactions: relationCounts.reactionsCount,
    comments: relationCounts.commentsCount,
    zaps: relationCounts.zapsCount,
    notes: relationCounts.notesCount,
  });
  const urlAvailabilityScore = computeUrlAvailabilityScore(urlStats.urlsAvailable, urlStats.urlsTotal);
  const rankingScore = computeRankingScore({
    authorProfileCompleteness,
    videoMetadataCompleteness,
    relatedEngagementScore,
    globalTrustScore,
    urlAvailabilityScore,
  });

  return {
    id: docId,
    event_id: row.event_id,
    pubkey: row.pubkey,
    npub,
    kind: row.kind,
    identifier: dTag,
    title,
    summary,
    content_preview: contentPreview,
    content: row.content,
    created_at: row.created_at,
    published_at: publishedAt,
    effectivePublishedAt: publishedAt ?? row.created_at,
    duration,
    tags: collectTopicTags(tags),
    thumbnail,
    candidateThumbnails,
    thumbnailBlurhash: imeta.thumbnailBlurhash,
    videoUrl,
    mimeType: imeta.mimeType,
    mediaType,
    dimensions,
    width: imeta.width,
    height: imeta.height,
    isHd: (imeta.height ?? 0) >= 720,
    isShort,
    isVideo,
    isNostrNative,
    size: imeta.size,
    hash: imeta.hash,
    fallbackUrls: imeta.fallbackUrls,
    contentWarning,
    textTracks,
    hasCaptions: textTracks.length > 0,
    origins,
    nostrUrl,
    d_tag: dTag,
    authorDisplayName: authorProfile?.display_name ?? authorProfile?.username ?? authorProfile?.name ?? null,
    relatedEventsTotal: relationCounts.relatedEventsTotal,
    reactionsCount: relationCounts.reactionsCount,
    commentsCount: relationCounts.commentsCount,
    zapsCount: relationCounts.zapsCount,
    urlsAvailable: urlStats.urlsAvailable,
    urlsTotal: urlStats.urlsTotal,
    authorProfileCompleteness,
    videoMetadataCompleteness,
    globalTrustScore,
    rankingScore,
    raw_event: row.raw_event,
  };
}

// ── Index management ──────────────────────────────────────────────────────────

async function applyVideoIndexSettings(client: MeiliSearch, uid: string): Promise<void> {
  const task = await client.index(uid).updateSettings({
    searchableAttributes: ['title', 'tags', 'summary', 'content_preview', 'content', 'authorDisplayName'],
    filterableAttributes: [
      'event_id', 'kind', 'pubkey', 'published_at', 'created_at', 'duration', 'hasCaptions',
      'effectivePublishedAt', 'isHd', 'isShort', 'isVideo', 'isNostrNative', 'mediaType',
      'identifier', 'd_tag',
    ],
    sortableAttributes: ['rankingScore', 'created_at', 'published_at', 'effectivePublishedAt', 'duration'],
    rankingRules: [
      'words', 'typo', 'proximity', 'attribute', 'exactness', 'sort',
      'rankingScore:desc', 'created_at:desc',
    ],
  });
  await client.waitForTask(task.taskUid);
}

async function applyTermsIndexSettings(client: MeiliSearch, uid: string): Promise<void> {
  const task = await client.index(uid).updateSettings({
    searchableAttributes: ['word'],
    sortableAttributes: ['count'],
    rankingRules: ['words', 'typo', 'proximity', 'attribute', 'exactness', 'count:desc'],
    typoTolerance: { minWordSizeForTypos: { oneTypo: 100, twoTypos: 100 } },
  });
  await client.waitForTask(task.taskUid);
}

async function deleteIndexIfExists(client: MeiliSearch, uid: string): Promise<void> {
  try {
    const task = await client.deleteIndex(uid);
    await client.waitForTask(task.taskUid);
  } catch {
    // index does not exist — nothing to do
  }
}

// Ensures an index exists with correct settings. No-op if already present.
async function ensureIndexExists(
  client: MeiliSearch,
  uid: string,
  primaryKey: string,
  applySettings: (c: MeiliSearch, u: string) => Promise<void>,
): Promise<void> {
  try {
    await client.getIndex(uid);
    await applySettings(client, uid);
  } catch {
    const createTask = await client.createIndex(uid, { primaryKey });
    await client.waitForTask(createTask.taskUid);
    await applySettings(client, uid);
  }
}

// Deletes (if present) and re-creates a clean index with correct settings.
async function createFreshIndex(
  client: MeiliSearch,
  uid: string,
  primaryKey: string,
  applySettings: (c: MeiliSearch, u: string) => Promise<void>,
): Promise<void> {
  await deleteIndexIfExists(client, uid);
  const createTask = await client.createIndex(uid, { primaryKey });
  await client.waitForTask(createTask.taskUid);
  await applySettings(client, uid);
}

// ── Terms upsert ──────────────────────────────────────────────────────────────

// Returns the last enqueued task UID (for waiting before index swap).
async function upsertTerms(
  client: MeiliSearch,
  termsUid: string,
  wordCounts: Map<string, number>,
): Promise<number | undefined> {
  const index = client.index(termsUid);
  const docs = Array.from(wordCounts.entries()).map(([word, count]) => ({ id: word, word, count }));
  let lastTaskUid: number | undefined;
  for (let i = 0; i < docs.length; i += TERMS_BATCH_SIZE) {
    const task = await index.addDocuments(docs.slice(i, i + TERMS_BATCH_SIZE));
    lastTaskUid = task.taskUid;
  }
  return lastTaskUid;
}

// ── Batch processor ───────────────────────────────────────────────────────────

async function indexBatch(
  videosIndex: Index,
  batchEvents: Event[],
  sourceRelays: string[],
  trustClientConnected: boolean,
  batchOffset: number,
  total: number,
): Promise<{ taskUid: number; wordCounts: Map<string, number> }> {
  const rows = batchEvents.map(eventToVideoRow);
  const uniquePubkeys = Array.from(new Set(rows.map(r => r.pubkey)));

  let relationCountsByEventId = new Map<string, EventRelationCounts>();
  try {
    relationCountsByEventId = await fetchRelationCountsForBatch(sourceRelays, batchEvents);
  } catch (err) {
    console.warn(`[Indexer] Relation fetch failed at offset ${batchOffset}:`, err);
  }

  let trustScoreByPubkey: Map<string, number>;
  if (trustClientConnected) {
    try {
      trustScoreByPubkey = await fetchTrustScores(uniquePubkeys);
    } catch (err) {
      console.warn(`[Indexer] Trust score fetch failed at offset ${batchOffset}:`, err);
      trustScoreByPubkey = new Map();
    }
  } else {
    trustScoreByPubkey = new Map();
  }

  const profileByPubkey = await fetchAuthorProfiles(uniquePubkeys);
  const urlStatsByEventId = new Map<string, EventUrlStats>();

  const documents = rows.map(row =>
    toSearchDocument(row, profileByPubkey, relationCountsByEventId, urlStatsByEventId, trustScoreByPubkey),
  );

  const task = await videosIndex.addDocuments(documents);
  console.log(`[Indexer] ${batchOffset + rows.length}/${total} events enqueued (taskUid=${task.taskUid})`);

  return { taskUid: task.taskUid, wordCounts: collectWords(documents) };
}

// ── Incremental update ────────────────────────────────────────────────────────

async function incrementalUpdate(
  client: MeiliSearch,
  sourceRelays: string[],
  trustClientConnected: boolean,
  since: number,
): Promise<void> {
  // Overlap by 5 min to avoid missing events near the boundary
  const sinceSeconds = Math.max(0, Math.floor((since - 5 * 60 * 1000) / 1000));
  console.log(`[Indexer] Incremental update since ${new Date(sinceSeconds * 1000).toISOString()} ...`);

  const newEvents = await fetchVideoEventsSince(sourceRelays, sinceSeconds);

  if (newEvents.length === 0) {
    console.log('[Indexer] Incremental: no new events.');
    writeState({ lastIncrementalAt: Date.now() });
    return;
  }

  console.log(`[Indexer] Incremental: ${newEvents.length} new events to upsert`);

  const videosIndex = client.index(INDEX_UID);
  const allWordCounts = new Map<string, number>();

  for (let offset = 0; offset < newEvents.length; offset += BATCH_SIZE) {
    const batchEvents = newEvents.slice(offset, offset + BATCH_SIZE);
    const { wordCounts } = await indexBatch(
      videosIndex, batchEvents, sourceRelays, trustClientConnected, offset, newEvents.length,
    );
    mergeWordCounts(allWordCounts, wordCounts);
  }

  if (allWordCounts.size > 0) {
    await upsertTerms(client, TERMS_INDEX_UID, allWordCounts);
  }

  writeState({ lastIncrementalAt: Date.now() });
  console.log(`[Indexer] Incremental complete — upserted ${newEvents.length} events.`);
}

// ── Full re-index (rolling swap) ──────────────────────────────────────────────

async function fullReindex(
  client: MeiliSearch,
  sourceRelays: string[],
  trustClientConnected: boolean,
): Promise<void> {
  console.log('[Indexer] Starting full re-index (rolling swap) ...');

  // Ensure primary indexes exist so the swap API accepts both sides
  await ensureIndexExists(client, INDEX_UID, 'id', applyVideoIndexSettings);
  await ensureIndexExists(client, TERMS_INDEX_UID, 'id', applyTermsIndexSettings);

  // Clean up orphaned _next indexes from a previously interrupted run
  await deleteIndexIfExists(client, INDEX_NEXT_UID);
  await deleteIndexIfExists(client, TERMS_NEXT_UID);

  // Build the new indexes from scratch
  await createFreshIndex(client, INDEX_NEXT_UID, 'id', applyVideoIndexSettings);
  await createFreshIndex(client, TERMS_NEXT_UID, 'id', applyTermsIndexSettings);

  const nextVideosIndex = client.index(INDEX_NEXT_UID);
  const allWordCounts = new Map<string, number>();
  let lastVideosTaskUid: number | undefined;

  const allEvents = await fetchAllVideoEvents(sourceRelays);
  const total = allEvents.length;
  console.log(`[Indexer] Full re-index: ${total} events`);

  for (let offset = 0; offset < total; offset += BATCH_SIZE) {
    const batchEvents = allEvents.slice(offset, offset + BATCH_SIZE);
    const { taskUid, wordCounts } = await indexBatch(
      nextVideosIndex, batchEvents, sourceRelays, trustClientConnected, offset, total,
    );
    lastVideosTaskUid = taskUid;
    mergeWordCounts(allWordCounts, wordCounts);
  }

  console.log(`[Indexer] Upserting ${allWordCounts.size} terms into ${TERMS_NEXT_UID} ...`);
  const lastTermsTaskUid = await upsertTerms(client, TERMS_NEXT_UID, allWordCounts);

  // Wait for all enqueued tasks to finish before swapping
  if (lastVideosTaskUid !== undefined) await client.waitForTask(lastVideosTaskUid);
  if (lastTermsTaskUid !== undefined) await client.waitForTask(lastTermsTaskUid);

  // Atomically swap: videos ↔ videos_next, terms ↔ terms_next
  console.log('[Indexer] Swapping indexes ...');
  const swapTask = await client.swapIndexes([
    { indexes: [INDEX_UID, INDEX_NEXT_UID] },
    { indexes: [TERMS_INDEX_UID, TERMS_NEXT_UID] },
  ]);
  await client.waitForTask(swapTask.taskUid);
  console.log('[Indexer] Swap complete. Deleting old data ...');

  // _next indexes now hold the previous (old) data — remove them
  await deleteIndexIfExists(client, INDEX_NEXT_UID);
  await deleteIndexIfExists(client, TERMS_NEXT_UID);

  const now = Date.now();
  writeState({ lastFullAt: now, lastIncrementalAt: now });
  console.log(`[Indexer] Full re-index complete — ${total} events live.`);
}

// ── Scheduler ─────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(res => setTimeout(res, ms));
}

async function runScheduler(
  client: MeiliSearch,
  sourceRelays: string[],
  trustClientConnected: boolean,
): Promise<void> {
  const fullIntervalMs = Number(process.env.INDEXER_FULL_INTERVAL_MS) || 86_400_000; // 24 h
  const incrIntervalMs = Number(process.env.INDEXER_INCREMENTAL_INTERVAL_MS) || 600_000; // 10 min
  const checkIntervalMs = 60_000; // loop cadence: check every 60 s

  console.log(
    `[Scheduler] Full re-index every ${fullIntervalMs / 3_600_000}h, ` +
    `incremental every ${incrIntervalMs / 60_000}m`,
  );

  let shuttingDown = false;
  const onSignal = () => { shuttingDown = true; };
  process.once('SIGTERM', onSignal);
  process.once('SIGINT', onSignal);

  while (!shuttingDown) {
    const state = readState();
    const now = Date.now();

    const needsFull = now - state.lastFullAt >= fullIntervalMs;
    // Only consider incremental if a full index already exists
    const needsIncremental = !needsFull && state.lastFullAt > 0 && now - state.lastIncrementalAt >= incrIntervalMs;

    try {
      if (needsFull) {
        await fullReindex(client, sourceRelays, trustClientConnected);
      } else if (needsIncremental) {
        await incrementalUpdate(client, sourceRelays, trustClientConnected, state.lastIncrementalAt);
      }
    } catch (err) {
      console.error('[Scheduler] Run failed (will retry next cycle):', err);
    }

    if (!shuttingDown) await sleep(checkIntervalMs);
  }

  console.log('[Scheduler] Shutting down.');
}

// ── Entry point ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  loadEnvFromDotEnv();

  const meiliUrl = getRequiredEnv('MEILI_URL');
  const meiliMasterKey = getRequiredEnv('MEILI_MASTER_KEY');

  if (process.env.PROFILE_CACHE_PATH) profileCache.setCachePath(process.env.PROFILE_CACHE_PATH);
  if (process.env.PROFILE_CACHE_TTL_MS) {
    const v = Number(process.env.PROFILE_CACHE_TTL_MS);
    if (Number.isFinite(v) && v > 0) profileCache.setCacheTTL(v);
  }
  if (process.env.INDEXER_STATE_PATH) setStatePath(process.env.INDEXER_STATE_PATH);

  const pruned = pruneCache();
  const cs = cacheStats();
  console.log(
    `[TrustCache] ${cs.entries} entries, TTL=${cs.ttlMs}ms` +
    (pruned > 0 ? `, pruned ${pruned} expired` : ''),
  );

  const prunedProfiles = profileCache.prune();
  const pcs = profileCache.stats();
  console.log(
    `[ProfileCache] ${pcs.entries} entries, TTL=${pcs.ttlMs}ms` +
    (prunedProfiles > 0 ? `, pruned ${prunedProfiles} expired` : ''),
  );

  const sourceRelays = sourceRelaysFromEnv();
  console.log(`[Indexer] Source relays: ${sourceRelays.join(', ')}`);

  const client = new MeiliSearch({ host: meiliUrl, apiKey: meiliMasterKey });
  await ensureIndexExists(client, INDEX_UID, 'id', applyVideoIndexSettings);
  await ensureIndexExists(client, TERMS_INDEX_UID, 'id', applyTermsIndexSettings);

  const [videosStats, termsStats] = await Promise.all([
    client.index(INDEX_UID).getStats(),
    client.index(TERMS_INDEX_UID).getStats(),
  ]);
  console.log(
    `[Indexer] Index status: ${INDEX_UID}=${videosStats.numberOfDocuments} docs, ` +
    `${TERMS_INDEX_UID}=${termsStats.numberOfDocuments} docs`,
  );

  const trustScoresEnabled = process.env.FETCH_TRUST_SCORES === 'true';
  let trustClientConnected = false;

  if (trustScoresEnabled) {
    try {
      await connectTrustScoreClient();
      trustClientConnected = true;
      console.log('[Indexer] Trust score client connected');
    } catch (err) {
      console.warn('[Indexer] Trust score client unavailable — using default 0.5:', err);
    }
  } else {
    console.log('[Indexer] FETCH_TRUST_SCORES disabled — using default 0.5 for all documents');
  }

  try {
    await runScheduler(client, sourceRelays, trustClientConnected);
  } finally {
    await disconnectTrustScoreClient();
  }
}

export { main };
