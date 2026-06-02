import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { serve } from '@hono/node-server'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { nip19 } from 'nostr-tools'

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
  authorDisplayName?: string | null
}

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

function parseSearchFilters(query: {
  type?: string
  duration?: string
  date?: string
  feature?: string | string[]
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
    origins: Array.isArray(hit.origins) ? hit.origins : [],
  }
}

async function meiliSearch(params: {
  q: string
  limit: number
  offset?: number
  sort?: string[]
  filter?: string[]
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
    throw new Error(`MeiliSearch request failed with status ${res.status}`)
  }

  return res.json() as Promise<{
    hits: SearchHit[]
    estimatedTotalHits?: number
    totalHits?: number
  }>
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
    feature: c.req.queries('feature') ?? c.req.query('feature'),
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
  } catch {
    return c.json({ error: 'Search engine unavailable' }, 502)
  }
})

app.get('/api/search/suggest', async c => {
  const q = (c.req.query('q') ?? '').trim()
  if (!q) return c.json({ suggestions: [] })

  try {
    const result = await meiliSearch({ q, limit: 5, offset: 0 })
    const suggestions = [...new Set((result.hits ?? []).map(hit => (hit.title ?? '').trim()).filter(Boolean))]
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
