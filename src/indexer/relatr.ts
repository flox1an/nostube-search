/**
 * Trust score client for the relatr ContextVM MCP server.
 *
 * Uses ContextVM (Nostr transport) instead of HTTP MCP — the relatr server
 * only exposes a Nostr-based transport via @contextvm/sdk.
 *
 * Results are cached locally via TrustCache to avoid redundant network calls
 * when the same pubkeys appear across indexer batches.
 *
 * Server identity (from nostube/src/nostr/contextvm.ts):
 *   npub: npub16w48u4xvtlp7ywgfsjlud74tlgdfx9s33scdlafmgl3a40n9tthsu6ty8g
 *   hex:  d3aa7e54cc5fc3e2390984bfc6faabfa1a9316118c30dff53b47e3dabe655aef
 *   relay: wss://relay2.contextvm.org
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { NostrClientTransport, PrivateKeySigner, ApplesauceRelayPool } from '@contextvm/sdk';
import { nip19 } from 'nostr-tools';
import { getMany, setMany } from './trust-cache.js';

const SERVER_NPUB = 'npub16w48u4xvtlp7ywgfsjlud74tlgdfx9s33scdlafmgl3a40n9tthsu6ty8g';
const CONTEXTVM_RELAYS = ['wss://relay2.contextvm.org'];

// Decode server npub to hex once at module load
const decoded = nip19.decode(SERVER_NPUB);
const SERVER_PUBKEY_HEX = decoded.data as string;

/** Individual validator score from ContextVM */
interface ValidatorScore {
  score: number;
  description?: string;
}

/** Trust score result from ContextVM */
export interface TrustScoreResult {
  sourcePubkey: string;
  targetPubkey: string;
  score: number;
  components: {
    distanceWeight: number;
    socialDistance: number;
    normalizedDistance: number;
    validators: Record<string, ValidatorScore>;
  };
  computedAt: number;
}

/** Validators that contribute to the global (non-personalized) video creator score */
const VIDEO_INDICATORS = new Set([
  'video_creator_activity',
  'video_viewer_engagement',
  'video_creator_comments',
]);

const DEFAULT_CHUNK_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_FETCH_MS = 60_000;
const DEFAULT_MAX_CONSECUTIVE_FAILURES = 2;
const DEFAULT_DISCONNECT_TIMEOUT_MS = 2_000;
const DEFAULT_COOLDOWN_MS = 5 * 60_000;
const TRUST_SCORE_CHUNK_SIZE = 50;

// Singleton state
let activeClient: Client | null = null;
let activeTransport: NostrClientTransport | null = null;
let activeRelayPool: ApplesauceRelayPool | null = null;
let trustScoreCooldownUntil = 0;

class TrustScoreTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TrustScoreTimeoutError';
  }
}

function getPositiveIntEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function isTimeoutLike(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const msg = error.message ?? '';
  return error.name === 'TrustScoreTimeoutError'
    || error.name === 'AbortError'
    || msg.includes('timeout')
    || msg.includes('Timeout')
    || msg.includes('ETIMEDOUT')
    || msg.includes('listOnTimeout');
}

function startTrustScoreCooldown(reason: string): void {
  const cooldownMs = getPositiveIntEnv('TRUST_SCORE_COOLDOWN_MS', DEFAULT_COOLDOWN_MS);
  trustScoreCooldownUntil = Date.now() + cooldownMs;
  console.warn(`[TrustScore] Entering ${cooldownMs}ms cooldown; future uncached pubkeys will use default scores. Reason: ${reason}`);
}

async function closeWithTimeout(label: string, close: () => Promise<unknown>, timeoutMs: number): Promise<void> {
  try {
    await Promise.race([
      close(),
      new Promise((_, reject) => {
        setTimeout(() => reject(new TrustScoreTimeoutError(`${label} close timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } catch (error) {
    console.warn(`[TrustScore] ${label} close skipped/failed:`, error);
  }
}

async function callTrustScoreTool(client: Client, chunk: string[], timeoutMs: number): Promise<unknown> {
  const controller = new AbortController();
  let timeoutId: NodeJS.Timeout | undefined;

  const hardTimeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      const error = new TrustScoreTimeoutError(`Trust score chunk timed out after ${timeoutMs}ms`);
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });

  try {
    return await Promise.race([
      client.callTool(
        {
          name: 'calculate_trust_scores',
          arguments: { targetPubkeys: chunk },
        },
        undefined,
        {
          timeout: timeoutMs,
          maxTotalTimeout: timeoutMs,
          signal: controller.signal,
        },
      ),
      hardTimeout,
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

/**
 * Connect to the relatr ContextVM server using an ephemeral key.
 * Returns the MCP Client ready for tool calls.
 */
export async function connectTrustScoreClient(): Promise<Client> {
  if (activeClient) {
    console.log('[TrustScore] Reusing existing client connection');
    return activeClient;
  }

  const signer = new PrivateKeySigner();
  const relayPool = new ApplesauceRelayPool(CONTEXTVM_RELAYS);

  console.log(`[TrustScore] Connecting to relatr server ${SERVER_NPUB}`);
  console.log(`[TrustScore] Relays: ${CONTEXTVM_RELAYS.join(', ')}`);
  console.log(`[TrustScore] Server pubkey hex: ${SERVER_PUBKEY_HEX}`);

  const transport = new NostrClientTransport({
    serverPubkey: SERVER_PUBKEY_HEX,
    signer,
    relayHandler: relayPool,
    isStateless: true,
  });

  const client = new Client({
    name: 'nostube-search-indexer',
    version: '1.0.0',
  });

  const connectStart = Date.now();
  try {
    await client.connect(transport);
    const elapsed = Date.now() - connectStart;
    console.log(`[TrustScore] Connected to relatr via ContextVM (${elapsed}ms)`);
  } catch (error) {
    const elapsed = Date.now() - connectStart;
    console.error(`[TrustScore] Connection FAILED after ${elapsed}ms`);
    if (error instanceof Error) {
      console.error(`[TrustScore]   Name: ${error.name}`);
      console.error(`[TrustScore]   Message: ${error.message}`);
      if ((error as any).code) console.error(`[TrustScore]   Code: ${(error as any).code}`);
      if ((error as any).cause) console.error(`[TrustScore]   Cause:`, (error as any).cause);
      console.error(`[TrustScore]   Stack: ${error.stack}`);
    } else {
      console.error(`[TrustScore]   Raw error:`, error);
    }
    throw error;
  }

  activeClient = client;
  activeTransport = transport;
  activeRelayPool = relayPool;

  return client;
}

/**
 * Disconnect from the relatr server and clean up resources.
 */
export async function disconnectTrustScoreClient(): Promise<void> {
  const disconnectTimeoutMs = getPositiveIntEnv('TRUST_SCORE_DISCONNECT_TIMEOUT_MS', DEFAULT_DISCONNECT_TIMEOUT_MS);

  if (activeClient) {
    await closeWithTimeout('client', () => activeClient!.close(), disconnectTimeoutMs);
    activeClient = null;
  }
  if (activeTransport) {
    await closeWithTimeout('transport', () => activeTransport!.close(), disconnectTimeoutMs);
    activeTransport = null;
  }
  if (activeRelayPool) {
    await closeWithTimeout('relay pool', () => activeRelayPool!.disconnect(), disconnectTimeoutMs);
  activeRelayPool = null;
  trustScoreCooldownUntil = 0;
}
}

/**
 * Extract the global (non-personalized) score from a trust score result.
 * Uses only video-related validators, ignoring personalized distance weights.
 */
export function getGlobalScore(result: TrustScoreResult): number | null {
  const validators = result.components?.validators;
  if (!validators || typeof validators !== 'object') {
    console.warn(`[TrustScore] getGlobalScore: no validators in result for ${result.targetPubkey?.slice(0, 12)}...`);
    return null;
  }

  const videoScores: number[] = [];
  for (const [key, val] of Object.entries(validators)) {
    // Handle namespaced keys like "d3aa7e54:video_creator_activity"
    const indicator = key.includes(':') ? key.slice(key.indexOf(':') + 1) : key;
    if (VIDEO_INDICATORS.has(indicator)) {
      videoScores.push(val.score);
    }
  }

  if (videoScores.length === 0) {
    const allKeys = Object.keys(validators).join(', ');
    console.warn(`[TrustScore] getGlobalScore: no video indicators found. Available validators: ${allKeys}`);
    return null;
  }

  return videoScores.reduce((sum, s) => sum + s, 0) / videoScores.length;
}

// ---- MCP result parsing ----

function extractTrustScores(payload: unknown): TrustScoreResult[] {
  if (!payload || typeof payload !== 'object') {
    console.warn('[TrustScore] extractTrustScores: payload is not an object:', typeof payload);
    return [];
  }

  // structuredContent.trustScores
  const content = (payload as Record<string, unknown>).structuredContent as
    | Record<string, unknown>
    | undefined;
  if (content && Array.isArray(content.trustScores)) {
    console.log(`[TrustScore] Extracted ${content.trustScores.length} scores via structuredContent`);
    return content.trustScores as TrustScoreResult[];
  }

  // content[].text fallback
  const contentArray = (payload as Record<string, unknown>).content as
    | Array<Record<string, unknown>>
    | undefined;
  if (Array.isArray(contentArray)) {
    const textBlock = contentArray.find(c => c.type === 'text');
    if (textBlock?.text && typeof textBlock.text === 'string') {
      try {
        const parsed = JSON.parse(textBlock.text);
        if (Array.isArray(parsed)) {
          console.log(`[TrustScore] Extracted ${parsed.length} scores via content[].text (JSON array)`);
          return parsed as TrustScoreResult[];
        }
        console.log('[TrustScore] Extracted 1 score via content[].text (single object)');
        return [parsed as TrustScoreResult];
      } catch (parseError) {
        const preview = textBlock.text.slice(0, 200);
        console.warn(`[TrustScore] Failed to parse text content as JSON. Preview: ${preview}...`);
        return [];
      }
    } else {
      console.warn('[TrustScore] extractTrustScores: no text block found in content array');
      console.warn(`[TrustScore]   content array has ${contentArray.length} items of types:`, contentArray.map(c => c.type));
    }
  } else {
    console.warn('[TrustScore] extractTrustScores: no content array found in payload');
    console.warn('[TrustScore]   Payload keys:', Object.keys(payload as Record<string, unknown>));
  }

  return [];
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

/**
 * Fetch global trust scores for a batch of pubkeys, using a local file cache
 * to avoid redundant network calls.
 *
 * Pubkeys with a fresh cache hit are returned immediately.
 * Only uncached / expired pubkeys trigger ContextVM calls.
 * Fresh results are written back to the cache before returning.
 *
 * Requires connectTrustScoreClient() to have been called first.
 */
export async function fetchTrustScores(pubkeys: string[]): Promise<Map<string, number>> {
  const startTotal = Date.now();
  const scores = new Map<string, number>();
  if (!pubkeys.length) {
    console.log('[TrustScore] fetchTrustScores: empty pubkey list, returning immediately');
    return scores;
  }

  console.log(`[TrustScore] fetchTrustScores: ${pubkeys.length} pubkeys, first 3: ${pubkeys.slice(0, 3).map(pk => pk.slice(0, 12) + '...').join(', ')}`);

  // 1. Check cache for all requested pubkeys
  const cacheStart = Date.now();
  const cached = getMany(pubkeys);
  const cacheLookupMs = Date.now() - cacheStart;
  const missing = pubkeys.filter(pk => !cached.has(pk));

  console.log(`[TrustScore] Cache check: ${cached.size} hits, ${missing.length} misses (${cacheLookupMs}ms)`);

  // Seed scores with cache hits
  for (const [pk, score] of cached) {
    scores.set(pk, score);
  }

  if (Date.now() < trustScoreCooldownUntil) {
    const remainingMs = trustScoreCooldownUntil - Date.now();
    console.warn(`[TrustScore] Relatr cooldown active for another ${remainingMs}ms — ${missing.length} uncached pubkeys will use default score`);
    return scores;
  }

  // If no active client, return whatever we have from cache
  if (!activeClient) {
    if (missing.length > 0) {
      console.warn(`[TrustScore] No active client — ${missing.length} uncached pubkeys will use default score`);
    }
    return scores;
  }

  if (missing.length === 0) {
    console.log(`[TrustScore] All ${pubkeys.length} pubkeys served from cache — skipping ContextVM call`);
    return scores;
  }

  // 2. Fetch only missing pubkeys via ContextVM
  const chunkTimeoutMs = getPositiveIntEnv('TRUST_SCORE_CHUNK_TIMEOUT_MS', DEFAULT_CHUNK_TIMEOUT_MS);
  const maxFetchMs = getPositiveIntEnv('TRUST_SCORE_MAX_FETCH_MS', DEFAULT_MAX_FETCH_MS);
  const maxConsecutiveFailures = getPositiveIntEnv('TRUST_SCORE_MAX_CONSECUTIVE_FAILURES', DEFAULT_MAX_CONSECUTIVE_FAILURES);
  const deadline = startTotal + maxFetchMs;
  const chunks: string[][] = [];
  for (let i = 0; i < missing.length; i += TRUST_SCORE_CHUNK_SIZE) {
    chunks.push(missing.slice(i, i + TRUST_SCORE_CHUNK_SIZE));
  }

  console.log(`[TrustScore] Fetching ${missing.length} missing pubkeys in ${chunks.length} chunks (chunk size=${TRUST_SCORE_CHUNK_SIZE}, chunk timeout=${chunkTimeoutMs}ms, max fetch=${maxFetchMs}ms)`);

  const freshScores = new Map<string, number>();
  let successCount = 0;
  let failCount = 0;
  let skippedCount = 0;
  let consecutiveFailures = 0;

  for (let ci = 0; ci < chunks.length; ci++) {
    const chunk = chunks[ci];
    const chunkPubkeySample = chunk.slice(0, 3).map(pk => pk.slice(0, 12) + '...').join(', ')
      + (chunk.length > 3 ? ` +${chunk.length - 3} more` : '');

    if (Date.now() >= deadline) {
      skippedCount = chunks.length - ci;
      console.warn(`[TrustScore] Stopping trust score fetch after ${Date.now() - startTotal}ms budget; ${skippedCount} chunks will use default scores`);
      startTrustScoreCooldown('max fetch budget exceeded');
      break;
    }

    if (consecutiveFailures >= maxConsecutiveFailures) {
      skippedCount = chunks.length - ci;
      console.warn(`[TrustScore] Stopping trust score fetch after ${consecutiveFailures} consecutive failed chunks; ${skippedCount} chunks will use default scores`);
      startTrustScoreCooldown(`${consecutiveFailures} consecutive failed chunks`);
      break;
    }

    console.log(`[TrustScore] Chunk ${ci + 1}/${chunks.length}: ${chunk.length} pubkeys [${chunkPubkeySample}]`);

    const chunkStart = Date.now();
    try {
      const result = await callTrustScoreTool(activeClient, chunk, Math.min(chunkTimeoutMs, Math.max(1, deadline - Date.now())));
      const chunkElapsed = Date.now() - chunkStart;

      console.log(`[TrustScore] Chunk ${ci + 1} responded in ${chunkElapsed}ms`);

      const trustScores = extractTrustScores(result);

      console.log(`[TrustScore] Chunk ${ci + 1}: received ${trustScores.length} trust score results`);

      for (const item of trustScores) {
        if (!item.targetPubkey) {
          console.warn(`[TrustScore]   Skipping result with no targetPubkey:`, JSON.stringify(item).slice(0, 100));
          continue;
        }
        const globalScore = getGlobalScore(item);
        const score = clamp01(globalScore ?? 0.5);
        freshScores.set(item.targetPubkey, score);
        scores.set(item.targetPubkey, score);

        const pubkeyShort = item.targetPubkey.slice(0, 12) + '...';
        console.log(`[TrustScore]   ${pubkeyShort} → score=${score.toFixed(4)} (globalScore=${globalScore?.toFixed(4) ?? 'null'})`);
      }

      // Log any pubkeys in the chunk that got NO result back
      const returnedPubkeys = new Set(trustScores.map(r => r.targetPubkey));
      for (const pk of chunk) {
        if (!returnedPubkeys.has(pk)) {
          console.warn(`[TrustScore]   ${pk.slice(0, 12)}... → NO RESULT returned (will use default score)`);
        }
      }

      successCount++;
      consecutiveFailures = 0;
    } catch (error) {
      const chunkElapsed = Date.now() - chunkStart;
      failCount++;
      consecutiveFailures++;

      console.error(`[TrustScore] Chunk ${ci + 1} FAILED after ${chunkElapsed}ms (${chunk.length} pubkeys)`);
      if (error instanceof Error) {
        console.error(`[TrustScore]   Name: ${error.name}`);
        console.error(`[TrustScore]   Message: ${error.message}`);
        if ((error as any).code) console.error(`[TrustScore]   Code: ${(error as any).code}`);
        if ((error as any).cause) console.error(`[TrustScore]   Cause:`, (error as any).cause);

        // Classify the error
        const msg = error.message ?? '';
        if (isTimeoutLike(error)) {
          console.error(`[TrustScore]   ⚠ DETECTED TIMEOUT — relay may be slow or unresponsive`);
        }
        if (error.name === 'AbortError' || msg.includes('abort')) {
          console.error(`[TrustScore]   ⚠ DETECTED ABORT — request was cancelled`);
        }
        if (msg.includes('rate') || msg.includes('Rate') || msg.includes('limit') || msg.includes('Limit')) {
          console.error(`[TrustScore]   ⚠ DETECTED RATE LIMITING — relay may be throttling requests`);
        }
        if (msg.includes('close') || msg.includes('disconnect') || msg.includes('reset') || msg.includes('refused') || msg.includes('ECONNREFUSED')) {
          console.error(`[TrustScore]   ⚠ DETECTED CONNECTION DROP — relay or transport connection was lost`);
        }
        if (msg.includes('listOnTimeout') || msg.includes('onreadystatechange') || msg.includes('ETIMEDOUT')) {
          console.error(`[TrustScore]   ⚠ DETECTED listOnTimeout / SOCKET TIMEOUT — Node.js internal timer expired`);
        }
        if (error.name === 'Error' && !msg.includes('timeout') && !msg.includes('abort') && !msg.includes('rate') && !msg.includes('close')) {
          console.error(`[TrustScore]   ⚠ GENERIC ERROR — check full stack trace above`);
        }

        console.error(`[TrustScore]   Stack: ${error.stack}`);
      } else {
        console.error(`[TrustScore]   Raw error:`, error);
      }

      // Log the chunk pubkeys that failed
      console.error(`[TrustScore]   Failed pubkeys (${chunk.length}): ${chunk.map(pk => pk.slice(0, 12) + '...').join(', ')}`);
    }
  }

  const totalElapsed = Date.now() - startTotal;
  console.log(`[TrustScore] Summary: ${successCount}/${chunks.length} chunks succeeded, ${failCount} failed, ${skippedCount} skipped, ${freshScores.size} fresh scores, ${cached.size} cached, ${pubkeys.length} total (${totalElapsed}ms)`);

  // 3. Persist fresh results to cache
  if (freshScores.size > 0) {
    const setStart = Date.now();
    setMany(freshScores);
    console.log(`[TrustCache] Persisted ${freshScores.size} fresh scores to cache (${Date.now() - setStart}ms)`);
  } else if (missing.length > 0) {
    console.warn(`[TrustScore] No fresh scores to cache despite ${missing.length} missing pubkeys — all chunks may have failed`);
  }

  return scores;
}
