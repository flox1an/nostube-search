import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export type IndexerState = {
  lastIncrementalAt: number; // Unix ms
  lastFullAt: number;        // Unix ms
  lastAvailabilityCheckAt: number; // Unix ms
  lastPlaylistScoreAt: number;     // Unix ms
};

let statePath = process.env.INDEXER_STATE_PATH
  ?? resolve(process.cwd(), '.indexer-state.json');

export function setStatePath(path: string): void {
  statePath = resolve(path);
}

export function readState(): IndexerState {
  try {
    if (existsSync(statePath)) {
      const parsed = JSON.parse(readFileSync(statePath, 'utf-8')) as Partial<IndexerState>;
      return { lastIncrementalAt: 0, lastFullAt: 0, lastAvailabilityCheckAt: 0, lastPlaylistScoreAt: 0, ...parsed };
    }
  } catch (err) {
    console.warn('[State] Failed to read state file, starting fresh:', err);
  }
  return { lastIncrementalAt: 0, lastFullAt: 0, lastAvailabilityCheckAt: 0, lastPlaylistScoreAt: 0 };
}

export function writeState(patch: Partial<IndexerState>): void {
  const next = { ...readState(), ...patch };
  try {
    const dir = dirname(statePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(statePath, JSON.stringify(next, null, 2), 'utf-8');
  } catch (err) {
    console.warn('[State] Failed to write state file:', err);
  }
}
