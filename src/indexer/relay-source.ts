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
  const pool = new SimplePool({ enablePing: false, enableReconnect: false });
  const maxWait = Number(process.env.NOSTR_SOURCE_MAX_WAIT_MS) || 30_000;
  const seen = new Map<string, Event>();

  try {
    let until: number | undefined;

    for (;;) {
      const events = await pool.querySync(
        relays,
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

    return Array.from(seen.values()).sort((a, b) => a.created_at - b.created_at);
  } finally {
    pool.destroy();
  }
}

export async function fetchAllVideoEvents(relays: string[]): Promise<Event[]> {
  const pool = new SimplePool({ enablePing: false, enableReconnect: false });
  const maxWait = Number(process.env.NOSTR_SOURCE_MAX_WAIT_MS) || 30_000;
  const seen = new Map<string, Event>();

  try {
    let until: number | undefined;

    for (;;) {
      const events = await pool.querySync(
        relays,
        { kinds: VIDEO_KINDS, limit: PAGE_SIZE, ...(until !== undefined ? { until } : {}) },
        { maxWait, label: 'nostube-search-videos' },
      );

      if (events.length === 0) break;

      for (const e of events) seen.set(e.id, e);
      console.log(`[RelaySource] Fetched page: ${events.length} events (total so far: ${seen.size})`);

      if (events.length < PAGE_SIZE) break;

      until = Math.min(...events.map(e => e.created_at)) - 1;
    }

    // Sort ascending by created_at to match the previous ORDER BY created_at ASC behaviour
    return Array.from(seen.values()).sort((a, b) => a.created_at - b.created_at);
  } finally {
    pool.destroy();
  }
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
    const [eTagEvents, aTagEvents] = await Promise.all([
      pool.querySync(relays, { kinds: RELATION_KINDS, '#e': eventIds }, { maxWait }),
      aTags.length > 0
        ? pool.querySync(relays, { kinds: RELATION_KINDS, '#a': aTags }, { maxWait })
        : Promise.resolve([] as Event[]),
    ]);

    // Deduplicate relation events by their own ID
    const allRelationEvents = new Map<string, Event>();
    for (const e of [...eTagEvents, ...aTagEvents]) allRelationEvents.set(e.id, e);

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
