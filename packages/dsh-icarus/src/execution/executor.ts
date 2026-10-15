// 固定 Mission revision 执行，核对成果后持久保存交付记录。
// 请求边界负责预留与结算预算；超时、修改及卸载通过宿主取消仍在运行的回合。
// 重启先核查宿主会话，已完成的回合沿用原成果提交。
import { randomUUID } from 'node:crypto'
import { errorText } from '../bridge/deliver.js'
import { newId as mintId } from '../domain/ids.js'
import { parseSchedule } from '../domain/schedule.js'
import { wallClockOf } from '../domain/timezone.js'
import { absoluteArtifactPath, artifactRef, contentHash, readArtifact, writeArtifact } from './artifacts.js'
import { OUTBOX_CHANNEL_BOT } from './outbox.js'
import { checkDeliverable, modelJson } from './requirements.js'
import { APPROVAL_OUTCOMES, SupersededError, spentTokens } from './runs.js'
import { BudgetExhaustedError, DEFAULT_MAX_OUTPUT_TOKENS, installModelBudget, modelCallUsage } from './model-budget.js'
import { parseBindings } from '../domain/bindings.js'
import { PreparationBlockedError } from './curation.js'
import type { MissionBindings } from '../domain/bindings.js'
import type { CurationService } from './curation.js'
import type { WindowService } from './windows.js'
import type { CapabilityService } from '../capabilities/index.js'
import type { FaultService } from './faults.js'
import type { Mission, MissionRevision, MissionService } from '../domain/index.js'
import type { IcarusDatabase, IcarusPaths } from '../storage/index.js'
import type { IcarusContext, SessionEventLike } from '../types/host.js'
import type { OutboxService } from './outbox.js'
import type { ApprovalOutcome, ApprovalRef, ApprovalRequest, Run, RunStore, TokenUsage } from './runs.js'

export const DEFAULT_LEASE_MS = 5 * 60_000
export const DEFAULT_EXECUTION_TIMEOUT_MS = 10 * 60_000
/** Bound on the host *admitting* a prompt; the turn itself is bounded by the execution timeout. */
export const DEFAULT_ACCEPT_TIMEOUT_MS = 30_000
export const DEFAULT_DELIVERY_MAX_CHARS = 4_000
const MAX_EVIDENCE_LINKS = 20
const MAX_TOOL_ERRORS = 20

export type ExecutionStatus = 'succeeded' | 'failed' | 'cancelled' | 'superseded' | 'budget_exhausted' | 'abandoned' | 'skipped'

export interface ExecutionOutcome {
  readonly runId: string
  readonly status: ExecutionStatus
  readonly detail: string
}

export interface Executor {
  leaseLost?(runId: string): void
  missionChanged?(mission: Mission): void
  recover?(): Promise<void>
  /** Claim and run one Run. Never throws for a Run that simply lost its lease. */
  execute(runId: string): Promise<ExecutionOutcome>
  /** Run ids currently in flight on this instance. */
  active(): readonly string[]
  /** Plugin unload: settle pending turns without writing to the database. */
  dispose(): Promise<void>
}

export interface ExecutorOptions {
  readonly curation: CurationService
  readonly windows: WindowService
  readonly capabilities: CapabilityService
  readonly faults: FaultService
  readonly maxOutputTokens?: number
  readonly userTokenBudget?: number | null
  readonly ctx: IcarusContext
  readonly database: IcarusDatabase
  readonly paths: IcarusPaths
  readonly store: RunStore
  readonly missions: MissionService
  readonly outbox: OutboxService
  readonly instanceId: string
  readonly now?: (() => number) | undefined
  readonly newId?: ((prefix: string) => string) | undefined
  readonly leaseMs?: number | undefined
  readonly timeoutMs?: number | undefined
  /** Bound on the host admitting the prompt; defaults to 30 s (`DEFAULT_ACCEPT_TIMEOUT_MS`). */
  readonly acceptTimeoutMs?: number | undefined
  readonly deliveryMaxChars?: number | undefined
}

interface FailureRecord {
  readonly code: string
  readonly message: string
  readonly status?: number | undefined
  readonly requestId?: string | undefined
}

/**
 * The Mission's budget at the moment a Run is claimed: the hard cap, what has been settled,
 * what this Run may therefore spend, and whether the gate is already shut. `reserved` is the
 * Run's own cap for the whole attempt (in memory only: with one execution at a time there is
 * nothing to publish, and M4's concurrency is what will need a persisted reservation).
 */
interface BudgetState {
  readonly budget: number | null
  readonly budgetUsed: number
  readonly reserved: number | null
  readonly exhausted: boolean
}

/** What a Run spent past the budget it had left; recorded, never used to discard the result. */
interface BudgetOvershoot {
  readonly reserved: number
  readonly spent: number
  readonly over: number
}

type TurnEnd =
  | { readonly kind: 'completed' }
  | { readonly kind: 'error'; readonly failure: FailureRecord }
  | { readonly kind: 'ended'; readonly reason: string }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'abandoned' }

/** One tool result the host marked as an error, kept raw for the failure archive. */
interface ToolErrorRecord {
  readonly callId: string | null
  readonly toolName: string | null
  readonly message: string
  /** `result.error.info` when the host attached one (a timeout carries `code: TOOL_TIMEOUT`). */
  readonly info?: unknown
}

/**
 * One execution turn: the assistant text and usage it produced, the tool errors it hit, and how
 * it ended. Approvals are not mirrored here — the store's chain is their single source of truth.
 *
 * Text is kept per segment, not as one running blob: a tool-using turn narrates between calls
 * ("now I'll write the file"), and that narration is not the deliverable. `resultText` returns
 * what arrived after the LAST tool result — the closing answer — or the last message of a turn
 * that called no tool at all.
 */
class TurnTracker {
  bookkeepingFailure: FailureRecord | null = null
  readonly texts: string[] = []
  readonly toolErrors: ToolErrorRecord[] = []
  /** Tool names by call id, so a tool error can name the tool it came from. */
  readonly callNames = new Map<string, string>()
  /** How many assistant texts had arrived when the last tool result landed; -1 before any. */
  private lastToolResultAt = -1
  usage: TokenUsage | null = null
  private settled = false
  private timer: TimerHandle | undefined
  private readonly resolve: (end: TurnEnd) => void
  readonly done: Promise<TurnEnd>

  constructor(readonly sessionId: string, readonly runId: string) {
    let resolve!: (end: TurnEnd) => void
    this.done = new Promise<TurnEnd>(settle => {
      resolve = settle
    })
    this.resolve = resolve
  }

  /** Bound what a runaway turn can put into the failure archive. */
  remember(error: ToolErrorRecord): void {
    if (this.toolErrors.length < MAX_TOOL_ERRORS) this.toolErrors.push(error)
  }

  /** Record one assistant text, in order. */
  say(text: string): void {
    this.texts.push(text)
  }

  /** Note that a tool result arrived: everything said so far is working narration. */
  sawToolResult(): void {
    this.lastToolResultAt = this.texts.length
  }

  /** The deliverable candidate: the segment after the last tool result, else the last message. */
  resultText(): string {
    const segment = this.lastToolResultAt < 0 ? this.texts.slice(-1) : this.texts.slice(this.lastToolResultAt)
    return segment.join('\n\n').trim()
  }

  settle(end: TurnEnd): void {
    if (this.settled) return
    this.settled = true
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
    this.resolve(end)
  }

  armTimeout(ms: number): void {
    if (this.settled) return
    this.timer = setTimeout(() => this.settle({ kind: 'timeout' }), ms)
  }
}

interface RevisionRow {
  readonly bindings: string
  readonly missionId: string
  readonly revision: number
  readonly kind: string
  readonly objective: string
  readonly requirements: string
  readonly schedule: string
  readonly timezone: string
  readonly budget: number | null
  readonly authorizationRef: string | null
  readonly createdAt: number
}

export function createExecutor(options: ExecutorOptions): Executor {
  const now = options.now ?? (() => Date.now())
  const newId = options.newId ?? mintId
  const timeoutMs = options.timeoutMs ?? DEFAULT_EXECUTION_TIMEOUT_MS
  const acceptTimeoutMs = options.acceptTimeoutMs ?? DEFAULT_ACCEPT_TIMEOUT_MS
  const deliveryMaxChars = options.deliveryMaxChars ?? DEFAULT_DELIVERY_MAX_CHARS
  const { ctx, store, missions, paths } = options
  const turns = new Map<string, TurnTracker>()
  const preparations = new Set<string>()
  /** Aborted on unload, so a prompt still being admitted does not outlive the plugin. */
  const unloading = new AbortController()
  let disposed = false
  const budgetFailures = new Map<string, Error>()
  const modelBudget = installModelBudget({
    ctx,
    database: options.database,
    maxOutputTokens: options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
    userTokenBudget: options.userTokenBudget ?? null,
    onBlocked: (runId, error, purpose) => {
      if (purpose !== 'session-title' && (preparations.has(runId) || [...turns.values()].some(turn => turn.runId === runId))) budgetFailures.set(runId, error)
      else ctx.logger.warn('icarus: Run %s auxiliary request refused: %s', runId, error.message)
    },
  })

  const submissions = new Map<string, { readonly runId: string; readonly key: string; readonly validate: (value: unknown) => void }>()
  ctx.tools.register({
    name: 'icarus_submit_step',
    description: '提交 Icarus 当前准备步骤的结构化结果。按本次步骤提供的结构填写 result；工具验证格式和证据引用，接受后结束回合。仅供当前 Icarus 执行会话调用。',
    parameters: { type: 'object', properties: { result: { type: 'object', additionalProperties: true } }, required: ['result'], additionalProperties: false },
    output: { schema: { type: 'object', properties: { accepted: { type: 'boolean' }, step: { type: 'string' } }, required: ['accepted', 'step'], additionalProperties: false },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args, exec) {
      const submission = exec.agent === undefined ? undefined : submissions.get(exec.agent.id)
      if (submission === undefined) throw new Error('icarus: no structured step is active in this Session')
      store.committable(submission.runId, options.instanceId)
      submission.validate(args.result)
      const serialized = JSON.stringify(args.result)
      const step = options.database.db.prepare('SELECT responseRef FROM RunStep WHERE runId = ? AND stepKey = ?').get<{ responseRef: string | null }>(submission.runId, submission.key)
      if (step === undefined) throw new Error('icarus: active preparation step is not persisted')
      if (step.responseRef !== null) {
        if (readArtifact(paths, step.responseRef) !== serialized) throw new Error('icarus: this step already accepted a different result')
      } else {
        const ref = writeArtifact(paths, `runs/${submission.runId}/steps/${contentHash(submission.key)}-response.txt`, serialized)
        options.database.db.prepare('UPDATE RunStep SET responseRef = ? WHERE runId = ? AND stepKey = ?').run(ref, submission.runId, submission.key)
      }
      return { accepted: true, step: submission.key }
    },
  })

  ctx.on('tools/post-execute', async (request, result, next) => {
    const decision = await next()
    const turn = request.agent === undefined ? undefined : turns.get(request.agent.id)
    if (turn === undefined || decision.kind !== 'accept' || Object.hasOwn(decision, 'value')) return decision
    const run = store.get(turn.runId)
    if (run.deliveryWindowId === null) return decision
    const content = decision.content ?? result.content
    const ref = options.capabilities.capture(run.missionId, run.id, request.agent!.id, request.callId, request.name, { ...result, content })
    return { ...decision, content: [...content, { type: 'text', text: JSON.stringify({ icarusEvidence: { ref, scope: 'tool_result', truncated: null, isError: result.isError === true } }) }] }
  })

  ctx.on('session/event', (session, event) => {
    const sessionId = session?.id
    if (typeof sessionId !== 'string') return
    const turn = turns.get(sessionId)
    if (turn === undefined) return
    if (event.type === 'assistant/message') {
      const text = textOfMessage(event)
      if (text !== '') turn.say(text)
      const usage = usageOfEvent(event)
      if (usage !== null) {
        turn.usage = addUsage(turn.usage, usage)
        try {
          // 保存实际进展；记账失败会取消回合并保留失败状态。
          store.recordUsage(turn.runId, options.instanceId, turn.usage)
        } catch (error) {
          turn.bookkeepingFailure = { code: 'ICARUS_BOOKKEEPING_ERROR', message: errorText(error) }
          modelBudget.stop(turn.runId)
          ctx.logger.warn('icarus: could not record partial usage for Run %s: %s', turn.runId, errorText(error))
        }
      }
      return
    }
    if (event.type === 'tool/call') {
      const callId = stringOf(event.data?.callId)
      const name = stringOf(event.data?.name)
      if (callId !== null && name !== null) turn.callNames.set(callId, name)
      return
    }
    if (event.type === 'tool/result') {
      const callId = stringOf(event.data?.callId)
      const result = event.data?.result
      if (callId !== null && isRecord(result) && Array.isArray(result.content)) {
        const run = store.get(turn.runId)
        options.capabilities.capture(run.missionId, run.id, sessionId, callId, turn.callNames.get(callId) ?? 'unknown', result as unknown as import('../types/host.js').ToolResult)
      }
      // Any tool result ends a narration segment: what follows it is the closing answer.
      turn.sawToolResult()
      // A rejected or timed-out tool call lands here as an error result; it is the raw material
      // the failure archive keeps, because the approval event itself carries no error detail.
      const failure = toolErrorOf(event, turn)
      if (failure !== null) turn.remember(failure)
      return
    }
    if (event.type === 'approval/asked') {
      const request = approvalRequestOf(event)
      if (request === null) return
      try {
        if (!store.markAwaitingApproval(turn.runId, options.instanceId, request)) {
          ctx.logger.warn('icarus: Run %s is no longer executing; approval %s was not bound', turn.runId, request.requestId)
        }
      } catch (error) {
        turn.bookkeepingFailure = { code: 'ICARUS_BOOKKEEPING_ERROR', message: errorText(error) }
        modelBudget.stop(turn.runId)
        // The host's dispatch must survive a failed bookkeeping write.
        ctx.logger.warn('icarus: could not bind approval %s to Run %s: %s', request.requestId, turn.runId, errorText(error))
      }
      return
    }
    if (event.type === 'approval/decided') {
      const decision = approvalDecisionOf(event)
      if (decision === null) return
      try {
        if (!store.recordApproval(turn.runId, options.instanceId, decision)) {
          ctx.logger.warn('icarus: approval %s of Run %s had no open request to close', decision.requestId, turn.runId)
        }
      } catch (error) {
        turn.bookkeepingFailure = { code: 'ICARUS_BOOKKEEPING_ERROR', message: errorText(error) }
        modelBudget.stop(turn.runId)
        ctx.logger.warn('icarus: could not record approval %s for Run %s: %s', decision.requestId, turn.runId, errorText(error))
      }
      return
    }
    if (event.type === 'turn/end') turn.settle(endOfEvent(event))
  })

  function snapshotOf(missionId: string, revision: number): MissionRevision {
    const row = options.database.db
      .prepare(`SELECT missionId, revision, kind, objective, requirements, schedule, timezone, budget, authorizationRef, createdAt, bindings
        FROM MissionRevision WHERE missionId = ? AND revision = ?`)
      .get<RevisionRow>(missionId, revision)
    if (row === undefined) throw new Error(`icarus: Mission ${JSON.stringify(missionId)} has no revision ${revision} snapshot`)
    if (row.kind !== 'once' && row.kind !== 'recurring') throw new Error(`icarus: MissionRevision ${missionId}@${revision} has unknown kind ${JSON.stringify(row.kind)}`)
    const requirements = JSON.parse(row.requirements) as unknown
    if (!Array.isArray(requirements)) throw new Error(`icarus: MissionRevision ${missionId}@${revision} requirements are not an array`)
    return {
      ...parseBindings(JSON.parse(row.bindings) as MissionBindings),
      missionId: row.missionId,
      revision: row.revision,
      kind: row.kind,
      objective: row.objective,
      requirements: requirements.filter((item): item is string => typeof item === 'string'),
      schedule: parseSchedule(JSON.parse(row.schedule) as unknown),
      timezone: row.timezone,
      budget: row.budget,
      authorizationRef: row.authorizationRef,
      createdAt: row.createdAt,
    }
  }

  /** The Run's approval chain as stored; a read failure must not swallow the failure itself. */
  function approvalsOf(runId: string): readonly ApprovalRef[] {
    return store.get(runId).approvalRefs
  }

  /**
   * The failure archive: everything the Run knows about why it failed, in a fixed order, written
   * only by a failure path. The approval chain is printed in full — request id, tool, outcome and
   * both timestamps per request — so a Run blocked by a refused approval is readable without the
   * host's Session log.
   */
  function failureArchive(run: Run, kind: string, detail: string, raw: unknown, turn: TurnTracker | null): string {
    const approvals = approvalsOf(run.id)
    const toolErrors = turn?.toolErrors ?? []
    return [
      `Icarus Run ${run.id} failure archive`,
      `time: ${new Date(now()).toISOString()}`,
      `kind: ${kind}`,
      `detail: ${detail}`,
      `mission: ${run.missionId} revision ${run.missionRevision} generation ${run.generation}`,
      `session: ${turn?.sessionId ?? run.sessionId ?? 'none'}`,
      `usage: ${JSON.stringify(turn?.usage ?? run.usage ?? null)}`,
      `progress: ${turn?.resultText() ?? ''}`,
      '',
      `approval chain (${approvals.length}):`,
      ...(approvals.length === 0 ? ['  none'] : approvals.map(approvalLine)),
      '',
      `tool errors (${toolErrors.length}):`,
      ...(toolErrors.length === 0 ? ['  none'] : toolErrors.map(toolErrorLine)),
      '',
      'raw:',
      JSON.stringify(raw, null, 2),
    ].join('\n')
  }

  function fail(run: Run, turn: TurnTracker | null, kind: string, detail: string, raw: unknown): ExecutionOutcome {
    run = store.get(run.id)
    store.committable(run.id, options.instanceId)
    const ref = artifactRef('runs', run.id, 'error.txt')
    writeArtifact(paths, ref, failureArchive(run, kind, detail, raw, turn))
    try {
      store.finish(run.id, options.instanceId, { status: 'failed', usage: turn?.usage ?? null, errorRef: ref })
      if (run.deliveryWindowId !== null) options.windows.failed(run.deliveryWindowId, { kind, detail, errorRef: ref, at: now() })
      if (kind !== 'sources') options.faults.record({ missionId: run.missionId, runId: run.id, kind, conditionKey: `preparation:${kind}`, errorRef: ref,
        detail: { message: detail.split('\n')[0], detail: raw } })
    } catch (error) {
      if (error instanceof SupersededError) return { runId: run.id, status: 'superseded', detail: error.reason }
      throw error
    }
    return { runId: run.id, status: 'failed', detail }
  }

  /** Budget of the Mission as the Run claims it. Read live: the cap is the current one, not the pinned revision's. */
  function budgetStateOf(mission: Mission): BudgetState {
    return {
      budget: mission.budget,
      budgetUsed: mission.budgetUsed,
      reserved: mission.budget === null ? null : mission.budget - mission.budgetUsed,
      exhausted: mission.budget !== null && mission.budgetUsed >= mission.budget,
    }
  }

  /**
   * The budget record left in `artifacts/`, one file per Run with two distinguishable kinds:
   * `budget-exhausted` is the gate refusing a Run before any model call,
   * `budget-overrun` is a Run that spent past what the Mission had left and still delivered.
   */
  function budgetNote(run: Run, gate: BudgetState, kind: 'exhausted' | 'overrun', spent: number): string {
    const overshoot = kind === 'overrun' && gate.reserved !== null ? Math.max(0, spent - gate.reserved) : 0
    return [
      kind === 'exhausted' ? `Icarus Run ${run.id} was refused on budget` : `Icarus Run ${run.id} overspent the remaining budget`,
      `time: ${new Date(now()).toISOString()}`,
      `kind: ${kind === 'exhausted' ? 'budget-exhausted' : 'budget-overrun'}`,
      `mission: ${run.missionId} revision ${run.missionRevision} generation ${run.generation}`,
      `budget: ${gate.budget ?? 'none'}`,
      `budgetUsed at claim: ${gate.budgetUsed}`,
      `reserved (remaining at claim): ${gate.reserved ?? 'none'}`,
      `spent this run: ${spent} tokens (input + output; cache read/write is recorded but not charged)`,
      `overshoot: ${overshoot}`,
      '',
      kind === 'exhausted'
        ? 'no model call was made: the Mission had no remaining budget when the Run was claimed, and the gate refuses every later Run until the budget is raised'
        : 'the turn finished, the requirement check passed and the result was persisted and delivered; the overspend is settled into Mission.budgetUsed, which shuts the gate for every later Run',
    ].join('\n')
  }

  /** Write the budget note and return its artifact ref. */
  function writeBudgetNote(run: Run, gate: BudgetState, kind: 'exhausted' | 'overrun', spent: number): string {
    const ref = artifactRef('runs', run.id, 'budget.txt')
    writeArtifact(paths, ref, budgetNote(run, gate, kind, spent))
    return ref
  }

  /** Gate shut before any model call: the Run ends exhausted without creating a Session. */
  function exhaust(run: Run, gate: BudgetState, detail: string): ExecutionOutcome {
    const ref = writeBudgetNote(run, gate, 'exhausted', 0)
    try {
      store.finish(run.id, options.instanceId, { status: 'budget_exhausted', usage: null, errorRef: ref })
      if (run.deliveryWindowId !== null) options.windows.failed(run.deliveryWindowId, { kind: 'budget_exhausted', errorRef: ref, at: now() })
    } catch (error) {
      if (error instanceof SupersededError) return { runId: run.id, status: 'superseded', detail: error.reason }
      throw error
    }
    return { runId: run.id, status: 'budget_exhausted', detail }
  }

  function promptOf(revision: MissionRevision, run: Run): string {
    const wall = wallClockOf(now(), revision.timezone)
    const pad = (value: number): string => String(value).padStart(2, '0')
    const lines = [
      'Icarus 执行会话：为下面的委托产出一次成果。只输出成果正文，不要复述本段要求。',
      '',
      `委托目标：${revision.objective}`,
      `委托类型：${revision.kind === 'once' ? '单次' : '循环'}`,
      `执行标识：Run ${run.id}（Mission revision ${revision.revision}）`,
      `当前本地时间：${wall.year}-${pad(wall.month)}-${pad(wall.day)} ${pad(wall.hour)}:${pad(wall.minute)}（${revision.timezone}）`,
      '',
      '请回应以下要求，按内容自然组织成果：',
    ]
    if (revision.requirements.length === 0) lines.push('（本次委托没有逐条要求，直接给出成果正文）')
    else revision.requirements.forEach((requirement, index) => lines.push(`${index + 1}. ${requirement}`))
    lines.push(
      '',
      '输出约束：',
      '- 至少给出一个可访问的来源链接，或以「来源：」开头的来源列表；',
      '- 不要解释这些格式要求。',
    )
    return lines.join('\n')
  }

  /**
   * The approvals that did not grant, as one delivery line: a refusal is not a reason to discard
   * a paid-for result, but it must never be delivered silently.
   */
  function refusalLine(refusals: readonly ApprovalRef[]): string {
    if (refusals.length === 0) return ''
    const detail = refusals.map(entry => `${entry.toolName}（${entry.outcome ?? 'open'}）`).join('、')
    return `\n\n⚠ 本次执行有 ${refusals.length} 次审批未获通过：${detail}；成果据此产出。`
  }

  function deliverableText(text: string, ref: string, run: Run, overshoot: BudgetOvershoot | null, refusals: readonly ApprovalRef[]): string {
    const full = absoluteArtifactPath(paths, ref)
    const body = text.length <= deliveryMaxChars ? text : `${text.slice(0, deliveryMaxChars)}\n\n…（正文共 ${text.length} 字，完整内容见 ${full}）`
    const budget = overshoot === null
      ? ''
      : `\n\n⚠ 本次执行超出剩余预算：可用 ${overshoot.reserved} tokens，实际 ${overshoot.spent}（超出 ${overshoot.over}）；Mission 累计用量已更新，后续 Run 会被预算闸门拦下。`
    return `${body}${budget}${refusalLine(refusals)}\n\n— Icarus｜Run ${run.id}｜Mission ${run.missionId} revision ${run.missionRevision}｜正文 ${text.length} 字｜完整记录：${full}`
  }

  async function complete(run: Run, turn: TurnTracker, gate: BudgetState): Promise<ExecutionOutcome> {
    store.committable(run.id, options.instanceId)
    const verificationStep = options.database.db.prepare('SELECT stepKey FROM RunStep WHERE runId = ? AND stepKey = ?').get(run.id, 'verify-legacy')
    const text = verificationStep === undefined ? turn.resultText() : readArtifact(paths, `runs/${run.id}/candidate.md`)
    writeArtifact(paths, `runs/${run.id}/candidate.md`, text)
    if (missions.get(run.missionId).status === 'cancelled') {
      store.finish(run.id, options.instanceId, { status: 'cancelled', usage: turn.usage, errorRef: null })
      return { runId: run.id, status: 'cancelled', detail: 'the Mission was cancelled while the Run was in flight' }
    }
    const revision = snapshotOf(run.missionId, run.missionRevision)
    const verification = await invokeStep(run, 'verify-legacy', `请核对成果是否满足用户目标及每项要求。\n目标：${revision.objective}\n要求：${JSON.stringify(revision.requirements)}\n成果：${text}\n实际证据：${JSON.stringify([...options.curation.evidenceFacts(run.id)].map(([ref, fact]) => ({ ref, ...fact })))}\n只返回 JSON：{"objective":{"passed":true,"reason":"具体判断依据","evidenceRefs":[]},"results":[{"requirement":"要求原文，按输入顺序","passed":true,"reason":"具体判断依据","evidenceRefs":[]}],"evidenceRefs":[],"readingClaims":[]}。判断不通过时 passed 为 false，并说明原因。引用只能使用上面的实际证据。`, now() + timeoutMs)
    const check = checkDeliverable(text, revision.requirements, modelJson(verification), options.curation.evidenceFacts(run.id))
    if (!check.passed) return fail(run, turn, 'requirement-check', check.failures.join('; '), { text, check })
    // A refusal is recorded, never a reason to drop the result: the turn is over and the call is
    // paid for, so the delivery carries the refusal line instead of the result disappearing.
    const refusals = approvalsOf(run.id).filter(entry => entry.outcome !== null && entry.outcome !== 'allowed-once')
    if (refusals.length > 0) {
      ctx.logger.warn('icarus: Run %s delivered with %d refused approval(s): %s', run.id, refusals.length, refusals.map(entry => `${entry.toolName}:${entry.outcome}`).join(', '))
    }
    // Spending past the remaining budget is recorded on the Run and in the delivered text, and
    // it settles into Mission.budgetUsed — which is what shuts the gate for every later Run.
    // The result itself is never destroyed: by the time this is known, the call is paid for.
    const spent = spentTokens(turn.usage)
    const overshoot = gate.reserved !== null && spent > gate.reserved
      ? { reserved: gate.reserved, spent, over: spent - gate.reserved }
      : null
    if (overshoot !== null) {
      ctx.logger.warn('icarus: Run %s spent %d tokens of the %d reserved for Mission %s', run.id, spent, overshoot.reserved, run.missionId)
    }
    const budgetRef = overshoot === null ? null : writeBudgetNote(run, gate, 'overrun', spent)
    const bodyRef = artifactRef('runs', run.id, 'deliverable.md')
    writeArtifact(paths, bodyRef, text)
    const commit = store.commit(run.id, options.instanceId, {
      deliverable: {
        id: newId('deliverable'),
        content: deliverableText(text, bodyRef, run, overshoot, refusals),
        contentHash: contentHash(text),
        requirementResults: check,
        artifactRefs: budgetRef === null ? [bodyRef] : [bodyRef, budgetRef],
        evidenceRefs: linksOf(text),
      },
      outboxId: newId('outbox'),
      channel: OUTBOX_CHANNEL_BOT,
      usage: turn.usage,
    })
    return { runId: run.id, status: 'succeeded', detail: `outbox pending ${commit.outboxId}` }
  }

  interface StepRow { readonly requestId: string; readonly promptRef: string; readonly responseRef: string | null }

  function replayStep(events: readonly SessionEventLike[], requestId: string): { readonly started: boolean; readonly text?: string } {
    const start = events.findIndex(event => event.type === 'user/message' && isRecord(event.data?.source) && event.data.source.rpcId === requestId)
    if (start < 0) return { started: false }
    const tracker = new TurnTracker('replay', 'replay')
    for (const event of events.slice(start)) {
      if (event.type === 'assistant/message') tracker.say(textOfMessage(event))
      if (event.type === 'tool/result') tracker.sawToolResult()
      if (event.type === 'turn/end') return endOfEvent(event).kind === 'completed' ? { started: true, text: tracker.resultText() } : { started: true }
    }
    return { started: true }
  }

  async function invokeStep(run: Run, key: string, prompt: string, deadline: number, validate?: (value: unknown) => void): Promise<string> {
    run = store.get(run.id)
    store.committable(run.id, options.instanceId)
    if (run.sessionId === null) throw new Error('icarus: preparation step requires a Session')
    const { db } = options.database
    let step = db.prepare('SELECT requestId, promptRef, responseRef FROM RunStep WHERE runId = ? AND stepKey = ?').get<StepRow>(run.id, key)
    if (step?.responseRef !== null && step?.responseRef !== undefined) return readArtifact(paths, step.responseRef)
    if (step !== undefined) {
      const observation = await ctx.sessionQuery.observeSession(run.sessionId, { projectionMode: 'none' })
      try {
        const replay = replayStep(observation.events, step.requestId)
        if (replay.text !== undefined) {
          const ref = writeArtifact(paths, `runs/${run.id}/steps/${contentHash(key)}-response.txt`, replay.text)
          db.prepare('UPDATE RunStep SET responseRef = ?, completedAt = ? WHERE runId = ? AND stepKey = ?').run(ref, now(), run.id, key)
          return replay.text
        }
        if (replay.started) throw new Error(`icarus: preparation step ${key} was interrupted; preserve its progress for a new attempt`)
      } finally { observation[Symbol.dispose]() }
      prompt = readArtifact(paths, step.promptRef)
    } else {
      const requestId = newId('step_prompt')
      const promptRef = writeArtifact(paths, `runs/${run.id}/steps/${contentHash(key)}-prompt.txt`, prompt)
      db.prepare('INSERT INTO RunStep(runId, stepKey, requestId, promptRef, createdAt) VALUES (?, ?, ?, ?, ?)').run(run.id, key, requestId, promptRef, now())
      step = { requestId, promptRef, responseRef: null }
    }
    db.prepare('UPDATE Run SET phase = ? WHERE id = ?').run(key, run.id)
    const tracker = new TurnTracker(run.sessionId, run.id)
    turns.set(run.sessionId, tracker)
    if (validate !== undefined) {
      submissions.set(run.sessionId, { runId: run.id, key, validate })
      prompt += '\n\n请调用 icarus_submit_step，通过 result 参数提交上述结构。工具接受后结束本回合。'
    }
    try {
      await ctx.sessionController.prompt({ requestId: step.requestId, sessionId: run.sessionId, mode: 'queue', content: [{ type: 'text', text: prompt }], clientTimeZone: snapshotOf(run.missionId, run.missionRevision).timezone },
        AbortSignal.any([unloading.signal, AbortSignal.timeout(Math.min(acceptTimeoutMs, Math.max(1, deadline - now())))]))
      tracker.armTimeout(Math.max(1, deadline - now()))
      const end = await tracker.done
      store.committable(run.id, options.instanceId)
      const mission = missions.get(run.missionId)
      if (mission.status !== 'active') throw new Error(`icarus: Mission is ${mission.status}`)
      const blocked = budgetFailures.get(run.id)
      if (blocked !== undefined) throw blocked
      if (tracker.bookkeepingFailure !== null) throw new Error(tracker.bookkeepingFailure.message)
      if (end.kind !== 'completed') {
        modelBudget.stop(run.id)
        throw new Error(`icarus: preparation ${key} ended: ${JSON.stringify(end)}`)
      }
      const submitted = db.prepare('SELECT responseRef FROM RunStep WHERE runId = ? AND stepKey = ?').get<{ responseRef: string | null }>(run.id, key)
      if (validate !== undefined && submitted?.responseRef == null) throw new Error(`icarus: step ${key} ended without submitting its structured result`)
      const text = validate === undefined ? tracker.resultText() : readArtifact(paths, submitted!.responseRef!)
      const ref = writeArtifact(paths, `runs/${run.id}/steps/${contentHash(key)}-response.txt`, text)
      db.prepare('UPDATE RunStep SET responseRef = ?, completedAt = ? WHERE runId = ? AND stepKey = ?').run(ref, now(), run.id, key)
      return text
    } finally { submissions.delete(run.sessionId); turns.delete(run.sessionId) }
  }

  async function executeCurated(run: Run): Promise<ExecutionOutcome> {
    preparations.add(run.id)
    try {
      const revision = snapshotOf(run.missionId, run.missionRevision)
      const created = await ctx.sessionController.create({ ...(run.sessionId === null ? {} : { sessionId: run.sessionId }), cwd: revision.workspaceRef ?? paths.workspaceDir })
      if (!store.attachSession(run.id, options.instanceId, created.sessionId)) throw new SupersededError(run.id, 'Session attachment lost its lease')
      const current = store.get(run.id)
      const deadline = now() + timeoutMs
      const signal = AbortSignal.any([unloading.signal, AbortSignal.timeout(timeoutMs)])
      const result = await options.curation.prepare(current, revision, (key, prompt, validate) => invokeStep(current, key, prompt, deadline, validate), signal)
      store.committable(run.id, options.instanceId)
      if ('suppressed' in result) {
        options.windows.suppress(current.deliveryWindowId!, current.id, options.instanceId, result.outcome)
        options.faults.clearPreparation(run.missionId, run.missionRevision)
        return { runId: current.id, status: 'succeeded', detail: 'window suppressed: no qualified content' }
      }
      const bodyRef = writeArtifact(paths, `runs/${run.id}/deliverable.md`, result.content)
      const refusals = approvalsOf(run.id).filter(item => item.outcome !== null && item.outcome !== 'allowed-once')
      const body = result.content.length <= deliveryMaxChars ? result.content
        : `${result.content.slice(0, deliveryMaxChars)}\n\n[阅读完整成果](${absoluteArtifactPath(paths, bodyRef)})`
      const commit = store.commit(run.id, options.instanceId, {
        deliverable: { id: newId('deliverable'), content: `${body}${refusalLine(refusals)}`, contentHash: contentHash(result.content),
          requirementResults: result.check, evidenceRefs: result.evidenceRefs, artifactRefs: [...result.artifactRefs, bodyRef] },
        outboxId: newId('outbox'), channel: OUTBOX_CHANNEL_BOT, usage: modelCallUsage(options.database, run.id), windowOutcomeRef: result.outcomeRef,
      })
      options.faults.clearPreparation(run.missionId, run.missionRevision)
      return { runId: run.id, status: 'succeeded', detail: `prepared; outbox pending ${commit.outboxId}` }
    } finally { preparations.delete(run.id) }
  }

  async function execute(runId: string): Promise<ExecutionOutcome> {
    if (disposed) return { runId, status: 'skipped', detail: 'execution service is unloaded' }
    const claimed = store.claim(runId, options.instanceId, options.leaseMs ?? DEFAULT_LEASE_MS)
    if (claimed === null) {
      const current = store.get(runId)
      return { runId, status: current.status === 'superseded' ? 'superseded' : 'skipped', detail: `run is ${current.status}` }
    }
    let turn: TurnTracker | undefined
    try {
      // Gate first: no Session, no prompt, no model call when the Mission has nothing left.
      const gate = budgetStateOf(missions.get(claimed.missionId))
      if (gate.exhausted) {
        return exhaust(claimed, gate, `no remaining budget (${gate.budgetUsed} of ${gate.budget} settled)`)
      }
      if (claimed.deliveryWindowId !== null) return await executeCurated(claimed)
      const revision = snapshotOf(claimed.missionId, claimed.missionRevision)
      const created = await ctx.sessionController.create({ cwd: revision.workspaceRef ?? paths.workspaceDir })
      store.attachSession(runId, options.instanceId, created.sessionId)
      turn = new TurnTracker(created.sessionId, runId)
      turns.set(created.sessionId, turn)
      // The second argument is required by the host gateway, which calls `signal.throwIfAborted()`
      // on it with no optional chain — omitting it fails the Run before the prompt is admitted.
      // The signal bounds admission only; the turn itself is bounded by `turn.armTimeout`.
      const acceptSignal = AbortSignal.any([unloading.signal, AbortSignal.timeout(acceptTimeoutMs)])
      await ctx.sessionController.prompt({
        requestId: randomUUID(),
        sessionId: created.sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: promptOf(revision, claimed) }],
      }, acceptSignal)
      turn.armTimeout(timeoutMs)
      const end = await turn.done
      if (disposed || end.kind === 'abandoned') return { runId, status: 'abandoned', detail: 'the plugin unloaded while the turn was open' }
      const current = missions.get(claimed.missionId)
      if (current.revision !== claimed.missionRevision) store.committable(runId, options.instanceId)
      if (current.status === 'cancelled' || current.status === 'paused') {
        store.finish(runId, options.instanceId, { status: 'cancelled', usage: turn.usage })
        return { runId, status: 'cancelled', detail: `Mission is ${current.status}` }
      }
      if (turn.bookkeepingFailure !== null) return fail(claimed, turn, 'bookkeeping-error', turn.bookkeepingFailure.message, turn.bookkeepingFailure)
      const blocked = budgetFailures.get(runId)
      if (blocked !== undefined) {
        const ref = artifactRef('runs', runId, 'budget.txt')
        writeArtifact(paths, ref, failureArchive(claimed, 'budget-exhausted', blocked.message, { progress: turn.resultText() }, turn))
        store.finish(runId, options.instanceId, { status: 'budget_exhausted', usage: turn.usage, errorRef: ref })
        return { runId, status: 'budget_exhausted', detail: blocked.message }
      }
      if (end.kind === 'timeout') {
        modelBudget.stop(runId)
        // A timeout with a request still open is named for what actually blocked the turn: the
        // host has no approval timer of its own, so our wall clock is what ends the wait.
        const waiting = approvalsOf(claimed.id).some(entry => entry.outcome === null)
        return waiting
          ? fail(claimed, turn, 'approval-timeout', `the turn was still waiting for an approval after ${timeoutMs} ms`, { sessionId: turn.sessionId })
          : fail(claimed, turn, 'turn-timeout', `no turn/end within ${timeoutMs} ms`, { sessionId: turn.sessionId })
      }
      if (end.kind === 'ended') return fail(claimed, turn, 'turn-ended', `turn ended with reason ${end.reason}`, { sessionId: turn.sessionId, reason: end.reason })
      if (end.kind === 'error') return fail(claimed, turn, 'turn-error', end.failure.message, { sessionId: turn.sessionId, failure: end.failure })
      return await complete(claimed, turn, gate)
    } catch (error) {
      if (disposed) return { runId, status: 'abandoned', detail: 'the plugin unloaded during the Run' }
      if (error instanceof SupersededError) return { runId, status: 'superseded', detail: error.reason }
      if (store.get(runId).status === 'succeeded') throw error
      const currentMission = missions.get(claimed.missionId)
      if (currentMission.status === 'paused' || currentMission.status === 'cancelled') {
        store.finish(runId, options.instanceId, { status: 'cancelled', usage: modelCallUsage(options.database, runId) })
        return { runId, status: 'cancelled', detail: `Mission is ${currentMission.status}` }
      }
      if (error instanceof BudgetExhaustedError || budgetFailures.has(runId)) {
        const ref = writeArtifact(paths, `runs/${runId}/budget.txt`, errorText(error))
        store.finish(runId, options.instanceId, { status: 'budget_exhausted', usage: modelCallUsage(options.database, runId), errorRef: ref })
        if (claimed.deliveryWindowId !== null) options.windows.failed(claimed.deliveryWindowId, { kind: 'budget_exhausted', errorRef: ref, at: now() })
        return { runId, status: 'budget_exhausted', detail: errorText(error) }
      }
      if (claimed.deliveryWindowId !== null && error instanceof PreparationBlockedError) {
        return fail(claimed, turn ?? null, error.kind, error.message, error.detail)
      }
      return fail(claimed, turn ?? null, 'execution-error', errorText(error), {
        sessionId: turn?.sessionId ?? null,
        error: { name: errorName(error), message: errorText(error), stack: stackSummary(error) },
      })
    } finally {
      if (turn !== undefined) turns.delete(turn.sessionId)
      budgetFailures.delete(runId)
    }
  }

  async function recover(): Promise<void> {
    const expired = store.list().filter(run => (run.status === 'running' || run.status === 'awaiting_approval')
      && (run.leaseUntil === null || run.leaseUntil <= now()) && ![...turns.values()].some(turn => turn.runId === run.id))
    for (const run of expired) {
      if (run.sessionId === null) continue
      const observation = await ctx.sessionQuery.observeSession(run.sessionId, { projectionMode: 'none' })
      try {
        const events = observation.events
        if (run.deliveryWindowId !== null) {
          const pending = options.database.db.prepare('SELECT requestId FROM RunStep WHERE runId = ? AND responseRef IS NULL').all<{ requestId: string }>(run.id)
          const interrupted = pending.some(step => { const replay = replayStep(events, step.requestId); return replay.started && replay.text === undefined })
          if (!interrupted) {
            const claimed = store.reclaim(run.id, options.instanceId, options.leaseMs ?? DEFAULT_LEASE_MS)
            if (claimed !== null) {
              try { await executeCurated(claimed) } catch (error) {
                if (!(error instanceof SupersededError)) fail(claimed, null, 'recovery-error', errorText(error), { phase: claimed.phase })
              }
            }
          } else if (ctx.sessions.get(run.sessionId) !== undefined) ctx.sessionController.cancel({ sessionId: run.sessionId })
          continue
        }
        const turn = new TurnTracker(run.sessionId, run.id)
        let end: TurnEnd | undefined
        for (const event of events) {
          if (event.type === 'assistant/message') turn.say(textOfMessage(event))
          if (event.type === 'tool/result') turn.sawToolResult()
          if (event.type === 'assistant/message' || event.type === 'assistant/attempt') {
            const usage = usageOfEvent(event)
            if (usage !== null) turn.usage = addUsage(turn.usage, usage)
          }
          if (event.type === 'turn/end') end = endOfEvent(event)
        }
        if (end?.kind === 'completed') {
          const claimed = store.reclaim(run.id, options.instanceId, options.leaseMs ?? DEFAULT_LEASE_MS)
          if (claimed === null) continue
          try {
            await complete(claimed, turn, budgetStateOf(missions.get(run.missionId)))
          } catch (error) {
            if (!(error instanceof SupersededError)) throw error
          }
        } else {
          // 保留宿主已写入的实际用量，再由代次恢复流程登记新的执行尝试。
          if (turn.usage !== null) {
            options.database.db.prepare('UPDATE Run SET usage = ? WHERE id = ?').run(JSON.stringify(turn.usage), run.id)
          }
          if (ctx.sessions.get(run.sessionId) !== undefined) ctx.sessionController.cancel({ sessionId: run.sessionId })
        }
      } finally {
        observation[Symbol.dispose]()
      }
    }
  }

  return {
    execute,
    recover,
    leaseLost: runId => { modelBudget.stop(runId) },
    missionChanged: mission => {
      if (mission.status === 'cancelled' || mission.status === 'completed') {
        options.database.db.prepare("UPDATE Run SET status = 'cancelled', endedAt = ? WHERE missionId = ? AND status = 'queued'")
          .run(now(), mission.id)
      }
      const runs = options.database.db.prepare('SELECT id, missionRevision FROM Run WHERE missionId = ?')
        .all<{ id: string; missionRevision: number }>(mission.id)
      for (const run of runs) {
        if (mission.status !== 'active' || mission.revision !== run.missionRevision) modelBudget.stop(run.id)
      }
    },
    active: () => [...new Set([...preparations, ...[...turns.values()].map(turn => turn.runId)])],
    dispose: async () => {
      disposed = true
      unloading.abort()
      const draining = modelBudget.dispose()
      for (const turn of turns.values()) turn.settle({ kind: 'abandoned' })
      turns.clear()
      await draining
    },
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function textOfMessage(event: SessionEventLike): string {
  const message = event.data?.message
  const content = isRecord(message) ? message.content : undefined
  if (!Array.isArray(content)) return ''
  return content
    .map(block => (isRecord(block) && block.type === 'text' && typeof block.text === 'string' ? block.text : ''))
    .filter(text => text !== '')
    .join('\n')
    .trim()
}

function usageOfEvent(event: SessionEventLike): TokenUsage | null {
  const direct = usageOf(event.data?.usage)
  if (direct !== null) return direct
  const stream = event.data?.stream
  if (!Array.isArray(stream)) return null
  for (const record of stream) {
    if (!isRecord(record)) continue
    const chunk = record.chunk
    if (isRecord(chunk) && chunk.type === 'usage') {
      const usage = usageOf(chunk.usage)
      if (usage !== null) return usage
    }
  }
  return null
}

function usageOf(value: unknown): TokenUsage | null {
  if (!isRecord(value)) return null
  const input = count(value.inputTokens)
  const output = count(value.outputTokens)
  if (input === null && output === null) return null
  const total = count(value.totalTokens)
  const cacheRead = count(value.cacheReadTokens)
  const cacheWrite = count(value.cacheWriteTokens)
  const reasoning = count(value.reasoningTokens)
  return {
    inputTokens: input ?? 0,
    outputTokens: output ?? 0,
    ...(total === null ? {} : { totalTokens: total }),
    ...(cacheRead === null ? {} : { cacheReadTokens: cacheRead }),
    ...(cacheWrite === null ? {} : { cacheWriteTokens: cacheWrite }),
    ...(reasoning === null ? {} : { reasoningTokens: reasoning }),
  }
}

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** Sum the parts a budget cares about; a field nobody reported stays absent. */
function addUsage(left: TokenUsage | null, right: TokenUsage): TokenUsage {
  if (left === null) return right
  const sum = (a: number | undefined, b: number | undefined): number | undefined => (a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0))
  const total = sum(left.totalTokens, right.totalTokens)
  const cacheRead = sum(left.cacheReadTokens, right.cacheReadTokens)
  const cacheWrite = sum(left.cacheWriteTokens, right.cacheWriteTokens)
  const reasoning = sum(left.reasoningTokens, right.reasoningTokens)
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    ...(total === undefined ? {} : { totalTokens: total }),
    ...(cacheRead === undefined ? {} : { cacheReadTokens: cacheRead }),
    ...(cacheWrite === undefined ? {} : { cacheWriteTokens: cacheWrite }),
    ...(reasoning === undefined ? {} : { reasoningTokens: reasoning }),
  }
}

function endOfEvent(event: SessionEventLike): TurnEnd {
  const reason = event.data?.reason
  if (!isRecord(reason) || typeof reason.kind !== 'string') return { kind: 'ended', reason: 'unknown' }
  if (reason.kind === 'completed') return { kind: 'completed' }
  if (reason.kind === 'error') {
    const failure = reason.error
    return {
      kind: 'error',
      failure: {
        code: isRecord(failure) && typeof failure.code === 'string' ? failure.code : 'unknown',
        message: isRecord(failure) && typeof failure.message === 'string' ? failure.message : 'the host reported an error without a message',
        ...(isRecord(failure) && typeof failure.status === 'number' ? { status: failure.status } : {}),
        ...(isRecord(failure) && typeof failure.requestId === 'string' ? { requestId: failure.requestId } : {}),
      },
    }
  }
  return { kind: 'ended', reason: reason.kind }
}

function linksOf(text: string): readonly string[] {
  const links = new Set<string>()
  for (const match of text.matchAll(/https?:\/\/[^\s)>\]"']+/gi)) {
    links.add(match[0])
    if (links.size >= MAX_EVIDENCE_LINKS) break
  }
  return [...links]
}

function stringOf(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

/** One `tool/result` the host marked as an error, read from the message it answers the call with. */
function toolErrorOf(event: SessionEventLike, turn: TurnTracker): ToolErrorRecord | null {
  const message = event.data?.message
  if (!isRecord(message) || message.isError !== true) return null
  const content = Array.isArray(message.content) ? message.content : []
  const text = content
    .map(block => (isRecord(block) && block.type === 'text' && typeof block.text === 'string' ? block.text : ''))
    .filter(part => part !== '')
    .join('\n')
    .trim()
  const callId = stringOf(message.toolCallId)
  return {
    callId,
    toolName: callId === null ? null : (turn.callNames.get(callId) ?? null),
    message: text === '' ? 'the host reported a tool error without text' : text,
    ...(event.data?.error === undefined ? {} : { info: event.data.error }),
  }
}

/** `approval/asked` payload: `{ id, toolName, callId?, reason? }`. */
function approvalRequestOf(event: SessionEventLike): ApprovalRequest | null {
  const requestId = stringOf(event.data?.id)
  const toolName = stringOf(event.data?.toolName)
  if (requestId === null || toolName === null) return null
  const callId = stringOf(event.data?.callId)
  const reason = stringOf(event.data?.reason)
  return {
    requestId,
    toolName,
    ...(callId === null ? {} : { callId }),
    ...(reason === null ? {} : { reason }),
  }
}

/** `approval/decided` payload: `{ id, outcome }` over the host's closed vocabulary. */
function approvalDecisionOf(event: SessionEventLike): { readonly requestId: string; readonly outcome: ApprovalOutcome } | null {
  const requestId = stringOf(event.data?.id)
  const outcome = event.data?.outcome
  if (requestId === null || !APPROVAL_OUTCOMES.includes(outcome as ApprovalOutcome)) return null
  return { requestId, outcome: outcome as ApprovalOutcome }
}

/** One line per request, the asked/decided pair complete: what the archive must not lose. */
function approvalLine(entry: ApprovalRef): string {
  const parts = [
    `requestId=${entry.requestId}`,
    `tool=${entry.toolName}`,
    ...(entry.callId === undefined ? [] : [`callId=${entry.callId}`]),
    `outcome=${entry.outcome ?? 'open'}`,
    `askedAt=${new Date(entry.askedAt).toISOString()}`,
    `decidedAt=${entry.decidedAt === null ? 'open' : new Date(entry.decidedAt).toISOString()}`,
  ]
  const reason = entry.reason === undefined ? '' : ` reason=${JSON.stringify(entry.reason)}`
  return `  - ${parts.join(' ')}${reason}`
}

function toolErrorLine(record: ToolErrorRecord): string {
  const info = record.info === undefined ? '' : ` info=${JSON.stringify(record.info)}`
  return `  - tool=${record.toolName ?? 'unknown'} callId=${record.callId ?? 'unknown'} error=${JSON.stringify(record.message)}${info}`
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error
}

/** The first frames of a stack, kept short: the archive records a summary, not a dump. */
function stackSummary(error: unknown): string | null {
  if (!(error instanceof Error) || typeof error.stack !== 'string') return null
  return error.stack.split('\n').slice(0, 4).join('\n')
}
