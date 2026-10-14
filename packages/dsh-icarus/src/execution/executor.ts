// Executor: one claimed Run, driven through an Icarus-owned execution Session.
//
// Flow: claim → `sessionController.create({ cwd: workspaceDir })` → prompt carrying the
// pinned revision's objective/requirements → collect the turn from `session/event` →
// requirement check → Deliverable + artifact + Outbox(pending) → delivery attempt →
// `missions.recordDelivery`.
//
// Only Sessions this executor created are observed: the event listener keys on the Session
// id of a Run it started, so Bot chats and other plugins' Sessions never enter collection.
// A turn that ends with a non-completed reason, or does not end within the timeout, fails the
// Run with the raw reason; the Session is left running (M2.3 has no cancel call in the
// verified surface) and its later events are ignored once untracked.
import { randomUUID } from 'node:crypto'
import { errorText } from '../bridge/deliver.js'
import { newId as mintId } from '../domain/ids.js'
import { parseSchedule } from '../domain/schedule.js'
import { wallClockOf } from '../domain/timezone.js'
import { absoluteArtifactPath, artifactRef, contentHash, writeArtifact } from './artifacts.js'
import { OUTBOX_CHANNEL_BOT } from './outbox.js'
import { MIN_RESULT_CHARS, checkDeliverable } from './requirements.js'
import { APPROVAL_OUTCOMES, SupersededError, spentTokens } from './runs.js'
import type { Mission, MissionRevision, MissionService } from '../domain/index.js'
import type { IcarusDatabase, IcarusPaths } from '../storage/index.js'
import type { IcarusContext, SessionEventLike } from '../types/host.js'
import type { OutboxService } from './outbox.js'
import type { ApprovalOutcome, ApprovalRef, ApprovalRequest, Run, RunStore, TokenUsage } from './runs.js'

export const DEFAULT_LEASE_MS = 5 * 60_000
export const DEFAULT_EXECUTION_TIMEOUT_MS = 10 * 60_000
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
  /** Claim and run one Run. Never throws for a Run that simply lost its lease. */
  execute(runId: string): Promise<ExecutionOutcome>
  /** Run ids currently in flight on this instance. */
  active(): readonly string[]
  /** Plugin unload: settle pending turns without writing to the database. */
  dispose(): void
}

export interface ExecutorOptions {
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
 */
class TurnTracker {
  readonly texts: string[] = []
  readonly toolErrors: ToolErrorRecord[] = []
  /** Tool names by call id, so a tool error can name the tool it came from. */
  readonly callNames = new Map<string, string>()
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
  const deliveryMaxChars = options.deliveryMaxChars ?? DEFAULT_DELIVERY_MAX_CHARS
  const { ctx, store, missions, paths } = options
  const turns = new Map<string, TurnTracker>()
  let disposed = false

  ctx.on('session/event', (session, event) => {
    const sessionId = session?.id
    if (typeof sessionId !== 'string') return
    const turn = turns.get(sessionId)
    if (turn === undefined) return
    if (event.type === 'assistant/message') {
      const text = textOfMessage(event)
      if (text !== '') turn.texts.push(text)
      const usage = usageOfEvent(event)
      if (usage !== null) {
        turn.usage = addUsage(turn.usage, usage)
        try {
          // Progress, not the final word: a Run superseded or killed mid-flight must still
          // settle what it actually spent. A failed progress write must not break the host's
          // event dispatch, so it only warns.
          store.recordUsage(turn.runId, options.instanceId, turn.usage)
        } catch (error) {
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
        ctx.logger.warn('icarus: could not record approval %s for Run %s: %s', decision.requestId, turn.runId, errorText(error))
      }
      return
    }
    if (event.type === 'turn/end') turn.settle(endOfEvent(event))
  })

  function snapshotOf(missionId: string, revision: number): MissionRevision {
    const row = options.database.db
      .prepare(`SELECT missionId, revision, kind, objective, requirements, schedule, timezone, budget, authorizationRef, createdAt
        FROM MissionRevision WHERE missionId = ? AND revision = ?`)
      .get<RevisionRow>(missionId, revision)
    if (row === undefined) throw new Error(`icarus: Mission ${JSON.stringify(missionId)} has no revision ${revision} snapshot`)
    if (row.kind !== 'once' && row.kind !== 'recurring') throw new Error(`icarus: MissionRevision ${missionId}@${revision} has unknown kind ${JSON.stringify(row.kind)}`)
    const requirements = JSON.parse(row.requirements) as unknown
    if (!Array.isArray(requirements)) throw new Error(`icarus: MissionRevision ${missionId}@${revision} requirements are not an array`)
    return {
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
    try {
      return store.get(runId).approvalRefs
    } catch (error) {
      ctx.logger.warn('icarus: could not read the approval chain of Run %s: %s', runId, errorText(error))
      return []
    }
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
    const ref = artifactRef('runs', run.id, 'error.txt')
    writeArtifact(paths, ref, failureArchive(run, kind, detail, raw, turn))
    try {
      store.finish(run.id, options.instanceId, { status: 'failed', usage: turn?.usage ?? null, errorRef: ref })
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
      '必须逐条回应的要求。每条用一个 Markdown 二级标题「## <要求原文>」开头，标题下紧跟该条的回应正文：',
    ]
    if (revision.requirements.length === 0) lines.push('（本次委托没有逐条要求，直接给出成果正文）')
    else revision.requirements.forEach((requirement, index) => lines.push(`${index + 1}. ${requirement}`))
    lines.push(
      '',
      '输出约束：',
      `- 正文不少于 ${MIN_RESULT_CHARS} 字；`,
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
    const text = turn.texts.join('\n\n').trim()
    if (missions.get(run.missionId).status === 'cancelled') {
      store.finish(run.id, options.instanceId, { status: 'cancelled', usage: turn.usage, errorRef: null })
      return { runId: run.id, status: 'cancelled', detail: 'the Mission was cancelled while the Run was in flight' }
    }
    const revision = snapshotOf(run.missionId, run.missionRevision)
    const check = checkDeliverable(text, revision.requirements)
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
    const attempt = await options.outbox.attempt(commit.outboxId)
    if (attempt.status === 'sent') {
      try {
        missions.recordDelivery(run.missionId)
      } catch (error) {
        // The deliverable and the sent receipt are already durable; a status write that
        // refuses (for example an already completed once Mission) must not undo them.
        ctx.logger.error('icarus: Mission %s status not updated after delivery: %s', run.missionId, errorText(error))
      }
    }
    return { runId: run.id, status: 'succeeded', detail: `outbox ${attempt.status}` }
  }

  async function execute(runId: string): Promise<ExecutionOutcome> {
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
      const created = await ctx.sessionController.create({ cwd: paths.workspaceDir })
      store.attachSession(runId, options.instanceId, created.sessionId)
      turn = new TurnTracker(created.sessionId, runId)
      turns.set(created.sessionId, turn)
      const revision = snapshotOf(claimed.missionId, claimed.missionRevision)
      await ctx.sessionController.prompt({
        requestId: randomUUID(),
        sessionId: created.sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: promptOf(revision, claimed) }],
      })
      turn.armTimeout(timeoutMs)
      const end = await turn.done
      if (disposed || end.kind === 'abandoned') return { runId, status: 'abandoned', detail: 'the plugin unloaded while the turn was open' }
      if (end.kind === 'timeout') {
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
      return fail(claimed, turn ?? null, 'execution-error', errorText(error), {
        sessionId: turn?.sessionId ?? null,
        error: { name: errorName(error), message: errorText(error), stack: stackSummary(error) },
      })
    } finally {
      if (turn !== undefined) turns.delete(turn.sessionId)
    }
  }

  return {
    execute,
    active: () => [...turns.values()].map(turn => turn.runId),
    dispose: () => {
      disposed = true
      for (const turn of turns.values()) turn.settle({ kind: 'abandoned' })
      turns.clear()
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
