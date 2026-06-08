import { SimplePool, type Event } from 'nostr-tools';

import * as blossomListCache from './blossom-list-cache.js';

type BlossomServerList = {
  servers: string[];
  eventCreatedAt: number | null;
};

function relayUrlsFromEnv(): string[] {
  return (process.env.NOSTR_INDEX_RELAYS ?? process.env.NOSTR_INDEX_NRELAY ?? '')
    .split(',')
    .map(url => url.trim())
    .filter(Boolean);
}

function normalizeServerUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host.toLowerCase()}`;
  } catch {
    return null;
  }
}

function parseServerTags(event: Event): string[] {
  return [...new Set(
    event.tags
      .filter(tag => tag[0] === 'server' && tag[1])
      .map(tag => normalizeServerUrl(tag[1]))
      .filter((url): url is string => Boolean(url)),
  )];
}

function latestEventsByPubkey(events: Event[]): Map<string, Event> {
  const latest = new Map<string, Event>();

  for (const event of events) {
    const existing = latest.get(event.pubkey);
    if (!existing || event.created_at > existing.created_at) {
      latest.set(event.pubkey, event);
    }
  }

  return latest;
}

async function fetchBlossomListsFromRelay(pubkeys: string[]): Promise<Map<string, BlossomServerList>> {
  const relays = relayUrlsFromEnv();
  if (relays.length === 0 || pubkeys.length === 0) return new Map<string, BlossomServerList>();

  const pool = new SimplePool({ enablePing: true, enableReconnect: false });
  const maxWait = Number(process.env.NOSTR_INDEX_BLOSSOM_LIST_FETCH_MAX_WAIT_MS) || 6_000;

  try {
    const events = await pool.querySync(
      relays,
      {
        kinds: [10063],
        authors: pubkeys,
        limit: pubkeys.length,
      },
      {
        maxWait,
        label: 'nostube-search-blossom-lists',
      },
    );

    const lists = new Map<string, BlossomServerList>();
    for (const [pubkey, event] of latestEventsByPubkey(events)) {
      lists.set(pubkey, {
        servers: parseServerTags(event),
        eventCreatedAt: event.created_at,
      });
    }

    return lists;
  } finally {
    pool.destroy();
  }
}

export async function fetchAuthorBlossomServers(pubkeys: string[]): Promise<Map<string, string[]>> {
  const uniquePubkeys = [...new Set(pubkeys.filter(Boolean))];
  const cached = blossomListCache.getMany(uniquePubkeys);
  const serversByPubkey = new Map(cached.serversByPubkey);

  const relays = relayUrlsFromEnv();
  if (cached.missingPubkeys.length === 0) return serversByPubkey;
  if (relays.length === 0) {
    console.log('[BlossomLists] NOSTR_INDEX_RELAYS not configured; using cache only for Blossom server lists');
    return serversByPubkey;
  }

  const fetchStart = Date.now();
  let relayLists: Map<string, BlossomServerList>;
  try {
    relayLists = await fetchBlossomListsFromRelay(cached.missingPubkeys);
  } catch (err) {
    console.warn('[BlossomLists] Failed to fetch Blossom server lists from Nostr relay; using cache only:', err);
    return serversByPubkey;
  }

  const relayMisses = cached.missingPubkeys.filter(pubkey => !relayLists.has(pubkey));
  for (const [pubkey, list] of relayLists) {
    serversByPubkey.set(pubkey, list.servers);
  }

  blossomListCache.setMany(relayLists, relayMisses);
  console.log(`[BlossomLists] Fetched ${relayLists.size}/${cached.missingPubkeys.length} Blossom server lists from ${relays.join(', ')} (${Date.now() - fetchStart}ms)`);

  return serversByPubkey;
}

export { blossomListCache };
