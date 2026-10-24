/**
 * Local file-based cache for trust scores.
 *
 * Stores pubkey → trust score + timestamp as a JSON file on disk.
 * Avoids redundant ContextVM network calls when the same pubkeys
 * appear across indexer batches.
 *
 * The file is loaded once into a bounded in-memory map (oldest writes evicted
 * first) and written back at most once per FLUSH_DELAY_MS instead of being
 * re-parsed and re-serialized on every indexer batch.
 */

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

// ---- Types ----

interface CacheEntry {
  score: number;
  cachedAt: number; // Unix ms timestamp
}

type CacheData = Record<string, CacheEntry>;

// ---- Defaults ----

const DEFAULT_CACHE_PATH = resolve(process.cwd(), '.trust-cache.json');
const DEFAULT_TTL_MS = 86_400_000; // 1 day
const DEFAULT_MAX_ENTRIES = 100_000; // ~100 bytes each on disk
const FLUSH_DELAY_MS = 30_000;

// ---- Module state (reconfigurable before first use) ----

let cachePath: string = process.env.TRUST_CACHE_PATH ?? DEFAULT_CACHE_PATH;
let ttlMs: number = Number(process.env.TRUST_CACHE_TTL_MS) || DEFAULT_TTL_MS;
const maxEntries: number = Number(process.env.TRUST_CACHE_MAX_ENTRIES) || DEFAULT_MAX_ENTRIES;

let cache: Map<string, CacheEntry> | null = null;
let flushTimer: NodeJS.Timeout | null = null;

process.on('exit', () => {
  if (flushTimer) flush();
});

/**
 * Override cache file path at runtime. Pending writes go to the old path first.
 */
export function setCachePath(path: string): void {
  flush();
  cachePath = resolve(path);
  cache = null;
}

/**
 * Override cache TTL at runtime. Call before any cache operations.
 */
export function setCacheTTL(ms: number): void {
  ttlMs = ms;
}

// ---- Internal helpers ----

function load(): Map<string, CacheEntry> {
  if (cache) return cache;
  cache = new Map();
  try {
    if (existsSync(cachePath)) {
      const raw = JSON.parse(readFileSync(cachePath, 'utf-8')) as CacheData;
      for (const [pubkey, entry] of Object.entries(raw)) cache.set(pubkey, entry);
    }
  } catch (err) {
    console.warn('[TrustCache] Failed to read cache file, starting fresh:', err);
  }
  evictOverflow(cache);
  return cache;
}

/** Map iteration is insertion order and writes re-insert, so the first keys are the stalest. */
function evictOverflow(data: Map<string, CacheEntry>): void {
  for (const key of data.keys()) {
    if (data.size <= maxEntries) break;
    data.delete(key);
  }
}

function put(data: Map<string, CacheEntry>, pubkey: string, entry: CacheEntry): void {
  data.delete(pubkey);
  data.set(pubkey, entry);
}

function scheduleFlush(): void {
  if (flushTimer) return;
  flushTimer = setTimeout(flush, FLUSH_DELAY_MS);
  flushTimer.unref();
}

/**
 * Write pending changes to disk now (also runs automatically on a timer and at process exit).
 */
export function flush(): void {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (!cache) return;
  try {
    const dir = dirname(cachePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    // Write-then-rename so a crash mid-write cannot truncate the existing cache.
    const tmpPath = `${cachePath}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(Object.fromEntries(cache)), 'utf-8');
    renameSync(tmpPath, cachePath);
  } catch (err) {
    console.warn('[TrustCache] Failed to write cache file:', err);
  }
}

// ---- Public API ----

/**
 * Prune expired entries from the cache file.
 * Returns the count of removed entries.
 */
export function prune(): number {
  const data = load();
  const now = Date.now();
  const before = data.size;

  for (const [key, entry] of data) {
    if (now - entry.cachedAt > ttlMs) {
      data.delete(key);
    }
  }

  const removed = before - data.size;
  if (removed > 0) {
    flush();
  }

  return removed;
}

/**
 * Get a cached score for a pubkey, or null if missing / expired.
 */
export function get(pubkey: string): number | null {
  const entry = load().get(pubkey);
  if (!entry) return null;
  if (Date.now() - entry.cachedAt > ttlMs) return null;
  return entry.score;
}

/**
 * Check which pubkeys from a list have a valid cached score.
 * Returns a Map of cached pubkey → score (only fresh entries).
 */
export function getMany(pubkeys: string[]): Map<string, number> {
  const data = load();
  const now = Date.now();
  const results = new Map<string, number>();
  let expired = 0;

  for (const pubkey of pubkeys) {
    const entry = data.get(pubkey);
    if (entry) {
      const age = now - entry.cachedAt;
      if (age <= ttlMs) {
        results.set(pubkey, entry.score);
      } else {
        expired++;
      }
    }
  }

  if (expired > 0) {
    console.log(`[TrustCache] getMany: ${results.size} fresh hits, ${expired} expired, ${pubkeys.length - results.size - expired} not found`);
  }

  return results;
}

/**
 * Store a single pubkey score in the cache.
 */
export function set(pubkey: string, score: number): void {
  const data = load();
  put(data, pubkey, { score, cachedAt: Date.now() });
  evictOverflow(data);
  scheduleFlush();
}

/**
 * Store multiple pubkey scores at once.
 */
export function setMany(scores: Map<string, number>): void {
  if (!scores.size) {
    console.log('[TrustCache] setMany: called with empty map, skipping');
    return;
  }

  const logSample = Array.from(scores.entries()).slice(0, 3).map(([pk, sc]) => `${pk.slice(0, 10)}...=${sc.toFixed(4)}`).join(', ');
  const writeStart = Date.now();

  const data = load();
  const now = Date.now();
  const beforeCount = data.size;

  for (const [pubkey, score] of scores) {
    put(data, pubkey, { score, cachedAt: now });
  }
  evictOverflow(data);
  scheduleFlush();

  const elapsed = Date.now() - writeStart;
  console.log(`[TrustCache] setMany: stored ${scores.size} scores (cache grew from ${beforeCount} to ${data.size} entries, max ${maxEntries}) in ${elapsed}ms [${logSample}]`);
}

/**
 * Clear the cache file entirely.
 */
export function clear(): void {
  cache = new Map();
  flush();
}

/**
 * Get cache stats for logging / monitoring.
 */
export function stats(): { entries: number; ttlMs: number; path: string } {
  return {
    entries: load().size,
    ttlMs,
    path: cachePath,
  };
}
