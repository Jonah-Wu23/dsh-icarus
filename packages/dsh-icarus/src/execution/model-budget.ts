import { Buffer } from 'node:buffer'
import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { inTransaction } from '../domain/index.js'
import type { IcarusDatabase } from '../storage/index.js'
import type { IcarusContext, ModelChunk, ModelRequest } from '../types/host.js'
import type { TokenUsage } from './runs.js'

export const DEFAULT_MAX_OUTPUT_TOKENS = 8192

export class BudgetExhaustedError extends Error {
  constructor(message: string) {
    super(`icarus: ${message}`)
    this.name = 'BudgetExhaustedError'
  }
}

interface Owner {
  readonly id: string
  readonly missionId: string
  readonly missionRevision: number
  readonly status: string
  readonly delivery: boolean
}

export interface ModelBudgetOptions {
  readonly ctx: IcarusContext
  readonly database: IcarusDatabase
  readonly maxOutputTokens: number
  readonly userTokenBudget: number | null
  readonly onBlocked: (runId: string, error: BudgetExhaustedError, purpose: string | undefined) => void
}

export function modelCallUsage(database: IcarusDatabase, runId: string): TokenUsage | null {
  const calls = database.db.prepare('SELECT usage FROM ModelCall WHERE runId = ? AND usage IS NOT NULL').all<{ usage: string }>(runId)
  if (calls.length === 0) return null
  const result: Record<string, number> = { inputTokens: 0, outputTokens: 0 }
  for (const call of calls) {
    const usage = JSON.parse(call.usage) as Record<string, number>
    for (const [key, value] of Object.entries(usage)) {
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) result[key] = (result[key] ?? 0) + value
    }
  }
  return result as unknown as TokenUsage
}

export function installModelBudget(options: ModelBudgetOptions): { stop(runId: string): void; dispose(): Promise<void> } {
  const { ctx, database } = options
  const { db } = database
  const admitted = new WeakSet<ModelRequest>()
  const activeSessions = new Map<string, Set<string>>()
  const pending = new Set<Promise<void>>()
  const pendingCounts = new Map<string, number>()
  const controllers = new Map<string, AbortController>()
  const provenance = new AsyncLocalStorage<Owner>()
  let disposed = false

  function ownerOf(request: ModelRequest): Owner | undefined {
    function promptOf(data: unknown): string | undefined {
      if (typeof data !== 'object' || data === null || !('source' in data)) return undefined
      const source = data.source
      if (typeof source !== 'object' || source === null || !('rpcId' in source)) return undefined
      return typeof source.rpcId === 'string' ? source.rpcId : undefined
    }
    function deliveryOf(prompt: unknown): Owner | undefined {
      if (typeof prompt !== 'string') return undefined
      const run = db.prepare(`SELECT Run.id, Run.missionId, Run.missionRevision, Run.status
        FROM Outbox JOIN Deliverable ON Deliverable.id = Outbox.deliverableId JOIN Run ON Run.id = Deliverable.runId
        WHERE Outbox.id = ?`).get<Omit<Owner, 'delivery'>>(prompt)
      return run === undefined ? undefined : { ...run, delivery: true }
    }
    let sessionId = request.sessionId
    const visited = new Set<string>()
    while (sessionId !== undefined && !visited.has(sessionId)) {
      visited.add(sessionId)
      const run = db.prepare('SELECT id, missionId, missionRevision, status FROM Run WHERE sessionId = ?').get<Omit<Owner, 'delivery'>>(sessionId)
      if (run !== undefined) return { ...run, delivery: false }
      const session = ctx.sessions.get(sessionId)
      if (session?.header.parentSession !== undefined) {
        const prior = db.prepare(`SELECT Run.id, Run.missionId, Run.missionRevision, Run.status FROM ModelCall
          JOIN Run ON Run.id = ModelCall.runId WHERE ModelCall.sessionId = ? ORDER BY ModelCall.rowid LIMIT 1`).get<Omit<Owner, 'delivery'>>(sessionId)
        if (prior !== undefined) return { ...prior, delivery: prior.status === 'succeeded' }
      }
      const events = session?.snapshotEvents() ?? []
      const start = events.findLastIndex(event => event.type === 'turn/start')
      const input = events.slice(Math.max(0, start)).findLast(event => event.type === 'user/message' && promptOf(event.data) !== undefined)
      const delivery = deliveryOf(promptOf(input?.data))
      if (delivery !== undefined) return delivery
      sessionId = session?.header.parentSession
    }
    if (request.sessionId !== undefined && ctx.sessions.get(request.sessionId) !== undefined) return provenance.getStore()
    return deliveryOf(request.messages?.findLast(message => message.role === 'user' && message.source?.rpcId !== undefined)?.source?.rpcId) ?? provenance.getStore()
  }

  async function reserve(owner: Owner, request: ModelRequest, output: number): Promise<string> {
    // UTF-8 字节数按每字节一个 token 预留，并为每条消息和工具留出协议开销。
    const messages = request.messages ?? []
    let attachment = false
    for (const message of messages) {
      for (const block of message.content) {
        if (typeof block === 'object' && block !== null && 'type' in block && (block.type === 'image' || block.type === 'file')) {
          attachment = true
        }
      }
    }
    let input = Buffer.byteLength(JSON.stringify({ messages, system: request.system, tools: request.tools }), 'utf8')
      + 1024 * (messages.length + (Array.isArray(request.tools) ? request.tools.length : 0) + 1)
    if (attachment) {
      if (typeof request.provider !== 'string' || typeof request.model !== 'string') throw new Error('icarus: attachment request has no model route')
      const info = await ctx.llm.resolveModelInfo(request.provider, request.model)
      if (info.contextWindow === undefined) throw new BudgetExhaustedError('attachment input has no route context bound')
      input = Math.max(input, info.contextWindow)
    }
    const reserved = input + output
    const id = randomUUID()
    inTransaction(database, () => {
      const mission = db.prepare('SELECT revision, status, budget, budgetUsed FROM Mission WHERE id = ?')
        .get<{ revision: number; status: string; budget: number | null; budgetUsed: number }>(owner.missionId)
      const run = db.prepare('SELECT status, leaseUntil FROM Run WHERE id = ?').get<{ status: string; leaseUntil: number | null }>(owner.id)
      if (mission === undefined || mission.revision !== owner.missionRevision || mission.status === 'cancelled'
        || run === undefined || (owner.delivery && run.status !== 'succeeded')
        || (!owner.delivery && (mission.status !== 'active' || (run.status !== 'running' && run.status !== 'awaiting_approval')
          || run.leaseUntil === null || run.leaseUntil <= Date.now()))) {
        throw new Error('icarus: model request belongs to an inactive or superseded execution')
      }
      const outstanding = db.prepare(`SELECT COALESCE(SUM(ModelCall.reservedTokens), 0) AS tokens FROM ModelCall
        JOIN Run ON Run.id = ModelCall.runId WHERE Run.missionId = ? AND ModelCall.status <> 'settled'`)
        .get<{ tokens: number }>(owner.missionId)?.tokens ?? 0
      if (mission.budget !== null && mission.budgetUsed + outstanding + reserved > mission.budget) {
        throw new BudgetExhaustedError(`request needs ${reserved} tokens; Mission has ${mission.budget - mission.budgetUsed - outstanding} available`)
      }
      if (options.userTokenBudget !== null) {
        const used = db.prepare('SELECT COALESCE(SUM(budgetUsed), 0) AS tokens FROM Mission').get<{ tokens: number }>()?.tokens ?? 0
        const pending = db.prepare("SELECT COALESCE(SUM(reservedTokens), 0) AS tokens FROM ModelCall WHERE status <> 'settled'").get<{ tokens: number }>()?.tokens ?? 0
        if (used + pending + reserved > options.userTokenBudget) throw new BudgetExhaustedError('user token budget cannot reserve this request')
      }
      db.prepare(`INSERT INTO ModelCall(id, runId, sessionId, purpose, reservedTokens, status, createdAt)
        VALUES (?, ?, ?, ?, ?, 'reserved', ?)`).run(id, owner.id, request.sessionId ?? '', request.purpose ?? (owner.delivery ? 'delivery' : 'execution'), reserved, Date.now())
    })
    return id
  }

  async function* meter(owner: Owner, request: ModelRequest, next: () => AsyncIterable<ModelChunk>): AsyncIterable<ModelChunk> {
    if (disposed) throw new Error('icarus: execution service is unloaded')
    let id: string | undefined
    const output = Math.min(request.maxTokens ?? options.maxOutputTokens, options.maxOutputTokens)
    const controller = controllers.get(owner.id) ?? new AbortController()
    controllers.set(owner.id, controller)
    const auxiliary = request.purpose !== undefined && request.purpose !== 'execution' && request.purpose !== 'delivery'
    let usage: ModelChunk['usage']
    let dispatched = false
    let resolve!: () => void
    const finished = new Promise<void>(done => { resolve = done })
    pending.add(finished)
    pendingCounts.set(owner.id, (pendingCounts.get(owner.id) ?? 0) + 1)
    try {
      controller.signal.throwIfAborted()
      if (!Number.isSafeInteger(output) || output <= 0) throw new TypeError('icarus: model output limit must be a positive integer')
      id = await reserve(owner, request, output)
      controller.signal.throwIfAborted()
      if (disposed) throw new Error('icarus: execution service unloaded before model dispatch')
      if (request.sessionId !== undefined && !auxiliary) {
        const sessions = activeSessions.get(owner.id) ?? new Set<string>()
        sessions.add(request.sessionId)
        activeSessions.set(owner.id, sessions)
      }
      let stream: AsyncIterable<ModelChunk>
      dispatched = true
      if (request.maxTokens === output && !auxiliary) stream = next()
      else {
        const signal = request.signal === undefined ? controller.signal : AbortSignal.any([request.signal, controller.signal])
        const bounded = { ...request, maxTokens: output, signal }
        admitted.add(bounded)
        stream = ctx.llm.stream(bounded)
      }
      for await (const chunk of stream) {
        if (chunk.type === 'usage') {
          if (chunk.usage === undefined || !Number.isSafeInteger(chunk.usage.inputTokens) || !Number.isSafeInteger(chunk.usage.outputTokens)
            || chunk.usage.inputTokens < 0 || chunk.usage.outputTokens < 0) throw new TypeError('icarus: model returned invalid usage counters')
          usage = chunk.usage
        }
        yield chunk
      }
      if (usage === undefined) throw new Error('icarus: model call ended without actual usage; reservation retained')
    } catch (error) {
      if (error instanceof BudgetExhaustedError) options.onBlocked(owner.id, error, request.purpose)
      throw error
    } finally {
      try {
        if (id !== undefined) {
          inTransaction(database, () => {
            if (!dispatched) {
              db.prepare("UPDATE ModelCall SET status = 'settled', endedAt = ? WHERE id = ?").run(Date.now(), id)
            } else if (usage === undefined) {
              db.prepare("UPDATE ModelCall SET status = 'unknown', endedAt = ? WHERE id = ?").run(Date.now(), id)
            } else {
              const spent = usage.inputTokens + usage.outputTokens
              db.prepare("UPDATE ModelCall SET status = 'settled', chargedTokens = ?, usage = ?, endedAt = ? WHERE id = ?")
                .run(spent, JSON.stringify(usage), Date.now(), id)
              db.prepare('UPDATE Mission SET budgetUsed = budgetUsed + ? WHERE id = ?').run(spent, owner.missionId)
              db.prepare('UPDATE Run SET usage = ? WHERE id = ?').run(JSON.stringify(modelCallUsage(database, owner.id)), owner.id)
            }
          })
        }
      } finally {
        resolve()
        pending.delete(finished)
        const count = (pendingCounts.get(owner.id) ?? 1) - 1
        if (count === 0) {
          pendingCounts.delete(owner.id)
          if (!controller.signal.aborted && !activeSessions.has(owner.id)) controllers.delete(owner.id)
        } else pendingCounts.set(owner.id, count)
      }
    }
  }

  ctx.on('llm/stream', (request, next) => {
    if (admitted.has(request)) return next()
    const owner = ownerOf(request)
    return owner === undefined ? next() : meter(owner, request, next)
  })
  ctx.on('agent/request', async ({ agent }, next) => {
    const config = await next()
    if (ownerOf({ sessionId: agent.session.id }) === undefined) return config
    const maximum = typeof config.maxTokens === 'number' ? config.maxTokens : options.maxOutputTokens
    return { ...config, maxTokens: Math.min(maximum, options.maxOutputTokens) }
  })
  ctx.on('tools/execute', (request, next) => {
    const owner = ownerOf(request.agent === undefined ? {} : { sessionId: request.agent.session.id })
    return owner === undefined ? next() : provenance.run(owner, next)
  })
  ctx.on('session/event', (session, event) => {
    if (event.type !== 'turn/end' || session.id === undefined) return
    for (const [runId, sessions] of activeSessions) {
      sessions.delete(session.id)
      if (sessions.size === 0) {
        activeSessions.delete(runId)
        if (!pendingCounts.has(runId) && !controllers.get(runId)?.signal.aborted) controllers.delete(runId)
      }
    }
  })
  return {
    stop(runId) {
      controllers.get(runId)?.abort()
      for (const sessionId of activeSessions.get(runId) ?? []) ctx.agents.get(sessionId)?.cancel({ kind: 'user' }, { keepInbox: true })
      activeSessions.delete(runId)
    },
    async dispose() {
      disposed = true
      for (const controller of controllers.values()) controller.abort()
      for (const sessions of activeSessions.values()) {
        for (const sessionId of sessions) ctx.agents.get(sessionId)?.cancel({ kind: 'user' }, { keepInbox: true })
      }
      activeSessions.clear()
      await Promise.all(pending)
      controllers.clear()
    },
  }
}
