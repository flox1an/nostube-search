import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { serve } from '@hono/node-server'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { nip19, SimplePool, type Event } from 'nostr-tools'
import {
  AsyncTtlCache,
  buildUserRecommendationProfile,
  contentSimilarity,
  extractUserSignalRefs,
  getAuthorAffinity,
  getKindAffinity,
  getTagAffinity,
  mapRecommendationHit,
  normalizePubkey,
  parseVideoRef,
  scoreRecommendation,
  type RecommendationSearchHit,
  type UserRecommendationProfile,
} from './recommendations.js'
import { filterVerifiedEvents } from '../nostr-events.js'

type SearchHit = {
  event_id?: string
  title?: string
  summary?: string
  content_preview?: string
  content?: string | null
  pubkey?: string
  npub?: string
  kind?: number
  created_at?: number
  published_at?: number | null
  effectivePublishedAt?: number
  duration?: number | null
  thumbnail?: string | null
  thumbnailBlurhash?: string | null
  tags?: string[]
  d_tag?: string | null
  identifier?: string | null
  videoUrl?: string | null
  mimeType?: string | null
  mediaType?: 'video' | 'audio' | null
  dimensions?: string | null
  height?: number | null
  isHd?: boolean
  isShort?: boolean
  isVideo?: boolean
  isNostrNative?: boolean
  size?: number | null
  hash?: string | null
  fallbackUrls?: string[]
  mediaAvailabilityKey?: string | null
  availabilityStatus?: 'unknown' | 'available' | 'unavailable' | 'error'
  hasPlayableMedia?: boolean
  playableUrl?: string | null
  mediaCheckedAt?: number | null
  mediaRetryAfter?: number | null
  contentWarning?: string | null
  textTracks?: Array<{ url?: string; lang?: string | null }>
  hasCaptions?: boolean
  origins?: Array<{
    platform?: string | null
    externalId?: string | null
    originalUrl?: string | null
    metadata?: Record<string, string>
  }>
  nostrUrl?: string
  rankingScore?: number
  reactionsCount?: number
  commentsCount?: number
  zapsCount?: number
  _rankingScore?: number
  authorDisplayName?: string | null
}

type VideoLookup = ReturnType<typeof parseVideoRef>

const meiliUrl = process.env.MEILI_URL
const meiliMasterKey = process.env.MEILI_MASTER_KEY

if (!meiliUrl || !meiliMasterKey) {
  throw new Error('Missing MEILI_URL or MEILI_MASTER_KEY environment variable')
}

const app = new Hono()
const corsOrigin = process.env.CORS_ORIGIN?.replace(/^['"]|['"]$/g, '') ?? ''
if (corsOrigin) {
  app.use('/api/*', cors({ origin: corsOrigin === '*' ? '*' : corsOrigin }))
}
const uiPath = resolve(process.cwd(), 'src/api/public/index.html')
const ALLOWED_RAW_SORTS = new Set([
  'rankingScore:desc',
  'rankingScore:asc',
  'created_at:desc',
  'created_at:asc',
  'published_at:desc',
  'published_at:asc',
  'effectivePublishedAt:desc',
  'effectivePublishedAt:asc',
  'duration:desc',
  'duration:asc',
])
const SORT_ALIASES = new Map([
  ['relevance', undefined],
  ['newest', 'effectivePublishedAt:desc'],
  ['oldest', 'effectivePublishedAt:asc'],
  ['duration', 'duration:desc'],
])
const TYPE_FILTERS = new Map([
  ['videos', 'isVideo = true'],
  ['shorts', 'isShort = true'],
  ['audio', 'mediaType = "audio"'],
])
const DURATION_FILTERS = new Map([
  ['short', 'duration < 180'],
  ['medium', 'duration >= 180 AND duration <= 1200'],
  ['long', 'duration > 1200'],
])
const FEATURE_FILTERS = new Map([
  ['captions', 'hasCaptions = true'],
  ['hd', 'isHd = true'],
  ['nostr', 'isNostrNative = true'],
])
const SEARCHABLE_VIDEO_KINDS = new Set([21, 22, 34235, 34236])

function toInt(input: string | undefined, fallback: number): number {
  const n = Number(input)
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback
}

function contentPreview(hit: SearchHit): string {
  const source = hit.content_preview ?? hit.summary ?? hit.content ?? ''
  return source.slice(0, 200)
}

function parseSort(input: string | undefined): string | undefined {
  if (!input) return undefined
  if (SORT_ALIASES.has(input)) return SORT_ALIASES.get(input)
  return ALLOWED_RAW_SORTS.has(input) ? input : undefined
}

function unixNowSeconds(): number {
  return Math.floor(Date.now() / 1000)
}

function parseDateFilter(input: string | undefined): string | undefined {
  if (!input || input === 'any') return undefined
  const now = unixNowSeconds()
  const day = 86_400
  const thresholds: Record<string, number> = {
    today: now - day,
    week: now - 7 * day,
    month: now - 30 * day,
    year: now - 365 * day,
  }
  const threshold = thresholds[input]
  return threshold ? `effectivePublishedAt >= ${threshold}` : undefined
}

function parseKindFilters(input: string | string[] | undefined): string | undefined {
  const values = Array.isArray(input)
    ? input.flatMap(value => value.split(','))
    : typeof input === 'string'
      ? input.split(',')
      : []

  const kinds = [...new Set(values
    .map(value => Number(value.trim()))
    .filter(kind => Number.isInteger(kind) && SEARCHABLE_VIDEO_KINDS.has(kind))
  )]

  if (kinds.length === 0) return undefined
  if (kinds.length === 1) return `kind = ${kinds[0]}`
  return `(${kinds.map(kind => `kind = ${kind}`).join(' OR ')})`
}

function parseSearchFilters(query: {
  type?: string
  duration?: string
  date?: string
  available?: string
  feature?: string | string[]
  kinds?: string | string[]
}): string[] {
  const filters: string[] = []

  if (query.type && query.type !== 'all') {
    const filter = TYPE_FILTERS.get(query.type)
    if (filter) filters.push(filter)
  }

  if (query.duration && query.duration !== 'any') {
    const filter = DURATION_FILTERS.get(query.duration)
    if (filter) filters.push(filter)
  }

  const dateFilter = parseDateFilter(query.date)
  if (dateFilter) filters.push(dateFilter)

  if (query.available === 'true') {
    filters.push('hasPlayableMedia = true')
  } else if (query.available === 'exclude-unavailable') {
    filters.push('availabilityStatus != "unavailable"')
  }

  const kindFilter = parseKindFilters(query.kinds)
  if (kindFilter) filters.push(kindFilter)

  const features = Array.isArray(query.feature)
    ? query.feature.flatMap(feature => feature.split(','))
    : typeof query.feature === 'string'
      ? query.feature.split(',')
      : []

  for (const feature of features) {
    const filter = FEATURE_FILTERS.get(feature.trim())
    if (filter) filters.push(filter)
  }

  return filters
}

function generateNostubeUrl(hit: {
  event_id: string
  pubkey: string
  kind: number
  d_tag?: string | null
}): string {
  const isHorizontal = hit.kind === 21 || hit.kind === 34235
  const baseUrl = isHorizontal ? 'https://nostu.be/v' : 'https://nostu.be/short'
  const author = hit.pubkey
  const video = hit.event_id

  // Parameterized replaceable events (34235, 34236) use naddr
  if (hit.kind >= 30000 && hit.kind < 40000 && hit.d_tag != null) {
    const naddr = nip19.naddrEncode({
      identifier: hit.d_tag,
      pubkey: author,
      kind: hit.kind,
    })
    return `${baseUrl}/${naddr}?author=${author}&video=${video}`
  }

  // Regular events (21, 22) use nevent
  const nevent = nip19.neventEncode({ id: video, author })
  if (hit.kind === 21) {
    return `${baseUrl}/${nevent}`
  }
  return `${baseUrl}/${nevent}?author=${author}&video=${video}`
}

function mapHit(hit: SearchHit) {
  const event_id = hit.event_id ?? ''
  const pubkey = hit.pubkey ?? ''
  const kind = hit.kind ?? 0

  const nostrUrl = event_id && pubkey
    ? hit.nostrUrl ?? generateNostubeUrl({ event_id, pubkey, kind, d_tag: hit.d_tag ?? hit.identifier })
    : ''

  return {
    event_id,
    title: hit.title ?? 'Untitled',
    content_preview: contentPreview(hit),
    pubkey,
    npub: hit.npub ?? null,
    kind,
    created_at: hit.created_at ?? 0,
    published_at: hit.published_at ?? null,
    duration: hit.duration ?? null,
    thumbnail: hit.thumbnail ?? null,
    thumbnailBlurhash: hit.thumbnailBlurhash ?? null,
    videoUrl: hit.videoUrl ?? null,
    tags: Array.isArray(hit.tags) ? hit.tags : [],
    authorDisplayName: hit.authorDisplayName ?? null,
    rankingScore: hit.rankingScore ?? 0,
    nostrUrl,
    contentWarning: hit.contentWarning ?? null,
    textTracks: Array.isArray(hit.textTracks)
      ? hit.textTracks.map(track => ({ url: track.url ?? '', lang: track.lang ?? null })).filter(track => track.url)
      : [],
    hasCaptions: hit.hasCaptions ?? false,
    dimensions: hit.dimensions ?? null,
    height: hit.height ?? null,
    isHd: hit.isHd ?? false,
    isShort: hit.isShort ?? false,
    isVideo: hit.isVideo ?? false,
    isNostrNative: hit.isNostrNative ?? false,
    mimeType: hit.mimeType ?? null,
    mediaType: hit.mediaType ?? null,
    size: hit.size ?? null,
    hash: hit.hash ?? null,
    fallbackUrls: Array.isArray(hit.fallbackUrls) ? hit.fallbackUrls : [],
    mediaAvailabilityKey: hit.mediaAvailabilityKey ?? null,
    availabilityStatus: hit.availabilityStatus ?? 'unknown',
    hasPlayableMedia: hit.hasPlayableMedia ?? false,
    playableUrl: hit.playableUrl ?? null,
    mediaCheckedAt: hit.mediaCheckedAt ?? null,
    mediaRetryAfter: hit.mediaRetryAfter ?? null,
    origins: Array.isArray(hit.origins) ? hit.origins : [],
  }
}

async function meiliSearch(params: {
  q: string
  limit: number
  offset?: number
  sort?: string[]
  filter?: string[]
  showRankingScore?: boolean
}) {
  const res = await fetch(`${meiliUrl}/indexes/videos/search`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${meiliMasterKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(params),
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`MeiliSearch request failed with status ${res.status}: ${body}`)
  }

  return res.json() as Promise<{
    hits: SearchHit[]
    estimatedTotalHits?: number
    totalHits?: number
  }>
}

function quoteFilterValue(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

function sourceRelaysFromEnv(): string[] {
  const raw = process.env.NOSTR_SOURCE_RELAYS ?? 'wss://relay.nostu.be'
  return raw.split(',').map(relay => relay.trim()).filter(Boolean)
}

async function findVideoByRef(videoRef: string): Promise<SearchHit | null> {
  const lookup = parseVideoRef(videoRef)

  if (lookup.type === 'event') {
    const filter = [`event_id = ${quoteFilterValue(lookup.eventId)}`]
    const result = await meiliSearch({ q: '', limit: 1, offset: 0, filter })
    return result.hits[0] ?? await fetchVideoFromRelayHints(lookup)
  }

  // Try identifier first (current schema), then d_tag (pre-June-2 schema)
  const identifierFilter = [
    `kind = ${lookup.kind}`,
    `pubkey = ${quoteFilterValue(lookup.pubkey)}`,
    `identifier = ${quoteFilterValue(lookup.identifier)}`,
  ]
  const byIdentifier = await meiliSearch({ q: '', limit: 1, offset: 0, filter: identifierFilter })
  if (byIdentifier.hits[0]) return byIdentifier.hits[0]

  const dTagFilter = [
    `kind = ${lookup.kind}`,
    `pubkey = ${quoteFilterValue(lookup.pubkey)}`,
    `d_tag = ${quoteFilterValue(lookup.identifier)}`,
  ]
  const byDTag = await meiliSearch({ q: '', limit: 1, offset: 0, filter: dTagFilter })
  return byDTag.hits[0] ?? await fetchVideoFromRelayHints(lookup)
}

function firstTagValue(tags: string[][], tagName: string): string | null {
  const tag = tags.find(entry => entry[0] === tagName && typeof entry[1] === 'string')
  return tag?.[1] ?? null
}

function parsePositiveInt(value: string | null): number | null {
  if (!value) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : null
}

function parseImetaForSource(tags: string[][]): Pick<SearchHit, 'thumbnail' | 'thumbnailBlurhash' | 'videoUrl' | 'mediaType'> {
  let thumbnail: string | null = null
  let thumbnailBlurhash: string | null = null
  let videoUrl: string | null = null
  let mediaType: 'video' | 'audio' | null = null

  for (const imeta of tags.filter(tag => tag[0] === 'imeta')) {
    const values = new Map<string, string>()
    for (const part of imeta.slice(1)) {
      const firstSpace = part.indexOf(' ')
      if (firstSpace === -1) continue
      values.set(part.slice(0, firstSpace), part.slice(firstSpace + 1).trim())
    }

    if (!thumbnail && values.get('image')) thumbnail = values.get('image') ?? null
    if (!thumbnailBlurhash && values.get('blurhash')) thumbnailBlurhash = values.get('blurhash') ?? null

    const url = values.get('url')
    const mime = values.get('m')
    if (!videoUrl && url && mime?.startsWith('video/')) {
      videoUrl = url
      mediaType = 'video'
    }
    if (!videoUrl && url && mime?.startsWith('audio/')) {
      videoUrl = url
      mediaType = 'audio'
    }
  }

  return { thumbnail, thumbnailBlurhash, videoUrl, mediaType }
}

function eventToSearchHit(event: Event): SearchHit {
  const tags = event.tags.filter((tag): tag is string[] =>
    Array.isArray(tag) && tag.every(item => typeof item === 'string'),
  )
  const imeta = parseImetaForSource(tags)
  const thumbnail = firstTagValue(tags, 'thumb') ?? firstTagValue(tags, 'image') ?? imeta.thumbnail
  const videoUrl = imeta.videoUrl ?? firstTagValue(tags, 'url')
  const summary = firstTagValue(tags, 'summary') ?? firstTagValue(tags, 'alt') ?? event.content ?? ''
  const publishedAt = parsePositiveInt(firstTagValue(tags, 'published_at'))
  const kind = event.kind

  return {
    event_id: event.id,
    pubkey: event.pubkey,
    kind,
    created_at: event.created_at,
    published_at: publishedAt,
    effectivePublishedAt: publishedAt ?? event.created_at,
    identifier: firstTagValue(tags, 'd'),
    d_tag: firstTagValue(tags, 'd'),
    title: firstTagValue(tags, 'title') ?? 'Untitled',
    summary,
    content_preview: summary.slice(0, 200),
    content: event.content,
    tags: tags.filter(tag => tag[0] === 't' && tag[1]).map(tag => tag[1]),
    duration: parsePositiveInt(firstTagValue(tags, 'duration')),
    thumbnail,
    thumbnailBlurhash: imeta.thumbnailBlurhash,
    videoUrl,
    mediaType: imeta.mediaType ?? (videoUrl ? 'video' : null),
    isShort: kind === 22 || kind === 34236,
    isVideo: kind === 21 || kind === 34235,
    contentWarning: firstTagValue(tags, 'content-warning'),
    rankingScore: 0,
    reactionsCount: 0,
    commentsCount: 0,
    zapsCount: 0,
  }
}

async function fetchVideoFromRelayHints(lookup: VideoLookup): Promise<SearchHit | null> {
  if (lookup.relays.length === 0) return null

  return relayHintVideoCache.getOrCreate(
    videoLookupCacheKey(lookup),
    () => fetchVideoFromRelayHintsUncached(lookup),
    getPositiveEnvMs('RECOMMENDATION_REF_CACHE_TTL_MS', 5 * 60_000),
  )
}

function videoLookupCacheKey(lookup: VideoLookup): string {
  const relayKey = [...lookup.relays].sort().join(',')
  if (lookup.type === 'event') return `event:${lookup.eventId}:${relayKey}`
  return `addr:${lookup.kind}:${lookup.pubkey}:${lookup.identifier}:${relayKey}`
}

const relayHintVideoCache = new AsyncTtlCache<string, SearchHit | null>()

function getPositiveEnvMs(name: string, fallback: number): number {
  const value = Number(process.env[name])
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback
}

async function fetchVideoFromRelayHintsUncached(lookup: VideoLookup): Promise<SearchHit | null> {
  const pool = new SimplePool({ enablePing: false, enableReconnect: false })
  const maxWait = getPositiveEnvMs('RECOMMENDATION_REF_MAX_WAIT_MS', 5_000)

  try {
    const filter = lookup.type === 'event'
      ? [{ ids: [lookup.eventId], limit: 1 }]
      : [{ kinds: [lookup.kind], authors: [lookup.pubkey], '#d': [lookup.identifier], limit: 1 }]
    const events = await pool.querySync(
      lookup.relays,
      filter[0],
      { maxWait, label: 'nostube-search-recommendation-ref' },
    )
    const verifiedEvents = filterVerifiedEvents(events, 'recommendation-ref')
    return verifiedEvents[0] ? eventToSearchHit(verifiedEvents[0]) : null
  } finally {
    pool.destroy()
  }
}

function recommendationQuery(source: SearchHit): string {
  const tags = Array.isArray(source.tags) ? source.tags : []
  // Repeat title + tags so MeiliSearch gives them more signal weight; secondary
  // content is capped so content_preview noise doesn't dilute the primary terms.
  const primary = [source.title, ...tags, source.title, ...tags].filter(Boolean).join(' ')
  const secondary = [source.summary, source.content_preview]
    .filter(Boolean)
    .join(' ')
    .slice(0, 150)
  return [primary, secondary].filter(Boolean).join(' ').slice(0, 600)
}

function candidateFilters(source: SearchHit): string[] {
  // Derive candidate type from kind (always present) rather than isVideo/isShort
  // which may not be set on documents indexed before the June-2026 schema update.
  const kind = source.kind ?? 0
  if (kind === 22 || kind === 34236) return ['(kind = 22 OR kind = 34236)']
  if (kind === 21 || kind === 34235) return ['(kind = 21 OR kind = 34235)']
  if (source.mediaType) return [`mediaType = ${quoteFilterValue(source.mediaType)}`]
  return []
}

function recommendationCandidateFilters(source: SearchHit): string[] {
  return candidateFilters(source)
}

function excludeKnownUnavailableHits(hits: SearchHit[]): SearchHit[] {
  return hits.filter(hit => hit.availabilityStatus !== 'unavailable')
}

function addressKey(hit: SearchHit): string | null {
  const identifier = hit.identifier ?? hit.d_tag
  if (!hit.kind || !hit.pubkey || !identifier) return null
  return `${hit.kind}:${hit.pubkey}:${identifier}`
}

function isSameVideo(a: SearchHit, b: SearchHit): boolean {
  if (a.event_id && b.event_id && a.event_id === b.event_id) return true
  const aAddress = addressKey(a)
  const bAddress = addressKey(b)
  return Boolean(aAddress && bAddress && aAddress === bAddress)
}

function filterAndDedupeCandidates(source: SearchHit, candidates: SearchHit[], excludeContentWarnings: boolean): SearchHit[] {
  const seen = new Set<string>()
  const out: SearchHit[] = []

  for (const candidate of candidates) {
    if (isSameVideo(source, candidate)) continue
    if (excludeContentWarnings && candidate.contentWarning) continue

    const key = addressKey(candidate) ?? candidate.event_id
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push(candidate)
  }

  return out
}

async function fetchUserSignalEvents(pubkey: string): Promise<Event[]> {
  const pool = new SimplePool({ enablePing: false, enableReconnect: false })
  const maxWait = Number(process.env.RECOMMENDATION_SIGNAL_MAX_WAIT_MS) || 5_000
  const limit = Number(process.env.RECOMMENDATION_SIGNAL_LIMIT) || 300

  try {
    const events = await pool.querySync(
      sourceRelaysFromEnv(),
      { authors: [pubkey], kinds: [7, 1, 9735], limit },
      { maxWait, label: 'nostube-search-recommendation-signals' },
    )
    return filterVerifiedEvents(events, 'recommendation-signals')
  } finally {
    pool.destroy()
  }
}

function eventIdFilter(eventIds: string[]): string | null {
  if (eventIds.length === 0) return null
  return `(${eventIds.map(id => `event_id = ${quoteFilterValue(id)}`).join(' OR ')})`
}

function addressFilter(addresses: string[]): string | null {
  const filters = addresses
    .map(address => {
      const [kind, pubkey, ...identifierParts] = address.split(':')
      const identifier = identifierParts.join(':')
      const numericKind = Number(kind)
      if (!Number.isInteger(numericKind) || !pubkey || !identifier) return null
      return `(kind = ${numericKind} AND pubkey = ${quoteFilterValue(pubkey)} AND identifier = ${quoteFilterValue(identifier)})`
    })
    .filter((filter): filter is string => Boolean(filter))

  return filters.length > 0 ? `(${filters.join(' OR ')})` : null
}

async function searchReferenceVideos(filter: string | null, limit: number): Promise<SearchHit[]> {
  if (!filter) return []
  const result = await meiliSearch({ q: '', limit, offset: 0, filter: [filter] })
  return result.hits ?? []
}

const userProfileCache = new AsyncTtlCache<string, UserRecommendationProfile | null>()

async function getUserRecommendationProfile(pubkey: string): Promise<UserRecommendationProfile | null> {
  const cached = userProfileCache.get(pubkey)
  if (cached !== undefined) return cached

  const ttlMs = getPositiveEnvMs('USER_RECOMMENDATION_PROFILE_TTL_MS', 30 * 60_000)
  const shouldBlock = process.env.RECOMMENDATION_BLOCK_ON_PROFILE_MISS === 'true'
  if (shouldBlock) {
    try {
      return await userProfileCache.getOrCreate(pubkey, () => buildUserRecommendationProfileFromRelays(pubkey), ttlMs)
    } catch (err) {
      console.warn('[API] Recommendation profile unavailable; using anonymous ranking:', err)
      return null
    }
  }

  void userProfileCache
    .getOrCreate(pubkey, () => buildUserRecommendationProfileFromRelays(pubkey), ttlMs)
    .catch(err => {
      console.warn('[API] Recommendation profile warmup failed:', err)
    })

  return null
}

async function buildUserRecommendationProfileFromRelays(pubkey: string): Promise<UserRecommendationProfile> {
  const signals = await fetchUserSignalEvents(pubkey)
  const refs = extractUserSignalRefs(signals)
  const [eventVideos, addressVideos] = await Promise.all([
    searchReferenceVideos(eventIdFilter(refs.eventIds.slice(0, 100)), 100),
    searchReferenceVideos(addressFilter(refs.addresses.slice(0, 100)), 100),
  ])
  return buildUserRecommendationProfile(pubkey, signals, [...eventVideos, ...addressVideos])
}

async function relatedVideos(input: {
  videoRef: string
  user?: string | null
  limit: number
  excludeContentWarnings: boolean
}) {
  const source = await findVideoByRef(input.videoRef)
  if (!source) return null

  const candidateLimit = Math.max(input.limit * 4, input.limit)
  const typeFilters = recommendationCandidateFilters(source)

  // Stage 1: similarity search — MeiliSearch stops at the first term combination
  // that finds any results (matchingStrategy "last"), so niche/foreign content
  // may only yield a handful of hits.
  const simResult = await meiliSearch({
    q: recommendationQuery(source),
    limit: candidateLimit,
    offset: 0,
    filter: typeFilters,
    showRankingScore: true,
  })

  const userPubkey = normalizePubkey(input.user)
  const profile = userPubkey ? await getUserRecommendationProfile(userPubkey) : null
  const loggedIn = Boolean(profile)

  const allHits: SearchHit[] = [...(simResult.hits ?? [])]

  // Stage 2: if the similarity search came up short, pull in a few videos from the
  // same author so their other work can appear in the sidebar. Capped to ~30% of the
  // requested limit so stage 3 (popular/diverse) always has room to contribute — without
  // this cap an unindexed source video would fill the entire result set with same-author
  // content and stage 3 would never fire.
  const authorBackfillLimit = Math.max(2, Math.ceil(input.limit * 0.4))
  if (allHits.length < candidateLimit && source.pubkey) {
    const authorFilters = [
      `pubkey = ${quoteFilterValue(source.pubkey)}`,
      ...typeFilters,
    ]
    const authorResult = await meiliSearch({
      q: '',
      limit: authorBackfillLimit,
      offset: 0,
      filter: authorFilters,
      sort: ['rankingScore:desc'],
      showRankingScore: true,
    })
    // Strip _rankingScore so fill candidates are scored by tag/token overlap,
    // not by MeiliSearch's empty-query score of 1.0.
    for (const hit of authorResult.hits ?? []) allHits.push({ ...hit, _rankingScore: undefined })
  }

  let candidates = filterAndDedupeCandidates(source, allHits, input.excludeContentWarnings)

  // Stage 3: if still under limit, pad with popular videos of the same type.
  if (candidates.length < input.limit) {
    const popularResult = await meiliSearch({
      q: '',
      limit: candidateLimit,
      offset: 0,
      filter: typeFilters,
      sort: ['rankingScore:desc'],
      showRankingScore: true,
    })
    for (const hit of popularResult.hits ?? []) allHits.push({ ...hit, _rankingScore: undefined })
    candidates = filterAndDedupeCandidates(source, allHits, input.excludeContentWarnings)
  }

  const sorted = excludeKnownUnavailableHits(candidates)
    .map(candidate => {
      const score = scoreRecommendation({
        candidate,
        contentSimilarity: contentSimilarity(source, candidate, candidate._rankingScore),
        tagAffinity: getTagAffinity(candidate, profile),
        authorAffinity: getAuthorAffinity(candidate, profile),
        kindAffinity: getKindAffinity(candidate, profile),
        loggedIn,
      })
      return { candidate, score }
    })
    .sort((a, b) => b.score - a.score)

  // Diversity pass: limit same-source-author videos to ~30% of results so unindexed
  // videos with no similarity signal don't flood the list with one author's content.
  const maxSameAuthor = Math.max(2, Math.floor(input.limit * 0.3))
  const ranked: typeof sorted = []
  const deferred: typeof sorted = []
  let sameAuthorCount = 0
  for (const item of sorted) {
    if (ranked.length >= input.limit) break
    if (item.candidate.pubkey === source.pubkey && sameAuthorCount >= maxSameAuthor) {
      deferred.push(item)
    } else {
      if (item.candidate.pubkey === source.pubkey) sameAuthorCount++
      ranked.push(item)
    }
  }
  // Fill any remaining slots with deferred same-author candidates
  for (const item of deferred) {
    if (ranked.length >= input.limit) break
    ranked.push(item)
  }

  return ranked.map(({ candidate, score }) => mapRecommendationHit(candidate as RecommendationSearchHit, score))
}

app.get('/api/search', async c => {
  const q = (c.req.query('q') ?? '').trim()
  if (!q) return c.json({ error: 'Missing query parameter q' }, 400)

  const limit = toInt(c.req.query('limit'), 20)
  const offset = toInt(c.req.query('offset'), 0)
  const sort = parseSort(c.req.query('sort'))
  const filter = parseSearchFilters({
    type: c.req.query('type'),
    duration: c.req.query('duration'),
    date: c.req.query('date'),
    available: c.req.query('available'),
    feature: c.req.queries('feature') ?? c.req.query('feature'),
    kinds: c.req.queries('kinds') ?? c.req.query('kinds'),
  })

  try {
    const result = await meiliSearch({
      q,
      limit,
      offset,
      ...(sort ? { sort: [sort] } : {}),
      ...(filter.length > 0 ? { filter } : {}),
    })
    const hits = (result.hits ?? []).map(mapHit)
    const total = result.estimatedTotalHits ?? result.totalHits ?? hits.length

    return c.json({ hits, total, limit, offset })
  } catch (err) {
    console.error('[API] Search request failed:', err)
    return c.json({ error: 'Search engine unavailable' }, 502)
  }
})

app.get('/api/search/suggest', async c => {
  const q = (c.req.query('q') ?? '').trim()
  if (!q) return c.json({ suggestions: [] })

  try {
    const result = await meiliSearch({ q, limit: 10, offset: 0 })
    const suggestions = [...new Set(excludeKnownUnavailableHits(result.hits ?? []).map(hit => (hit.title ?? '').trim()).filter(Boolean))]
      .slice(0, 5)
    return c.json({ suggestions })
  } catch {
    return c.json({ error: 'Search engine unavailable' }, 502)
  }
})

app.get('/api/search/completion', async c => {
  const prefix = (c.req.query('prefix') ?? '').trim().toLowerCase()
  if (!prefix || prefix.length < 1) return c.json({ completions: [] })

  try {
    const res = await fetch(`${meiliUrl}/indexes/terms/search`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${meiliMasterKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        q: prefix,
        limit: 10,
        attributesToRetrieve: ['word'],
      }),
    })

    if (!res.ok) throw new Error(`MeiliSearch request failed with status ${res.status}`)
    const data = await res.json() as { hits: Array<{ word: string }> }
    const completions = data.hits.map(h => h.word)
    return c.json({ completions })
  } catch {
    return c.json({ error: 'Search engine unavailable' }, 502)
  }
})

app.post('/api/recommendations/related', async c => {
  let body: {
    videoRef?: unknown
    user?: unknown
    limit?: unknown
    excludeContentWarnings?: unknown
  }

  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400)
  }

  if (typeof body.videoRef !== 'string' || !body.videoRef.trim()) {
    return c.json({ error: 'Missing videoRef' }, 400)
  }

  const rawLimit = typeof body.limit === 'number' || typeof body.limit === 'string'
    ? String(body.limit)
    : undefined
  const limit = Math.max(1, Math.min(toInt(rawLimit, 20), 50))
  const excludeContentWarnings = typeof body.excludeContentWarnings === 'boolean'
    ? body.excludeContentWarnings
    : true

  try {
    const hits = await relatedVideos({
      videoRef: body.videoRef,
      user: typeof body.user === 'string' ? body.user : null,
      limit,
      excludeContentWarnings,
    })

    if (!hits) return c.json({ error: 'Video not found' }, 404)
    return c.json({ hits, total: hits.length, limit })
  } catch (err) {
    if (err instanceof Error && (
      err.message.startsWith('Unsupported videoRef') ||
      err.message.startsWith('User must')
    )) {
      return c.json({ error: err.message }, 400)
    }
    console.error('[API] Related recommendations request failed:', err)
    return c.json({ error: 'Recommendations unavailable' }, 502)
  }
})

app.get('/health', async c => {
  try {
    const res = await fetch(`${meiliUrl}/health`, {
      headers: { Authorization: `Bearer ${meiliMasterKey}` },
    })
    if (!res.ok) return c.json({ ok: false }, 502)
    return c.json({ ok: true })
  } catch {
    return c.json({ ok: false }, 502)
  }
})

app.get('/', async c => {
  try {
    const html = await readFile(uiPath, 'utf-8')
    return c.html(html)
  } catch {
    return c.text('UI not found', 500)
  }
})

const port = Number(process.env.PORT ?? 3001)
serve({ fetch: app.fetch, port })
console.log(`Search API running on http://localhost:${port}`)
