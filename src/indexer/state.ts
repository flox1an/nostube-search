import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export type IndexerState = {
  lastIncrementalAt: number; // Unix ms
  lastFullAt: number;        // Unix ms
  lastFullStartAt: number;   // Unix ms; written when a full re-index starts, survives crashes
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
      return { lastIncrementalAt: 0, lastFullAt: 0, lastFullStartAt: 0, lastAvailabilityCheckAt: 0, lastPlaylistScoreAt: 0, ...parsed };
    }
  } catch (err) {
    console.warn('[State] Failed to read state file, starting fresh:', err);
  }
  return { lastIncrementalAt: 0, lastFullAt: 0, lastFullStartAt: 0, lastAvailabilityCheckAt: 0, lastPlaylistScoreAt: 0 };
}

/**
 * Whether a full re-index is due. A run that was started but never completed
 * (process crashed or run failed) must not restart immediately on the next
 * boot — `lastFullStartAt` gates retries behind `fullRetryMs`.
 */
export function needsFullReindex(
  state: IndexerState,
  now: number,
  fullIntervalMs: number,
  fullRetryMs: number,
): boolean {
  if (now - state.lastFullAt < fullIntervalMs) return false;
  return now - state.lastFullStartAt >= fullRetryMs;
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
