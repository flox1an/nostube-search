import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { needsFullReindex, readState, setStatePath, type IndexerState } from './state.js';

const DAY = 86_400_000;
const RETRY = 15 * 60_000;

const base: IndexerState = {
  lastIncrementalAt: 0,
  lastFullAt: 0,
  lastFullStartAt: 0,
  lastAvailabilityCheckAt: 0,
  lastPlaylistScoreAt: 0,
};

const oldStatePaths: string[] = [];

afterEach(() => {
  for (const p of oldStatePaths.splice(0)) setStatePath(p);
});

describe('needsFullReindex', () => {
  it('triggers a full when the interval elapsed and no run was started', () => {
    assert.equal(needsFullReindex(base, DAY + 1, DAY, RETRY), true);
  });

  it('does not run while a full is still due-scheduled', () => {
    const state = { ...base, lastFullAt: DAY - 60_000 };
    assert.equal(needsFullReindex(state, DAY, DAY, RETRY), false);
  });

  it('does not restart immediately after a crashed run', () => {
    // Container restarted 60s after the previous run wrote lastFullStartAt.
    const state = { ...base, lastFullStartAt: DAY };
    assert.equal(needsFullReindex(state, DAY + 60_000, DAY, RETRY), false);
  });

  it('allows a retry once the retry window has elapsed', () => {
    const state = { ...base, lastFullStartAt: DAY };
    assert.equal(needsFullReindex(state, DAY + RETRY, DAY, RETRY), true);
  });
});

describe('readState backcompat', () => {
  it('defaults lastFullStartAt to 0 for pre-existing state files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nostube-state-'));
    const legacy = join(dir, '.indexer-state.json');
    writeFileSync(legacy, JSON.stringify({ lastIncrementalAt: 1, lastFullAt: 2, lastAvailabilityCheckAt: 3, lastPlaylistScoreAt: 4 }), 'utf-8');
    oldStatePaths.push(legacy);
    setStatePath(legacy);

    const state = readState();
    assert.equal(state.lastFullAt, 2);
    assert.equal(state.lastFullStartAt, 0);
  });
});
