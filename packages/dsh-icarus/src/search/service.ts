import { newId } from '../domain/ids.js'
import { inTransaction } from '../domain/missions.js'
import { readArtifact, writeArtifact } from '../execution/artifacts.js'
import { BudgetExhaustedError } from '../execution/model-budget.js'
import { metering, normalizeFetch, normalizeSearch, redact, vendorFetch, vendorSearch } from './clients.js'
import { CREDENTIAL_REFS, PROVIDERS, ProviderHttpError, ProviderProtocolError, SearchUnavailableError, monthWindow } from './types.js'
import type { FetchRequest, Provider, ProviderFailure, ProviderState, SearchOptions, SearchOwner, SearchRequest, VendorResponse } from './types.js'
import type { IcarusDatabase } from '../storage/index.js'
import type { IcarusContext } from '../types/host.js'
import type { SearchBudget } from '../domain/bindings.js'

export function createSearchService(ctx: IcarusContext, database: IcarusDatabase, options: SearchOptions | (() => SearchOptions) = {}) {
  const { db, paths } = database
  const configured = new Map<Provider, boolean>()
  const keys = new Map<Provider, string>()
  const seen = new Set<Provider>()
  const stopping = new AbortController()
  const active = new Set<Promise<unknown>>()
  const depth = () => (typeof options === 'function' ? options() : options).tavilyDepth ?? 'basic'
  let refreshing: Promise<void> | undefined
  let onFailure: ((owner: SearchOwner, failure: ProviderFailure, ref: string) => void) | undefined
  let onSuccess: ((provider: Provider) => void) | undefined
  let onBudget: ((owner: SearchOwner, error: BudgetExhaustedError) => void) | undefined
  const secrets = () => [...keys.values()]
  const safe = (value: string) => redact(value, secrets())

  for (const provider of PROVIDERS) db.prepare(`INSERT INTO SearchProviderState(provider, status, updatedAt) VALUES (?, 'unconfigured', ?)
    ON CONFLICT(provider) DO NOTHING`).run(provider, Date.now())
  db.prepare("UPDATE SearchCall SET status = 'unknown', endedAt = ? WHERE status = 'running'").run(Date.now())

  function state(provider: Provider): ProviderState {
    return db.prepare('SELECT * FROM SearchProviderState WHERE provider = ?').get<ProviderState>(provider)!
  }
  function refresh(): Promise<void> {
    if (refreshing !== undefined) return refreshing
    refreshing = (async () => {
      for (const provider of PROVIDERS) {
        const hit = await ctx.credentials.resolve(CREDENTIAL_REFS[provider])
        const key = hit?.value || undefined
        const changed = seen.has(provider) && key !== keys.get(provider)
        seen.add(provider)
        configured.set(provider, key !== undefined)
        if (key === undefined) keys.delete(provider)
        else keys.set(provider, key)
        const current = state(provider)
        if (key === undefined || changed || current.status === 'unconfigured') db.prepare('UPDATE SearchProviderState SET status = ?, until = NULL, lastSucceededAt = NULL, lastErrorRef = NULL, updatedAt = ? WHERE provider = ?')
          .run(key === undefined ? 'unconfigured' : 'healthy', Date.now(), provider)
        else if (current.until !== null && current.until <= Date.now()) db.prepare("UPDATE SearchProviderState SET status = 'healthy', until = NULL, updatedAt = ? WHERE provider = ?").run(Date.now(), provider)
      }
    })().finally(() => { refreshing = undefined })
    return refreshing
  }

  function usage() {
    const { start, resetAt } = monthWindow()
    return PROVIDERS.map(provider => {
      const totals = db.prepare(`SELECT COUNT(*) AS calls, COALESCE(SUM(units), 0) AS units,
        COALESCE(SUM(costDollars), 0) AS costDollars,
        COALESCE(SUM(CASE WHEN costDollars IS NULL AND status IN ('succeeded','unknown','running','cancelled') THEN reservedDollars ELSE costDollars END), 0) AS budgetDollars,
        COALESCE(SUM(CASE WHEN status IN ('unknown','running','cancelled') THEN reservedUnits ELSE units END), 0) AS budgetUnits,
        SUM(CASE WHEN status = 'succeeded' AND costDollars IS NULL AND provider = 'exa' THEN 1 ELSE 0 END) AS unknownCosts
        FROM SearchCall WHERE provider = ? AND startedAt >= ?`).get<{ calls: number; units: number; costDollars: number; budgetDollars: number; budgetUnits: number; unknownCosts: number | null }>(provider, start)!
      return { provider, ...totals, freeUnits: provider === 'keenable' ? 100_000 : provider === 'tavily' ? 1000 : null,
        freeDollars: provider === 'exa' ? 10 : null, resetAt, start, accounting: 'Icarus records; vendor dashboard is authoritative' }
    })
  }

  function classify(provider: Provider, error: unknown, key: string): ProviderFailure {
    const httpStatus = error instanceof ProviderHttpError || error instanceof ProviderProtocolError ? error.status : null
    const body = redact(error instanceof ProviderHttpError || error instanceof ProviderProtocolError ? error.body : error instanceof Error ? `${error.name}: ${error.message}${error.cause === undefined ? '' : `; ${String(error.cause)}`}` : String(error), [...secrets(), key]).slice(0, 500)
    const now = Date.now()
    if (httpStatus === 401 || httpStatus === 403 || (provider === 'keenable' && httpStatus === 400)) return { provider, status: 'auth_failed', httpStatus, body, until: null }
    if (httpStatus === 402 || (provider === 'tavily' && (httpStatus === 432 || httpStatus === 433))) return { provider, status: 'quota_exhausted', httpStatus, body, until: provider === 'exa' ? null : monthWindow().resetAt }
    if (httpStatus === 429) return { provider, status: 'rate_limited', httpStatus, body, until: error instanceof ProviderHttpError ? Math.max(now + 1000, error.retryAt ?? now + 60_000) : now + 60_000 }
    return { provider, status: 'cooling', httpStatus, body, until: now + 120_000 }
  }

  function choose(excluded: ReadonlySet<Provider>, allowPaid: boolean): Provider | undefined {
    const totals = usage()
    const candidates = PROVIDERS.filter(provider => !excluded.has(provider) && (state(provider).status === 'healthy' || (allowPaid && state(provider).status === 'quota_exhausted' && state(provider).lastErrorRef === null)))
    let totalWeight = 0
    let selected: { provider: Provider; credit: number } | undefined
    for (const provider of candidates) {
      const used = totals.find(item => item.provider === provider)!
      const remaining = provider === 'exa' ? 1 - used.budgetDollars / 10 : 1 - used.budgetUnits / used.freeUnits!
      const weight = Math.max(0.001, remaining)
      totalWeight += weight
      const credit = state(provider).selectionCredit + weight
      db.prepare('UPDATE SearchProviderState SET selectionCredit = ? WHERE provider = ?').run(credit, provider)
      if (selected === undefined || credit > selected.credit) selected = { provider, credit }
    }
    if (selected !== undefined) db.prepare('UPDATE SearchProviderState SET selectionCredit = selectionCredit - ? WHERE provider = ?').run(totalWeight, selected.provider)
    return selected?.provider
  }

  function budgetOf(owner: SearchOwner): SearchBudget | undefined {
    if (owner.missionId === undefined) return undefined
    const row = owner.runId === undefined
      ? db.prepare('SELECT bindings FROM Mission WHERE id = ?').get<{ bindings: string }>(owner.missionId)
      : db.prepare('SELECT MissionRevision.bindings FROM MissionRevision JOIN Run ON Run.missionId = MissionRevision.missionId AND Run.missionRevision = MissionRevision.revision WHERE Run.id = ? AND Run.missionId = ?').get<{ bindings: string }>(owner.runId, owner.missionId)
    if (row === undefined) throw new Error('icarus: search owner has no Mission revision')
    const bindings = JSON.parse(row.bindings) as { searchBudget?: SearchBudget; deliveryPolicy?: unknown }
    return bindings.searchBudget ?? { perRun: bindings.deliveryPolicy === undefined ? 20 : 10, perMonth: 600 }
  }

  function reserve(provider: Provider, kind: 'search' | 'fetch', input: SearchRequest | FetchRequest, owner: SearchOwner) {
    const budget = budgetOf(owner)
    const reservedUnits = provider === 'tavily' ? kind === 'fetch' ? 1 : ('depth' in input ? input.depth : depth()) === 'advanced' ? 2 : 1 : 1
    const reservedDollars = provider === 'exa' ? kind === 'search' ? 0.04 : 0.001 : 0
    return inTransaction(database, () => {
      assertBudget(owner)
      const used = usage().find(item => item.provider === provider)!
      if (budget?.allowPaid !== true && (provider === 'exa' ? used.budgetDollars + reservedDollars > 10 : used.budgetUnits + reservedUnits > used.freeUnits!)) {
        db.prepare("UPDATE SearchProviderState SET status = 'quota_exhausted', until = ?, lastErrorRef = NULL, updatedAt = ? WHERE provider = ?").run(used.resetAt, Date.now(), provider)
        return undefined
      }
      const id = newId('search_call')
      db.prepare(`INSERT INTO SearchCall(id, provider, kind, missionId, runId, sessionId, purpose, query, url, status, reservedUnits, reservedDollars, startedAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?)`).run(id, provider, owner.test ? 'test' : kind, owner.missionId ?? null,
          owner.runId ?? null, owner.sessionId ?? null, owner.purpose, 'query' in input ? safe(input.query) : null, 'url' in input ? safe(input.url) : null, reservedUnits, reservedDollars, Date.now())
      return id
    })
  }

  function assertBudget(owner: SearchOwner): void {
    const budget = budgetOf(owner)
    if (budget === undefined) return
    const month = db.prepare('SELECT COUNT(*) AS calls FROM SearchCall WHERE missionId = ? AND startedAt >= ?').get<{ calls: number }>(owner.missionId, monthWindow().start)!.calls
    const run = owner.runId === undefined ? 0 : db.prepare('SELECT COUNT(*) AS calls FROM SearchCall WHERE runId = ?').get<{ calls: number }>(owner.runId)!.calls
    if (month >= budget.perMonth || (owner.runId !== undefined && run >= budget.perRun)) throw new BudgetExhaustedError('search call budget exhausted', 'search')
  }

  async function perform(kind: 'search', input: SearchRequest, owner: SearchOwner, signal: AbortSignal, only?: Provider): Promise<{ provider: Provider; results: ReturnType<typeof normalizeSearch>; callId: string; evidenceRef: string; units: number; scope: 'snippet'; elapsedMs: number }>
  async function perform(kind: 'fetch', input: FetchRequest, owner: SearchOwner, signal: AbortSignal, only?: Provider): Promise<ReturnType<typeof normalizeFetch> & { callId: string; evidenceRef: string; units: number; elapsedMs: number }>
  async function perform(kind: 'search' | 'fetch', input: SearchRequest | FetchRequest, owner: SearchOwner, signal: AbortSignal, only?: Provider): Promise<unknown> {
    signal = AbortSignal.any([signal, stopping.signal])
    signal.throwIfAborted()
    await refresh()
    assertBudget(owner)
    const excluded = new Set<Provider>(only === undefined ? [] : PROVIDERS.filter(provider => provider !== only))
    const failures: ProviderFailure[] = []
    for (;;) {
      signal.throwIfAborted()
      const provider = choose(excluded, budgetOf(owner)?.allowPaid === true)
      if (provider === undefined) break
      excluded.add(provider)
      const callId = reserve(provider, kind, input, owner)
      if (callId === undefined) continue
      const startedAt = Date.now()
      const key = keys.get(provider)!
      const sanitize = (value: string) => redact(value, [...secrets(), key])
      let response: VendorResponse | undefined
      let normalized: { provider: Provider; results: ReturnType<typeof normalizeSearch>; scope: 'snippet' } | ReturnType<typeof normalizeFetch>
      try {
        response = kind === 'search' ? await vendorSearch(provider, key, input as SearchRequest, signal) : await vendorFetch(provider, key, input as FetchRequest, signal)
        normalized = kind === 'search' ? { provider, results: normalizeSearch(provider, response, (input as SearchRequest).maxResults ?? 8), scope: 'snippet' as const }
          : normalizeFetch(provider, response, input as FetchRequest)
      } catch (error) {
        const cancelled = signal.aborted
        const failure = classify(provider, error, key)
        const ref = writeArtifact(paths, `search/${callId}.json`, sanitize(JSON.stringify({ ...failure, status: cancelled ? 'cancelled' : failure.status,
          error: error instanceof Error ? { name: error.name, message: error.message, cause: error.cause === undefined ? null : String(error.cause) } : String(error),
          response: response?.data, headers: error instanceof ProviderHttpError || error instanceof ProviderProtocolError ? error.headers : response?.headers,
          startedAt, endedAt: Date.now() })))
        // 收到成功 HTTP 响应后解析失败，保留计费；中断和网络失败保留预留，避免重复消耗额度。
        const counts = response === undefined ? undefined : metering(provider, response, kind, (input as SearchRequest).depth ?? depth())
        const uncertain = response === undefined && !(error instanceof ProviderHttpError)
        db.prepare('UPDATE SearchCall SET status = ?, httpStatus = ?, units = ?, costDollars = ?, responseRef = ?, endedAt = ? WHERE id = ?')
          .run(cancelled ? 'cancelled' : uncertain ? 'unknown' : failure.status, response?.httpStatus ?? failure.httpStatus, counts?.units ?? 0, counts?.costDollars ?? null, ref, Date.now(), callId)
        if (cancelled) throw signal.reason
        if (keys.get(provider) === key) db.prepare('UPDATE SearchProviderState SET status = ?, until = ?, lastErrorRef = ?, updatedAt = ? WHERE provider = ?')
          .run(failure.status, failure.until, ref, Date.now(), provider)
        failures.push(failure)
        if (keys.get(provider) === key) onFailure?.(owner, failure, ref)
        continue
      }
      const counts = metering(provider, response, kind, (input as SearchRequest).depth ?? depth())
      const endedAt = Date.now()
      const unexpectedPayment = counts.paid === true && budgetOf(owner)?.allowPaid !== true
      const evidenceRef = writeArtifact(paths, `search/${callId}.json`, sanitize(JSON.stringify({ provider, kind, httpStatus: response.httpStatus, headers: response.headers,
        response: response.data, ...counts, billing: counts.paid === true ? 'paid' : counts.paid === false || provider !== 'exa' || counts.costDollars !== null ? 'free_allowance' : 'unknown',
        result: normalized, startedAt, endedAt, elapsedMs: endedAt - startedAt })))
      db.prepare("UPDATE SearchCall SET status = 'succeeded', httpStatus = ?, units = ?, costDollars = ?, resultCount = ?, responseRef = ?, endedAt = ? WHERE id = ?")
        .run(response.httpStatus, counts.units, counts.costDollars, 'results' in normalized ? normalized.results.length : 1, evidenceRef, endedAt, callId)
      if (keys.get(provider) === key) {
        const current = state(provider)
        const newerFailure = current.status !== 'healthy' && current.updatedAt > startedAt
        if (newerFailure && !unexpectedPayment) db.prepare('UPDATE SearchProviderState SET lastSucceededAt = ? WHERE provider = ?').run(endedAt, provider)
        else db.prepare('UPDATE SearchProviderState SET status = ?, until = ?, lastErrorRef = ?, lastSucceededAt = ?, updatedAt = ? WHERE provider = ?')
          .run(unexpectedPayment ? 'quota_exhausted' : 'healthy', unexpectedPayment ? monthWindow().resetAt : null, unexpectedPayment ? evidenceRef : null, endedAt, endedAt, provider)
        if (!unexpectedPayment && !newerFailure) onSuccess?.(provider)
      }
      return { ...normalized, ...counts, callId, evidenceRef, elapsedMs: endedAt - startedAt }
    }
    throw new SearchUnavailableError(PROVIDERS.filter(provider => only === undefined || provider === only).map(provider => failures.find(item => item.provider === provider) ?? {
      provider, status: state(provider).status, httpStatus: null, body: state(provider).lastErrorRef === null ? '' : readArtifact(paths, state(provider).lastErrorRef!).slice(0, 500), until: state(provider).until,
    }))
  }

  function track<T>(promise: Promise<T>, owner: SearchOwner): Promise<T> {
    const reported = promise.catch(error => { if (error instanceof BudgetExhaustedError) onBudget?.(owner, error); throw error })
    active.add(reported)
    void reported.then(() => active.delete(reported), () => active.delete(reported))
    return reported
  }
  return {
    refresh, usage,
    available: () => PROVIDERS.some(provider => configured.get(provider)),
    async status() {
      await refresh()
      return { providers: PROVIDERS.map(provider => ({ ...state(provider), configured: configured.get(provider) === true,
        lastError: state(provider).lastErrorRef === null ? null : JSON.parse(readArtifact(paths, state(provider).lastErrorRef!)) })), usage: usage(), tavilyDepth: depth() }
    },
    search(input: SearchRequest, owner: SearchOwner, signal: AbortSignal) {
      if (typeof input.query !== 'string' || !input.query.trim()) throw new TypeError('icarus: nonempty search query required')
      if (input.timeRange !== undefined && !['day', 'week', 'month', 'year'].includes(input.timeRange)) throw new TypeError('icarus: invalid search timeRange')
      if (input.depth !== undefined && !['basic', 'advanced'].includes(input.depth)) throw new TypeError('icarus: invalid search depth')
      const limit = input.maxResults ?? 8
      if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new TypeError('icarus: maxResults must be between 1 and 20')
      return track(perform('search', { ...input, maxResults: limit, depth: input.depth ?? depth() }, owner, signal), owner)
    },
    fetch(input: FetchRequest, owner: SearchOwner, signal: AbortSignal) {
      const url = new URL(input.url)
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new TypeError('icarus: extraction requires an HTTP URL without credentials')
      const maxChars = input.maxChars ?? 30_000
      if (!Number.isInteger(maxChars) || maxChars < 1 || maxChars > 50_000) throw new TypeError('icarus: maxChars must be between 1 and 50000')
      return track(perform('fetch', { ...input, maxChars }, owner, signal), owner)
    },
    async test(provider: Provider | undefined, signal: AbortSignal, owner: SearchOwner = { purpose: 'connection-test', test: true }) {
      if (provider !== undefined && !PROVIDERS.includes(provider)) throw new TypeError('icarus: invalid search provider')
      await refresh()
      if (provider !== undefined && configured.get(provider)) db.prepare("UPDATE SearchProviderState SET status = 'healthy', until = NULL, updatedAt = ? WHERE provider = ?").run(Date.now(), provider)
      return track(perform('search', { query: 'DeepSeek Harness', maxResults: 1, depth: 'basic' }, { ...owner, test: true }, signal, provider), owner)
    },
    handlers(handlers: { failure: NonNullable<typeof onFailure>; success: NonNullable<typeof onSuccess>; budget: NonNullable<typeof onBudget> }) {
      onFailure = handlers.failure; onSuccess = handlers.success; onBudget = handlers.budget
    },
    async dispose() { stopping.abort(); await Promise.allSettled(active); await refreshing },
  }
}

export type SearchService = ReturnType<typeof createSearchService>
