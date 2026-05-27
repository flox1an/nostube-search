/**
 * Local file-based cache for trust scores.
 *
 * Stores pubkey → trust score + timestamp as a JSON file on disk.
 * Avoids redundant ContextVM network calls when the same pubkeys
 * appear across indexer batches.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
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

// ---- Module state (reconfigurable before first use) ----

let cachePath: string = process.env.TRUST_CACHE_PATH ?? DEFAULT_CACHE_PATH;
let ttlMs: number = Number(process.env.TRUST_CACHE_TTL_MS) || DEFAULT_TTL_MS;

/**
 * Override cache file path at runtime. Call before any cache operations.
 */
export function setCachePath(path: string): void {
  cachePath = resolve(path);
}

/**
 * Override cache TTL at runtime. Call before any cache operations.
 */
export function setCacheTTL(ms: number): void {
  ttlMs = ms;
}

// ---- Internal helpers ----

function readCache(): CacheData {
  try {
    if (existsSync(cachePath)) {
      const raw = readFileSync(cachePath, 'utf-8');
      return JSON.parse(raw) as CacheData;
    }
  } catch (err) {
    console.warn('[TrustCache] Failed to read cache file, starting fresh:', err);
  }
  return {};
}

function writeCache(data: CacheData): void {
  try {
    const dir = dirname(cachePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(cachePath, JSON.stringify(data, null, 2), 'utf-8');
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
  const data = readCache();
  const now = Date.now();
  const before = Object.keys(data).length;

  for (const key of Object.keys(data)) {
    if (now - data[key].cachedAt > ttlMs) {
      delete data[key];
    }
  }

  const after = Object.keys(data).length;
  if (after < before) {
    writeCache(data);
  }

  return before - after;
}

/**
 * Get a cached score for a pubkey, or null if missing / expired.
 */
export function get(pubkey: string): number | null {
  const data = readCache();
  const entry = data[pubkey];
  if (!entry) return null;
  if (Date.now() - entry.cachedAt > ttlMs) return null;
  return entry.score;
}

/**
 * Check which pubkeys from a list have a valid cached score.
 * Returns a Map of cached pubkey → score (only fresh entries).
 */
export function getMany(pubkeys: string[]): Map<string, number> {
  const data = readCache();
  const now = Date.now();
  const results = new Map<string, number>();
  let expired = 0;

  for (const pubkey of pubkeys) {
    const entry = data[pubkey];
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
 * Store a single pubkey score in the cache and persist.
 */
export function set(pubkey: string, score: number): void {
  const data = readCache();
  data[pubkey] = { score, cachedAt: Date.now() };
  writeCache(data);
}

/**
 * Store multiple pubkey scores at once and persist.
 * More efficient than calling set() in a loop (one write).
 */
export function setMany(scores: Map<string, number>): void {
  if (!scores.size) {
    console.log('[TrustCache] setMany: called with empty map, skipping');
    return;
  }

  const logSample = Array.from(scores.entries()).slice(0, 3).map(([pk, sc]) => `${pk.slice(0, 10)}...=${sc.toFixed(4)}`).join(', ');
  const writeStart = Date.now();

  const data = readCache();
  const now = Date.now();
  const beforeCount = Object.keys(data).length;

  for (const [pubkey, score] of scores) {
    data[pubkey] = { score, cachedAt: now };
  }

  writeCache(data);

  const elapsed = Date.now() - writeStart;
  console.log(`[TrustCache] setMany: stored ${scores.size} scores (cache grew from ${beforeCount} to ${Object.keys(data).length} entries) in ${elapsed}ms [${logSample}]`);
}

/**
 * Clear the cache file entirely.
 */
export function clear(): void {
  writeCache({});
}

/**
 * Get cache stats for logging / monitoring.
 */
export function stats(): { entries: number; ttlMs: number; path: string } {
  const data = readCache();
  return {
    entries: Object.keys(data).length,
    ttlMs,
    path: cachePath,
  };
}
