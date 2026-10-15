import Parser from 'rss-parser'
import { XMLParser, XMLValidator } from 'fast-xml-parser'
import { Readability } from '@mozilla/readability'
import { parseHTML } from 'linkedom'
import { SourceHttpError } from './types.js'
import type { PageCursor, Source, SourceItem, SourcePage, SourceRateLimit } from './types.js'

const rss = new Parser()
const xml = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', isArray: tag => ['entry', 'author', 'link', 'category'].includes(tag) })

export function publicUrl(value: string): URL {
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new TypeError('icarus: source requires an HTTP URL without credentials')
  return url
}

function timestamp(value: unknown): number | null {
  if (typeof value !== 'string') return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

function arxivDate(at: number): string {
  return new Date(at).toISOString().slice(0, 16).replaceAll('-', '').replace('T', '').replace(':', '')
}

function firstUrl(source: Source, now: number): string {
  if (source.adapter === 'arxiv') {
    const url = new URL('https://export.arxiv.org/api/query')
    url.searchParams.set('search_query', `(${source.locator}) AND lastUpdatedDate:[${arxivDate(source.config.sinceAt)} TO ${arxivDate(source.cursor.cycleUntil ?? now)}]`)
    url.searchParams.set('sortBy', 'lastUpdatedDate')
    url.searchParams.set('sortOrder', 'descending')
    url.searchParams.set('max_results', String(source.config.pageSize ?? 100))
    url.searchParams.set('start', '0')
    return url.href
  }
  const url = publicUrl(source.locator)
  if (source.adapter === 'github') {
    if (url.hostname !== 'api.github.com') throw new TypeError('icarus: GitHub sources require an api.github.com repository releases or issues URL')
    const parts = url.pathname.split('/').filter(Boolean)
    if (parts.length !== 4 || parts[0] !== 'repos' || !['releases', 'issues'].includes(parts[3] ?? '')) throw new TypeError('icarus: invalid GitHub repository resource')
    url.searchParams.set('per_page', String(source.config.pageSize ?? 100))
    url.searchParams.set('page', '1')
    if (parts[3] === 'issues') {
      url.searchParams.set('state', 'all')
      url.searchParams.set('sort', 'updated')
      url.searchParams.set('direction', 'desc')
      url.searchParams.set('since', new Date(source.config.sinceAt).toISOString())
    }
  }
  return url.href
}

function nextGithubUrl(current: URL, count: number, pageSize: number): string | undefined {
  if (count < pageSize) return undefined
  const next = new URL(current.href)
  next.searchParams.set('page', String(Number(current.searchParams.get('page') ?? 1) + 1))
  return next.href
}

function updatedCursor(source: Source, url: string, response: Response, nextUrl: string | undefined, now: number): PageCursor {
  const page = {
    ...(response.headers.get('etag') === null ? {} : { etag: response.headers.get('etag')! }),
    ...(response.headers.get('last-modified') === null ? {} : { modified: response.headers.get('last-modified')! }),
    ...(nextUrl === undefined ? {} : { nextUrl }),
  }
  return {
    pages: { ...source.cursor.pages, [url]: page },
    ...(nextUrl === undefined ? {} : { nextUrl, cycleUntil: source.cursor.cycleUntil ?? now }),
  }
}

export async function readSourcePage(source: Source, signal: AbortSignal, credential?: string): Promise<SourcePage> {
  const now = Date.now()
  const url = publicUrl(source.cursor.nextUrl ?? firstUrl(source, now))
  if (source.adapter === 'github' && url.hostname !== 'api.github.com') throw new TypeError('icarus: GitHub cursor escaped API origin')
  if (source.adapter === 'arxiv' && url.origin !== 'https://export.arxiv.org') throw new TypeError('icarus: arXiv cursor escaped API origin')
  const saved = source.cursor.pages?.[url.href]
  const headers: Record<string, string> = { 'User-Agent': 'Icarus/0.1 (personal research source reader)' }
  if (saved?.etag !== undefined) headers['If-None-Match'] = saved.etag
  if (saved?.modified !== undefined) headers['If-Modified-Since'] = saved.modified
  if (source.adapter === 'github') {
    headers.Accept = 'application/vnd.github+json'
    headers['X-GitHub-Api-Version'] = '2022-11-28'
  }
  if (credential !== undefined) headers.Authorization = `Bearer ${credential}`
  const response = await fetch(url.href, { signal, headers })
  const numberHeader = (name: string): number | null => {
    const value = response.headers.get(name)
    return value !== null && Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : null
  }
  const retry = response.headers.get('retry-after')
  const reset = numberHeader('x-ratelimit-reset')
  const retryAt = retry === null ? null : Number.isFinite(Number(retry)) ? now + Number(retry) * 1000 : timestamp(retry)
  const rateLimit: SourceRateLimit | undefined = source.adapter === 'github' ? {
    limit: numberHeader('x-ratelimit-limit'), remaining: numberHeader('x-ratelimit-remaining'), resetAt: reset === null ? null : reset * 1000, retryAt,
  } : undefined
  if (response.status === 304) {
    return { items: [], status: 304, more: saved?.nextUrl !== undefined, raw: null, url: url.href,
      ...(rateLimit === undefined ? {} : { rateLimit }),
      cursor: { pages: source.cursor.pages ?? {}, ...(saved?.nextUrl === undefined ? {} : { nextUrl: saved.nextUrl, cycleUntil: source.cursor.cycleUntil ?? now }) } }
  }
  const raw = await response.text()
  if (!response.ok) {
    throw new SourceHttpError(response.status, url.href, retryAt ?? (reset === null ? null : reset * 1000), raw, rateLimit)
  }
  let items: SourceItem[]
  let nextUrl: string | undefined
  if (source.adapter === 'rss') {
    const feed = await rss.parseString(raw)
    items = feed.items.map(item => {
      if (!item.guid && !item.link) throw new Error('icarus: feed item has no stable ID or link')
      return { nativeId: item.guid ?? item.link!, url: item.link ?? url.href, title: item.title ?? '', content: item['content:encoded'] ?? item.content ?? item.summary ?? '',
        publishedAt: timestamp(item.isoDate ?? item.pubDate), metadata: { creator: item.creator ?? null, categories: item.categories ?? [] },
        reading: { scope: 'partial', truncated: false, continuation: item.link ?? null } }
    })
  } else if (source.adapter === 'arxiv') {
    const valid = XMLValidator.validate(raw)
    if (valid !== true) throw new Error(`icarus: invalid Atom response: ${valid.err.msg}`)
    const feed = (xml.parse(raw) as { feed?: Record<string, unknown> }).feed
    if (feed === undefined) throw new Error('icarus: arXiv response has no feed')
    const entries = (feed.entry ?? []) as Record<string, unknown>[]
    items = entries.map(entry => {
      const id = String(entry.id)
      const links = entry.link as Record<string, string>[]
      const html = links.find(link => link['@_rel'] === 'alternate')?.['@_href'] ?? id
      return { nativeId: new URL(id).pathname.replace(/v\d+$/, ''), url: html, title: String(entry.title), content: String(entry.summary), publishedAt: timestamp(entry.updated ?? entry.published),
        metadata: { published: entry.published, updated: entry.updated, authors: entry.author, categories: entry.category, versionId: id },
        reading: { scope: 'abstract', truncated: false, continuation: html } }
    })
    const start = Number(feed['opensearch:startIndex'] ?? url.searchParams.get('start'))
    const total = Number(feed['opensearch:totalResults'])
    if (entries.length > 0 && start + entries.length < total) {
      const next = new URL(url.href)
      next.searchParams.set('start', String(start + entries.length))
      nextUrl = next.href
    }
  } else if (source.adapter === 'github') {
    const rows: unknown = JSON.parse(raw)
    if (!Array.isArray(rows)) throw new Error('icarus: GitHub response is not an array')
    items = rows.map((item: Record<string, unknown>) => ({
      nativeId: String(item.id), url: String(item.html_url), title: String(item.name ?? item.title ?? item.tag_name ?? ''), content: String(item.body ?? ''),
      publishedAt: timestamp(item.updated_at ?? item.published_at ?? item.created_at),
      metadata: { state: item.state ?? null, tag: item.tag_name ?? null, draft: item.draft ?? null, prerelease: item.prerelease ?? null, updatedAt: item.updated_at ?? null },
      reading: { scope: 'full', truncated: false, continuation: null },
    }))
    nextUrl = nextGithubUrl(url, rows.length, source.config.pageSize ?? 100)
  } else {
    const { document } = parseHTML(raw)
    const article = new Readability(document as unknown as ConstructorParameters<typeof Readability>[0]).parse()
    if (article === null || !article.textContent) throw new Error('icarus: page has no readable article body')
    items = [{ nativeId: source.locator, url: source.locator, title: article.title ?? '', content: article.textContent,
      publishedAt: null, metadata: { byline: article.byline, excerpt: article.excerpt }, reading: { scope: 'full', truncated: false, continuation: null } }]
  }
  return { items: items.filter(item => item.publishedAt === null || item.publishedAt >= source.config.sinceAt),
    ...(rateLimit === undefined ? {} : { rateLimit }),
    status: response.status, cursor: updatedCursor(source, url.href, response, nextUrl, now), more: nextUrl !== undefined, raw, url: url.href }
}
