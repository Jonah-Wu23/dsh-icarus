// Icarus host plugin (M1 BotBridge + M2.2 Mission domain + M2.3 execution lifecycle).
//
// `apply` opens the Icarus database (migrations run on open), assembles the Mission service
// and the execution layer, and registers them as the `icarus` service: a plugin declaring
// `inject: ['icarus']` reads `ctx.icarus.missions` and `ctx.icarus.runs`. Registrations go
// through `ctx.provide`/`ctx.effect`/`ctx.interval`, so unload stops the scheduler, settles
// in-flight executions and closes the connection. No host package is imported at run time:
// the plugin is installed as a local path and resolves node built-ins only.
import { runDigest } from './demo/digest.js'
import { errorText } from './bridge/deliver.js'
import { createIcarusDomain } from './domain/index.js'
import { DEFAULT_MAX_OUTPUT_TOKENS, createExecution } from './execution/index.js'
import { openDatabase, exportMissionData, deleteMissionData } from './storage/index.js'
import { registerBotTools } from './bridge/tools.js'
import type { MissionService } from './domain/index.js'
import type { RunService } from './execution/index.js'
import type { IcarusContext } from './types/host.js'

export const name = 'dsh-icarus'
/** `sessionController` drives execution Sessions; `timer` supplies `ctx.interval`. */
export const inject = ['sessionController', 'timer', 'llm', 'sessions', 'sessionQuery', 'agents', 'tools', 'credentials']

export interface IcarusConfig {
  /** Bot id or name that receives deliveries; defaults to the Main Bot `Chief`. */
  readonly bot?: string | undefined
  /** DSH home holding `bot/state.json` and `icarus/`; defaults to `$DSH_HOME`, then `~/.dsh`. */
  readonly dshHome?: string | undefined
  readonly demo?: DemoConfig | undefined
  readonly execution?: ExecutionConfig | undefined
}

export interface DemoConfig {
  /** Run the arXiv demonstration delivery once per plugin load. */
  readonly onBoot?: boolean | undefined
  /** Submissions per digest; defaults to 5. */
  readonly maxResults?: number | undefined
}

export interface ExecutionConfig {
  readonly maxOutputTokens?: number
  readonly userTokenBudget?: number | null
  /** Scheduler, executor and startup recovery; defaults to true. */
  readonly enabled?: boolean | undefined
  /** Pass interval in milliseconds; defaults to 60000. */
  readonly intervalMs?: number | undefined
  /** Run lease length; renewed every pass; defaults to 300000. */
  readonly leaseMs?: number | undefined
  /** Wall-clock bound on one execution turn; defaults to 600000. */
  readonly timeoutMs?: number | undefined
  /** Bound on one delivery attempt; defaults to 30000. */
  readonly deliveryTimeoutMs?: number | undefined
  /** Runs executed per pass; defaults to 1 (M4 raises concurrency). */
  readonly maxRunsPerTick?: number | undefined
}

/** What the plugin publishes to the host as `ctx.icarus`. */
export interface IcarusService {
  readonly missions: MissionService
  readonly runs: RunService
  readonly sources: import('./sources/index.js').SourceService
  readonly capabilities: import('./capabilities/index.js').CapabilityService
  readonly windows: import('./execution/windows.js').WindowService
  readonly deliveries: import('./execution/outbox.js').OutboxService
  readonly faults: import('./execution/faults.js').FaultService
  readonly data: { exportMission(missionId: string): unknown; deleteMission(missionId: string): import('./storage/index.js').DeleteResult }
}

interface ResolvedExecutionConfig {
  readonly maxOutputTokens: number
  readonly userTokenBudget: number | null
  readonly enabled: boolean
  readonly intervalMs: number
  readonly leaseMs: number
  readonly timeoutMs: number
  readonly deliveryTimeoutMs: number
  readonly maxRunsPerTick: number
}

interface ResolvedDemoConfig {
  readonly onBoot: boolean
  readonly maxResults: number | undefined
}

interface ResolvedConfig {
  readonly bot: string
  readonly dshHome: string | undefined
  readonly demo: ResolvedDemoConfig
  readonly execution: ResolvedExecutionConfig
}

export function apply(ctx: IcarusContext, config: IcarusConfig = {}): void {
  const resolved = resolveConfig(config)
  const database = openDatabase({ dshHome: resolved.dshHome })
  const domain = createIcarusDomain(database)
  const execution = createExecution({
    ctx,
    database,
    missions: domain.missions,
    bot: resolved.bot,
    dshHome: resolved.dshHome,
    enabled: resolved.execution.enabled,
    tickMs: resolved.execution.intervalMs,
    leaseMs: resolved.execution.leaseMs,
    timeoutMs: resolved.execution.timeoutMs,
    deliveryTimeoutMs: resolved.execution.deliveryTimeoutMs,
    maxRunsPerTick: resolved.execution.maxRunsPerTick,
    maxOutputTokens: resolved.execution.maxOutputTokens,
    userTokenBudget: resolved.execution.userTokenBudget,
  })
  const service: IcarusService = { missions: domain.missions, runs: execution.runs, sources: execution.sources, capabilities: execution.capabilities, windows: execution.windows, deliveries: execution.outbox,
    faults: execution.faults, data: { exportMission: id => exportMissionData(database, id), deleteMission: id => deleteMissionData(database, id) } }
  ctx.provide('icarus', service)
  registerBotTools(ctx, service, execution, database, resolved.dshHome)
  ctx.effect(() => async () => {
    await execution.dispose()
    domain.close()
  }, 'icarus: execution and storage')
  execution.start()
  ctx.logger.info(
    'icarus: loaded (instance=%s, bot=%s, execution=%s, schema=v%d, data=%s)',
    execution.instanceId,
    resolved.bot,
    resolved.execution.enabled ? `every ${resolved.execution.intervalMs}ms` : 'off',
    database.schemaVersion,
    database.paths.dataDir,
  )
  if (execution.recovery.superseded.length > 0) {
    ctx.logger.warn('icarus: startup recovery superseded %d Run(s)', execution.recovery.superseded.length)
  }
  if (!resolved.demo.onBoot) return
  ctx.effect(() => {
    const controller = new AbortController()
    void runDigest(ctx, {
      bot: resolved.bot,
      dshHome: resolved.dshHome,
      maxResults: resolved.demo.maxResults,
      signal: controller.signal,
    }).catch(error => {
      // The failure keeps its original text and cause; nothing is delivered in its place.
      ctx.logger.error('icarus: boot digest failed: %s', errorText(error))
    })
    return () => controller.abort()
  }, 'icarus: demo boot delivery')
}

function resolveConfig(config: IcarusConfig): ResolvedConfig {
  const bot = config.bot ?? 'Chief'
  if (typeof bot !== 'string' || bot.trim() === '') throw new TypeError('icarus: config.bot must be a non-empty Bot id or name')
  const onBoot = config.demo?.onBoot ?? false
  if (typeof onBoot !== 'boolean') throw new TypeError('icarus: config.demo.onBoot must be a boolean')
  const maxResults = config.demo?.maxResults
  if (maxResults !== undefined && (!Number.isInteger(maxResults) || maxResults <= 0)) throw new TypeError('icarus: config.demo.maxResults must be a positive integer')
  return { bot: bot.trim(), dshHome: config.dshHome, demo: { onBoot, maxResults }, execution: resolveExecution(config.execution) }
}

function resolveExecution(config: ExecutionConfig | undefined): ResolvedExecutionConfig {
  const enabled = config?.enabled ?? true
  if (typeof enabled !== 'boolean') throw new TypeError('icarus: config.execution.enabled must be a boolean')
  return {
    enabled,
    maxOutputTokens: positive(config?.maxOutputTokens, DEFAULT_MAX_OUTPUT_TOKENS, 'config.execution.maxOutputTokens'),
    userTokenBudget: tokenBudget(config?.userTokenBudget),
    intervalMs: positive(config?.intervalMs, 60_000, 'config.execution.intervalMs'),
    leaseMs: positive(config?.leaseMs, 300_000, 'config.execution.leaseMs'),
    timeoutMs: positive(config?.timeoutMs, 600_000, 'config.execution.timeoutMs'),
    deliveryTimeoutMs: positive(config?.deliveryTimeoutMs, 30_000, 'config.execution.deliveryTimeoutMs'),
    maxRunsPerTick: positive(config?.maxRunsPerTick, 1, 'config.execution.maxRunsPerTick'),
  }
}

function tokenBudget(value: number | null | undefined): number | null {
  if (value === undefined || value === null) return null
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('icarus: config.execution.userTokenBudget must be a non-negative integer or null')
  return value
}

function positive(value: number | undefined, fallback: number, field: string): number {
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || value <= 0) throw new TypeError(`icarus: ${field} must be a positive integer`)
  return value
}
