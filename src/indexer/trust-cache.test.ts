import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

// The ceiling is read at module load, so set it before importing.
process.env.TRUST_CACHE_MAX_ENTRIES = '2';
const trustCache = await import('./trust-cache.js');

describe('trust cache', () => {
  it('evicts the stalest entries past the ceiling and keeps the on-disk format', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'nostube-trust-cache-')), 'trust.json');
    writeFileSync(path, JSON.stringify({ a: { score: 0.1, cachedAt: Date.now() } }), 'utf-8');
    trustCache.setCachePath(path);

    trustCache.setMany(new Map([['b', 0.2]]));
    trustCache.setMany(new Map([['a', 0.3]])); // rewrite moves a behind b
    trustCache.setMany(new Map([['c', 0.4]]));

    assert.deepEqual([...trustCache.getMany(['a', 'b', 'c'])], [['a', 0.3], ['c', 0.4]]);

    trustCache.flush();
    const onDisk = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, { score: number; cachedAt: number }>;
    assert.deepEqual(Object.keys(onDisk), ['a', 'c']);
    assert.equal(onDisk.c.score, 0.4);
    assert.equal(typeof onDisk.c.cachedAt, 'number');
  });
});
