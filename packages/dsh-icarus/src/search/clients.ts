// 三家请求与字段映射移植自 dsh-balanced-search，许可见 THIRD_PARTY_NOTICES。
import { ProviderHttpError, ProviderProtocolError } from './types.js'
import type { Provider, SearchRequest, FetchRequest, SearchResult, VendorResponse } from './types.js'

const DAYS = { day: 1, week: 7, month: 30, year: 365 }
const RELATIVE = { day: '1d', week: '7d', month: '1mo', year: '1y' }
const RATE_HEADERS = ['retry-after', 'x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset', 'ratelimit-limit', 'ratelimit-remaining', 'ratelimit-reset', 'x-request-id']

export function redact(value: string, secrets: readonly string[]): string {
  for (const secret of secrets) if (secret) value = value.split(secret).join('[credential removed]')
  return value
}

async function request(url: string, key: string, headers: Record<string, string>, body: Record<string, unknown> | undefined, signal: AbortSignal): Promise<VendorResponse> {
  const response = await fetch(url, { method: body === undefined ? 'GET' : 'POST', headers: { ...headers, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]) })
  const raw = redact(await response.text(), [key])
  const limits: Record<string, string> = {}
  for (const name of RATE_HEADERS) { const value = response.headers.get(name); if (value !== null) limits[name] = redact(value, [key]) }
  const retry = limits['retry-after']
  const retryAt = retry === undefined ? null : Number.isFinite(Number(retry)) ? Date.now() + Number(retry) * 1000 : Date.parse(retry)
  if (!response.ok) throw new ProviderHttpError(response.status, raw.slice(0, 500), limits, retryAt !== null && Number.isFinite(retryAt) ? retryAt : null)
  let data: unknown
  try { data = JSON.parse(raw) }
  catch (error) { throw new ProviderProtocolError(response.status, raw.slice(0, 500), limits, error) }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) throw new ProviderProtocolError(response.status, raw.slice(0, 500), limits, new TypeError('JSON response is not an object'))
  return { data: data as Record<string, unknown>, raw, httpStatus: response.status, headers: limits }
}

export async function vendorSearch(provider: Provider, key: string, input: SearchRequest, signal: AbortSignal): Promise<VendorResponse> {
  const maxResults = input.maxResults ?? 8
  if (provider === 'keenable') return request('https://api.keenable.ai/v1/search', key, { 'X-API-Key': key }, {
    query: input.query, mode: 'realtime', max_results: maxResults, ...(input.timeRange === undefined ? {} : { published_after: RELATIVE[input.timeRange] }),
  }, signal)
  if (provider === 'exa') return request('https://api.exa.ai/search', key, { 'x-api-key': key }, {
    query: input.query, type: 'auto', numResults: maxResults, contents: { highlights: true },
    ...(input.timeRange === undefined ? {} : { startPublishedDate: new Date(Date.now() - DAYS[input.timeRange] * 86_400_000).toISOString() }),
  }, signal)
  return request('https://api.tavily.com/search', key, { Authorization: `Bearer ${key}` }, {
    query: input.query, max_results: maxResults, search_depth: input.depth ?? 'basic', include_usage: true, include_published_date: true,
    ...(input.timeRange === undefined ? {} : { time_range: input.timeRange }),
  }, signal)
}

export async function vendorFetch(provider: Provider, key: string, input: FetchRequest, signal: AbortSignal): Promise<VendorResponse> {
  if (provider === 'keenable') {
    const url = new URL('https://api.keenable.ai/v1/fetch')
    url.searchParams.set('url', input.url)
    url.searchParams.set('max_chars', String(input.maxChars ?? 30_000))
    return request(url.href, key, { 'X-API-Key': key }, undefined, signal)
  }
  if (provider === 'exa') return request('https://api.exa.ai/contents', key, { 'x-api-key': key }, {
    urls: [input.url], text: { maxCharacters: input.maxChars ?? 30_000 },
  }, signal)
  return request('https://api.tavily.com/extract', key, { Authorization: `Bearer ${key}` }, {
    urls: [input.url], extract_depth: 'basic', format: 'markdown', include_usage: true,
  }, signal)
}

export function resultRows(data: Record<string, unknown>): Record<string, unknown>[] {
  if (!Array.isArray(data.results)) throw new Error('search provider response has no results array')
  return data.results.map(value => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('search provider returned an invalid result')
    return value as Record<string, unknown>
  })
}

export function normalizeSearch(provider: Provider, response: VendorResponse, limit: number): SearchResult[] {
  return resultRows(response.data).slice(0, limit).map(item => {
    if (typeof item.url !== 'string') throw new Error('search result has no URL')
    const content = provider === 'exa' && Array.isArray(item.highlights) ? item.highlights.join('\n') : item.snippet ?? item.description ?? item.text ?? item.content ?? ''
    return { title: String(item.title ?? ''), url: item.url, content: String(content).trim(),
      publishedAt: typeof (item.published_at ?? item.publishedDate ?? item.published_date) === 'string' ? String(item.published_at ?? item.publishedDate ?? item.published_date) : null,
      score: typeof item.score === 'number' ? item.score : null, provider }
  })
}

export function normalizeFetch(provider: Provider, response: VendorResponse, input: FetchRequest) {
  if (provider === 'exa' && Array.isArray(response.data.statuses)) {
    const failed = response.data.statuses.filter((value): value is Record<string, unknown> => value !== null && typeof value === 'object' && 'status' in value && value.status !== 'success')
    if (failed.length > 0) throw new Error(`search provider extraction failed: ${JSON.stringify(failed)}`)
  }
  const item = provider === 'keenable' ? response.data : resultRows(response.data)[0]
  if (item === undefined) throw new Error(`search provider extraction returned no result: ${JSON.stringify(response.data.failed_results ?? response.data.statuses ?? [])}`)
  const content = item.content ?? item.text ?? item.raw_content
  if (typeof content !== 'string' || !content.trim()) throw new Error('search provider extraction returned no content')
  const maxChars = input.maxChars ?? 30_000
  return { provider, url: String(item.url ?? input.url), title: String(item.title ?? ''), content: content.slice(0, maxChars), truncated: content.length >= maxChars,
    originStatus: null, extraction: 'vendor' as const, scope: 'vendor_extract' as const }
}

export function metering(provider: Provider, response: VendorResponse, kind: 'search' | 'fetch', depth: string) {
  const cost = response.data.costDollars
  const costDollars = typeof cost === 'number' ? cost : typeof cost === 'object' && cost !== null && 'total' in cost && typeof cost.total === 'number' ? cost.total : null
  const meta = response.data._meta as { 'keenable/usage'?: { credits?: number; paid?: boolean } } | undefined
  const usage = response.data.usage ?? meta?.['keenable/usage']
  const credits = typeof usage === 'object' && usage !== null && 'credits' in usage && typeof usage.credits === 'number' ? usage.credits : null
  const count = Array.isArray(response.data.results) ? response.data.results.length : 0
  const units = provider === 'tavily' ? credits ?? (kind === 'search' ? depth === 'advanced' ? 2 : 1 : count / 5) : provider === 'keenable' ? credits ?? 1 : 1
  const paid = typeof usage === 'object' && usage !== null && 'paid' in usage && typeof usage.paid === 'boolean' ? usage.paid : null
  return { units, costDollars, paid, meteringSource: credits !== null || costDollars !== null ? 'vendor' : 'published_rate' }
}
