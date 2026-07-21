import assert from 'node:assert/strict';
import { describe, it, before, after, mock } from 'node:test';
import { SimplePool, type Event } from 'nostr-tools';

import {
  isValidNsfwFilter,
  isValidPresetPubkey,
  parsePresetEvent,
  buildPresetFilters,
  isAuthorBlockedOrNsfw,
  PresetStore,
  fetchPresetFromRelays,
  type NsfwFilter,
  type PresetPolicy,
} from './preset-safety.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

const AAA = 'a'.repeat(64);
const BBB = 'b'.repeat(64);
const CCC = 'c'.repeat(64);
const DDD = 'd'.repeat(64);

function make30078Event(overrides: Partial<Event> & { content: string }): Event {
  return {
    id: BBB,
    pubkey: AAA,
    created_at: 1_000_000,
    kind: 30078,
    tags: [['d', 'nostube-presets']],
    sig: '0'.repeat(128),
    ...overrides,
  };
}

// ── Validation ──────────────────────────────────────────────────────────────

describe('isValidPresetPubkey', () => {
  it('accepts a 64-char hex string', () => {
    assert.equal(isValidPresetPubkey(AAA), true);
  });

  it('rejects empty string', () => {
    assert.equal(isValidPresetPubkey(''), false);
  });

  it('rejects npub', () => {
    assert.equal(isValidPresetPubkey('npub1...'), false);
  });

  it('rejects short hex', () => {
    assert.equal(isValidPresetPubkey('ff'.repeat(31)), false);
  });

  it('rejects non-hex characters', () => {
    assert.equal(isValidPresetPubkey('z'.repeat(64)), false);
  });
});

describe('isValidNsfwFilter', () => {
  it('accepts hide', () => {
    assert.equal(isValidNsfwFilter('hide'), true);
  });

  it('accepts warning', () => {
    assert.equal(isValidNsfwFilter('warning'), true);
  });

  it('accepts show', () => {
    assert.equal(isValidNsfwFilter('show'), true);
  });

  it('rejects unknown value', () => {
    assert.equal(isValidNsfwFilter('banana'), false);
  });

  it('rejects empty string', () => {
    assert.equal(isValidNsfwFilter(''), false);
  });
});

// ── Event parsing ──────────────────────────────────────────────────────────

describe('parsePresetEvent', () => {
  it('parses a valid preset event', () => {
    const event = make30078Event({
      content: JSON.stringify({
        blockedPubkeys: [AAA],
        nsfwPubkeys: [BBB],
        blockedEvents: [CCC],
      }),
    });

    const result = parsePresetEvent(event);
    assert.notEqual(result, null);
    assert.deepEqual(result!.blockedPubkeys, [AAA.toLowerCase()]);
    assert.deepEqual(result!.nsfwPubkeys, [BBB.toLowerCase()]);
    assert.deepEqual(result!.blockedEvents, [CCC.toLowerCase()]);
    assert.equal(result!.revision, 1_000_000);
    assert.equal(result!.eventId, BBB);
  });

  it('rejects wrong kind (not 30078)', () => {
    const event = make30078Event({ kind: 0, content: '{}' });
    assert.equal(parsePresetEvent(event), null);
  });

  it('rejects missing d tag', () => {
    const event = make30078Event({ tags: [], content: '{}' });
    assert.equal(parsePresetEvent(event), null);
  });

  it('rejects wrong d tag', () => {
    const event = make30078Event({ tags: [['d', 'wrong-tag']], content: '{}' });
    assert.equal(parsePresetEvent(event), null);
  });

  it('rejects non-JSON content', () => {
    const event = make30078Event({ content: 'not-json' });
    assert.equal(parsePresetEvent(event), null);
  });

  it('rejects JSON array (must be object)', () => {
    const event = make30078Event({ content: '["a", "b"]' });
    assert.equal(parsePresetEvent(event), null);
  });

  it('rejects JSON null (must be object)', () => {
    const event = make30078Event({ content: 'null' });
    assert.equal(parsePresetEvent(event), null);
  });

  it('accepts auxiliary unknown keys alongside valid filter arrays', () => {
    const event = make30078Event({
      content: JSON.stringify({
        blockedPubkeys: [AAA],
        nsfwPubkeys: [],
        blockedEvents: [],
        extraField: 'should-be-ignored',
      }),
    });
    const result = parsePresetEvent(event);
    assert.notEqual(result, null);
    assert.deepEqual(result!.blockedPubkeys, [AAA.toLowerCase()]);
    assert.deepEqual(result!.nsfwPubkeys, []);
    assert.deepEqual(result!.blockedEvents, []);
  });

  it('accepts Nostube preset with defaultRelays and defaultThumbResizeServer', () => {
    const event = make30078Event({
      content: JSON.stringify({
        defaultRelays: ['wss://relay.nostube.com', 'wss://relay.damus.io'],
        defaultThumbResizeServer: '/api/thumb',
        blockedPubkeys: [AAA, BBB],
        nsfwPubkeys: [],
        blockedEvents: [CCC],
      }),
    });
    const result = parsePresetEvent(event);
    assert.notEqual(result, null);
    assert.deepEqual(result!.blockedPubkeys, [AAA.toLowerCase(), BBB.toLowerCase()]);
    assert.deepEqual(result!.nsfwPubkeys, []);
    assert.deepEqual(result!.blockedEvents, [CCC.toLowerCase()]);
    assert.equal(result!.revision, 1_000_000);
    assert.equal(result!.eventId, BBB);
    // Ensure only the three safety-filter fields are in the policy
    assert.deepEqual(Object.keys(result!).sort(), [
      'blockedEvents',
      'blockedPubkeys',
      'eventId',
      'nsfwPubkeys',
      'revision',
    ]);
  });

  it('rejects oversized blockedPubkeys array', () => {
    const huge = Array.from({ length: 1001 }, (_, i) => `${i}`.padStart(64, '0'));
    const event = make30078Event({
      content: JSON.stringify({ blockedPubkeys: huge }),
    });
    assert.equal(parsePresetEvent(event), null);
  });

  it('rejects arrays with non-hex values', () => {
    const event = make30078Event({
      content: JSON.stringify({
        blockedPubkeys: [AAA, 'not-hex'],
        nsfwPubkeys: [],
        blockedEvents: [],
      }),
    });
    assert.equal(parsePresetEvent(event), null);
  });

  it('rejects non-string array entries', () => {
    const event = make30078Event({
      content: JSON.stringify({
        blockedPubkeys: [AAA, 123],
        nsfwPubkeys: [],
        blockedEvents: [],
      }),
    });
    assert.equal(parsePresetEvent(event), null);
  });

  it('deduplicates and lowercases hex values', () => {
    const event = make30078Event({
      content: JSON.stringify({
        blockedPubkeys: [AAA.toUpperCase(), AAA.toLowerCase()],
        nsfwPubkeys: [],
        blockedEvents: [],
      }),
    });
    const result = parsePresetEvent(event);
    assert.notEqual(result, null);
    assert.deepEqual(result!.blockedPubkeys, [AAA.toLowerCase()]);
  });

  it('accepts empty arrays', () => {
    const event = make30078Event({
      content: JSON.stringify({
        blockedPubkeys: [],
        nsfwPubkeys: [],
        blockedEvents: [],
      }),
    });
    assert.notEqual(parsePresetEvent(event), null);
  });
});

// ── Build preset filters ───────────────────────────────────────────────────

describe('buildPresetFilters', () => {
  const policy: PresetPolicy = {
    blockedPubkeys: [AAA, BBB],
    nsfwPubkeys: [CCC],
    blockedEvents: [DDD],
    revision: 1000,
    eventId: 'x'.repeat(64),
  };

  it('always excludes blocked pubkeys', () => {
    const filters = buildPresetFilters(policy, 'show');
    assert.ok(filters.some(f => f.includes(AAA)));
    assert.ok(filters.some(f => f.includes(BBB)));
  });

  it('always excludes blocked events', () => {
    const filters = buildPresetFilters(policy, 'show');
    assert.ok(filters.some(f => f.includes(DDD)));
  });

  it('excludes NSFW pubkeys on hide', () => {
    const filters = buildPresetFilters(policy, 'hide');
    assert.ok(filters.some(f => f.includes(CCC)));
  });

  it('does not exclude NSFW pubkeys on warning', () => {
    const filters = buildPresetFilters(policy, 'warning');
    assert.equal(filters.some(f => f.includes(CCC)), false);
  });

  it('does not exclude NSFW pubkeys on show', () => {
    const filters = buildPresetFilters(policy, 'show');
    assert.equal(filters.some(f => f.includes(CCC)), false);
  });

  it('returns empty array for empty policy with show', () => {
    const empty: PresetPolicy = {
      blockedPubkeys: [],
      nsfwPubkeys: [],
      blockedEvents: [],
      revision: 0,
      eventId: '',
    };
    assert.deepEqual(buildPresetFilters(empty, 'show'), []);
  });
});

// ── isAuthorBlockedOrNsfw ──────────────────────────────────────────────────

describe('isAuthorBlockedOrNsfw', () => {
  const policy: PresetPolicy = {
    blockedPubkeys: [AAA],
    nsfwPubkeys: [BBB],
    blockedEvents: [],
    revision: 1000,
    eventId: 'x'.repeat(64),
  };

  it('flags blocked pubkey regardless of nsfwFilter', () => {
    assert.equal(isAuthorBlockedOrNsfw(AAA, policy, 'show'), true);
    assert.equal(isAuthorBlockedOrNsfw(AAA, policy, 'hide'), true);
    assert.equal(isAuthorBlockedOrNsfw(AAA, policy, 'warning'), true);
  });

  it('flags NSFW pubkey only on hide', () => {
    assert.equal(isAuthorBlockedOrNsfw(BBB, policy, 'hide'), true);
    assert.equal(isAuthorBlockedOrNsfw(BBB, policy, 'show'), false);
    assert.equal(isAuthorBlockedOrNsfw(BBB, policy, 'warning'), false);
  });

  it('does not flag pubkey not in policy', () => {
    assert.equal(isAuthorBlockedOrNsfw(CCC, policy, 'hide'), false);
  });

  it('is case-insensitive', () => {
    assert.equal(isAuthorBlockedOrNsfw(AAA.toUpperCase(), policy, 'hide'), true);
  });
});

// ── PresetStore ────────────────────────────────────────────────────────────

describe('PresetStore', () => {
  let store: PresetStore;
  const validPolicy: PresetPolicy = {
    blockedPubkeys: [],
    nsfwPubkeys: [],
    blockedEvents: [],
    revision: 1000,
    eventId: 'y'.repeat(64),
  };

  before(() => {
    store = new PresetStore(10_000, 60_000); // fresh=10s, stale=60s
  });

  after(() => {
    mock.restoreAll();
  });

  it('returns null for unknown pubkey when fetch fails', async () => {
    const s = store as unknown as { fetchAndCache: (pubkey: string) => Promise<PresetPolicy | null> };
    mock.method(s, 'fetchAndCache', async () => null);

    const result = await store.getPreset(AAA);
    assert.equal(result, null);
  });

  it('never replaces valid cached data with invalid newer data', async () => {
    const store2 = new PresetStore(100_000, 200_000);
    const s2 = store2 as unknown as {
      cache: Map<string, { policy: PresetPolicy; expiresAt: number; staleAt: number }>;
      fetchAndCache: (pubkey: string) => Promise<PresetPolicy | null>;
    };

    // Inject a valid policy into the private cache
    s2.cache.set(AAA, {
      policy: validPolicy,
      expiresAt: Date.now() + 100_000,
      staleAt: Date.now() + 200_000,
    });

    // Simulate fetch returning null — stale should survive
    mock.method(s2, 'fetchAndCache', async () => null);
    const result = await store2.getPreset(AAA);
    assert.deepEqual(result, validPolicy);
  });
});

// ── fetchPresetFromRelays error handling (unit, not integration) ───────────

describe('fetchPresetFromRelays (error path)', () => {
  it('handles pool errors gracefully', async () => {
    const origRelays = process.env.NOSTR_PRESET_RELAYS;
    process.env.NOSTR_PRESET_RELAYS = 'wss://localhost:1';
    process.env.NOSTR_SOURCE_MAX_WAIT_MS = '100';

    const result = await fetchPresetFromRelays(AAA);
    assert.equal(result, null);

    if (origRelays !== undefined) {
      process.env.NOSTR_PRESET_RELAYS = origRelays;
    } else {
      delete process.env.NOSTR_PRESET_RELAYS;
    }
  });
});

// ── Empty/whitespace env-var fallback regression ──────────────────────────
// docker-compose's `NOSTR_PRESET_RELAYS: ${NOSTR_PRESET_RELAYS:-}` injects
// an empty string when unset. The old `??` operator treated `""` as a
// defined value, producing an empty relay list that hung querySync forever.

describe('fetchPresetFromRelays (empty-env fallback)', () => {
  it('returns null without querying when both env vars are empty', async () => {
    const origPreset = process.env.NOSTR_PRESET_RELAYS;
    const origIndex = process.env.NOSTR_INDEX_RELAYS;
    process.env.NOSTR_PRESET_RELAYS = '';
    process.env.NOSTR_INDEX_RELAYS = '';

    // Must return null immediately — no pool created, no querySync call
    const result = await fetchPresetFromRelays(AAA);
    assert.equal(result, null);

    if (origIndex !== undefined) process.env.NOSTR_INDEX_RELAYS = origIndex;
    else delete process.env.NOSTR_INDEX_RELAYS;
    if (origPreset !== undefined) process.env.NOSTR_PRESET_RELAYS = origPreset;
    else delete process.env.NOSTR_PRESET_RELAYS;
  });

  it('falls back to NOSTR_INDEX_RELAYS when NOSTR_PRESET_RELAYS is empty string', async () => {
    const origPreset = process.env.NOSTR_PRESET_RELAYS;
    const origIndex = process.env.NOSTR_INDEX_RELAYS;
    process.env.NOSTR_PRESET_RELAYS = '';
    process.env.NOSTR_INDEX_RELAYS = 'wss://fallback.example.com';
    process.env.NOSTR_SOURCE_MAX_WAIT_MS = '100';

    const querySyncSpy = mock.method(SimplePool.prototype, 'querySync', async () => []);

    const result = await fetchPresetFromRelays(AAA);

    // querySync must have been called with the fallback relay, not with []
    assert.equal(querySyncSpy.mock.callCount(), 1);
    const relayArg = querySyncSpy.mock.calls[0].arguments[0] as string[];
    assert.deepEqual(relayArg, ['wss://fallback.example.com']);
    assert.equal(result, null);

    mock.restoreAll();

    if (origIndex !== undefined) process.env.NOSTR_INDEX_RELAYS = origIndex;
    else delete process.env.NOSTR_INDEX_RELAYS;
    if (origPreset !== undefined) process.env.NOSTR_PRESET_RELAYS = origPreset;
    else delete process.env.NOSTR_PRESET_RELAYS;
  });

  it('treats whitespace-only NOSTR_PRESET_RELAYS as absent', async () => {
    const origPreset = process.env.NOSTR_PRESET_RELAYS;
    const origIndex = process.env.NOSTR_INDEX_RELAYS;
    process.env.NOSTR_PRESET_RELAYS = '   ';
    process.env.NOSTR_INDEX_RELAYS = 'wss://whitespace.example.com';
    process.env.NOSTR_SOURCE_MAX_WAIT_MS = '100';

    const querySyncSpy = mock.method(SimplePool.prototype, 'querySync', async () => []);

    const result = await fetchPresetFromRelays(AAA);

    assert.equal(querySyncSpy.mock.callCount(), 1);
    const relayArg = querySyncSpy.mock.calls[0].arguments[0] as string[];
    assert.deepEqual(relayArg, ['wss://whitespace.example.com']);
    assert.equal(result, null);

    mock.restoreAll();

    if (origIndex !== undefined) process.env.NOSTR_INDEX_RELAYS = origIndex;
    else delete process.env.NOSTR_INDEX_RELAYS;
    if (origPreset !== undefined) process.env.NOSTR_PRESET_RELAYS = origPreset;
    else delete process.env.NOSTR_PRESET_RELAYS;
  });
  });
