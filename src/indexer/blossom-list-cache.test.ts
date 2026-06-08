import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { nip19 } from 'nostr-tools';

import * as blossomListCache from './blossom-list-cache.js';

const pubkey = '0'.repeat(64);
const npub = nip19.npubEncode(pubkey);

function useTempCacheDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'nostube-blossom-lists-'));
  blossomListCache.setCacheDir(dir);
  blossomListCache.setCacheTTL(86_400_000);
  return dir;
}

describe('blossom list cache', () => {
  it('stores one server-list file per author npub', () => {
    const dir = useTempCacheDir();

    blossomListCache.setMany(new Map([
      [pubkey, { servers: ['https://Blossom.Example/path', 'https://blossom.example/'], eventCreatedAt: 123 }],
    ]));

    const cached = blossomListCache.getMany([pubkey]);
    assert.deepEqual(cached.missingPubkeys, []);
    assert.deepEqual(cached.serversByPubkey.get(pubkey), ['https://blossom.example']);

    const raw = JSON.parse(readFileSync(join(dir, `${npub}.json`), 'utf-8')) as {
      pubkey: string;
      npub: string;
      eventCreatedAt: number;
    };
    assert.equal(raw.pubkey, pubkey);
    assert.equal(raw.npub, npub);
    assert.equal(raw.eventCreatedAt, 123);
  });

  it('caches missing lists as empty server arrays', () => {
    useTempCacheDir();

    blossomListCache.setMany(new Map(), [pubkey]);

    const cached = blossomListCache.getMany([pubkey]);
    assert.deepEqual(cached.missingPubkeys, []);
    assert.deepEqual(cached.serversByPubkey.get(pubkey), []);
  });

  it('prunes expired per-author files', () => {
    const dir = useTempCacheDir();
    blossomListCache.setCacheTTL(1);
    blossomListCache.setMany(new Map([[pubkey, { servers: ['https://blossom.example'], eventCreatedAt: null }]]));

    const path = join(dir, `${npub}.json`);
    const entry = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
    entry.cachedAt = 0;
    blossomListCache.setCacheTTL(1);
    // Rewriting through the public API would refresh cachedAt; use the file to simulate age.
    writeFileSync(path, JSON.stringify(entry), 'utf-8');

    assert.equal(blossomListCache.prune(), 1);
    assert.equal(blossomListCache.stats().entries, 0);
  });
});
