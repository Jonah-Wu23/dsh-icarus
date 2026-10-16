import { contentHash, readArtifact, writeArtifact } from '../execution/artifacts.js'
import { newId } from '../domain/ids.js'
import { inTransaction } from '../domain/missions.js'
import { publicUrl, readSourcePage } from './adapters.js'
import { SourceHttpError } from './types.js'
import { existsSync } from 'node:fs'
import { artifactPathOf } from '../execution/artifacts.js'
import type { IcarusDatabase } from '../storage/index.js'
import type { Source, SourceAdapter, SourceConfig, Observation, SourcePage, SourceRateLimit } from './types.js'
import type { SearchService } from '../search/service.js'
import type { MissionService } from '../domain/index.js'

export type { Source, SourceAdapter, SourceConfig, SourceItem, SourcePage, Observation } from './types.js'

export interface SourcePollResult { readonly sourceId: string; readonly status: 'succeeded' | 'failed' | 'deferred'; readonly added: number; readonly errorRef?: string; readonly retryAt?: number }

interface SourceRow extends Omit<Source, 'config' | 'cursor' | 'health'> { config: string; cursor: string | null; health: string | null }

export interface SourceService {
  create(input: { readonly missionId: string; readonly adapter: SourceAdapter; readonly locator: string; readonly sinceAt: number; readonly pollIntervalMs?: number; readonly credentialRef?: string; readonly pageSize?: number; readonly config?: Pick<SourceConfig, 'timeRange' | 'maxResults' | 'site'> }): Source
  get(id: string): Source
  list(missionId?: string): Source[]
  observations(sourceId: string, limit?: number, offset?: number): Observation[]
  evidence(observationId: string): unknown
  attempts(sourceId: string): unknown[]
  requestBudget(sourceId: string): unknown
  poll(id: string): Promise<SourcePollResult>
  tick(): Promise<unknown[]>
  dispose(): Promise<void>
}

export function createSourceService(database: IcarusDatabase, credential?: (ref: string) => Promise<string>, onResult?: (source: Source, result: SourcePollResult) => void, search?: SearchService, missions?: MissionService): SourceService {
  const { db, paths } = database
  const active = new Map<string, Promise<Awaited<ReturnType<SourceService['poll']>>>>()
  const stopping = new AbortController()
  let ticking: Promise<unknown[]> | undefined
  const budgetKey = (source: Source) => `github:${source.config.credentialRef ?? 'anonymous'}`
  function reserveRequest(source: Source): number | null {
    if (source.adapter !== 'github') return null
    return inTransaction(database, () => {
      const now = Date.now()
      const budget = db.prepare('SELECT nextRequestAt FROM SourceRequestBudget WHERE budgetKey = ?').get<{ nextRequestAt: number }>(budgetKey(source))
      if (budget !== undefined && budget.nextRequestAt > now) {
        db.prepare('UPDATE Source SET nextPollAt = ? WHERE id = ?').run(budget.nextRequestAt, source.id)
        return budget.nextRequestAt
      }
      const next = now + (source.config.credentialRef === undefined ? 120_000 : 2000)
      db.prepare(`INSERT INTO SourceRequestBudget(budgetKey, nextRequestAt) VALUES (?, ?)
        ON CONFLICT(budgetKey) DO UPDATE SET nextRequestAt = excluded.nextRequestAt`).run(budgetKey(source), next)
      return null
    })
  }
  function recordRateLimit(source: Source, rate: SourceRateLimit | undefined): void {
    if (rate === undefined) return
    const now = Date.now()
    const blockedUntil = Math.max(rate.retryAt ?? 0, rate.remaining === 0 ? rate.resetAt ?? 0 : 0)
    db.prepare(`UPDATE SourceRequestBudget SET nextRequestAt = MAX(nextRequestAt, ?), requestLimit = ?, remaining = ?, resetAt = ?, lastResponseAt = ? WHERE budgetKey = ?`)
      .run(blockedUntil, rate.limit, rate.remaining, rate.resetAt, now, budgetKey(source))
  }
  for (const attempt of db.prepare("SELECT id, sourceId FROM SourceAttempt WHERE status = 'running'").all<{ id: string; sourceId: string }>()) {
    const ref = writeArtifact(paths, `sources/${attempt.sourceId}/${attempt.id}/interrupted.json`, JSON.stringify({ reason: 'host-stopped-before-source-attempt-settled', recoveredAt: Date.now() }))
    inTransaction(database, () => {
      db.prepare("UPDATE SourceAttempt SET status = 'failed', endedAt = ?, errorRef = ? WHERE id = ?").run(Date.now(), ref, attempt.id)
      db.prepare('UPDATE Source SET nextPollAt = ?, health = ? WHERE id = ?').run(Date.now(), JSON.stringify({ status: 'failed', errorRef: ref }), attempt.sourceId)
    })
  }

  function decode(row: SourceRow): Source {
    return { ...row, config: JSON.parse(row.config) as SourceConfig, cursor: row.cursor === null ? {} : JSON.parse(row.cursor), health: row.health === null ? { status: 'unknown' } : JSON.parse(row.health) }
  }
  function get(id: string): Source {
    const row = db.prepare('SELECT * FROM Source WHERE id = ?').get<SourceRow>(id)
    if (row === undefined) throw new Error(`icarus: source ${id} does not exist`)
    return decode(row)
  }
  function list(missionId?: string): Source[] {
    return (missionId === undefined ? db.prepare('SELECT * FROM Source ORDER BY createdAt, id').all<SourceRow>()
      : db.prepare('SELECT * FROM Source WHERE missionId = ? ORDER BY createdAt, id').all<SourceRow>(missionId)).map(decode)
  }
  function savePage(source: Source, attemptId: string, page: SourcePage): number {
    const observedAt = Date.now()
    const rawRef = page.raw === null ? null : writeArtifact(paths, `sources/${source.id}/${attemptId}/response.txt`, page.raw)
    const records = page.items.map(item => {
      const fingerprint = contentHash(JSON.stringify(source.adapter === 'search' ? { title: item.title, content: item.content } : item))
      const ref = `sources/${source.id}/items/${contentHash(item.nativeId)}/${fingerprint}.json`
      if (!existsSync(artifactPathOf(paths, ref))) writeArtifact(paths, ref, JSON.stringify({ ...item, sourceId: source.id, contentHash: fingerprint, observedAt, rawRef, requestUrl: page.url }))
      return { item, fingerprint, ref }
    })
    return inTransaction(database, () => {
      let added = 0
      for (const { item, fingerprint, ref } of records) {
        const result = db.prepare(`INSERT INTO Observation(id, sourceId, nativeId, contentHash, publishedAt, observedAt, evidenceRef, createdAt)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(sourceId, nativeId, contentHash) DO NOTHING`)
          .run(newId('observation'), source.id, item.nativeId, fingerprint, item.publishedAt, observedAt, ref, observedAt)
        added += Number(result.changes)
      }
      db.prepare('UPDATE Source SET cursor = ?, lastCheckedAt = ?, lastSucceededAt = ?, nextPollAt = ?, health = ? WHERE id = ?')
        .run(JSON.stringify(page.cursor), observedAt, observedAt, observedAt + (page.more ? (source.adapter === 'arxiv' ? 3000 : 1000) : source.config.pollIntervalMs), JSON.stringify({ status: 'healthy', httpStatus: page.status }), source.id)
      db.prepare("UPDATE SourceAttempt SET status = 'succeeded', endedAt = ?, httpStatus = ?, added = ?, responseRef = ? WHERE id = ?").run(observedAt, page.status, added, rawRef, attemptId)
      return added
    })
  }
  async function runPoll(id: string): ReturnType<SourceService['poll']> {
    stopping.signal.throwIfAborted()
    const source = get(id)
    const mission = db.prepare('SELECT status FROM Mission WHERE id = ?').get<{ status: string }>(source.missionId)
    if (mission?.status !== 'active') throw new Error('icarus: source polling requires an active Mission')
    const retryAt = reserveRequest(source)
    if (retryAt !== null) return { sourceId: id, status: 'deferred', added: 0, retryAt }
    const attemptId = newId('source_attempt')
    const started = Date.now()
    db.prepare("INSERT INTO SourceAttempt(id, sourceId, startedAt, status) VALUES (?, ?, ?, 'running')").run(attemptId, id, started)
    try {
      let token: string | undefined
      if (source.config.credentialRef !== undefined) {
        if (credential === undefined) throw new Error('icarus: host credential resolver is not connected')
        token = await credential(source.config.credentialRef)
      }
      const signal = AbortSignal.any([stopping.signal, AbortSignal.timeout(60_000)])
      let page: SourcePage
      if (source.adapter === 'search') {
        if (search === undefined) throw new Error('icarus: search service is not connected')
        const found = await search.search({ query: source.config.site === undefined ? source.locator : `${source.locator} site:${source.config.site}`,
          maxResults: source.config.maxResults, timeRange: source.config.timeRange }, { missionId: source.missionId, purpose: 'source-poll' }, signal)
        page = { items: found.results.filter(item => {
          if (source.config.site === undefined) return true
          const host = publicUrl(item.url).hostname
          return host === source.config.site || host.endsWith(`.${source.config.site}`)
        }).map(item => {
          const url = publicUrl(item.url)
          url.hash = ''
          url.searchParams.sort()
          return { nativeId: url.href, url: url.href, title: item.title, content: item.content,
            publishedAt: item.publishedAt === null || !Number.isFinite(Date.parse(item.publishedAt)) ? null : Date.parse(item.publishedAt),
            metadata: { provider: item.provider, callId: found.callId, responseRef: found.evidenceRef },
            reading: { scope: 'snippet' as const, truncated: false, continuation: item.url } }
        }).filter(item => item.publishedAt === null || item.publishedAt >= source.config.sinceAt), cursor: {}, status: 200, more: false, raw: JSON.stringify(found), url: `icarus-search:${source.locator}` }
      } else page = await readSourcePage(source, signal, token)
      recordRateLimit(source, page.rateLimit)
      return { sourceId: id, status: 'succeeded', added: savePage(source, attemptId, page) }
    } catch (error) {
      if (error instanceof SourceHttpError) recordRateLimit(source, error.rateLimit)
      const ended = Date.now()
      const ref = writeArtifact(paths, `sources/${id}/${attemptId}/error.json`, JSON.stringify({ error: error instanceof Error ? { name: error.name, message: error.message, cause: String(error.cause ?? '') } : String(error),
        ...(error instanceof SourceHttpError ? { status: error.status, body: error.responseBody } : {}), startedAt: started, endedAt: ended }))
      const retryAt = error instanceof SourceHttpError && error.retryAt !== null && Number.isFinite(error.retryAt) ? Math.max(ended + 3000, error.retryAt) : ended + source.config.pollIntervalMs
      inTransaction(database, () => {
        db.prepare('UPDATE Source SET lastCheckedAt = ?, nextPollAt = ?, health = ? WHERE id = ?')
          .run(ended, retryAt, JSON.stringify({ status: 'failed', errorRef: ref, ...(error instanceof SourceHttpError ? { httpStatus: error.status } : {}) }), id)
        db.prepare("UPDATE SourceAttempt SET status = 'failed', endedAt = ?, httpStatus = ?, errorRef = ? WHERE id = ?")
          .run(ended, error instanceof SourceHttpError ? error.status : null, ref, attemptId)
      })
      return { sourceId: id, status: 'failed', added: 0, errorRef: ref }
    }
  }
  function poll(id: string): ReturnType<SourceService['poll']> {
    const pending = active.get(id)
    if (pending !== undefined) return pending
    const work = runPoll(id).then(result => { if (result.status !== 'deferred') onResult?.(get(id), result); return result }).finally(() => { active.delete(id) })
    active.set(id, work)
    return work
  }
  return {
    create(input) {
      if (!['rss', 'arxiv', 'github', 'web', 'search'].includes(input.adapter)) throw new TypeError('icarus: unknown source adapter')
      if (typeof input.locator !== 'string' || input.locator.trim() === '') throw new TypeError('icarus: source locator required')
      if (input.adapter !== 'arxiv' && input.adapter !== 'search') publicUrl(input.locator)
      if (!Number.isSafeInteger(input.sinceAt) || input.sinceAt < 0 || input.sinceAt > Date.now()) throw new TypeError('icarus: explicit source lookback must be a past timestamp')
      const interval = input.pollIntervalMs ?? (input.adapter === 'search' ? 21_600_000 : 3_600_000)
      if (!Number.isSafeInteger(interval) || interval < 3000) throw new TypeError('icarus: poll interval must be at least 3000 ms')
      if (input.adapter === 'search' && interval < 3_600_000) throw new TypeError('icarus: search polling interval must be at least one hour')
      if (input.config?.timeRange !== undefined && !['day','week','month','year'].includes(input.config.timeRange)) throw new TypeError('icarus: invalid search timeRange')
      if (input.config?.maxResults !== undefined && (!Number.isInteger(input.config.maxResults) || input.config.maxResults < 1 || input.config.maxResults > 20)) throw new TypeError('icarus: invalid search maxResults')
      if (input.config?.site !== undefined && new URL(`https://${input.config.site}`).hostname !== input.config.site) throw new TypeError('icarus: site must be a hostname')
      if (input.pageSize !== undefined && (!Number.isSafeInteger(input.pageSize) || input.pageSize < 1 || input.pageSize > 100)) throw new TypeError('icarus: source pageSize must be between 1 and 100')
      const id = newId('source')
      const now = Date.now()
      const config: SourceConfig = { ...input.config, sinceAt: input.sinceAt, pollIntervalMs: interval, ...(input.credentialRef === undefined ? {} : { credentialRef: input.credentialRef }), ...(input.pageSize === undefined ? {} : { pageSize: input.pageSize }) }
      if (input.adapter === 'search' && missions !== undefined) {
        const mission = missions.get(input.missionId)
        if (!mission.capabilityRequirements?.some(item => item.tool === 'icarus_web_search' && item.required)) missions.modify(mission.id, {
          capabilityRequirements: [...mission.capabilityRequirements ?? [], { provider: 'Icarus', tool: 'icarus_web_search', required: true, purpose: '搜索来源检索；DSH 插件 → Icarus → 联网搜索' }],
          searchBudget: mission.searchBudget ?? { perRun: 10, perMonth: 600 },
        })
      }
      db.prepare('INSERT INTO Source(id, missionId, adapter, locator, config, nextPollAt, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(id, input.missionId, input.adapter, input.locator, JSON.stringify(config), now, now)
      return get(id)
    }, get, list, poll,
    observations(sourceId, limit = 100, offset = 0) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000 || !Number.isSafeInteger(offset) || offset < 0) throw new TypeError('icarus: invalid observation pagination')
      return db.prepare('SELECT id, sourceId, nativeId, contentHash, publishedAt, observedAt, evidenceRef FROM Observation WHERE sourceId = ? ORDER BY observedAt, id LIMIT ? OFFSET ?').all<Observation>(sourceId, limit, offset)
    },
    evidence(observationId) {
      const row = db.prepare('SELECT evidenceRef FROM Observation WHERE id = ?').get<{ evidenceRef: string }>(observationId)
      if (row === undefined) throw new Error('icarus: observation not found')
      return JSON.parse(readArtifact(paths, row.evidenceRef)) as unknown
    },
    attempts: sourceId => db.prepare('SELECT * FROM SourceAttempt WHERE sourceId = ? ORDER BY startedAt, id').all(sourceId),
    requestBudget(sourceId) {
      const source = get(sourceId)
      if (source.adapter !== 'github') return null
      return db.prepare('SELECT nextRequestAt, requestLimit, remaining, resetAt, lastResponseAt FROM SourceRequestBudget WHERE budgetKey = ?').get(budgetKey(source)) ?? null
    },
    tick() {
      if (ticking !== undefined) return ticking
      const ids = db.prepare("SELECT Source.id FROM Source JOIN Mission ON Mission.id = Source.missionId WHERE Mission.status = 'active' AND Source.nextPollAt <= ? ORDER BY Source.nextPollAt, Source.lastCheckedAt, Source.id").all<{ id: string }>(Date.now())
      ticking = Promise.all(ids.map(row => poll(row.id))).finally(() => { ticking = undefined })
      return ticking
    },
    async dispose() { stopping.abort(); await Promise.all(active.values()); await ticking },
  }
}
