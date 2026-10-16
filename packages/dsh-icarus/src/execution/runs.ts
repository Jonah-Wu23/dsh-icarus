// Run store: the persistence side of the execution lifecycle.
//
// generation — per Mission, `MAX(generation) + 1` computed inside the creating transaction.
// It is a monotonic attempt counter, not a global one: the unique constraint the schema
// carries is `(missionId, generation)`, so per-Mission numbering needs no extra state and no
// new table, and two Missions never couple through a shared counter. `missionRevision` is
// pinned at enqueue time to the Mission revision the Run was created for; every commit
// re-checks it against the Mission's current revision.
//
// lease — claiming a Run sets `leaseOwner = <instance id>` and `leaseUntil = now + leaseMs`.
// The owner renews it while executing. A commit needs all of: status `running`, the lease
// still owned by this instance, the lease not expired, and `missionRevision === Mission.revision`.
// Any failure marks the Run `superseded` (only while the lease is still ours) and the result
// is discarded. Startup recovery handles Runs whose owner died: an expired lease becomes
// `superseded` plus a fresh `queued` Run at the Mission's current revision.
//
// budget — every terminal transition writes the Run's status and adds its settled spend to
// `Mission.budgetUsed` in ONE transaction, and only the transaction that actually changed the
// status settles. That gives settlement exactly-once per Run without a marker column: the
// conditional `UPDATE ... WHERE status IN ('running', 'awaiting_approval')` (or the live-status
// update on the supersede path) can succeed only once, and a second attempt changes nothing and
// settles nothing. Spend is input + output tokens; cache read/write stay recorded in `usage` but
// do not count against the cap.
//
// approval — `awaiting_approval` is not a terminal state and not a different kind of execution:
// it is a wait inside the still-open turn, so a waiting Run keeps its lease, keeps recording
// usage, and may still commit. The host's audit pair (`approval/asked` then `approval/decided`)
// is folded into `Run.approvalRefs` by the executor; the store only owns the two writes that
// keep the status and the chain consistent, and both run in one transaction. Settlement is
// untouched: a decision is not a terminal transition, so an approval wait never charges twice.
import { newId as mintId } from '../domain/ids.js'
import { inTransaction } from '../domain/index.js'
import { nextDueAt } from '../domain/schedule.js'
import { modelCallUsage } from './model-budget.js'
import type { Mission, MissionService } from '../domain/index.js'
import type { IcarusDatabase } from '../storage/index.js'

export const RUN_STATUSES = ['queued', 'running', 'awaiting_approval', 'succeeded', 'failed', 'cancelled', 'superseded', 'budget_exhausted'] as const
export type RunStatus = (typeof RUN_STATUSES)[number]

/** Model usage as the host reported it; only the fields the host sent are kept. */
export interface TokenUsage {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly totalTokens?: number | undefined
  readonly cacheReadTokens?: number | undefined
  readonly cacheWriteTokens?: number | undefined
  readonly reasoningTokens?: number | undefined
}

/** Tokens a Mission's budget is charged for: input plus output only. */
export function spentTokens(usage: TokenUsage | null): number {
  if (usage === null) return 0
  return usage.inputTokens + usage.outputTokens
}

/** The host's closed approval vocabulary; `allowed-once` is the only grant. */
export const APPROVAL_OUTCOMES = ['allowed-once', 'rejected', 'cancelled', 'unavailable'] as const
export type ApprovalOutcome = (typeof APPROVAL_OUTCOMES)[number]

/** One host approval request seen in the execution Session, and how it settled. */
export interface ApprovalRef {
  /** `approval/asked.id` — the host's request id, the only identity the audit pair carries. */
  readonly requestId: string
  readonly toolName: string
  readonly callId?: string | undefined
  readonly reason?: string | undefined
  /** `null` while the request is open; the Run is `awaiting_approval` for exactly that long. */
  readonly outcome: ApprovalOutcome | null
  readonly askedAt: number
  readonly decidedAt: number | null
}

/** What the execution Session asked the host to approve, before any decision exists. */
export interface ApprovalRequest {
  readonly requestId: string
  readonly toolName: string
  readonly callId?: string | undefined
  readonly reason?: string | undefined
}

export interface Run {
  readonly deliveryWindowId: string | null
  readonly contextRef: string | null
  readonly capabilityRef: string | null
  readonly phase: string | null
  readonly id: string
  readonly missionId: string
  /** Mission revision this attempt was created for. */
  readonly missionRevision: number
  readonly preferenceRevision: number | null
  readonly status: RunStatus
  readonly sessionId: string | null
  readonly leaseOwner: string | null
  readonly leaseUntil: number | null
  readonly inputRefs: readonly string[]
  readonly usage: TokenUsage | null
  readonly errorRef: string | null
  /** Every approval the execution Session asked for, in order; open requests have `outcome: null`. */
  readonly approvalRefs: readonly ApprovalRef[]
  readonly generation: number
  readonly createdAt: number
  readonly startedAt: number | null
  readonly endedAt: number | null
}

export interface OutboxView {
  readonly purpose: 'deliverable' | 'fault'
  readonly id: string
  readonly deliverableId: string
  readonly channel: string
  readonly destinationRef: string | null
  readonly status: string
  readonly attemptCount: number
  readonly receiptRef: string | null
  readonly nextAttemptAt: number | null
}

export interface DeliverableView {
  readonly id: string
  readonly runId: string
  readonly content: string
  readonly contentHash: string
  readonly requirementResults: unknown
  readonly evidenceRefs: readonly string[]
  readonly artifactRefs: readonly string[]
  readonly createdAt: number
  readonly outbox: readonly OutboxView[]
}

export type RunView = Run & {
  readonly searchUsage: readonly { readonly provider: string; readonly calls: number; readonly units: number; readonly costDollars: number }[]
  readonly deliverables: readonly DeliverableView[]
  /** The owning Mission's budget, assembled for readers; `remaining` may go negative after an overspend. */
  readonly budget: RunBudgetView
}

export interface RunBudgetView {
  readonly budget: number | null
  readonly budgetUsed: number
  readonly reserved: number
  readonly remaining: number | null
}

export interface CommitInput {
  readonly windowOutcomeRef?: string
  readonly deliverable: {
    readonly id: string
    readonly content: string
    readonly contentHash: string
    readonly requirementResults: unknown
    readonly artifactRefs: readonly string[]
    readonly evidenceRefs: readonly string[]
  }
  readonly outboxId: string
  readonly channel: string
  readonly usage: TokenUsage | null
}

export interface CommitResult {
  readonly deliverableId: string
  readonly outboxId: string
}

export interface RecoveryReport {
  readonly superseded: readonly string[]
  readonly requeued: readonly string[]
}

export interface RunListFilter {
  readonly missionId?: string | undefined
  readonly status?: RunStatus | undefined
  readonly limit?: number | undefined
}

export interface RunStoreOptions {
  readonly missions: MissionService
  readonly now?: (() => number) | undefined
  readonly newId?: ((prefix: string) => string) | undefined
}

export interface RunStore {
  enqueueWindow(windowId: string): Run | null
  /** Create a queued Run for a Mission whose due time has arrived, and advance its due time. */
  enqueueDue(missionId: string): Run | null
  /** Queued Run ids, oldest first. */
  queuedIds(): string[]
  /** Claim a queued Run for this instance; null when it cannot be claimed. */
  claim(runId: string, instanceId: string, leaseMs: number): Run | null
  reclaim(runId: string, instanceId: string, leaseMs: number): Run | null
  renew(runId: string, instanceId: string, leaseMs: number): boolean
  attachSession(runId: string, instanceId: string, sessionId: string): boolean
  /** The Run, or a SupersededError naming why it may not commit. */
  committable(runId: string, instanceId: string): Run
  /** Terminal outcome of a claimed Run; the generation guard still applies. Settles the spend. */
  finish(runId: string, instanceId: string, outcome: { readonly status: 'failed' | 'cancelled' | 'budget_exhausted'; readonly usage: TokenUsage | null; readonly errorRef?: string | null }): Run
  /**
   * Record an open approval request and put the Run into `awaiting_approval`. False when this
   * instance no longer owns the Run in an executing status.
   */
  markAwaitingApproval(runId: string, instanceId: string, request: ApprovalRequest): boolean
  /**
   * Close one open request with the host's outcome. The Run goes back to `running` only when no
   * other request is still open — a decision is not a terminal transition.
   */
  recordApproval(runId: string, instanceId: string, decision: { readonly requestId: string; readonly outcome: ApprovalOutcome }): boolean
  /** Persist usage accumulated so far, so a Run superseded mid-flight still settles what it spent. */
  recordUsage(runId: string, instanceId: string, usage: TokenUsage | null): boolean
  /** Persist the deliverable and its pending Outbox row, mark the Run succeeded and settle. */
  commit(runId: string, instanceId: string, input: CommitInput): CommitResult
  /** Mark a Run superseded while this instance still owns it. */
  markSuperseded(runId: string, instanceId: string): boolean
  /** Startup recovery: expired-lease Runs across instances. */
  recoverExpired(): RecoveryReport
  get(runId: string): RunView
  list(filter?: RunListFilter): RunView[]
}

/** The Run may not commit: a newer revision exists, the lease is gone, or another instance owns it. */
export class SupersededError extends Error {
  constructor(readonly runId: string, readonly reason: string) {
    super(`icarus: Run ${JSON.stringify(runId)} cannot commit: ${reason}`)
    this.name = 'SupersededError'
  }
}

export class RunNotFoundError extends Error {
  constructor(runId: string) {
    super(`icarus: no Run ${JSON.stringify(runId)}`)
    this.name = 'RunNotFoundError'
  }
}

interface RunRow {
  readonly deliveryWindowId: string | null
  readonly contextRef: string | null
  readonly capabilityRef: string | null
  readonly phase: string | null
  readonly id: string
  readonly missionId: string
  readonly missionRevision: number
  readonly preferenceRevision: number | null
  readonly status: string
  readonly sessionId: string | null
  readonly leaseOwner: string | null
  readonly leaseUntil: number | null
  readonly inputRefs: string
  readonly usage: string | null
  readonly errorRef: string | null
  readonly approvalRefs: string
  readonly generation: number
  readonly createdAt: number
  readonly startedAt: number | null
  readonly endedAt: number | null
}

interface DeliverableRow {
  readonly id: string
  readonly runId: string
  readonly requirementResults: string
  readonly evidenceRefs: string
  readonly artifactRefs: string
  readonly content: string
  readonly contentHash: string
  readonly createdAt: number
}

interface OutboxRow {
  readonly purpose: 'deliverable' | 'fault'
  readonly id: string
  readonly deliverableId: string
  readonly channel: string
  readonly destinationRef: string | null
  readonly status: string
  readonly attemptCount: number
  readonly receiptRef: string | null
  readonly nextAttemptAt: number | null
}

const RUN_COLUMNS = `id, missionId, missionRevision, preferenceRevision, status, sessionId, leaseOwner, leaseUntil,
  inputRefs, usage, errorRef, approvalRefs, generation, createdAt, startedAt, endedAt, deliveryWindowId, contextRef, capabilityRef, phase`

/**
 * The statuses in which a Run is executing. An approval wait is one of them: the turn is still
 * open, the lease must keep being renewed, and the Run may still commit — only the terminal
 * transitions are gated on `running` becoming something else.
 */
const EXECUTING_STATUSES = `'running', 'awaiting_approval'`

export function createRunStore(database: IcarusDatabase, options: RunStoreOptions): RunStore {
  const now = options.now ?? (() => Date.now())
  const newId = options.newId ?? mintId
  const { db } = database

  function readRow(runId: string): RunRow | undefined {
    return db.prepare(`SELECT ${RUN_COLUMNS} FROM Run WHERE id = ?`).get<RunRow>(runId)
  }

  function rowOrThrow(runId: string): RunRow {
    const row = readRow(runId)
    if (row === undefined) throw new RunNotFoundError(runId)
    return row
  }

  /** Insert one queued Run at the Mission's current revision. Never opens its own transaction. */
  function insertQueued(mission: Mission, at: number, previous?: Pick<RunRow, 'deliveryWindowId' | 'inputRefs' | 'preferenceRevision' | 'contextRef'>): string {
    const next = db.prepare('SELECT COALESCE(MAX(generation), 0) + 1 AS next FROM Run WHERE missionId = ?').get<{ next: number }>(mission.id)
    const id = newId('run')
    db.prepare(`INSERT INTO Run (id, missionId, missionRevision, preferenceRevision, status, sessionId, leaseOwner, leaseUntil, inputRefs, usage, errorRef, approvalRefs, generation, createdAt, startedAt, endedAt)
      VALUES (?, ?, ?, NULL, 'queued', NULL, NULL, NULL, '[]', NULL, NULL, '[]', ?, ?, NULL, NULL)`)
      .run(id, mission.id, mission.revision, next?.next ?? 1, at)
    const preference = previous?.preferenceRevision ?? db.prepare('SELECT MAX(revision) AS revision FROM PreferenceRevision WHERE missionId = ?').get<{ revision: number | null }>(mission.id)?.revision ?? null
    db.prepare('UPDATE Run SET deliveryWindowId = ?, inputRefs = ?, preferenceRevision = ?, contextRef = ? WHERE id = ?')
      .run(previous?.deliveryWindowId ?? null, previous?.inputRefs ?? '[]', preference, previous?.contextRef ?? null, id)
    return id
  }

  function enqueueWindow(windowId: string): Run | null {
    return inTransaction(database, () => {
      const window = db.prepare('SELECT missionId, missionRevision, status FROM DeliveryWindow WHERE id = ?').get<{ missionId: string; missionRevision: number; status: string }>(windowId)
      if (window === undefined) throw new Error('icarus: delivery window not found')
      const mission = options.missions.get(window.missionId)
      if (window.status !== 'open' || mission.status !== 'active' || mission.revision !== window.missionRevision) return null
      if (db.prepare(`SELECT id FROM Run WHERE missionId = ? AND status IN ('queued', ${EXECUTING_STATUSES})`).get(mission.id) !== undefined) return null
      const previous = db.prepare('SELECT deliveryWindowId, inputRefs, preferenceRevision, contextRef FROM Run WHERE deliveryWindowId = ? ORDER BY generation DESC LIMIT 1')
        .get<Pick<RunRow, 'deliveryWindowId' | 'inputRefs' | 'preferenceRevision' | 'contextRef'>>(windowId)
      const id = insertQueued(mission, now(), previous ?? { deliveryWindowId: windowId, inputRefs: '[]', preferenceRevision: null, contextRef: null })
      return toRun(rowOrThrow(id))
    })
  }

  /**
   * Supersede a Run and settle what it spent. Never opens its own transaction: callers
   * already hold one (claim, recovery) or wrap the call (committable).
   */
  function supersedeRow(runId: string, instanceId: string | null, at: number): number {
    const row = db.prepare('SELECT missionId, usage FROM Run WHERE id = ?').get<{ missionId: string; usage: string | null }>(runId)
    if (row === undefined) return 0
    const result = instanceId === null
      ? db.prepare(`UPDATE Run SET status = 'superseded', endedAt = ? WHERE id = ? AND status IN ('queued', ${EXECUTING_STATUSES})`).run(at, runId)
      : db.prepare(`UPDATE Run SET status = 'superseded', endedAt = ? WHERE id = ? AND status IN (${EXECUTING_STATUSES}) AND leaseOwner = ?`).run(at, runId, instanceId)
    const changes = Number(result.changes)
    if (changes > 0) settle(row.missionId, row.usage, runId)
    return changes
  }

  /** Add one Run's settled spend to the Mission. Must run inside the transition's transaction. */
  function settle(missionId: string, usage: string | null, runId: string): void {
    if (db.prepare('SELECT id FROM ModelCall WHERE runId = ? LIMIT 1').get(runId) !== undefined) return
    const spend = spentTokens(usage === null ? null : (JSON.parse(usage) as TokenUsage))
    if (spend === 0) return
    db.prepare('UPDATE Mission SET budgetUsed = budgetUsed + ? WHERE id = ?').run(spend, missionId)
  }

  function budgetOf(missionId: string): RunBudgetView {
    const row = db.prepare('SELECT budget, budgetUsed FROM Mission WHERE id = ?').get<{ budget: number | null; budgetUsed: number }>(missionId)
    if (row === undefined) throw new Error(`icarus: Run points at missing Mission ${JSON.stringify(missionId)}`)
    const reserved = db.prepare(`SELECT COALESCE(SUM(ModelCall.reservedTokens), 0) AS tokens FROM ModelCall
      JOIN Run ON Run.id = ModelCall.runId WHERE Run.missionId = ? AND ModelCall.status <> 'settled'`).get<{ tokens: number }>(missionId)?.tokens ?? 0
    return { budget: row.budget, budgetUsed: row.budgetUsed, reserved, remaining: row.budget === null ? null : row.budget - row.budgetUsed - reserved }
  }

  function deliverablesOf(runId: string): DeliverableView[] {
    return db
      .prepare('SELECT id, runId, requirementResults, evidenceRefs, artifactRefs, content, contentHash, createdAt FROM Deliverable WHERE runId = ? ORDER BY createdAt')
      .all<DeliverableRow>(runId)
      .map(row => ({
        id: row.id,
        runId: row.runId,
        content: row.content,
        contentHash: row.contentHash,
        requirementResults: JSON.parse(row.requirementResults) as unknown,
        evidenceRefs: parseRefs(row.evidenceRefs),
        artifactRefs: parseRefs(row.artifactRefs),
        createdAt: row.createdAt,
        outbox: db
          .prepare('SELECT id, deliverableId, channel, destinationRef, status, attemptCount, receiptRef, nextAttemptAt, purpose FROM Outbox WHERE deliverableId = ? ORDER BY channel')
          .all<OutboxRow>(row.id)
          .map(outbox => ({ ...outbox })),
      }))
  }

  function view(row: RunRow): RunView {
    const searchUsage = db.prepare('SELECT provider, COUNT(*) AS calls, SUM(units) AS units, COALESCE(SUM(costDollars), 0) AS costDollars FROM SearchCall WHERE runId = ? GROUP BY provider')
      .all<{ provider: string; calls: number; units: number; costDollars: number }>(row.id)
    return { ...toRun(row), deliverables: deliverablesOf(row.id), budget: budgetOf(row.missionId), searchUsage }
  }

  function enqueueDue(missionId: string): Run | null {
    const at = now()
    return inTransaction(database, () => {
      const mission = options.missions.get(missionId)
      if (mission.status !== 'active') return null
      if (mission.deliveryPolicy !== undefined || db.prepare('SELECT id FROM Source WHERE missionId = ? LIMIT 1').get(missionId) !== undefined) return null
      if (mission.nextDueAt === null || mission.nextDueAt > at) return null
      if (db.prepare(`SELECT id FROM Run WHERE missionId = ? AND status IN ('queued', ${EXECUTING_STATUSES}) LIMIT 1`).get(missionId) !== undefined) return null
      const runId = insertQueued(mission, at)
      // A once Mission has no next occurrence, so clearing the due time is what keeps the
      // next tick from creating another Run. A recurring Mission rolls forward, so a
      // restart after downtime produces one catch-up Run rather than a backlog.
      const next = mission.schedule.kind === 'once' ? null : nextDueAt(mission.schedule, mission.timezone, at)
      db.prepare('UPDATE Mission SET nextDueAt = ? WHERE id = ?').run(next, mission.id)
      return toRun(rowOrThrow(runId))
    })
  }

  function claim(runId: string, instanceId: string, leaseMs: number): Run | null {
    const at = now()
    return inTransaction(database, () => {
      const row = readRow(runId)
      if (row === undefined || row.status !== 'queued') return null
      const mission = options.missions.get(row.missionId)
      if (mission.status !== 'active') {
        if (mission.status !== 'paused') db.prepare("UPDATE Run SET status = 'cancelled', endedAt = ? WHERE id = ? AND status = 'queued'").run(at, runId)
        return null
      }
      const executing = db.prepare(`SELECT id FROM Run WHERE missionId = ? AND status IN (${EXECUTING_STATUSES}) AND id <> ?`).get(row.missionId, runId)
      if (executing !== undefined) return null
      if (row.missionRevision !== mission.revision) {
        // The definition moved on while this attempt waited: refuse it and queue a fresh
        // attempt at the current revision instead of spending a model call on stale text.
        supersedeRow(runId, null, at)
        if (mission.status === 'active' && row.deliveryWindowId === null) insertQueued(mission, at)
        return null
      }
      const result = db.prepare(`UPDATE Run SET status = 'running', leaseOwner = ?, leaseUntil = ?, startedAt = ? WHERE id = ? AND status = 'queued'`)
        .run(instanceId, at + leaseMs, at, runId)
      if (Number(result.changes) === 0) return null
      return { ...toRun(row), status: 'running' as const, leaseOwner: instanceId, leaseUntil: at + leaseMs, startedAt: at }
    })
  }

  function committable(runId: string, instanceId: string): Run {
    const row = rowOrThrow(runId)
    const at = now()
    if ((row.status !== 'running' && row.status !== 'awaiting_approval') || row.leaseOwner !== instanceId || row.leaseUntil === null || row.leaseUntil <= at) {
      // Superseding settles too, so it commits before the refusal is raised.
      inTransaction(database, () => {
        supersedeRow(runId, instanceId, at)
      })
      throw new SupersededError(runId, `the lease is not held by ${instanceId} or has expired`)
    }
    const mission = options.missions.get(row.missionId)
    if (mission.revision !== row.missionRevision) {
      inTransaction(database, () => {
        supersedeRow(runId, instanceId, at)
      })
      throw new SupersededError(runId, `Mission revision is ${mission.revision}, the Run was created for ${row.missionRevision}`)
    }
    return toRun(row)
  }

  function recordUsage(runId: string, instanceId: string, usage: TokenUsage | null): boolean {
    usage = modelCallUsage(database, runId) ?? usage
    const result = db.prepare(`UPDATE Run SET usage = ? WHERE id = ? AND status IN (${EXECUTING_STATUSES}) AND leaseOwner = ?`)
      .run(usage === null ? null : JSON.stringify(usage), runId, instanceId)
    return Number(result.changes) > 0
  }

  /**
   * Append one open approval request and mark the Run as waiting. One transaction: the chain
   * gains the request only if the status write actually landed on a Run this instance owns,
   * so a request from a superseded execution is never recorded as if it were live.
   */
  function markAwaitingApproval(runId: string, instanceId: string, request: ApprovalRequest): boolean {
    const at = now()
    return inTransaction(database, () => {
      const row = readRow(runId)
      if (row === undefined || row.leaseOwner !== instanceId || (row.status !== 'running' && row.status !== 'awaiting_approval')) return false
      const chain: ApprovalRef[] = [...parseApprovals(row.approvalRefs), { ...request, outcome: null, askedAt: at, decidedAt: null }]
      const result = db.prepare(`UPDATE Run SET status = 'awaiting_approval', approvalRefs = ? WHERE id = ? AND status IN (${EXECUTING_STATUSES}) AND leaseOwner = ?`)
        .run(JSON.stringify(chain), runId, instanceId)
      return Number(result.changes) > 0
    })
  }

  /**
   * Close one open request with the outcome the host reported. The status follows the chain:
   * still-open siblings keep the Run in `awaiting_approval`, and only the last decision returns
   * it to `running`. No settle happens here — a decision is not a terminal transition.
   */
  function recordApproval(runId: string, instanceId: string, decision: { readonly requestId: string; readonly outcome: ApprovalOutcome }): boolean {
    const at = now()
    return inTransaction(database, () => {
      const row = readRow(runId)
      if (row === undefined || row.leaseOwner !== instanceId) return false
      const chain = [...parseApprovals(row.approvalRefs)]
      const index = chain.findIndex(item => item.requestId === decision.requestId && item.outcome === null)
      const open = chain[index]
      if (open === undefined) return false
      chain[index] = { ...open, outcome: decision.outcome, decidedAt: at }
      const status = chain.some(item => item.outcome === null) ? 'awaiting_approval' : 'running'
      const result = db.prepare(`UPDATE Run SET status = ?, approvalRefs = ? WHERE id = ? AND status IN (${EXECUTING_STATUSES}) AND leaseOwner = ?`)
        .run(status, JSON.stringify(chain), runId, instanceId)
      return Number(result.changes) > 0
    })
  }

  function finish(runId: string, instanceId: string, outcome: { readonly status: 'failed' | 'cancelled' | 'budget_exhausted'; readonly usage: TokenUsage | null; readonly errorRef?: string | null }): Run {
    committable(runId, instanceId)
    const at = now()
    return inTransaction(database, () => {
      const missionId = rowOrThrow(runId).missionId
      const usage = modelCallUsage(database, runId) ?? outcome.usage
      const result = db.prepare(`UPDATE Run SET status = ?, usage = ?, errorRef = ?, endedAt = ? WHERE id = ? AND status IN (${EXECUTING_STATUSES}) AND leaseOwner = ?`)
        .run(outcome.status, usage === null ? null : JSON.stringify(usage), outcome.errorRef ?? null, at, runId, instanceId)
      // Only the transaction that actually ended the Run charges the Mission.
      if (Number(result.changes) === 0) throw new SupersededError(runId, 'the Run is no longer running')
      settle(missionId, usage === null ? null : JSON.stringify(usage), runId)
      return toRun(rowOrThrow(runId))
    })
  }

  function commit(runId: string, instanceId: string, input: CommitInput): CommitResult {
    committable(runId, instanceId)
    const at = now()
    inTransaction(database, () => {
      const run = rowOrThrow(runId)
      const missionId = run.missionId
      const window = run.deliveryWindowId === null ? undefined : db.prepare('SELECT status, dueAt FROM DeliveryWindow WHERE id = ?').get<{ status: string; dueAt: number }>(run.deliveryWindowId)
      if (run.deliveryWindowId !== null && window?.status !== 'open') throw new SupersededError(runId, 'the delivery window is already finalized')
      const current = options.missions.get(missionId)
      if (current.status !== 'active' || current.revision !== run.missionRevision || run.leaseUntil === null || run.leaseUntil <= at) throw new SupersededError(runId, 'the Mission or lease changed before commit')
      db.prepare(`INSERT INTO Deliverable (id, runId, requirementResults, evidenceRefs, artifactRefs, content, contentHash, createdAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          input.deliverable.id,
          runId,
          JSON.stringify(input.deliverable.requirementResults),
          JSON.stringify(input.deliverable.evidenceRefs),
          JSON.stringify(input.deliverable.artifactRefs),
          input.deliverable.content,
          input.deliverable.contentHash,
          at,
        )
      db.prepare(`INSERT INTO Outbox (id, deliverableId, channel, destinationRef, status, attemptCount, receiptRef, nextAttemptAt, createdAt, updatedAt)
        VALUES (?, ?, ?, NULL, 'pending', 0, NULL, ?, ?, ?)`)
        .run(input.outboxId, input.deliverable.id, input.channel, window?.dueAt ?? at, at, at)
      if (run.deliveryWindowId !== null) db.prepare("UPDATE DeliveryWindow SET status = 'prepared', deliverableId = ?, outcomeRef = ? WHERE id = ? AND status = 'open'").run(input.deliverable.id, input.windowOutcomeRef ?? null, run.deliveryWindowId)
      const usage = modelCallUsage(database, runId) ?? input.usage
      const result = db.prepare(`UPDATE Run SET status = 'succeeded', usage = ?, endedAt = ? WHERE id = ? AND status IN (${EXECUTING_STATUSES}) AND leaseOwner = ?`)
        .run(usage === null ? null : JSON.stringify(usage), at, runId, instanceId)
      if (Number(result.changes) === 0) throw new SupersededError(runId, 'the Run stopped running before its deliverable was persisted')
      settle(missionId, usage === null ? null : JSON.stringify(usage), runId)
    })
    return { deliverableId: input.deliverable.id, outboxId: input.outboxId }
  }

  function recoverExpired(): RecoveryReport {
    const at = now()
    const superseded: string[] = []
    const requeued: string[] = []
    const rows = db
      .prepare(`SELECT ${RUN_COLUMNS} FROM Run WHERE status IN ('running', 'awaiting_approval') AND (leaseUntil IS NULL OR leaseUntil <= ?) ORDER BY createdAt`)
      .all<RunRow>(at)
    for (const row of rows) {
      inTransaction(database, () => {
        if (supersedeRow(row.id, null, at) === 0) return
        superseded.push(row.id)
        const mission = options.missions.get(row.missionId)
        if (mission.status !== 'active') return
        if (row.deliveryWindowId !== null) {
          const window = db.prepare('SELECT status, missionRevision FROM DeliveryWindow WHERE id = ?').get<{ status: string; missionRevision: number }>(row.deliveryWindowId)
          if (window?.status !== 'open' || window.missionRevision !== mission.revision) return
        }
        requeued.push(insertQueued(mission, at, row))
      })
    }
    return { superseded, requeued }
  }

  function get(runId: string): RunView {
    return view(rowOrThrow(runId))
  }

  function list(filter: RunListFilter = {}): RunView[] {
    const clauses: string[] = []
    const params: unknown[] = []
    if (filter.missionId !== undefined) {
      clauses.push('missionId = ?')
      params.push(filter.missionId)
    }
    if (filter.status !== undefined) {
      if (!RUN_STATUSES.includes(filter.status)) throw new TypeError(`icarus: unknown Run status ${JSON.stringify(filter.status)}`)
      clauses.push('status = ?')
      params.push(filter.status)
    }
    const where = clauses.length === 0 ? '' : ` WHERE ${clauses.join(' AND ')}`
    const limit = filter.limit === undefined ? '' : ` LIMIT ${Math.max(0, Math.trunc(filter.limit))}`
    return db.prepare(`SELECT ${RUN_COLUMNS} FROM Run${where} ORDER BY createdAt, id${limit}`).all<RunRow>(...params).map(view)
  }

  return {
    enqueueDue,
    enqueueWindow,
    queuedIds: () => db.prepare("SELECT Run.id FROM Run JOIN Mission ON Mission.id = Run.missionId WHERE Run.status = 'queued' AND Mission.status = 'active' ORDER BY Run.createdAt, Run.id").all<{ id: string }>().map(row => row.id),
    claim,
    reclaim: (runId, instanceId, leaseMs) => inTransaction(database, () => {
      const row = rowOrThrow(runId)
      const mission = options.missions.get(row.missionId)
      if (mission.status !== 'active' || mission.revision !== row.missionRevision) return null
      const at = now()
      const result = db.prepare(`UPDATE Run SET leaseOwner = ?, leaseUntil = ? WHERE id = ?
        AND status IN (${EXECUTING_STATUSES}) AND (leaseUntil IS NULL OR leaseUntil <= ?)`)
        .run(instanceId, at + leaseMs, runId, at)
      return Number(result.changes) === 0 ? null : toRun(rowOrThrow(runId))
    }),
    renew: (runId, instanceId, leaseMs) => {
      const at = now()
      return Number(db.prepare(`UPDATE Run SET leaseUntil = ? WHERE id = ? AND status IN (${EXECUTING_STATUSES}) AND leaseOwner = ? AND leaseUntil > ?`)
        .run(at + leaseMs, runId, instanceId, at).changes) > 0
    },
    attachSession: (runId, instanceId, sessionId) => Number(db.prepare(`UPDATE Run SET sessionId = ? WHERE id = ? AND status IN (${EXECUTING_STATUSES}) AND leaseOwner = ?`).run(sessionId, runId, instanceId).changes) > 0,
    committable,
    finish,
    markAwaitingApproval,
    recordApproval,
    recordUsage,
    commit,
    markSuperseded: (runId, instanceId) => inTransaction(database, () => supersedeRow(runId, instanceId, now()) > 0),
    recoverExpired,
    get,
    list,
  }
}

function parseRefs(json: string): readonly string[] {
  const parsed = JSON.parse(json) as unknown
  if (!Array.isArray(parsed)) throw new Error('icarus: stored ref list is not an array')
  return parsed.filter((item): item is string => typeof item === 'string')
}

/** Read the stored approval chain. A row written before 0002 holds the migration's `[]`. */
function parseApprovals(json: string): readonly ApprovalRef[] {
  const parsed = JSON.parse(json) as unknown
  if (!Array.isArray(parsed)) throw new Error('icarus: stored approval chain is not an array')
  return parsed.map(item => {
    if (typeof item !== 'object' || item === null) throw new Error('icarus: stored approval entry is not an object')
    const entry = item as Record<string, unknown>
    const outcome = entry.outcome
    if (outcome !== null && !APPROVAL_OUTCOMES.includes(outcome as ApprovalOutcome)) {
      throw new Error(`icarus: stored approval entry has unknown outcome ${JSON.stringify(outcome)}`)
    }
    if (typeof entry.requestId !== 'string' || typeof entry.toolName !== 'string') {
      throw new Error('icarus: stored approval entry is missing requestId or toolName')
    }
    return {
      requestId: entry.requestId,
      toolName: entry.toolName,
      ...(typeof entry.callId === 'string' ? { callId: entry.callId } : {}),
      ...(typeof entry.reason === 'string' ? { reason: entry.reason } : {}),
      outcome: (outcome ?? null) as ApprovalOutcome | null,
      askedAt: typeof entry.askedAt === 'number' ? entry.askedAt : 0,
      decidedAt: typeof entry.decidedAt === 'number' ? entry.decidedAt : null,
    }
  })
}

function toRun(row: RunRow): Run {
  if (!RUN_STATUSES.includes(row.status as RunStatus)) throw new Error(`icarus: Run ${JSON.stringify(row.id)} has unknown status ${JSON.stringify(row.status)}`)
  return {
    deliveryWindowId: row.deliveryWindowId,
    contextRef: row.contextRef,
    capabilityRef: row.capabilityRef,
    phase: row.phase,
    id: row.id,
    missionId: row.missionId,
    missionRevision: row.missionRevision,
    preferenceRevision: row.preferenceRevision,
    status: row.status as RunStatus,
    sessionId: row.sessionId,
    leaseOwner: row.leaseOwner,
    leaseUntil: row.leaseUntil,
    inputRefs: parseRefs(row.inputRefs),
    usage: row.usage === null ? null : (JSON.parse(row.usage) as TokenUsage),
    errorRef: row.errorRef,
    approvalRefs: parseApprovals(row.approvalRefs),
    generation: row.generation,
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
  }
}
