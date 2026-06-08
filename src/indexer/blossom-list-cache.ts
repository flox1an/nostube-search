import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { nip19 } from 'nostr-tools';

export type BlossomServerListCacheEntry = {
  pubkey: string;
  npub: string;
  servers: string[];
  cachedAt: number;
  eventCreatedAt: number | null;
};

const DEFAULT_CACHE_DIR = resolve(process.cwd(), 'blossom-lists');
const DEFAULT_TTL_MS = 86_400_000; // 1 day

let cacheDir = process.env.BLOSSOM_LIST_CACHE_DIR ?? DEFAULT_CACHE_DIR;
let ttlMs = Number(process.env.BLOSSOM_LIST_CACHE_TTL_MS) || DEFAULT_TTL_MS;

export function setCacheDir(path: string): void {
  cacheDir = resolve(path);
}

export function setCacheTTL(ms: number): void {
  ttlMs = ms;
}

function pubkeyToNpub(pubkey: string): string | null {
  try {
    return nip19.npubEncode(pubkey);
  } catch {
    return null;
  }
}

function cachePathForPubkey(pubkey: string): string | null {
  const npub = pubkeyToNpub(pubkey);
  return npub ? join(cacheDir, `${npub}.json`) : null;
}

function normalizeServerUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host.toLowerCase()}`;
  } catch {
    return null;
  }
}

function readEntry(pubkey: string): BlossomServerListCacheEntry | null {
  const path = cachePathForPubkey(pubkey);
  if (!path || !existsSync(path)) return null;

  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as BlossomServerListCacheEntry;
    if (parsed.pubkey !== pubkey || !Array.isArray(parsed.servers)) return null;
    return parsed;
  } catch (err) {
    console.warn('[BlossomListCache] Failed to read cache file:', err);
    return null;
  }
}

function writeEntry(entry: BlossomServerListCacheEntry): void {
  const path = cachePathForPubkey(entry.pubkey);
  if (!path) return;

  try {
    if (!existsSync(cacheDir)) mkdirSync(cacheDir, { recursive: true });
    writeFileSync(path, JSON.stringify(entry, null, 2), 'utf-8');
  } catch (err) {
    console.warn('[BlossomListCache] Failed to write cache file:', err);
  }
}

export function getMany(pubkeys: string[]): {
  serversByPubkey: Map<string, string[]>;
  missingPubkeys: string[];
} {
  const uniquePubkeys = [...new Set(pubkeys.filter(Boolean))];
  const now = Date.now();
  const serversByPubkey = new Map<string, string[]>();
  const missingPubkeys: string[] = [];
  let expired = 0;

  for (const pubkey of uniquePubkeys) {
    const entry = readEntry(pubkey);
    if (!entry) {
      missingPubkeys.push(pubkey);
      continue;
    }

    if (now - entry.cachedAt > ttlMs) {
      missingPubkeys.push(pubkey);
      expired++;
      continue;
    }

    serversByPubkey.set(pubkey, entry.servers);
  }

  if (serversByPubkey.size > 0 || expired > 0) {
    console.log(`[BlossomListCache] getMany: ${serversByPubkey.size} hits, ${expired} expired, ${missingPubkeys.length - expired} not found`);
  }

  return { serversByPubkey, missingPubkeys };
}

export function setMany(
  serversByPubkey: Map<string, { servers: string[]; eventCreatedAt: number | null }>,
  missingPubkeys: string[] = [],
): void {
  if (!serversByPubkey.size && missingPubkeys.length === 0) return;

  const now = Date.now();
  for (const [pubkey, value] of serversByPubkey) {
    const npub = pubkeyToNpub(pubkey);
    if (!npub) continue;
    writeEntry({
      pubkey,
      npub,
      servers: [...new Set(
        value.servers
          .map(server => normalizeServerUrl(server))
          .filter((server): server is string => Boolean(server)),
      )],
      cachedAt: now,
      eventCreatedAt: value.eventCreatedAt,
    });
  }

  for (const pubkey of missingPubkeys) {
    const npub = pubkeyToNpub(pubkey);
    if (!npub) continue;
    writeEntry({
      pubkey,
      npub,
      servers: [],
      cachedAt: now,
      eventCreatedAt: null,
    });
  }

  console.log(`[BlossomListCache] setMany: stored ${serversByPubkey.size} lists and ${missingPubkeys.length} misses`);
}

export function prune(): number {
  if (!existsSync(cacheDir)) return 0;

  const now = Date.now();
  let removed = 0;

  for (const file of readdirSync(cacheDir)) {
    if (!file.endsWith('.json')) continue;
    const path = join(cacheDir, file);
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf-8')) as { cachedAt?: number };
      if (!parsed.cachedAt || now - parsed.cachedAt > ttlMs) {
        rmSync(path);
        removed++;
      }
    } catch {
      rmSync(path);
      removed++;
    }
  }

  return removed;
}

export function stats(): { entries: number; ttlMs: number; dir: string } {
  const entries = existsSync(cacheDir)
    ? readdirSync(cacheDir).filter(file => file.endsWith('.json')).length
    : 0;

  return { entries, ttlMs, dir: cacheDir };
}
