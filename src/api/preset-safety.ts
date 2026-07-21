import { SimplePool, type Event } from 'nostr-tools';
import { filterVerifiedEvents } from '../nostr-events.js';

const HEX_64_RE = /^[a-f0-9]{64}$/i;

export const NSFW_FILTER_VALUES = ['hide', 'warning', 'show'] as const;
export type NsfwFilter = (typeof NSFW_FILTER_VALUES)[number];

export interface PresetPolicy {
  blockedPubkeys: string[];
  nsfwPubkeys: string[];
  blockedEvents: string[];
  /** created_at of the source event — used as revision identifier for cache busting */
  revision: number;
  /** event id for deterministic tiebreak */
  eventId: string;
}

const PRESET_D_TAG = 'nostube-presets';

// ── Validation ─────────────────────────────────────────────────────────────────

export function isValidNsfwFilter(value: string): value is NsfwFilter {
  return (NSFW_FILTER_VALUES as readonly string[]).includes(value);
}

export function isValidPresetPubkey(value: string): boolean {
  return HEX_64_RE.test(value);
}

function normalizeHexArray(input: unknown): string[] | null {
  if (!Array.isArray(input)) return null;
  const seen = new Set<string>();
  for (const item of input) {
    if (!(typeof item === 'string' && HEX_64_RE.test(item))) return null;
    seen.add(item.toLowerCase());
  }
  return [...seen];
}

const MAX_BLOCKED_PUBKEYS = 1000;
const MAX_NSFW_PUBKEYS = 1000;
const MAX_BLOCKED_EVENTS = 1000;

/**
 * Parse and validate preset content.
 *
 * Only three fields are consumed and validated:
 *   - `blockedPubkeys` — array of 64-char hex pubkeys (max 1000)
 *   - `nsfwPubkeys`    — array of 64-char hex pubkeys (max 1000)
 *   - `blockedEvents`  — array of 64-char hex event ids (max 1000)
 *
 * Any additional/unknown keys (e.g. `defaultRelays`, `defaultThumbResizeServer`)
 * are silently ignored to maintain compatibility with Nostube's official preset
 * event format.
 *
 * Returns `null` when content is not an object, any filter field is missing,
 * non-array, contains non-hex values, or exceeds its size limit.
 */
function validatePresetContent(
  content: unknown,
): { blockedPubkeys: string[]; nsfwPubkeys: string[]; blockedEvents: string[] } | null {
  if (typeof content !== 'object' || content === null || Array.isArray(content)) return null;
  const obj = content as Record<string, unknown>;

  // Only three safety-filter fields are extracted; all other keys are ignored.
  // This allows NIP-78 preset events with auxiliary configuration fields
  // (e.g. defaultRelays, defaultThumbResizeServer) to be accepted without
  // breaking validation.

  const blockedPubkeys = normalizeHexArray(obj.blockedPubkeys);
  if (!blockedPubkeys) return null;
  const nsfwPubkeys = normalizeHexArray(obj.nsfwPubkeys);
  if (!nsfwPubkeys) return null;
  const blockedEvents = normalizeHexArray(obj.blockedEvents);
  if (!blockedEvents) return null;

  if (blockedPubkeys.length > MAX_BLOCKED_PUBKEYS) return null;
  if (nsfwPubkeys.length > MAX_NSFW_PUBKEYS) return null;
  if (blockedEvents.length > MAX_BLOCKED_EVENTS) return null;

  return { blockedPubkeys, nsfwPubkeys, blockedEvents };
}

// ── Event parsing ──────────────────────────────────────────────────────────────

/**
 * Parse a single NIP-78 kind-30078 event into a PresetPolicy.
 *
 * Returns null if the event lacks the correct d tag, has unparseable or
 * invalid JSON content, or fails content validation.
 * Signature verification is the caller's responsibility.
 */
export function parsePresetEvent(event: Event): PresetPolicy | null {
  if (event.kind !== 30078) return null;

  const dTag = event.tags?.find(t => t[0] === 'd')?.[1];
  if (dTag !== PRESET_D_TAG) return null;

  let content: unknown;
  try {
    content = JSON.parse(event.content);
  } catch {
    return null;
  }

  const validated = validatePresetContent(content);
  if (!validated) return null;

  return {
    ...validated,
    revision: event.created_at,
    eventId: event.id ?? '',
  };
}

// ── Relay fetching ─────────────────────────────────────────────────────────────

function presetRelaysFromEnv(): string[] {
  // Treat empty/whitespace as absent — docker-compose's ${:-} injects "" when unset
  const preset = process.env.NOSTR_PRESET_RELAYS?.trim();
  if (preset) {
    return preset.split(',').map(r => r.trim()).filter(Boolean);
  }
  const index = process.env.NOSTR_INDEX_RELAYS?.trim();
  if (index) {
    return index.split(',').map(r => r.trim()).filter(Boolean);
  }
  return ['wss://relay.nostu.be'];
}

/**
 * Fetch preset events for the given pubkey from configured relays.
 *
 * Fetches kind-30078 events with d-tag `nostube-presets`. Returns the most
 * recent valid policy using deterministic tiebreak (created_at desc, event id desc).
 * Returns null if no events found, none parse, or none verify signatures.
 * Exported for testing and direct use.
 */
export async function fetchPresetFromRelays(pubkey: string): Promise<PresetPolicy | null> {
  const relays = presetRelaysFromEnv();
  if (relays.length === 0) return null;
  const pool = new SimplePool({ enablePing: false, enableReconnect: false });
  const maxWait = Number(process.env.NOSTR_SOURCE_MAX_WAIT_MS) || 30_000;

  try {
    const events = await pool.querySync(
      relays,
      { authors: [pubkey], kinds: [30078], '#d': [PRESET_D_TAG], limit: 10 },
      { maxWait, label: 'nostube-search-preset-fetch' },
    );

    const verified = filterVerifiedEvents(events, 'preset-fetch')
      .filter(e => e.pubkey === pubkey);

    const parsed = verified
      .map(parsePresetEvent)
      .filter((p): p is PresetPolicy => p !== null);

    if (parsed.length === 0) return null;

    // Most recent revision wins; deterministic event-ID tiebreak
    parsed.sort((a, b) => {
      if (b.revision !== a.revision) return b.revision - a.revision;
      return b.eventId.localeCompare(a.eventId);
    });

    return parsed[0];
  } finally {
    pool.destroy();
  }
}

// ── Stale-while-revalidate cache ──────────────────────────────────────────────

export class PresetStore {
  /** Fresh period before the entry enters stale territory (ms). */
  private freshTtlMs: number;
  /** Max age before the entry is treated as a full miss (ms). */
  private maxStaleTtlMs: number;

  private cache = new Map<
    string,
    { policy: PresetPolicy; expiresAt: number; staleAt: number }
  >();

  private pending = new Map<string, Promise<PresetPolicy | null>>();

  constructor(freshTtlMs?: number, maxStaleTtlMs?: number) {
    this.freshTtlMs = freshTtlMs ?? (Number(process.env.PRESET_CACHE_FRESH_TTL_MS) || 5 * 60_000);
    this.maxStaleTtlMs = maxStaleTtlMs ?? (Number(process.env.PRESET_CACHE_MAX_TTL_MS) || 30 * 60_000);
  }

  /**
   * Get the preset policy for the given pubkey.
   *
   * - Fresh cache hit: return immediately.
   * - Stale cache hit: return stale, fire background refresh.
   * - Miss or stale expired: fetch fresh, block until resolved.
   *
   * The cache will **never** replace a valid cached entry with invalid data
   * from a failed or empty fetch. If the fetch returns null and a stale
   * entry exists, the stale entry survives.
   */
  async getPreset(pubkey: string): Promise<PresetPolicy | null> {
    const now = Date.now();
    const entry = this.cache.get(pubkey);

    // Fresh — return immediately
    if (entry && now < entry.expiresAt) {
      return entry.policy;
    }

    // Stale — return, kick off background refresh
    if (entry && now < entry.staleAt) {
      this.refreshPreset(pubkey).catch(() => {
        /* stale value is still fine */
      });
      return entry.policy;
    }

    // Expired or missing — fetch synchronously
    return this.refreshPreset(pubkey);
  }

  /**
   * Invalidate a cached preset. Next call will fetch fresh.
   */
  invalidate(pubkey: string): void {
    this.cache.delete(pubkey);
  }

  private async refreshPreset(pubkey: string): Promise<PresetPolicy | null> {
    const existing = this.pending.get(pubkey);
    if (existing) return existing;

    const promise = this.fetchAndCache(pubkey);
    this.pending.set(pubkey, promise);
    try {
      return await promise;
    } finally {
      this.pending.delete(pubkey);
    }
  }

  private async fetchAndCache(pubkey: string): Promise<PresetPolicy | null> {
    const policy = await fetchPresetFromRelays(pubkey);
    const now = Date.now();

    if (policy) {
      this.cache.set(pubkey, {
        policy,
        expiresAt: now + this.freshTtlMs,
        staleAt: now + this.maxStaleTtlMs,
      });
      return policy;
    }

    // Fetch returned null — do NOT replace existing stale entry
    return this.cache.get(pubkey)?.policy ?? null;
  }
}

/** Singleton preset store used by route handlers. */
export const presetStore = new PresetStore();

// ── Meili filter helpers ──────────────────────────────────────────────────────

/**
 * Build MeiliSearch filter expressions from a preset policy and NSFW filter level.
 *
 * Returns an array of filter strings that should be ANDed with existing
 * search filters. Blocked pubkeys and events are always excluded.
 * NSFW pubkeys are excluded only when nsfwFilter is 'hide'.
 *
 * All filter values are MeiliSearch-safe quoted strings.
 */
export function buildPresetFilters(policy: PresetPolicy, nsfwFilter: NsfwFilter): string[] {
  const filters: string[] = [];
  const quote = (v: string) => `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

  // Blocked pubkeys — always excluded
  if (policy.blockedPubkeys.length > 0) {
    const clauses = policy.blockedPubkeys.map(pk => `pubkey != ${quote(pk)}`);
    filters.push(`(${clauses.join(' AND ')})`);
  }

  // Blocked events — always excluded
  if (policy.blockedEvents.length > 0) {
    const clauses = policy.blockedEvents.map(id => `event_id != ${quote(id)}`);
    filters.push(`(${clauses.join(' AND ')})`);
  }

  // NSFW pubkeys — hidden only when nsfwFilter is 'hide'
  if (policy.nsfwPubkeys.length > 0 && nsfwFilter === 'hide') {
    const clauses = policy.nsfwPubkeys.map(pk => `pubkey != ${quote(pk)}`);
    filters.push(`(${clauses.join(' AND ')})`);
  }

  return filters;
}

/**
 * Check whether a pubkey is blocked or (on hide) NSFW according to the given policy.
 * Used for post-query filtering when Meili filters aren't available (e.g. people index).
 */
export function isAuthorBlockedOrNsfw(pubkey: string, policy: PresetPolicy, nsfwFilter: NsfwFilter): boolean {
  const lower = pubkey.toLowerCase();
  if (policy.blockedPubkeys.includes(lower)) return true;
  if (nsfwFilter === 'hide' && policy.nsfwPubkeys.includes(lower)) return true;
  return false;
}
