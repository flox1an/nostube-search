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
  raw_event: { tags?: unknown };
};

type EventUrlStats = { urlsTotal: number; urlsAvailable: number };

type SearchDocument = {
  id: string;
  event_id: string;
  pubkey: string;
  npub: string;
  kind: number;
  title: string;
  summary: string;
  content: string | null;
  created_at: number;
  tags: string[];
  thumbnail: string | null;
  candidateThumbnails: string[];
  videoUrl: string | null;
  mimeType: string | null;
  width: number | null;
  height: number | null;
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
    raw_event: { tags: event.tags },
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

function collectTopicTags(tags: string[][]): string[] {
  return tags
    .filter(entry => entry[0] === 't' && typeof entry[1] === 'string' && entry[1].trim().length > 0)
    .map(entry => entry[1]);
}

function parseImetaTags(tags: string[][]): {
  videoUrl: string | null;
  mimeType: string | null;
  width: number | null;
  height: number | null;
  imageUrls: string[];
} {
  let videoUrl: string | null = null;
  let mimeType: string | null = null;
  let width: number | null = null;
  let height: number | null = null;
  const imageUrls: string[] = [];

  for (const imeta of tags.filter(t => t[0] === 'imeta')) {
    const values = new Map<string, string>();
    for (let i = 1; i < imeta.length; i++) {
      const firstSpace = imeta[i].indexOf(' ');
      if (firstSpace !== -1) {
        const key = imeta[i].slice(0, firstSpace);
        const value = imeta[i].slice(firstSpace + 1).trim();
        values.set(key, value);
        if (key === 'image' && value) imageUrls.push(value);
      }
    }

    const url = values.get('url');
    const m = values.get('m');
    const dim = values.get('dim');

    if (m?.startsWith('video/') && url) {
      videoUrl = url;
      mimeType = m;
      if (dim) {
        const [w, h] = dim.split('x').map(Number);
        if (w && h) { width = w; height = h; }
      }
    }
  }

  return { videoUrl, mimeType, width, height, imageUrls };
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
  const summary = firstTagValue(tags, 'summary') ?? row.content ?? '';

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

  let npub = '';
  try { npub = nip19.npubEncode(row.pubkey); }
  catch { npub = row.pubkey; }

  const dTag = firstTagValue(tags, 'd');
  const thumbnail = candidateThumbnails[0] ?? null;

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
    id: row.event_id,
    event_id: row.event_id,
    pubkey: row.pubkey,
    npub,
    kind: row.kind,
    title,
    summary,
    content: row.content,
    created_at: row.created_at,
    tags: collectTopicTags(tags),
    thumbnail,
    candidateThumbnails,
    videoUrl,
    mimeType: imeta.mimeType,
    width: imeta.width,
    height: imeta.height,
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
  };
}

// ── Index management ──────────────────────────────────────────────────────────

async function applyVideoIndexSettings(client: MeiliSearch, uid: string): Promise<void> {
  const task = await client.index(uid).updateSettings({
    searchableAttributes: ['title', 'tags', 'summary', 'content', 'authorDisplayName'],
    filterableAttributes: ['kind', 'pubkey'],
    sortableAttributes: ['rankingScore', 'created_at'],
    rankingRules: [
      'words', 'typo', 'proximity', 'attribute', 'exactness',
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
