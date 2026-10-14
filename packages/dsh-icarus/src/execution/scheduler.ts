// Scheduler: the due-time scan, the queue drain and recovery.
//
// One pass (`tick`) does four things: renew the lease of every Run this instance is executing,
// heal Runs whose owner is gone, enqueue a Run for each Mission whose due time has arrived, then
// claim and execute queued Runs. Enqueue and claim each happen inside their own transaction, so a
// crash between them loses at most a wake-up: the Run row either exists once or not at all, and
// `UNIQUE (missionId, generation)` refuses a duplicate.
//
// Recovery runs on every pass, not only at load. The lease is the fence, so healing on each pass
// is what makes it the real one: a host that restarts inside the lease window leaves an unowned
// `running` Run whose lease expires a minute later, and nothing else would ever look at it again.
//
// M2.3 executes serially (`maxRunsPerTick`, default 1). Concurrency and its budget belong to
// M4; the guard in the interval callback keeps two passes from overlapping.
import { errorText } from '../bridge/deliver.js'
import { DEFAULT_LEASE_MS } from './executor.js'
import type { Logger } from '../types/host.js'
import type { IcarusDatabase } from '../storage/index.js'
import type { ExecutionOutcome, Executor } from './executor.js'
import type { RecoveryReport, RunStore } from './runs.js'

export const DEFAULT_TICK_MS = 60_000
export const DEFAULT_MAX_RUNS_PER_TICK = 1

export interface SchedulerOptions {
  readonly database: IcarusDatabase
  readonly store: RunStore
  readonly executor: Executor
  readonly instanceId: string
  readonly logger: Logger
  readonly now?: (() => number) | undefined
  readonly leaseMs?: number | undefined
  readonly maxRunsPerTick?: number | undefined
}

export interface TickReport {
  readonly at: number
  /** Run ids created by this pass. */
  readonly enqueued: readonly string[]
  readonly outcomes: readonly ExecutionOutcome[]
  /** Expired-lease Runs this pass superseded, and the fresh Runs it queued for them. */
  readonly recovered: RecoveryReport
  /** Failures of the pass itself, already logged. */
  readonly errors: readonly string[]
}

export interface Scheduler {
  /** One pass: renew leases, heal expired ones, enqueue due Missions, execute queued Runs. */
  tick(): Promise<TickReport>
  /** Renew the lease of every Run this instance is executing. */
  renewLeases(): void
  /** Startup recovery: expired-lease Runs become superseded plus a fresh queued Run. */
  recover(): RecoveryReport
}

export function createScheduler(options: SchedulerOptions): Scheduler {
  const now = options.now ?? (() => Date.now())
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS
  const maxRunsPerTick = Math.max(1, options.maxRunsPerTick ?? DEFAULT_MAX_RUNS_PER_TICK)
  const { database, store, executor, logger } = options

  function renewLeases(): void {
    for (const runId of executor.active()) {
      try {
        store.renew(runId, options.instanceId, leaseMs)
      } catch (error) {
        logger.warn('icarus: could not renew the lease of Run %s: %s', runId, errorText(error))
      }
    }
  }

  function dueMissionIds(): readonly string[] {
    return database.db
      .prepare("SELECT id FROM Mission WHERE status = 'active' AND nextDueAt IS NOT NULL AND nextDueAt <= ? ORDER BY nextDueAt, id")
      .all<{ id: string }>(now())
      .map(row => row.id)
  }

  function runRecovery(): RecoveryReport {
    const report = store.recoverExpired()
    if (report.superseded.length > 0) {
      logger.warn('icarus: recovery superseded %d Run(s) with an expired lease and re-queued %d', report.superseded.length, report.requeued.length)
    }
    return report
  }

  async function tick(): Promise<TickReport> {
    const at = now()
    const enqueued: string[] = []
    const outcomes: ExecutionOutcome[] = []
    const errors: string[] = []
    // Renewal first: this instance's own live Runs keep their lease, so the recovery that follows
    // cannot take a Run away from an executor that is still working on it.
    renewLeases()
    const recovered = runRecovery()

    for (const missionId of dueMissionIds()) {
      try {
        const run = store.enqueueDue(missionId)
        if (run !== null) enqueued.push(run.id)
      } catch (error) {
        const message = `enqueue for Mission ${missionId} failed: ${errorText(error)}`
        errors.push(message)
        logger.error('icarus: %s', message)
      }
    }

    const attempted = new Set<string>()
    const claimLimit = maxRunsPerTick * 3 + 3
    let executed = 0
    for (let round = 0; round < claimLimit && executed < maxRunsPerTick; round += 1) {
      const next = store.queuedIds().find(runId => !attempted.has(runId))
      if (next === undefined) break
      attempted.add(next)
      try {
        const outcome = await executor.execute(next)
        outcomes.push(outcome)
        // A Run that could not be claimed (lost, or stale and re-queued) costs no
        // execution budget: the fresh attempt it left behind is picked up in a later round.
        if (outcome.status !== 'skipped' && outcome.status !== 'superseded') executed += 1
      } catch (error) {
        const message = `Run ${next} failed to execute: ${errorText(error)}`
        errors.push(message)
        logger.error('icarus: %s', message)
      }
    }
    return { at, enqueued, outcomes, recovered, errors }
  }

  return {
    tick,
    renewLeases,
    recover: runRecovery,
  }
}
