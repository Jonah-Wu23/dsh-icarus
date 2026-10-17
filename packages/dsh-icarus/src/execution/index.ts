// Execution layer assembly (M2.3): the Run store, the delivery Outbox, the executor and the
// scheduler, exposed to the host as `ctx.icarus.runs`.
//
// `runs.tick()` is the same pass the 60 s interval runs, so tests and manual checks drive the
// lifecycle deterministically instead of waiting for a due time.
import { errorText } from '../bridge/deliver.js'
import { newId as mintId } from '../domain/ids.js'
import { createExecutor, DEFAULT_EXECUTION_TIMEOUT_MS, DEFAULT_LEASE_MS } from './executor.js'
import { DELIVERY_TIMEOUT_MS, RETRY_DELAY_MS, createOutboxService } from './outbox.js'
import { createRunStore } from './runs.js'
import { DEFAULT_MAX_OUTPUT_TOKENS } from './model-budget.js'
import { DEFAULT_MAX_RUNS_PER_TICK, DEFAULT_TICK_MS, createScheduler } from './scheduler.js'
import { createSourceService } from '../sources/index.js'
import { createCapabilityService } from '../capabilities/index.js'
import { createContextService } from '../context/index.js'
import { createWindowService } from './windows.js'
import { createCurationService } from './curation.js'
import { createFeedbackService } from '../feedback/index.js'
import { createInvestigationService } from '../investigation/index.js'
import { createExplorationService } from '../investigation/exploration.js'
import type { SourceService } from '../sources/index.js'
import type { CapabilityService } from '../capabilities/index.js'
import type { ContextService } from '../context/index.js'
import type { WindowService } from './windows.js'
import type { CurationService } from './curation.js'
import type { FeedbackService } from '../feedback/index.js'
import type { InvestigationService } from '../investigation/index.js'
import type { ExplorationService } from '../investigation/exploration.js'
import { createFaultService } from './faults.js'
import type { FaultService } from './faults.js'
import type { MissionService } from '../domain/index.js'
import type { IcarusDatabase } from '../storage/index.js'
import type { IcarusContext } from '../types/host.js'
import type { Executor } from './executor.js'
import type { OutboxService } from './outbox.js'
import type { RecoveryReport, RunListFilter, RunStore, RunView } from './runs.js'
import type { Scheduler, TickReport } from './scheduler.js'

export { DEFAULT_ACCEPT_TIMEOUT_MS, DEFAULT_EXECUTION_TIMEOUT_MS, DEFAULT_LEASE_MS } from './executor.js'
export { DEFAULT_MAX_OUTPUT_TOKENS } from './model-budget.js'
export { DELIVERY_TIMEOUT_MS, OUTBOX_CHANNEL_BOT, OutboxNotFoundError, RETRY_DELAY_MS, createOutboxService } from './outbox.js'
export type { DeliveryAttempt, OutboxOptions, OutboxService, OutboxStatus } from './outbox.js'
export { APPROVAL_OUTCOMES, RunNotFoundError, RUN_STATUSES, SupersededError, createRunStore, spentTokens } from './runs.js'
export type { ApprovalOutcome, ApprovalRef, ApprovalRequest, CommitInput, DeliverableView, OutboxView, RecoveryReport as RunRecoveryReport, Run, RunBudgetView, RunListFilter, RunStatus, RunStore, RunStoreOptions, RunView, TokenUsage } from './runs.js'
export { DEFAULT_MAX_RUNS_PER_TICK, DEFAULT_TICK_MS, createScheduler } from './scheduler.js'
export type { Scheduler, SchedulerOptions, TickReport } from './scheduler.js'
export { createExecutor } from './executor.js'
export type { ExecutionOutcome, ExecutionStatus, Executor, ExecutorOptions } from './executor.js'
export { checkDeliverable } from './requirements.js'
export type { CheckReport, RequirementResult } from './requirements.js'

/** What the host reads at `ctx.icarus.runs`. */
export interface RunService {
  get(runId: string): RunView
  list(filter?: RunListFilter): RunView[]
  /** One scheduling pass: renew leases, enqueue due Missions, execute queued Runs. */
  tick(): Promise<TickReport>
}

export interface ExecutionOptions {
  readonly search?: import('../search/service.js').SearchService
  readonly maxOutputTokens?: number
  readonly userTokenBudget?: number | null
  readonly ctx: IcarusContext
  readonly database: IcarusDatabase
  readonly missions: MissionService
  /** Bot id or name that receives deliverables; defaults to `Chief`. */
  readonly bot?: string | undefined
  readonly dshHome?: string | undefined
  /** Lease owner id; minted per plugin load when omitted. */
  readonly instanceId?: string | undefined
  readonly now?: (() => number) | undefined
  readonly newId?: ((prefix: string) => string) | undefined
  /** When false the layer schedules nothing and runs no startup recovery. */
  readonly enabled?: boolean | undefined
  readonly tickMs?: number | undefined
  readonly leaseMs?: number | undefined
  readonly timeoutMs?: number | undefined
  readonly deliveryTimeoutMs?: number | undefined
  readonly maxRunsPerTick?: number | undefined
}

export interface IcarusExecution {
  readonly faults: FaultService
  readonly sources: SourceService
  readonly capabilities: CapabilityService
  readonly context: ContextService
  readonly windows: WindowService
  readonly curation: CurationService
  readonly feedback: FeedbackService
  readonly investigation: InvestigationService
  readonly exploration: ExplorationService
  readonly instanceId: string
  readonly runs: RunService
  /** Internals, for M2.4/M2.5 and for driving a lifecycle in tests. */
  readonly store: RunStore
  readonly outbox: OutboxService
  readonly executor: Executor
  readonly scheduler: Scheduler
  /** What the startup scan found. */
  readonly recovery: RecoveryReport
  /** Register the repeating pass (no-op when disabled). */
  start(): void
  dispose(): Promise<void>
}

export function createExecution(options: ExecutionOptions): IcarusExecution {
  const now = options.now ?? (() => Date.now())
  const newId = options.newId ?? mintId
  const instanceId = options.instanceId ?? newId('instance')
  const enabled = options.enabled ?? true
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS
  const tickMs = options.tickMs ?? DEFAULT_TICK_MS

  const store = createRunStore(options.database, { missions: options.missions, now, newId })
  const faults = createFaultService(options.database, options.missions)
  const sources = createSourceService(options.database, async ref => {
    const hit = await options.ctx.credentials.resolve(ref)
    if (hit === undefined || hit.value === '') throw new Error(`icarus: credential reference ${ref} is not configured`)
    return hit.value
  }, (source, result) => {
    if (result.status === 'succeeded') faults.clearSource(source.id)
    else if (result.errorRef !== undefined) faults.record({ missionId: source.missionId, kind: 'source', conditionKey: `source:${source.id}:${source.health.httpStatus ?? 'transport'}`,
      sourceId: source.id, errorRef: result.errorRef, detail: { message: `${source.adapter} 来源读取失败${source.health.httpStatus === undefined ? '' : `，HTTP ${source.health.httpStatus}`}。`, sourceId: source.id, nextAttemptAt: source.nextPollAt } })
  }, options.search, options.missions)
  const capabilities = createCapabilityService(options.ctx, options.database, options.missions, options.search)
  const context = createContextService(options.ctx, options.database, capabilities, options.dshHome)
  const feedback = createFeedbackService(options.database, { now })
  const investigation = createInvestigationService({ database: options.database, missions: options.missions, store, now, newId })
  const exploration = createExplorationService({ database: options.database, missions: options.missions, now, newId })
  const windows = createWindowService(options.database, options.missions, store, now, {
    latestPreference: missionId => feedback.latestPublished(missionId),
    pendingConsolidation: missionId => feedback.needsConsolidation().some(item => item.missionId === missionId),
  })
  const curation = createCurationService({ ctx: options.ctx, database: options.database, store, windows, sources, context, capabilities, instanceId, exploration })
  const outbox = createOutboxService({
    database: options.database,
    ctx: options.ctx,
    bot: options.bot ?? 'Chief',
    dshHome: options.dshHome,
    now,
    retryDelayMs: RETRY_DELAY_MS,
    timeoutMs: options.deliveryTimeoutMs ?? DELIVERY_TIMEOUT_MS,
    onSent: deliverableId => {
      if (options.database.db.prepare('SELECT purpose FROM Outbox WHERE deliverableId = ?').get<{ purpose: string }>(deliverableId)?.purpose === 'fault') return
      windows.delivered(deliverableId)
      const run = options.database.db.prepare('SELECT Run.missionId, Run.missionRevision FROM Deliverable JOIN Run ON Run.id = Deliverable.runId WHERE Deliverable.id = ?')
        .get<{ missionId: string; missionRevision: number }>(deliverableId)
      if (run === undefined) throw new Error('icarus: confirmed delivery has no Run')
      const mission = options.missions.get(run.missionId)
      if (mission.revision === run.missionRevision && mission.status !== 'cancelled' && mission.status !== 'completed') options.missions.recordDelivery(mission.id)
      // A proactive child investigation settles its reserved weekly allocation on delivery.
      if (exploration.findLaunch(run.missionId) !== undefined) exploration.settle(run.missionId)
    },
  })
  const executor = createExecutor({
    search: options.search,
    curation,
    feedback,
    investigation,
    exploration,
    windows,
    capabilities,
    faults,
    ctx: options.ctx,
    database: options.database,
    paths: options.database.paths,
    store,
    missions: options.missions,
    outbox,
    instanceId,
    now,
    newId,
    leaseMs,
    timeoutMs: options.timeoutMs ?? DEFAULT_EXECUTION_TIMEOUT_MS,
    maxOutputTokens: options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
    userTokenBudget: options.userTokenBudget ?? null,
  })
  function queueConsolidations(): void {
    for (const item of feedback.needsConsolidation()) {
      try {
        // A consolidation that already failed does not loop: a later feedback or an explicit
        // consolidate action is what queues the next attempt.
        const latest = options.database.db.prepare("SELECT status, createdAt FROM Run WHERE missionId = ? AND purpose = 'preference' ORDER BY createdAt DESC, generation DESC LIMIT 1").get<{ status: string; createdAt: number }>(item.missionId)
        if (latest !== undefined && ['failed', 'budget_exhausted', 'cancelled', 'superseded'].includes(latest.status)) {
          const newest = options.database.db.prepare(`SELECT MAX(Feedback.createdAt) AS at FROM Feedback JOIN Deliverable ON Deliverable.id = Feedback.deliverableId
            JOIN Run ON Run.id = Deliverable.runId WHERE Run.missionId = ? AND Feedback.status = 'recorded'`).get<{ at: number | null }>(item.missionId)?.at ?? null
          if (newest === null || newest <= latest.createdAt) continue
        }
        store.enqueuePurpose(item.missionId, 'preference', item.feedbackIds)
      } catch (error) { options.ctx.logger.warn('icarus: could not queue preference consolidation for %s: %s', item.missionId, errorText(error)) }
    }
  }
  const scheduler = createScheduler({
    enqueueWindows: () => { queueConsolidations(); return windows.scan() },
    database: options.database,
    store,
    executor,
    instanceId,
    logger: options.ctx.logger,
    now,
    leaseMs,
    maxRunsPerTick: options.maxRunsPerTick ?? DEFAULT_MAX_RUNS_PER_TICK,
  })
  const unsubscribe = options.missions.subscribe(mission => executor.missionChanged?.(mission))

  const recovery: RecoveryReport = { superseded: [], requeued: [] }
  let interval: (() => void) | undefined
  let sourceInterval: (() => void) | undefined
  let deliveryInterval: (() => void) | undefined
  let recoveryInterval: (() => void) | undefined
  let pendingRefresh: Promise<void> | undefined
  let running = false
  let pendingTick: Promise<TickReport> | undefined

  function tick(): Promise<TickReport> {
    if (pendingTick !== undefined) return pendingTick
    pendingTick = scheduler.tick().finally(() => { pendingTick = undefined })
    return pendingTick
  }

  return {
    sources, capabilities, context, windows, curation, feedback, investigation, exploration, faults,
    instanceId,
    runs: { get: runId => store.get(runId), list: filter => store.list(filter), tick },
    store,
    outbox,
    executor,
    scheduler,
    recovery,
    start() {
      if (!enabled || interval !== undefined) return
      const poll = () => { void sources.tick().catch(error => options.ctx.logger.error('icarus: source scan failed: %s', errorText(error))) }
      const send = () => { void outbox.tick().catch(error => options.ctx.logger.error('icarus: delivery scan failed: %s', errorText(error))) }
      poll()
      send()
      sourceInterval = options.ctx.interval(poll, 1000)
      deliveryInterval = options.ctx.interval(send, 1000)
      const refresh = () => {
        if (pendingRefresh !== undefined) return
        pendingRefresh = faults.refresh(options.ctx, capabilities, windows)
          .catch(error => options.ctx.logger.error('icarus: capability recovery failed: %s', errorText(error)))
          .finally(() => { pendingRefresh = undefined })
      }
      refresh()
      recoveryInterval = options.ctx.interval(refresh, 30_000)
      void tick().catch(error => options.ctx.logger.error('icarus: startup recovery failed: %s', errorText(error)))
      let lastScan = now()
      interval = options.ctx.interval(() => {
        // Renewal stays outside the overlap guard: a Run that outlives several ticks must
        // keep its lease, while a still-running pass must not be started twice.
        scheduler.renewLeases()
        if (running || now() - lastScan < Math.min(tickMs, 1000)) return
        lastScan = now()
        running = true
        void tick()
          .catch(error => {
            options.ctx.logger.error('icarus: scheduling pass failed: %s', errorText(error))
          })
          .finally(() => {
            running = false
          })
      }, Math.min(tickMs, 1000, Math.max(1, Math.floor(leaseMs / 3))))
    },
    async dispose() {
      unsubscribe()
      interval?.()
      sourceInterval?.()
      deliveryInterval?.()
      recoveryInterval?.()
      await Promise.all([executor.dispose(), sources.dispose(), outbox.dispose()])
      await pendingRefresh
      await pendingTick
    },
  }
}
