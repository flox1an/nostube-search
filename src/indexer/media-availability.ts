import { type Index, Meilisearch } from 'meilisearch';

export const MEDIA_AVAILABILITY_INDEX_UID = 'media_availability';

export type MediaAvailabilityStatus = 'unknown' | 'available' | 'unavailable' | 'error';

export type CheckedMediaUrl = {
  url: string;
  status: MediaAvailabilityStatus;
  statusCode?: number;
  contentType?: string;
  contentLength?: number;
  checkedAt: number;
};

export type MediaAvailabilityDocument = {
  id: string;
  mediaKey: string;
  status: MediaAvailabilityStatus;
  playableUrl: string | null;
  checkedAt: number | null;
  retryAfter: number | null;
  attempts: number;
  checkedUrls: CheckedMediaUrl[];
  sourceUrlCount: number;
};

export type MediaAvailabilitySnapshot = {
  mediaAvailabilityKey: string | null;
  availabilityStatus: MediaAvailabilityStatus;
  hasPlayableMedia: boolean;
  playableUrl: string | null;
  mediaCheckedAt: number | null;
  mediaRetryAfter: number | null;
};

const HEX_SHA256_RE = /^[a-f0-9]{64}$/i;
const DEFAULT_UNKNOWN_SNAPSHOT: MediaAvailabilitySnapshot = {
  mediaAvailabilityKey: null,
  availabilityStatus: 'unknown',
  hasPlayableMedia: false,
  playableUrl: null,
  mediaCheckedAt: null,
  mediaRetryAfter: null,
};

function normalizeHash(hash: string | null | undefined): string | null {
  const trimmed = hash?.trim().toLowerCase();
  return trimmed && HEX_SHA256_RE.test(trimmed) ? trimmed : null;
}

function normalizeMediaUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    parsed.protocol = parsed.protocol.toLowerCase();
    parsed.hostname = parsed.hostname.toLowerCase();
    return parsed.toString();
  } catch {
    return null;
  }
}

export function extractBlossomHash(url: string | null | undefined): string | null {
  if (!url || url.startsWith('data:')) return null;
  try {
    const parsed = new URL(url);
    const filename = parsed.pathname.split('/').pop() ?? '';
    const match = filename.match(/^([a-f0-9]{64})(?:\.[^.]+)?$/i);
    return normalizeHash(match?.[1]);
  } catch {
    return null;
  }
}

export function mediaAvailabilityKey(input: {
  hash?: string | null;
  videoUrl?: string | null;
  fallbackUrls?: string[];
}): string | null {
  const hash = normalizeHash(input.hash) ?? extractBlossomHash(input.videoUrl);
  if (hash) return `sha256:${hash}`;

  const urls = [input.videoUrl, ...(input.fallbackUrls ?? [])]
    .filter((url): url is string => Boolean(url?.trim()));
  for (const url of urls) {
    const normalized = normalizeMediaUrl(url);
    if (normalized) return `url:${normalized}`;
  }

  return null;
}

export function snapshotFromAvailability(
  mediaKey: string | null,
  availability?: MediaAvailabilityDocument,
): MediaAvailabilitySnapshot {
  if (!mediaKey) return DEFAULT_UNKNOWN_SNAPSHOT;
  if (!availability) {
    return { ...DEFAULT_UNKNOWN_SNAPSHOT, mediaAvailabilityKey: mediaKey };
  }

  return {
    mediaAvailabilityKey: mediaKey,
    availabilityStatus: availability.status,
    hasPlayableMedia: availability.status === 'available' && Boolean(availability.playableUrl),
    playableUrl: availability.playableUrl,
    mediaCheckedAt: availability.checkedAt,
    mediaRetryAfter: availability.retryAfter,
  };
}

export async function applyMediaAvailabilityIndexSettings(client: Meilisearch): Promise<void> {
  const task = await client.index(MEDIA_AVAILABILITY_INDEX_UID).updateSettings({
    filterableAttributes: ['id', 'mediaKey', 'status', 'checkedAt', 'retryAfter'],
    sortableAttributes: ['checkedAt', 'retryAfter', 'attempts'],
  });
  await client.tasks.waitForTask(task.taskUid);
}

export async function ensureMediaAvailabilityIndex(client: Meilisearch): Promise<Index> {
  try {
    await client.getIndex(MEDIA_AVAILABILITY_INDEX_UID);
  } catch {
    const task = await client.createIndex(MEDIA_AVAILABILITY_INDEX_UID, { primaryKey: 'id' });
    await client.tasks.waitForTask(task.taskUid);
  }

  await applyMediaAvailabilityIndexSettings(client);
  return client.index(MEDIA_AVAILABILITY_INDEX_UID);
}

function quoteFilterValue(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export async function fetchAvailabilityByKeys(
  availabilityIndex: Index,
  keys: string[],
): Promise<Map<string, MediaAvailabilityDocument>> {
  const uniqueKeys = [...new Set(keys.filter(Boolean))];
  const byKey = new Map<string, MediaAvailabilityDocument>();
  const chunkSize = 80;

  for (let i = 0; i < uniqueKeys.length; i += chunkSize) {
    const chunk = uniqueKeys.slice(i, i + chunkSize);
    const filter = chunk.map(key => `id = ${quoteFilterValue(key)}`).join(' OR ');
    const result = await availabilityIndex.search('', {
      limit: chunk.length,
      filter,
    });

    for (const hit of result.hits as MediaAvailabilityDocument[]) {
      byKey.set(hit.id, hit);
    }
  }

  return byKey;
}
