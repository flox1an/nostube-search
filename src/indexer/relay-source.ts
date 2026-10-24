import { SimplePool, type Event } from 'nostr-tools';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';

import { filterVerifiedEvents } from '../nostr-events.js';

export const VIDEO_KINDS: number[] = [21, 22, 34235, 34236];
const RELATION_KINDS = [7, 1, 9734, 9735];
const PLAYLIST_KIND = 30005;
const PAGE_SIZE = 500;

export type EventRelationCounts = {
  relatedEventsTotal: number;
  reactionsCount: number;
  commentsCount: number;
  zapsCount: number;
  notesCount: number;
};

export function defaultRelationCounts(): EventRelationCounts {
  return { relatedEventsTotal: 0, reactionsCount: 0, commentsCount: 0, zapsCount: 0, notesCount: 0 };
}

export function sourceRelaysFromEnv(): string[] {
  const raw = process.env.NOSTR_SOURCE_RELAYS ?? 'wss://relay.nostu.be';
  return raw.split(',').map(s => s.trim()).filter(Boolean);
}

export async function fetchVideoEventsSince(relays: string[], since: number): Promise<Event[]> {
  const seen = new Map<string, Event>();
  const maxWait = Number(process.env.NOSTR_SOURCE_MAX_WAIT_MS) || 30_000;

  for (const relay of relays) {
    const pool = new SimplePool({ enablePing: false, enableReconnect: false });
    try {
      let until: number | undefined;

      for (;;) {
        const events = await pool.querySync(
          [relay],
          { kinds: VIDEO_KINDS, since, limit: PAGE_SIZE, ...(until !== undefined ? { until } : {}) },
          { maxWait, label: 'nostube-search-incremental' },
        );

        if (events.length === 0) break;
        const verifiedEvents = filterVerifiedEvents(events, relay);
        for (const e of verifiedEvents) seen.set(e.id, e);
        if (events.length < PAGE_SIZE) break;

        const minTs = Math.min(...events.map(e => e.created_at)) - 1;
        if (minTs <= since) break;
        until = minTs;
      }
    } finally {
      pool.destroy();
    }
  }

  const deduplicated = deduplicateAddressableEvents(Array.from(seen.values()));
  return deduplicated.sort((a, b) => a.created_at - b.created_at);
}

const VERIFY_SLICE_SIZE = 100; // signature verification is CPU-bound; slice so the event loop breathes

/**
 * Stream all video events page-by-page instead of returning one array.
 *
 * Memory stays bounded: a Set of seen event ids and a `address → newest
 * created_at` map for NIP-33 addressable events. Newer addressable versions
 * arriving after an older one are re-yielded — the Meilisearch document id is
 * stable per address, so the re-emitted (newest) document wins the upsert,
 * matching the previous collect-then-dedupe result.
 */
export async function* iterateAllVideoEvents(relays: string[]): AsyncGenerator<Event> {
  const seenIds = new Set<string>();
  const newestByAddress = new Map<string, number>();
  // NIP-33 events missing their d tag: toSearchDocument keys those by event_id,
  // so an older copy emitted before a newer one would leave a stale duplicate.
  // Buffer them and emit only the newest per kind:pubkey at the very end.
  const noDAddressable = new Map<string, Event>();

  for (const relay of relays) {
    const pool = new SimplePool({ enablePing: false, enableReconnect: false });
    const maxWait = Number(process.env.NOSTR_SOURCE_MAX_WAIT_MS) || 30_000;

    try {
      let until: number | undefined;
      let uniqueSoFar = 0;
      let lastPageWasFull = false;
      let retriedEmptyPage = false;

      for (;;) {
        const events = await pool.querySync(
          [relay],
          { kinds: VIDEO_KINDS, limit: PAGE_SIZE, ...(until !== undefined ? { until } : {}) },
          { maxWait, label: 'nostube-search-videos' },
        );

        if (events.length === 0) {
          // A relay that drops the connection or a maxWait miss resolves to an
          // empty page. After a full page that is suspicious — retry once
          // instead of silently ending this relay's stream early.
          if (lastPageWasFull && !retriedEmptyPage) {
            retriedEmptyPage = true;
            console.warn(`[RelaySource] ${relay}: empty page after a full page — retrying once`);
            continue;
          }
          break;
        }
        retriedEmptyPage = false;

        let verifiedCount = 0;
        for (let i = 0; i < events.length; i += VERIFY_SLICE_SIZE) {
          const verifiedEvents = filterVerifiedEvents(events.slice(i, i + VERIFY_SLICE_SIZE), relay);
          verifiedCount += verifiedEvents.length;

          for (const e of verifiedEvents) {
            if (seenIds.has(e.id)) continue;
            seenIds.add(e.id);
            uniqueSoFar++;

            if (e.kind >= 30000 && e.kind < 40000) {
              const dTag = e.tags.find(t => t[0] === 'd')?.[1];
              if (dTag === undefined) {
                const addr = `${e.kind}:${e.pubkey}:`;
                const existing = noDAddressable.get(addr);
                if (!existing || e.created_at > existing.created_at) noDAddressable.set(addr, e);
                continue;
              }
              const addr = `${e.kind}:${e.pubkey}:${dTag}`;
              const newest = newestByAddress.get(addr);
              if (newest !== undefined && e.created_at <= newest) continue;
              newestByAddress.set(addr, e.created_at);
            }

            yield e;
          }

          // Signature verification above is synchronous CPU work; hand the
          // event loop back between slices so HTTP requests stay responsive.
          await yieldToEventLoop();
        }

        console.log(`[RelaySource] ${relay}: page ${verifiedCount}/${events.length} verified events (total unique so far: ${uniqueSoFar})`);

        lastPageWasFull = events.length >= PAGE_SIZE;
        if (!lastPageWasFull) break;

        until = Math.min(...events.map(e => e.created_at)) - 1;
      }
    } finally {
      pool.destroy();
    }
  }

  yield* noDAddressable.values();
}

function deduplicateAddressableEvents(events: Event[]): Event[] {
  // For addressable events (NIP-33), keep only the newest version per kind:pubkey:d_tag.
  // Different relays may hold older copies with distinct event IDs.
  const addressable = new Map<string, Event>();
  const regular: Event[] = [];

  for (const e of events) {
    if (e.kind >= 30000 && e.kind < 40000) {
      const dTag = e.tags.find(t => t[0] === 'd')?.[1] ?? '';
      const addr = `${e.kind}:${e.pubkey}:${dTag}`;
      const existing = addressable.get(addr);
      if (!existing || e.created_at > existing.created_at) {
        addressable.set(addr, e);
      }
    } else {
      regular.push(e);
    }
  }

  return [...regular, ...addressable.values()];
}

async function fetchPlaylistEventsFromRelay(relay: string, seen: Map<string, Event>): Promise<void> {
  const pool = new SimplePool({ enablePing: false, enableReconnect: false });
  const maxWait = Number(process.env.NOSTR_SOURCE_MAX_WAIT_MS) || 30_000;
  const fetchLimit = Number(process.env.PLAYLIST_FETCH_LIMIT) || 5_000;

  try {
    let until: number | undefined;

    for (;;) {
      const events = await pool.querySync(
        [relay],
        { kinds: [PLAYLIST_KIND], limit: PAGE_SIZE, ...(until !== undefined ? { until } : {}) },
        { maxWait, label: 'nostube-search-playlists' },
      );

      if (events.length === 0) break;
      const verified = filterVerifiedEvents(events, relay);
      for (const e of verified) seen.set(e.id, e);
      console.log(`[RelaySource] ${relay}: playlist page ${verified.length}/${events.length} verified (total so far: ${seen.size})`);

      if (events.length < PAGE_SIZE || seen.size >= fetchLimit) break;
      until = Math.min(...events.map(e => e.created_at)) - 1;
    }
  } finally {
    pool.destroy();
  }
}

export async function fetchAllPlaylistEvents(relays: string[]): Promise<Event[]> {
  const seen = new Map<string, Event>();
  for (const relay of relays) {
    await fetchPlaylistEventsFromRelay(relay, seen);
  }
  // Addressable kind — keep only the newest version per 30005:pubkey:d-tag
  return deduplicateAddressableEvents(Array.from(seen.values()));
}

const RELATION_FILTER_CHUNK_SIZE = 50;

function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
  return chunks;
}

export async function fetchRelationCountsForBatch(
  relays: string[],
  videoEvents: Event[],
): Promise<Map<string, EventRelationCounts>> {
  if (videoEvents.length === 0) return new Map();

  const pool = new SimplePool({ enablePing: false, enableReconnect: false });
  const maxWait = Number(process.env.NOSTR_SOURCE_MAX_WAIT_MS) || 30_000;

  const eventIdSet = new Set(videoEvents.map(e => e.id));
  const eventIds = Array.from(eventIdSet);

  // Build aTag -> eventId reverse map for addressable events (kinds 30000-39999)
  const aTagToEventId = new Map<string, string>();
  for (const e of videoEvents) {
    if (e.kind >= 30000 && e.kind < 40000) {
      const dTag = e.tags.find(t => t[0] === 'd')?.[1] ?? '';
      aTagToEventId.set(`${e.kind}:${e.pubkey}:${dTag}`, e.id);
    }
  }
  const aTags = Array.from(aTagToEventId.keys());

  try {
    const eTagChunks = chunkArray(eventIds, RELATION_FILTER_CHUNK_SIZE);
    const aTagChunks = chunkArray(aTags, RELATION_FILTER_CHUNK_SIZE);

    const allChunkResults = await Promise.all([
      ...eTagChunks.map(chunk => pool.querySync(relays, { kinds: RELATION_KINDS, '#e': chunk }, { maxWait })),
      ...aTagChunks.map(chunk => pool.querySync(relays, { kinds: RELATION_KINDS, '#a': chunk }, { maxWait })),
    ]);

    // Deduplicate relation events by their own ID. Verification is synchronous
    // CPU work and a batch can pull thousands of relation events; slice it so
    // the event loop (and the HTTP API) stays responsive.
    const allRelationEvents = new Map<string, Event>();
    for (const events of allChunkResults) {
      for (let i = 0; i < events.length; i += VERIFY_SLICE_SIZE) {
        for (const e of filterVerifiedEvents(events.slice(i, i + VERIFY_SLICE_SIZE), 'relation-counts')) {
          allRelationEvents.set(e.id, e);
        }
        await yieldToEventLoop();
      }
    }

    const counts = new Map<string, EventRelationCounts>();

    for (const e of allRelationEvents.values()) {
      const targetIds = new Set<string>();

      for (const tag of e.tags) {
        if (tag[0] === 'e' && tag[1] && eventIdSet.has(tag[1])) {
          targetIds.add(tag[1]);
        }
        if (tag[0] === 'a' && tag[1]) {
          const mapped = aTagToEventId.get(tag[1]);
          if (mapped) targetIds.add(mapped);
        }
      }

      for (const videoId of targetIds) {
        const c = counts.get(videoId) ?? defaultRelationCounts();
        c.relatedEventsTotal++;
        if (e.kind === 7) c.reactionsCount++;
        else if (e.kind === 1) c.commentsCount++;
        else if (e.kind === 9734 || e.kind === 9735) c.zapsCount++;
        counts.set(videoId, c);
      }
    }

    return counts;
  } finally {
    pool.destroy();
  }
}
