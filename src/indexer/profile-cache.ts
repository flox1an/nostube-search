/**
 * Local file-based cache for Nostr kind-0 author profiles.
 *
 * Stores pubkey -> parsed profile + timestamp. Missing relay results are cached
 * as null for the same TTL so repeated indexer batches do not hammer the relay.
 *
 * The file is loaded once into a bounded in-memory map (oldest writes evicted
 * first) and written back at most once per FLUSH_DELAY_MS instead of being
 * re-parsed and re-serialized on every indexer batch.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import type { AuthorProfile } from './scoring.js';

interface CacheEntry {
  profile: AuthorProfile | null;
  cachedAt: number;
}

type CacheData = Record<string, CacheEntry>;

const DEFAULT_CACHE_PATH = resolve(process.cwd(), '.profile-cache.json');
const DEFAULT_TTL_MS = 86_400_000; // 1 day
const DEFAULT_MAX_ENTRIES = 20_000; // profiles carry free-text `about`, keep the ceiling low
const FLUSH_DELAY_MS = 30_000;

let cachePath = process.env.PROFILE_CACHE_PATH ?? DEFAULT_CACHE_PATH;
let ttlMs = Number(process.env.PROFILE_CACHE_TTL_MS) || DEFAULT_TTL_MS;
const maxEntries = Number(process.env.PROFILE_CACHE_MAX_ENTRIES) || DEFAULT_MAX_ENTRIES;

let cache: Map<string, CacheEntry> | null = null;
let flushTimer: NodeJS.Timeout | null = null;

process.on('exit', () => {
  if (flushTimer) flush();
});

export function setCachePath(path: string): void {
  flush();
  cachePath = resolve(path);
  cache = null;
}

export function setCacheTTL(ms: number): void {
  ttlMs = ms;
}

function load(): Map<string, CacheEntry> {
  if (cache) return cache;
  cache = new Map();
  try {
    if (existsSync(cachePath)) {
      const raw = JSON.parse(readFileSync(cachePath, 'utf-8')) as CacheData;
      for (const [pubkey, entry] of Object.entries(raw)) cache.set(pubkey, entry);
    }
  } catch (err) {
    console.warn('[ProfileCache] Failed to read cache file, starting fresh:', err);
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

/** Write pending changes to disk now (also runs automatically on a timer and at process exit). */
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
    console.warn('[ProfileCache] Failed to write cache file:', err);
  }
}

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

export function getMany(pubkeys: string[]): { profiles: Map<string, AuthorProfile>; missingPubkeys: string[] } {
  const data = load();
  const now = Date.now();
  const profiles = new Map<string, AuthorProfile>();
  const missingPubkeys: string[] = [];
  let cachedMisses = 0;
  let expired = 0;

  for (const pubkey of pubkeys) {
    const entry = data.get(pubkey);
    if (!entry) {
      missingPubkeys.push(pubkey);
      continue;
    }

    if (now - entry.cachedAt > ttlMs) {
      missingPubkeys.push(pubkey);
      expired++;
      continue;
    }

    if (entry.profile) {
      profiles.set(pubkey, entry.profile);
    } else {
      cachedMisses++;
    }
  }

  if (profiles.size > 0 || cachedMisses > 0 || expired > 0) {
    console.log(`[ProfileCache] getMany: ${profiles.size} profile hits, ${cachedMisses} cached misses, ${expired} expired, ${missingPubkeys.length - expired} not found`);
  }

  return { profiles, missingPubkeys };
}

export function setMany(profiles: Map<string, AuthorProfile>, missingPubkeys: string[] = []): void {
  if (!profiles.size && missingPubkeys.length === 0) return;

  const data = load();
  const now = Date.now();
  const beforeCount = data.size;

  for (const [pubkey, profile] of profiles) {
    put(data, pubkey, { profile, cachedAt: now });
  }

  for (const pubkey of missingPubkeys) {
    put(data, pubkey, { profile: null, cachedAt: now });
  }

  evictOverflow(data);
  scheduleFlush();

  console.log(`[ProfileCache] setMany: stored ${profiles.size} profiles and ${missingPubkeys.length} misses (cache grew from ${beforeCount} to ${data.size}, max ${maxEntries})`);
}

export function stats(): { entries: number; ttlMs: number; path: string } {
  return {
    entries: load().size,
    ttlMs,
    path: cachePath,
  };
}
