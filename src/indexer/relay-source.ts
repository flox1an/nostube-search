import { SimplePool, type Event } from 'nostr-tools';

export const VIDEO_KINDS: number[] = [21, 22, 34235, 34236];
const RELATION_KINDS = [7, 1, 9734, 9735];
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
        for (const e of events) seen.set(e.id, e);
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

async function fetchAllVideoEventsFromRelay(relay: string, seen: Map<string, Event>): Promise<void> {
  const pool = new SimplePool({ enablePing: false, enableReconnect: false });
  const maxWait = Number(process.env.NOSTR_SOURCE_MAX_WAIT_MS) || 30_000;

  try {
    let until: number | undefined;

    for (;;) {
      const events = await pool.querySync(
        [relay],
        { kinds: VIDEO_KINDS, limit: PAGE_SIZE, ...(until !== undefined ? { until } : {}) },
        { maxWait, label: 'nostube-search-videos' },
      );

      if (events.length === 0) break;

      for (const e of events) seen.set(e.id, e);
      console.log(`[RelaySource] ${relay}: page ${events.length} events (total unique so far: ${seen.size})`);

      if (events.length < PAGE_SIZE) break;

      until = Math.min(...events.map(e => e.created_at)) - 1;
    }
  } finally {
    pool.destroy();
  }
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

export async function fetchAllVideoEvents(relays: string[]): Promise<Event[]> {
  const seen = new Map<string, Event>();

  // Query each relay individually so pagination terminates correctly per-relay.
  // A multi-relay combined query breaks early once the deduped page falls below
  // PAGE_SIZE, even though individual relays still have more events to offer.
  for (const relay of relays) {
    await fetchAllVideoEventsFromRelay(relay, seen);
  }

  const deduplicated = deduplicateAddressableEvents(Array.from(seen.values()));
  return deduplicated.sort((a, b) => a.created_at - b.created_at);
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

    // Deduplicate relation events by their own ID
    const allRelationEvents = new Map<string, Event>();
    for (const events of allChunkResults) {
      for (const e of events) allRelationEvents.set(e.id, e);
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
