import { nip19 } from 'nostr-tools';

export type VideoRefLookup =
  | { type: 'event'; eventId: string; relays: string[] }
  | { type: 'address'; kind: number; pubkey: string; identifier: string; relays: string[] };

export type RecommendationSearchHit = {
  event_id?: string;
  kind?: number;
  identifier?: string | null;
  d_tag?: string | null;
  pubkey?: string;
  title?: string;
  summary?: string;
  content_preview?: string;
  created_at?: number;
  published_at?: number | null;
  duration?: number | null;
  tags?: string[];
  thumbnail?: string | null;
  thumbnailBlurhash?: string | null;
  videoUrl?: string | null;
  fallbackUrls?: string[];
  availabilityStatus?: 'unknown' | 'available' | 'unavailable' | 'error';
  hasPlayableMedia?: boolean;
  playableUrl?: string | null;
  mediaType?: 'video' | 'audio' | null;
  language?: string | null;
  languageSource?: 'tag' | 'caption' | 'local' | null;
  languageConfidence?: number | null;
  captionLanguages?: string[];
  contentWarning?: string | null;
  rankingScore?: number;
  reactionsCount?: number;
  commentsCount?: number;
  zapsCount?: number;
  _rankingScore?: number;
  playlistScore?: number;
};

export type RecommendationVideo = {
  id: string;
  kind: number;
  identifier?: string;
  pubkey: string;
  title: string;
  images: string[];
  urls: string[];
  duration: number;
  created_at: number;
  published_at?: number;
  link: string;
  type: 'videos' | 'shorts';
  mediaType?: 'video' | 'audio';
  language: string | null;
  languageSource: 'tag' | 'caption' | 'local' | null;
  languageConfidence: number | null;
  captionLanguages: string[];
  contentWarning: string | null;
  thumbnailVariants: Array<{
    url: string;
    fallbackUrls: string[];
    mediaType: 'image';
    blurhash?: string;
  }>;
  recommendationScore: number;
};

export type UserRecommendationProfile = {
  pubkey: string;
  computedAt: number;
  tagAffinity: Record<string, number>;
  authorAffinity: Record<string, number>;
  kindAffinity: Record<number, number>;
  likedEventIds: string[];
  likedAddresses: string[];
};

export type UserSignalEvent = {
  kind: number;
  tags: string[][];
};

const HEX_EVENT_ID_RE = /^[a-f0-9]{64}$/i;
const ADDRESSABLE_KINDS = new Set([34235, 34236]);

/**
 * TTL cache with an entry ceiling.
 *
 * Keys are attacker-influenced (video refs carry relay hints, `user` is any
 * pubkey), so an unbounded map is a memory-exhaustion primitive: expired
 * entries are only dropped when the *same* key is read again, which never
 * happens for one-shot random keys. Every insert therefore sweeps expired
 * entries and, failing that, evicts oldest-first (Map iterates in insertion
 * order) to stay under `maxEntries`.
 */
export class AsyncTtlCache<K, V> {
  private values = new Map<K, { value: V; expiresAt: number }>();
  private inFlight = new Map<K, Promise<V>>();
  private readonly maxEntries: number;

  constructor(maxEntries = 5_000) {
    this.maxEntries = Math.max(1, Math.floor(maxEntries));
  }

  get size(): number {
    return this.values.size;
  }

  get(key: K): V | undefined {
    const cached = this.values.get(key);
    if (!cached) return undefined;
    if (cached.expiresAt <= Date.now()) {
      this.values.delete(key);
      return undefined;
    }
    return cached.value;
  }

  set(key: K, value: V, ttlMs: number): void {
    if (!this.values.has(key)) this.evictFor(1);
    this.values.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  getOrCreate(key: K, factory: () => Promise<V>, ttlMs: number): Promise<V> {
    const cached = this.get(key);
    if (cached !== undefined) return Promise.resolve(cached);

    const pending = this.inFlight.get(key);
    if (pending) return pending;

    const promise = factory()
      .then(value => {
        this.set(key, value, ttlMs);
        return value;
      })
      .finally(() => {
        this.inFlight.delete(key);
      });
    this.inFlight.set(key, promise);
    return promise;
  }

  /** Make room for `incoming` new entries: expired first, then oldest-inserted. */
  private evictFor(incoming: number): void {
    if (this.values.size + incoming <= this.maxEntries) return;

    const now = Date.now();
    for (const [key, entry] of this.values) {
      if (entry.expiresAt <= now) this.values.delete(key);
    }

    for (const key of this.values.keys()) {
      if (this.values.size + incoming <= this.maxEntries) break;
      this.values.delete(key);
    }
  }
}

function clamp(value: number, min = 0, max = 1): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function getIdentifier(hit: RecommendationSearchHit): string | undefined {
  return hit.identifier ?? hit.d_tag ?? undefined;
}

export function parseVideoRef(videoRef: string): VideoRefLookup {
  const trimmed = videoRef.trim();
  if (HEX_EVENT_ID_RE.test(trimmed)) return { type: 'event', eventId: trimmed.toLowerCase(), relays: [] };

  const decoded = nip19.decode(trimmed);
  if (decoded.type === 'nevent') {
    return { type: 'event', eventId: decoded.data.id, relays: decoded.data.relays ?? [] };
  }
  if (decoded.type === 'naddr') {
    return {
      type: 'address',
      kind: decoded.data.kind,
      pubkey: decoded.data.pubkey,
      identifier: decoded.data.identifier,
      relays: decoded.data.relays ?? [],
    };
  }

  throw new Error('Unsupported videoRef. Expected nevent, naddr, or raw event id.');
}

export function normalizePubkey(input: string | undefined | null): string | null {
  if (!input) return null;
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (/^[a-f0-9]{64}$/i.test(trimmed)) return trimmed.toLowerCase();

  const decoded = nip19.decode(trimmed);
  if (decoded.type !== 'npub') throw new Error('User must be an npub or hex pubkey.');
  return decoded.data;
}

export function buildEventLink(hit: RecommendationSearchHit): string {
  const kind = hit.kind ?? 0;
  const pubkey = hit.pubkey ?? '';
  const eventId = hit.event_id ?? '';
  const identifier = getIdentifier(hit);

  if (ADDRESSABLE_KINDS.has(kind) && identifier) {
    return nip19.naddrEncode({ kind, pubkey, identifier });
  }
  return nip19.neventEncode({ kind, id: eventId, author: pubkey });
}

export function getVideoType(kind: number): 'videos' | 'shorts' {
  return kind === 22 || kind === 34236 ? 'shorts' : 'videos';
}

export function getEngagementScore(candidate: Pick<RecommendationSearchHit, 'reactionsCount' | 'commentsCount' | 'zapsCount'>): number {
  const weighted =
    (candidate.reactionsCount ?? 0) +
    (candidate.commentsCount ?? 0) * 2 +
    (candidate.zapsCount ?? 0) * 3;
  return clamp(1 - 1 / (1 + weighted / 10));
}

function tokenize(input: string): Set<string> {
  return new Set(input
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .map(token => token.trim())
    .filter(token => token.length >= 3));
}

export function contentSimilarity(source: RecommendationSearchHit, candidate: RecommendationSearchHit, meiliRankScore?: number): number {
  if (typeof meiliRankScore === 'number') return clamp(meiliRankScore);

  const sourceTags = new Set((source.tags ?? []).map(tag => tag.toLowerCase()));
  const candidateTags = new Set((candidate.tags ?? []).map(tag => tag.toLowerCase()));
  const tagUnion = new Set([...sourceTags, ...candidateTags]);
  const tagOverlap = tagUnion.size === 0
    ? 0
    : [...sourceTags].filter(tag => candidateTags.has(tag)).length / tagUnion.size;

  const sourceTokens = tokenize(`${source.title ?? ''} ${source.summary ?? ''} ${source.content_preview ?? ''}`);
  const candidateTokens = tokenize(`${candidate.title ?? ''} ${candidate.summary ?? ''} ${candidate.content_preview ?? ''}`);
  const tokenUnion = new Set([...sourceTokens, ...candidateTokens]);
  const tokenOverlap = tokenUnion.size === 0
    ? 0
    : [...sourceTokens].filter(token => candidateTokens.has(token)).length / tokenUnion.size;

  return clamp(tagOverlap * 0.65 + tokenOverlap * 0.35);
}

function normalizeWeightedMap(weights: Map<string, number>): Record<string, number> {
  const max = Math.max(0, ...weights.values());
  if (max <= 0) return {};
  return Object.fromEntries([...weights.entries()].map(([key, value]) => [key, clamp(value / max)]));
}

function signalWeight(kind: number): number {
  if (kind === 9735) return 3;
  if (kind === 7) return 1;
  if (kind === 1) return 0.5;
  return 0;
}

export function extractUserSignalRefs(events: UserSignalEvent[]): { eventIds: string[]; addresses: string[]; weights: Map<string, number> } {
  const eventIds = new Set<string>();
  const addresses = new Set<string>();
  const weights = new Map<string, number>();

  for (const event of events) {
    const weight = signalWeight(event.kind);
    if (weight <= 0) continue;

    for (const tag of event.tags) {
      if (tag[0] === 'e' && tag[1] && HEX_EVENT_ID_RE.test(tag[1])) {
        const id = tag[1].toLowerCase();
        eventIds.add(id);
        weights.set(`e:${id}`, (weights.get(`e:${id}`) ?? 0) + weight);
      }
      if (tag[0] === 'a' && tag[1]) {
        addresses.add(tag[1]);
        weights.set(`a:${tag[1]}`, (weights.get(`a:${tag[1]}`) ?? 0) + weight);
      }
    }
  }

  return {
    eventIds: [...eventIds],
    addresses: [...addresses],
    weights,
  };
}

function hitAddress(hit: RecommendationSearchHit): string | null {
  const identifier = getIdentifier(hit);
  return hit.kind && hit.pubkey && identifier ? `${hit.kind}:${hit.pubkey}:${identifier}` : null;
}

export function buildUserRecommendationProfile(
  pubkey: string,
  signalEvents: UserSignalEvent[],
  referencedVideos: RecommendationSearchHit[],
): UserRecommendationProfile {
  const { eventIds, addresses, weights } = extractUserSignalRefs(signalEvents);
  const tagWeights = new Map<string, number>();
  const authorWeights = new Map<string, number>();
  const kindWeights = new Map<string, number>();

  for (const video of referencedVideos) {
    const eventWeight = video.event_id ? weights.get(`e:${video.event_id}`) ?? 0 : 0;
    const address = hitAddress(video);
    const addressWeight = address ? weights.get(`a:${address}`) ?? 0 : 0;
    const weight = Math.max(eventWeight, addressWeight);
    if (weight <= 0) continue;

    for (const tag of video.tags ?? []) {
      const normalized = tag.toLowerCase();
      tagWeights.set(normalized, (tagWeights.get(normalized) ?? 0) + weight);
    }
    if (video.pubkey) {
      authorWeights.set(video.pubkey, (authorWeights.get(video.pubkey) ?? 0) + weight);
    }
    if (typeof video.kind === 'number') {
      const key = String(video.kind);
      kindWeights.set(key, (kindWeights.get(key) ?? 0) + weight);
    }
  }

  return {
    pubkey,
    computedAt: Date.now(),
    tagAffinity: normalizeWeightedMap(tagWeights),
    authorAffinity: normalizeWeightedMap(authorWeights),
    kindAffinity: Object.fromEntries(
      Object.entries(normalizeWeightedMap(kindWeights)).map(([key, value]) => [Number(key), value]),
    ),
    likedEventIds: eventIds,
    likedAddresses: addresses,
  };
}

export function getTagAffinity(candidate: RecommendationSearchHit, profile: UserRecommendationProfile | null): number {
  if (!profile) return 0;
  const tags = candidate.tags ?? [];
  if (tags.length === 0) return 0;
  const sum = tags.reduce((total, tag) => total + (profile.tagAffinity[tag.toLowerCase()] ?? 0), 0);
  return clamp(sum / tags.length);
}

export function getAuthorAffinity(candidate: RecommendationSearchHit, profile: UserRecommendationProfile | null): number {
  if (!profile || !candidate.pubkey) return 0;
  return clamp(profile.authorAffinity[candidate.pubkey] ?? 0);
}

export function getKindAffinity(candidate: RecommendationSearchHit, profile: UserRecommendationProfile | null): number {
  if (!profile || typeof candidate.kind !== 'number') return 0;
  return clamp(profile.kindAffinity[candidate.kind] ?? 0);
}

export function scoreRecommendation(input: {
  candidate: Pick<RecommendationSearchHit, 'rankingScore' | 'reactionsCount' | 'commentsCount' | 'zapsCount'>;
  contentSimilarity: number;
  tagAffinity?: number;
  authorAffinity?: number;
  kindAffinity?: number;
  playlistScore?: number;
  loggedIn: boolean;
}): number {
  const rankingScore = clamp(input.candidate.rankingScore ?? 0);
  const engagementScore = getEngagementScore(input.candidate);
  const contentSimilarity = clamp(input.contentSimilarity);
  const tagAffinity = clamp(input.tagAffinity ?? 0);
  const authorAffinity = clamp(input.authorAffinity ?? 0);
  const kindAffinity = clamp(input.kindAffinity ?? 0);
  const playlistScore = clamp(input.playlistScore ?? 0);

  if (!input.loggedIn) {
    // weights: contentSimilarity 0.70, rankingScore 0.15, engagementScore 0.10, playlistScore 0.05
    return clamp(contentSimilarity * 0.70 + rankingScore * 0.15 + engagementScore * 0.10 + playlistScore * 0.05);
  }

  // weights: contentSimilarity 0.48, tagAffinity 0.24, rankingScore 0.10,
  //          engagementScore 0.05, authorAffinity 0.05, kindAffinity 0.03, playlistScore 0.05
  return clamp(
    contentSimilarity * 0.48 +
    tagAffinity * 0.24 +
    rankingScore * 0.10 +
    engagementScore * 0.05 +
    authorAffinity * 0.05 +
    kindAffinity * 0.03 +
    playlistScore * 0.05,
  );
}

export function mapRecommendationHit(hit: RecommendationSearchHit, recommendationScore: number): RecommendationVideo {
  const id = hit.event_id ?? '';
  const kind = hit.kind ?? 0;
  const identifier = getIdentifier(hit);
  const pubkey = hit.pubkey ?? '';
  const thumbnail = hit.thumbnail ?? null;
  const videoUrl = hit.videoUrl ?? null;
  const playableUrl = hit.playableUrl ?? null;
  const fallbackUrls = Array.isArray(hit.fallbackUrls) ? hit.fallbackUrls : [];
  const urls = [playableUrl, videoUrl, ...fallbackUrls]
    .filter((url): url is string => Boolean(url))
    .filter((url, index, all) => all.indexOf(url) === index);
  const thumbnailVariants = thumbnail
    ? [{
        url: thumbnail,
        fallbackUrls: [],
        mediaType: 'image' as const,
        ...(hit.thumbnailBlurhash ? { blurhash: hit.thumbnailBlurhash } : {}),
      }]
    : [];

  return {
    id,
    kind,
    ...(identifier ? { identifier } : {}),
    pubkey,
    title: hit.title ?? 'Untitled',
    images: thumbnail ? [thumbnail] : [],
    urls,
    duration: hit.duration ?? 0,
    created_at: hit.created_at ?? 0,
    ...(hit.published_at != null ? { published_at: hit.published_at } : {}),
    link: buildEventLink(hit),
    type: getVideoType(kind),
    ...(hit.mediaType ? { mediaType: hit.mediaType } : {}),
    language: hit.language ?? null,
    languageSource: hit.languageSource ?? null,
    languageConfidence: hit.languageConfidence ?? null,
    captionLanguages: Array.isArray(hit.captionLanguages) ? hit.captionLanguages : [],
    contentWarning: hit.contentWarning ?? null,
    thumbnailVariants,
    recommendationScore,
  };
}
