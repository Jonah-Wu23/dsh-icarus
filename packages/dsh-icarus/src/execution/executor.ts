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
import { SupersededError } from './runs.js'
import type { MissionRevision, MissionService } from '../domain/index.js'
import type { IcarusDatabase, IcarusPaths } from '../storage/index.js'
import type { IcarusContext, SessionEventLike } from '../types/host.js'
import type { OutboxService } from './outbox.js'
import type { Run, RunStore, TokenUsage } from './runs.js'

export const DEFAULT_LEASE_MS = 5 * 60_000
export const DEFAULT_EXECUTION_TIMEOUT_MS = 10 * 60_000
export const DEFAULT_DELIVERY_MAX_CHARS = 4_000
const MAX_EVIDENCE_LINKS = 20

export type ExecutionStatus = 'succeeded' | 'failed' | 'cancelled' | 'superseded' | 'abandoned' | 'skipped'

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

type TurnEnd =
  | { readonly kind: 'completed' }
  | { readonly kind: 'error'; readonly failure: FailureRecord }
  | { readonly kind: 'ended'; readonly reason: string }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'abandoned' }

/** One execution turn: the assistant text and usage it produced, and how it ended. */
class TurnTracker {
  readonly texts: string[] = []
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
      if (usage !== null) turn.usage = addUsage(turn.usage, usage)
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

  /** Failure record: the raw error plus whatever the Run had produced, never a rewrite of it. */
  function failureRecord(run: Run, kind: string, detail: string, raw: unknown): string {
    const sections = [
      `Icarus Run ${run.id} failed`,
      `time: ${new Date(now()).toISOString()}`,
      `kind: ${kind}`,
      `detail: ${detail}`,
      `mission: ${run.missionId} revision ${run.missionRevision} generation ${run.generation}`,
      '',
      'raw:',
      JSON.stringify(raw, null, 2),
    ]
    return sections.join('\n')
  }

  function fail(run: Run, usage: TokenUsage | null, kind: string, detail: string, raw: unknown): ExecutionOutcome {
    const ref = artifactRef('runs', run.id, 'error.txt')
    writeArtifact(paths, ref, failureRecord(run, kind, detail, raw))
    try {
      store.finish(run.id, options.instanceId, { status: 'failed', usage, errorRef: ref })
    } catch (error) {
      if (error instanceof SupersededError) return { runId: run.id, status: 'superseded', detail: error.reason }
      throw error
    }
    return { runId: run.id, status: 'failed', detail }
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

  function deliverableText(text: string, ref: string, run: Run): string {
    const full = absoluteArtifactPath(paths, ref)
    const body = text.length <= deliveryMaxChars ? text : `${text.slice(0, deliveryMaxChars)}\n\n…（正文共 ${text.length} 字，完整内容见 ${full}）`
    return `${body}\n\n— Icarus｜Run ${run.id}｜Mission ${run.missionId} revision ${run.missionRevision}｜正文 ${text.length} 字｜完整记录：${full}`
  }

  async function complete(run: Run, turn: TurnTracker): Promise<ExecutionOutcome> {
    const text = turn.texts.join('\n\n').trim()
    if (missions.get(run.missionId).status === 'cancelled') {
      store.finish(run.id, options.instanceId, { status: 'cancelled', usage: turn.usage, errorRef: null })
      return { runId: run.id, status: 'cancelled', detail: 'the Mission was cancelled while the Run was in flight' }
    }
    const revision = snapshotOf(run.missionId, run.missionRevision)
    const check = checkDeliverable(text, revision.requirements)
    if (!check.passed) return fail(run, turn.usage, 'requirement-check', check.failures.join('; '), { text, check })
    const bodyRef = artifactRef('runs', run.id, 'deliverable.md')
    writeArtifact(paths, bodyRef, text)
    const commit = store.commit(run.id, options.instanceId, {
      deliverable: {
        id: newId('deliverable'),
        content: deliverableText(text, bodyRef, run),
        contentHash: contentHash(text),
        requirementResults: check,
        artifactRefs: [bodyRef],
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
      if (end.kind === 'timeout') return fail(claimed, turn.usage, 'turn-timeout', `no turn/end within ${timeoutMs} ms`, { sessionId: turn.sessionId })
      if (end.kind === 'ended') return fail(claimed, turn.usage, 'turn-ended', `turn ended with reason ${end.reason}`, { sessionId: turn.sessionId, reason: end.reason })
      if (end.kind === 'error') return fail(claimed, turn.usage, 'turn-error', end.failure.message, { sessionId: turn.sessionId, failure: end.failure })
      return await complete(claimed, turn)
    } catch (error) {
      if (disposed) return { runId, status: 'abandoned', detail: 'the plugin unloaded during the Run' }
      if (error instanceof SupersededError) return { runId, status: 'superseded', detail: error.reason }
      return fail(claimed, turn?.usage ?? null, 'execution-error', errorText(error), { sessionId: turn?.sessionId ?? null })
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
