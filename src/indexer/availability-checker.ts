import { closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { MeiliSearch, type Index } from 'meilisearch';

import { fetchAuthorBlossomServers } from './blossom-lists.js';
import {
  fetchAvailabilityByKeys,
  mediaAvailabilityKey,
  snapshotFromAvailability,
  type CheckedMediaUrl,
  type MediaAvailabilityDocument,
  type MediaAvailabilityStatus,
} from './media-availability.js';

type AvailabilityVideoHit = {
  id?: string;
  event_id?: string;
  pubkey?: string;
  hash?: string | null;
  videoUrl?: string | null;
  fallbackUrls?: string[];
  mediaAvailabilityKey?: string | null;
  mediaCheckedAt?: number | null;
  mediaRetryAfter?: number | null;
};

type HeadResult = {
  url: string;
  status: MediaAvailabilityStatus;
  statusCode?: number;
  contentType?: string;
  contentLength?: number;
};

type AvailabilityCheckConfig = {
  batchSize: number;
  headTimeoutMs: number;
  staleAfterMs: number;
  retryAfterMs: number;
  lockPath: string;
  lockStaleMs: number;
};

const DEFAULT_LOCK_PATH = resolve(process.cwd(), '.media-availability-check.lock');

function getPositiveIntEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function getConfig(): AvailabilityCheckConfig {
  return {
    batchSize: getPositiveIntEnv('MEDIA_AVAILABILITY_CHECK_BATCH_SIZE', 100),
    headTimeoutMs: getPositiveIntEnv('MEDIA_AVAILABILITY_HEAD_TIMEOUT_MS', 5_000),
    staleAfterMs: getPositiveIntEnv('MEDIA_AVAILABILITY_STALE_AFTER_MS', 86_400_000),
    retryAfterMs: getPositiveIntEnv('MEDIA_AVAILABILITY_RETRY_AFTER_MS', 3_600_000),
    lockPath: resolve(process.env.MEDIA_AVAILABILITY_LOCK_PATH ?? DEFAULT_LOCK_PATH),
    lockStaleMs: getPositiveIntEnv('MEDIA_AVAILABILITY_LOCK_STALE_MS', 30 * 60_000),
  };
}

function quoteFilterValue(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function uniqueUrls(urls: Array<string | null | undefined>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();

  for (const url of urls) {
    const trimmed = url?.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }

  return out;
}

function extractBlossomFile(urls: string[], fallbackHash?: string | null): { hash: string | null; ext: string | null } {
  for (const url of urls) {
    try {
      const parsed = new URL(url);
      const filename = parsed.pathname.split('/').pop() ?? '';
      const match = filename.match(/^([a-f0-9]{64})(?:\.([^.]+))?$/i);
      if (match) {
        return { hash: match[1].toLowerCase(), ext: match[2] ?? null };
      }
    } catch {
      // Invalid URLs are ignored by the caller during HEAD checks.
    }
  }

  const normalizedHash = fallbackHash?.match(/^[a-f0-9]{64}$/i)?.[0].toLowerCase() ?? null;
  return { hash: normalizedHash, ext: null };
}

function hashFromAvailabilityKey(key: string | null | undefined): string | null {
  const match = key?.match(/^sha256:([a-f0-9]{64})$/i);
  return match ? match[1].toLowerCase() : null;
}

export async function buildAvailabilityCandidateUrls(
  hit: AvailabilityVideoHit,
  authorServers: string[] = [],
): Promise<string[]> {
  const directUrls = uniqueUrls([hit.videoUrl, ...(hit.fallbackUrls ?? [])]);
  const fallbackHash = hit.hash ?? hashFromAvailabilityKey(hit.mediaAvailabilityKey);
  const blossomFile = extractBlossomFile(directUrls, fallbackHash);

  const authorFallbackUrls = blossomFile.hash
    ? authorServers.map(server => {
        const normalized = server.replace(/\/+$/, '');
        return `${normalized}/${blossomFile.hash}${blossomFile.ext ? `.${blossomFile.ext}` : '.mp4'}`;
      })
    : [];

  return uniqueUrls([...directUrls, ...authorFallbackUrls]);
}

async function headUrl(url: string, timeoutMs: number): Promise<HeadResult> {
  try {
    const response = await fetch(url, {
      method: 'HEAD',
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    });

    const contentLength = response.headers.get('content-length');
    return {
      url,
      status: response.ok ? 'available' : 'unavailable',
      statusCode: response.status,
      contentType: response.headers.get('content-type') ?? undefined,
      contentLength: contentLength ? Number(contentLength) : undefined,
    };
  } catch {
    return { url, status: 'error' };
  }
}

async function checkUrls(urls: string[], timeoutMs: number): Promise<{
  status: MediaAvailabilityStatus;
  playableUrl: string | null;
  checkedUrls: CheckedMediaUrl[];
}> {
  const checkedUrls: CheckedMediaUrl[] = [];
  const checkedAt = Date.now();

  for (const url of urls) {
    const result = await headUrl(url, timeoutMs);
    checkedUrls.push({ ...result, checkedAt });
    if (result.status === 'available') {
      return { status: 'available', playableUrl: url, checkedUrls };
    }
  }

  const status = checkedUrls.some(result => result.status === 'unavailable') ? 'unavailable' : 'error';
  return { status, playableUrl: null, checkedUrls };
}

function acquireLock(path: string, staleMs: number): (() => void) | null {
  try {
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    try {
      const stats = statSync(path);
      if (Date.now() - stats.mtimeMs > staleMs) {
        console.warn(`[AvailabilityChecker] Removing stale lock at ${path}`);
        unlinkSync(path);
      }
    } catch {
      // Missing lock is the normal path.
    }

    const fd = openSync(path, 'wx');
    writeFileSync(fd, JSON.stringify({ pid: process.pid, lockedAt: Date.now() }), 'utf-8');
    return () => {
      try { closeSync(fd); } catch { /* ignore */ }
      try { unlinkSync(path); } catch { /* ignore */ }
    };
  } catch {
    try {
      const raw = readFileSync(path, 'utf-8');
      console.log(`[AvailabilityChecker] Lock held, skipping run: ${raw}`);
    } catch {
      console.log('[AvailabilityChecker] Lock held, skipping run');
    }
    return null;
  }
}

async function fetchDueVideoHits(videosIndex: Index, config: AvailabilityCheckConfig): Promise<AvailabilityVideoHit[]> {
  const now = Date.now();
  const staleBefore = now - config.staleAfterMs;
  const filter = [
    'mediaAvailabilityKey EXISTS',
    `(mediaCheckedAt IS NULL OR mediaCheckedAt <= ${staleBefore} OR mediaRetryAfter <= ${now})`,
  ];

  const result = await videosIndex.search('', {
    limit: config.batchSize,
    filter,
    sort: ['mediaCheckedAt:asc'],
    attributesToRetrieve: [
      'id', 'event_id', 'pubkey', 'hash', 'videoUrl', 'fallbackUrls',
      'mediaAvailabilityKey', 'mediaCheckedAt', 'mediaRetryAfter',
    ],
  });

  return result.hits as AvailabilityVideoHit[];
}

function toAvailabilityDoc(input: {
  key: string;
  previous?: MediaAvailabilityDocument;
  result: Awaited<ReturnType<typeof checkUrls>>;
  sourceUrlCount: number;
  retryAfterMs: number;
}): MediaAvailabilityDocument {
  const checkedAt = Date.now();
  return {
    id: input.key,
    mediaKey: input.key,
    status: input.result.status,
    playableUrl: input.result.playableUrl,
    checkedAt,
    retryAfter: input.result.status === 'available' ? null : checkedAt + input.retryAfterMs,
    attempts: (input.previous?.attempts ?? 0) + 1,
    checkedUrls: input.result.checkedUrls,
    sourceUrlCount: input.sourceUrlCount,
  };
}

export async function runMediaAvailabilityCheck(
  client: MeiliSearch,
  videosIndex: Index,
  availabilityIndex: Index,
): Promise<void> {
  const config = getConfig();
  const releaseLock = acquireLock(config.lockPath, config.lockStaleMs);
  if (!releaseLock) return;

  const startedAt = Date.now();
  try {
    const hits = await fetchDueVideoHits(videosIndex, config);
    if (hits.length === 0) {
      console.log('[AvailabilityChecker] No due videos to check');
      return;
    }

    const authorServersByPubkey = await fetchAuthorBlossomServers(hits.map(hit => hit.pubkey ?? ''));
    const keys = hits
      .map(hit => hit.mediaAvailabilityKey ?? mediaAvailabilityKey({
        hash: hit.hash,
        videoUrl: hit.videoUrl,
        fallbackUrls: hit.fallbackUrls,
      }))
      .filter((key): key is string => Boolean(key));
    const existingByKey = await fetchAvailabilityByKeys(availabilityIndex, keys);

    const availabilityDocs: MediaAvailabilityDocument[] = [];
    const videoPatches: Array<Record<string, unknown>> = [];
    let available = 0;
    let unavailable = 0;
    let errors = 0;

    for (const hit of hits) {
      const key = hit.mediaAvailabilityKey ?? mediaAvailabilityKey({
        hash: hit.hash,
        videoUrl: hit.videoUrl,
        fallbackUrls: hit.fallbackUrls,
      });
      if (!key || !hit.id) continue;

      const candidates = await buildAvailabilityCandidateUrls(
        hit,
        hit.pubkey ? authorServersByPubkey.get(hit.pubkey) ?? [] : [],
      );
      const result = await checkUrls(candidates, config.headTimeoutMs);
      const doc = toAvailabilityDoc({
        key,
        previous: existingByKey.get(key),
        result,
        sourceUrlCount: candidates.length,
        retryAfterMs: config.retryAfterMs,
      });
      const snapshot = snapshotFromAvailability(key, doc);

      availabilityDocs.push(doc);
      videoPatches.push({
        id: hit.id,
        ...snapshot,
      });

      if (doc.status === 'available') available++;
      else if (doc.status === 'unavailable') unavailable++;
      else errors++;
    }

    if (availabilityDocs.length > 0) {
      const availabilityTask = await availabilityIndex.addDocuments(availabilityDocs);
      const videosTask = await videosIndex.updateDocuments(videoPatches);
      await Promise.all([
        client.waitForTask(availabilityTask.taskUid),
        client.waitForTask(videosTask.taskUid),
      ]);
    }

    console.log(
      `[AvailabilityChecker] Checked ${availabilityDocs.length}/${hits.length} videos ` +
      `(${available} available, ${unavailable} unavailable, ${errors} error) in ${Date.now() - startedAt}ms`,
    );
  } finally {
    releaseLock();
  }
}
