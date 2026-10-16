export const PROVIDERS = ['keenable', 'exa', 'tavily'] as const
export type Provider = typeof PROVIDERS[number]
export const CREDENTIAL_REFS: Record<Provider, string> = { keenable: 'KEENABLE_API_KEY', exa: 'EXA_API_KEY', tavily: 'TAVILY_API_KEY' }
export type ProviderStatus = 'healthy' | 'cooling' | 'rate_limited' | 'quota_exhausted' | 'auth_failed' | 'unconfigured'
export type TimeRange = 'day' | 'week' | 'month' | 'year'
export type SearchDepth = 'basic' | 'advanced'
export interface SearchOptions { readonly tavilyDepth?: SearchDepth }
export interface SearchRequest {
  readonly query: string
  readonly maxResults?: number | undefined
  readonly timeRange?: TimeRange | undefined
  readonly depth?: SearchDepth | undefined
}
export interface FetchRequest { readonly url: string; readonly maxChars?: number | undefined }
export interface SearchOwner {
  readonly missionId?: string | undefined
  readonly runId?: string | undefined
  readonly sessionId?: string | undefined
  readonly purpose: string
  readonly test?: boolean
}
export interface SearchResult {
  readonly title: string
  readonly url: string
  readonly content: string
  readonly publishedAt: string | null
  readonly score: number | null
  readonly provider: Provider
}
export interface ProviderState {
  readonly provider: Provider
  readonly status: ProviderStatus
  readonly until: number | null
  readonly lastErrorRef: string | null
  readonly lastSucceededAt: number | null
  readonly updatedAt: number
  readonly selectionCredit: number
}
export interface ProviderFailure {
  readonly provider: Provider
  readonly status: ProviderStatus
  readonly httpStatus: number | null
  readonly body: string
  readonly until: number | null
}
export class SearchUnavailableError extends Error {
  readonly code = 'SEARCH_UNAVAILABLE'
  constructor(readonly providers: readonly ProviderFailure[]) {
    super(`icarus: 联网搜索不可用。DSH 插件 → Icarus → 联网搜索。${JSON.stringify(providers)}`)
    this.name = 'SearchUnavailableError'
  }
}
export class ProviderHttpError extends Error {
  constructor(readonly status: number, readonly body: string, readonly headers: Readonly<Record<string, string>>, readonly retryAt: number | null) {
    super(`search provider HTTP ${status}`)
    this.name = 'ProviderHttpError'
  }
}
export class ProviderProtocolError extends Error {
  constructor(readonly status: number, readonly body: string, readonly headers: Readonly<Record<string, string>>, cause: unknown) {
    super('search provider returned invalid JSON', { cause })
    this.name = 'ProviderProtocolError'
  }
}
export interface VendorResponse {
  readonly data: Record<string, unknown>
  readonly httpStatus: number
  readonly headers: Readonly<Record<string, string>>
  readonly raw: string
}
export function monthWindow(at = Date.now()): { start: number; resetAt: number } {
  const date = new Date(at)
  return { start: Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1), resetAt: Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1) }
}
