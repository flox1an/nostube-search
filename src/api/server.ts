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
  content?: string | null
  pubkey?: string
  kind?: number
  created_at?: number
  thumbnail?: string | null
  tags?: string[]
  d_tag?: string | null
  videoUrl?: string | null
  rankingScore?: number
  authorDisplayName?: string | null
}

const meiliUrl = process.env.MEILI_URL
const meiliMasterKey = process.env.MEILI_MASTER_KEY

if (!meiliUrl || !meiliMasterKey) {
  throw new Error('Missing MEILI_URL or MEILI_MASTER_KEY environment variable')
}

const app = new Hono()
const corsOrigin = process.env.CORS_ORIGIN ?? ''
if (corsOrigin) {
  app.use('/api/*', cors({ origin: corsOrigin }))
}
const uiPath = resolve(process.cwd(), 'src/api/public/index.html')
const ALLOWED_SORTS = new Set([
  'rankingScore:desc',
  'rankingScore:asc',
  'created_at:desc',
  'created_at:asc',
])

function toInt(input: string | undefined, fallback: number): number {
  const n = Number(input)
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback
}

function contentPreview(hit: SearchHit): string {
  const source = hit.summary ?? hit.content ?? ''
  return source.slice(0, 200)
}

function parseSort(input: string | undefined): string | undefined {
  if (!input) return undefined
  return ALLOWED_SORTS.has(input) ? input : undefined
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
    ? generateNostubeUrl({ event_id, pubkey, kind, d_tag: hit.d_tag })
    : ''

  return {
    event_id,
    title: hit.title ?? 'Untitled',
    content_preview: contentPreview(hit),
    pubkey,
    kind,
    created_at: hit.created_at ?? 0,
    thumbnail: hit.thumbnail ?? null,
    videoUrl: hit.videoUrl ?? null,
    tags: Array.isArray(hit.tags) ? hit.tags : [],
    authorDisplayName: hit.authorDisplayName ?? null,
    rankingScore: hit.rankingScore ?? 0,
    nostrUrl,
  }
}

async function meiliSearch(params: { q: string; limit: number; offset?: number; sort?: string[] }) {
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

  try {
    const result = await meiliSearch({ q, limit, offset, ...(sort ? { sort: [sort] } : {}) })
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
