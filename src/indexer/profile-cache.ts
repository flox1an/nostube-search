/**
 * Local file-based cache for Nostr kind-0 author profiles.
 *
 * Stores pubkey -> parsed profile + timestamp. Missing relay results are cached
 * as null for the same TTL so repeated indexer batches do not hammer the relay.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import type { AuthorProfile } from './scoring.js';

interface CacheEntry {
  profile: AuthorProfile | null;
  cachedAt: number;
}

type CacheData = Record<string, CacheEntry>;

const DEFAULT_CACHE_PATH = resolve(process.cwd(), '.profile-cache.json');
const DEFAULT_TTL_MS = 86_400_000; // 1 day

let cachePath = process.env.PROFILE_CACHE_PATH ?? DEFAULT_CACHE_PATH;
let ttlMs = Number(process.env.PROFILE_CACHE_TTL_MS) || DEFAULT_TTL_MS;

export function setCachePath(path: string): void {
  cachePath = resolve(path);
}

export function setCacheTTL(ms: number): void {
  ttlMs = ms;
}

function readCache(): CacheData {
  try {
    if (existsSync(cachePath)) {
      return JSON.parse(readFileSync(cachePath, 'utf-8')) as CacheData;
    }
  } catch (err) {
    console.warn('[ProfileCache] Failed to read cache file, starting fresh:', err);
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
    console.warn('[ProfileCache] Failed to write cache file:', err);
  }
}

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

export function getMany(pubkeys: string[]): { profiles: Map<string, AuthorProfile>; missingPubkeys: string[] } {
  const data = readCache();
  const now = Date.now();
  const profiles = new Map<string, AuthorProfile>();
  const missingPubkeys: string[] = [];
  let cachedMisses = 0;
  let expired = 0;

  for (const pubkey of pubkeys) {
    const entry = data[pubkey];
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

  const data = readCache();
  const now = Date.now();
  const beforeCount = Object.keys(data).length;

  for (const [pubkey, profile] of profiles) {
    data[pubkey] = { profile, cachedAt: now };
  }

  for (const pubkey of missingPubkeys) {
    data[pubkey] = { profile: null, cachedAt: now };
  }

  writeCache(data);

  console.log(`[ProfileCache] setMany: stored ${profiles.size} profiles and ${missingPubkeys.length} misses (cache grew from ${beforeCount} to ${Object.keys(data).length})`);
}

export function stats(): { entries: number; ttlMs: number; path: string } {
  const data = readCache();
  return {
    entries: Object.keys(data).length,
    ttlMs,
    path: cachePath,
  };
}
