export type AuthorProfile = {
  name?: string;
  display_name?: string;
  username?: string;
  about?: string;
  picture?: string;
  nip05?: string;
  lud16?: string;
};

export type RelatedCounts = {
  reactions: number;
  comments: number;
  zaps: number;
  notes: number;
};

export type RankingSignals = {
  authorProfileCompleteness: number;
  videoMetadataCompleteness: number;
  relatedEngagementScore: number;
  globalTrustScore: number;
  urlAvailabilityScore: number;
};

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

export function computeAuthorProfileCompleteness(profile?: AuthorProfile | null): number {
  if (!profile) return 0;

  let score = 0;
  if (profile.name?.trim()) score += 0.3;
  if (profile.display_name?.trim() || profile.username?.trim()) score += 0.2;
  if (profile.about?.trim()) score += 0.2;
  if (profile.picture?.trim()) score += 0.1;
  if (profile.nip05?.trim()) score += 0.1;
  if (profile.lud16?.trim()) score += 0.1;

  return clamp(score, 0, 1);
}

export function computeVideoMetadataCompleteness(doc: {
  title: string;
  summary: string;
  thumbnail: string | null;
  videoUrl: string | null;
  kind: number;
  width: number | null;
  height: number | null;
}): number {
  let score = 0;
  if (doc.title && doc.title.trim() !== 'Untitled') score += 0.2;
  if (doc.summary?.trim()) score += 0.2;
  if (doc.thumbnail?.trim()) score += 0.2;
  if (doc.videoUrl?.trim()) score += 0.2;
  if (doc.kind === 34235 || doc.kind === 34236) score += 0.1;
  if (doc.width && doc.height) score += 0.1;

  return clamp(score, 0, 1);
}

export function computeRelatedEngagementScore(counts: RelatedCounts): number {
  const weighted = counts.reactions * 1 + counts.comments * 2 + counts.zaps * 3 + counts.notes * 0.5;
  const score = 1 - 1 / (1 + weighted / 10);
  return clamp(score, 0, 1);
}

export function computeUrlAvailabilityScore(available: number, total: number): number {
  if (total <= 0) return 0;
  return clamp(available / total, 0, 1);
}

export function computeRankingScore(signals: RankingSignals): number {
  const score =
    signals.authorProfileCompleteness * 0.25 +
    signals.videoMetadataCompleteness * 0.25 +
    signals.relatedEngagementScore * 0.2 +
    clamp(signals.globalTrustScore, 0, 1) * 0.2 +
    signals.urlAvailabilityScore * 0.1;

  return clamp(score, 0, 1);
}
