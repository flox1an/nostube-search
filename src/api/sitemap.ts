import type { Hono } from 'hono'
import { nip19 } from 'nostr-tools'
import { blockedAuthorPubkeys } from './blocked-authors.js'

const DEFAULT_SITE_ORIGIN = 'https://nostu.be'
const DEFAULT_MAX_URLS = 50_000
const DEFAULT_MAX_AUTHORS = 5_000
const DEFAULT_AUTHOR_MIN_VIDEOS = 10
const PAGE_SIZE = 1_000
const CACHE_TTL_MS = 6 * 60 * 60 * 1000

export type SitemapVideoHit = {
  event_id?: string
  pubkey?: string
  kind?: number
  d_tag?: string | null
  identifier?: string | null
  nostrUrl?: string | null
  title?: string | null
  summary?: string | null
  content_preview?: string | null
  thumbnail?: string | null
  videoUrl?: string | null
  playableUrl?: string | null
  mimeType?: string | null
  duration?: number | null
  published_at?: number | null
  created_at?: number | null
  effectivePublishedAt?: number | null
  contentWarning?: string | null
  hasPlayableMedia?: boolean
}

export type SitemapAuthorHit = {
  pubkey?: string
  npub?: string
  name?: string | null
  display_name?: string | null
  username?: string | null
  about?: string | null
  videoCount?: number
  globalTrustScore?: number
  updatedAt?: number
}

type MeiliSearchResponse<T> = {
  hits?: T[]
  estimatedTotalHits?: number
  totalHits?: number
}

type SitemapEntry = {
  loc: string
  lastmod?: string
  video?: {
    title: string
    description: string
    thumbnail: string
    contentUrl: string
    mimeType?: string
    duration?: number
    publicationDate?: string
  }
}

type SitemapCache = {
  xml: string
  createdAt: number
}

let sitemapCache: SitemapCache | null = null

function positiveIntFromEnv(name: string, fallback: number): number {
  const value = Number(process.env[name])
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback
}

function siteOriginFromEnv(): string {
  return (process.env.SITEMAP_SITE_ORIGIN ?? DEFAULT_SITE_ORIGIN).replace(/\/+$/, '')
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function isoFromUnixSeconds(value: number | null | undefined): string | undefined {
  if (!value || !Number.isFinite(value) || value <= 0) return undefined
  return new Date(value * 1000).toISOString()
}

function trimDescription(hit: SitemapVideoHit): string {
  return (hit.summary ?? hit.content_preview ?? '').trim().slice(0, 200)
}

function isVideoKind(kind: number): boolean {
  return kind === 21 || kind === 22 || kind === 34235 || kind === 34236
}

export function canonicalVideoUrl(hit: SitemapVideoHit, siteOrigin = DEFAULT_SITE_ORIGIN): string | null {
  const kind = hit.kind ?? 0
  const eventId = hit.event_id ?? ''
  const pubkey = hit.pubkey ?? ''
  const dTag = hit.identifier ?? hit.d_tag ?? null
  const isShort = kind === 22 || kind === 34236
  const basePath = isShort ? '/short' : '/v'

  if (!isVideoKind(kind) || !pubkey) return null

  try {
    if (kind >= 30000 && kind < 40000) {
      if (!dTag) return null
      const naddr = nip19.naddrEncode({ identifier: dTag, pubkey, kind })
      return `${siteOrigin}${basePath}/${naddr}`
    }

    if (!eventId) return null
    const nevent = nip19.neventEncode({ id: eventId, author: pubkey })
    return `${siteOrigin}${basePath}/${nevent}`
  } catch {
    return null
  }
}

export function isSitemapVideoEligible(hit: SitemapVideoHit): boolean {
  const title = hit.title?.trim() ?? ''
  if (!isVideoKind(hit.kind ?? 0)) return false
  if (hit.contentWarning?.trim()) return false
  if (hit.hasPlayableMedia !== true) return false
  if (!title || title === 'Untitled') return false
  if (!hit.thumbnail?.trim()) return false
  if (!(hit.playableUrl?.trim() || hit.videoUrl?.trim())) return false
  return true
}

export function videoHitToSitemapEntry(hit: SitemapVideoHit, siteOrigin = DEFAULT_SITE_ORIGIN): SitemapEntry | null {
  if (!isSitemapVideoEligible(hit)) return null

  const loc = canonicalVideoUrl(hit, siteOrigin)
  const title = hit.title?.trim()
  const thumbnail = hit.thumbnail?.trim()
  const contentUrl = (hit.playableUrl ?? hit.videoUrl)?.trim()
  if (!loc || !title || !thumbnail || !contentUrl) return null

  return {
    loc,
    lastmod: isoFromUnixSeconds(hit.effectivePublishedAt ?? hit.published_at ?? hit.created_at),
    video: {
      title,
      description: trimDescription(hit),
      thumbnail,
      contentUrl,
      mimeType: hit.mimeType ?? undefined,
      duration: typeof hit.duration === 'number' && hit.duration > 0 ? Math.floor(hit.duration) : undefined,
      publicationDate: isoFromUnixSeconds(hit.published_at ?? hit.created_at),
    },
  }
}

export function authorHitToSitemapEntry(
  hit: SitemapAuthorHit,
  siteOrigin = DEFAULT_SITE_ORIGIN,
  minVideos = DEFAULT_AUTHOR_MIN_VIDEOS,
): SitemapEntry | null {
  const videoCount = hit.videoCount ?? 0
  if (videoCount <= minVideos) return null

  try {
    const nprofile = hit.npub?.startsWith('nprofile')
      ? hit.npub
      : nip19.nprofileEncode({ pubkey: hit.pubkey ?? '' })
    return {
      loc: `${siteOrigin}/p/${nprofile}`,
      lastmod: isoFromUnixSeconds(hit.updatedAt),
    }
  } catch {
    return null
  }
}

export function buildSitemapXml(entries: SitemapEntry[]): string {
  const urls = entries.map(entry => {
    const lines = [
      '  <url>',
      `    <loc>${escapeXml(entry.loc)}</loc>`,
    ]

    if (entry.lastmod) lines.push(`    <lastmod>${escapeXml(entry.lastmod)}</lastmod>`)

    if (entry.video) {
      lines.push('    <video:video>')
      lines.push(`      <video:thumbnail_loc>${escapeXml(entry.video.thumbnail)}</video:thumbnail_loc>`)
      lines.push(`      <video:title>${escapeXml(entry.video.title)}</video:title>`)
      lines.push(`      <video:description>${escapeXml(entry.video.description || entry.video.title)}</video:description>`)
      lines.push(`      <video:content_loc>${escapeXml(entry.video.contentUrl)}</video:content_loc>`)
      if (entry.video.duration) lines.push(`      <video:duration>${entry.video.duration}</video:duration>`)
      if (entry.video.publicationDate) lines.push(`      <video:publication_date>${escapeXml(entry.video.publicationDate)}</video:publication_date>`)
      lines.push('    </video:video>')
    }

    lines.push('  </url>')
    return lines.join('\n')
  })

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:video="http://www.google.com/schemas/sitemap-video/1.1">',
    ...urls,
    '</urlset>',
    '',
  ].join('\n')
}

async function meiliSearch<T>(input: {
  meiliUrl: string
  meiliMasterKey: string
  index: string
  body: Record<string, unknown>
}): Promise<MeiliSearchResponse<T>> {
  const res = await fetch(`${input.meiliUrl}/indexes/${input.index}/search`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${input.meiliMasterKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(input.body),
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`MeiliSearch ${input.index} sitemap request failed with status ${res.status}: ${body}`)
  }

  return res.json() as Promise<MeiliSearchResponse<T>>
}

function blockedAuthorFilters(): string[] {
  return blockedAuthorPubkeys().map(pubkey => `pubkey != "${pubkey.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`)
}

async function collectAuthorEntries(input: {
  meiliUrl: string
  meiliMasterKey: string
  siteOrigin: string
  maxAuthors: number
  minVideos: number
}): Promise<SitemapEntry[]> {
  const result = await meiliSearch<SitemapAuthorHit>({
    meiliUrl: input.meiliUrl,
    meiliMasterKey: input.meiliMasterKey,
    index: 'people',
    body: {
      q: '',
      limit: input.maxAuthors,
      offset: 0,
      filter: [`videoCount > ${input.minVideos}`],
      sort: ['videoCount:desc', 'globalTrustScore:desc', 'updatedAt:desc'],
      attributesToRetrieve: ['pubkey', 'npub', 'videoCount', 'globalTrustScore', 'updatedAt'],
    },
  })

  return (result.hits ?? [])
    .map(hit => authorHitToSitemapEntry(hit, input.siteOrigin, input.minVideos))
    .filter((entry): entry is SitemapEntry => entry !== null)
}

async function collectVideoEntries(input: {
  meiliUrl: string
  meiliMasterKey: string
  siteOrigin: string
  maxVideos: number
}): Promise<SitemapEntry[]> {
  const entries: SitemapEntry[] = []
  const seen = new Set<string>()
  let offset = 0

  while (entries.length < input.maxVideos) {
    const result = await meiliSearch<SitemapVideoHit>({
      meiliUrl: input.meiliUrl,
      meiliMasterKey: input.meiliMasterKey,
      index: 'videos',
      body: {
        q: '',
        limit: PAGE_SIZE,
        offset,
        filter: [
          '(kind = 21 OR kind = 22 OR kind = 34235 OR kind = 34236)',
          'hasPlayableMedia = true',
          ...blockedAuthorFilters(),
        ],
        sort: ['rankingScore:desc', 'playlistScore:desc', 'effectivePublishedAt:desc'],
        attributesToRetrieve: [
          'event_id', 'pubkey', 'kind', 'd_tag', 'identifier', 'title', 'summary', 'content_preview',
          'thumbnail', 'videoUrl', 'playableUrl', 'mimeType', 'duration', 'published_at', 'created_at',
          'effectivePublishedAt', 'contentWarning', 'hasPlayableMedia',
        ],
      },
    })

    const hits = result.hits ?? []
    if (hits.length === 0) break

    for (const hit of hits) {
      if (entries.length >= input.maxVideos) break
      const entry = videoHitToSitemapEntry(hit, input.siteOrigin)
      if (!entry || seen.has(entry.loc)) continue
      seen.add(entry.loc)
      entries.push(entry)
    }

    offset += hits.length
    if (hits.length < PAGE_SIZE) break
  }

  return entries
}

export async function buildSitemap(input: {
  meiliUrl: string
  meiliMasterKey: string
  siteOrigin?: string
  maxUrls?: number
  maxAuthors?: number
  authorMinVideos?: number
}): Promise<string> {
  const siteOrigin = (input.siteOrigin ?? siteOriginFromEnv()).replace(/\/+$/, '')
  const maxUrls = Math.min(input.maxUrls ?? positiveIntFromEnv('SITEMAP_MAX_URLS', DEFAULT_MAX_URLS), DEFAULT_MAX_URLS)
  const authorMinVideos = input.authorMinVideos ?? positiveIntFromEnv('SITEMAP_AUTHOR_MIN_VIDEOS', DEFAULT_AUTHOR_MIN_VIDEOS)
  const maxAuthors = Math.min(
    input.maxAuthors ?? positiveIntFromEnv('SITEMAP_MAX_AUTHORS', DEFAULT_MAX_AUTHORS),
    maxUrls,
  )

  const authorEntries = await collectAuthorEntries({
    meiliUrl: input.meiliUrl,
    meiliMasterKey: input.meiliMasterKey,
    siteOrigin,
    maxAuthors,
    minVideos: authorMinVideos,
  })
  const videoEntries = await collectVideoEntries({
    meiliUrl: input.meiliUrl,
    meiliMasterKey: input.meiliMasterKey,
    siteOrigin,
    maxVideos: Math.max(0, maxUrls - authorEntries.length),
  })

  return buildSitemapXml([...authorEntries, ...videoEntries].slice(0, maxUrls))
}

export function registerSitemapRoutes(app: Hono, input: { meiliUrl: string; meiliMasterKey: string }) {
  app.get('/sitemap.xml', async c => {
    const now = Date.now()
    if (!sitemapCache || now - sitemapCache.createdAt > CACHE_TTL_MS) {
      sitemapCache = {
        xml: await buildSitemap(input),
        createdAt: now,
      }
    }

    return c.body(sitemapCache.xml, 200, {
      'content-type': 'application/xml; charset=utf-8',
      'cache-control': 'public, max-age=3600, stale-while-revalidate=86400',
    })
  })
}
