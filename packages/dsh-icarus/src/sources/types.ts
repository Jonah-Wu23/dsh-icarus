export type SourceAdapter = 'rss' | 'arxiv' | 'github' | 'web' | 'search'

export interface SourceConfig {
  readonly sinceAt: number
  readonly pollIntervalMs: number
  readonly credentialRef?: string
  readonly pageSize?: number
  readonly timeRange?: import('../search/types.js').TimeRange
  readonly maxResults?: number
  readonly site?: string
}

export interface PageCursor {
  readonly nextUrl?: string
  readonly cycleUntil?: number
  readonly pages?: Readonly<Record<string, { readonly etag?: string; readonly modified?: string; readonly nextUrl?: string }>>
}

export interface Source {
  readonly id: string
  readonly missionId: string
  readonly adapter: SourceAdapter
  readonly locator: string
  readonly config: SourceConfig
  readonly cursor: PageCursor
  readonly lastCheckedAt: number | null
  readonly lastSucceededAt: number | null
  readonly nextPollAt: number | null
  readonly health: { readonly status: 'unknown' | 'healthy' | 'failed'; readonly errorRef?: string; readonly httpStatus?: number }
  readonly createdAt: number
}

export interface SourceItem {
  readonly nativeId: string
  readonly url: string
  readonly title: string
  readonly content: string
  readonly publishedAt: number | null
  readonly metadata: Readonly<Record<string, unknown>>
  readonly reading: {
    readonly scope: 'abstract' | 'full' | 'partial' | 'snippet' | 'vendor_extract'
    readonly truncated: boolean
    readonly continuation: string | null
  }
}

export interface SourcePage {
  readonly items: readonly SourceItem[]
  readonly cursor: PageCursor
  readonly status: number
  readonly more: boolean
  readonly raw: string | null
  readonly url: string
  readonly rateLimit?: SourceRateLimit
}

export interface SourceRateLimit {
  readonly limit: number | null
  readonly remaining: number | null
  readonly resetAt: number | null
  readonly retryAt: number | null
}

export interface Observation {
  readonly id: string
  readonly sourceId: string
  readonly nativeId: string
  readonly contentHash: string
  readonly publishedAt: number | null
  readonly observedAt: number
  readonly evidenceRef: string
}

export class SourceHttpError extends Error {
  constructor(readonly status: number, readonly url: string, readonly retryAt: number | null, readonly responseBody: string, readonly rateLimit?: SourceRateLimit) {
    super(`icarus: source HTTP ${status} ${url}`)
    this.name = 'SourceHttpError'
  }
}
