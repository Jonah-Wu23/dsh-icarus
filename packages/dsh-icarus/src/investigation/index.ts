// Investigation service: the bounded inquiry Mission (M4.5/M4.6).
//
// An investigation is a Mission of its own, created from an origin deliverable item. The item,
// its deliverable excerpt and the evidence it cites are copied into a child artifact, so the
// inquiry stays readable after the parent Mission is gone. A code investigation additionally gets
// a git worktree up front and proves its work by re-running one verify command.
//
// Checkpoints are the resume points: two artifacts (summary, trace) plus one row. A retry starts a
// new investigation Run and links it to the Run whose checkpoint it resumes. Commands are recorded
// separately because the verification gate reads them: only a verify command that ran to exit code
// 0 after the last mutation counts.
import { MissionStateError } from '../domain/index.js'
import { newId } from '../domain/ids.js'
import { inTransaction } from '../domain/missions.js'
import { readArtifact, writeArtifact } from '../execution/artifacts.js'
import { captureWorktree, ensureWorktree } from './worktree.js'
import type { CapabilityRequirement, InvestigationBinding, MissionBindings } from '../domain/bindings.js'
import type { Mission, MissionRevision, MissionService } from '../domain/index.js'
import type { ReadingFact } from '../execution/requirements.js'
import type { RunStore } from '../execution/runs.js'
import type { IcarusDatabase } from '../storage/index.js'
import type { WorktreeInfo } from './worktree.js'

export const DELIVERABLE_SPECS = ['reading', 'comparison', 'document', 'code'] as const
export type DeliverableSpec = (typeof DELIVERABLE_SPECS)[number]

export const COMMAND_STATUSES = ['running', 'succeeded', 'failed', 'unknown', 'rejected'] as const
export type CommandStatus = (typeof COMMAND_STATUSES)[number]

const EVIDENCE_EXCERPT_LIMIT = 20_000
const DELIVERABLE_EXCERPT_LIMIT = 8_000
const DEFAULT_SEARCH_BUDGET = { perRun: 20, perMonth: 600 }
const DEFAULT_MAX_MODEL_REQUESTS = 8
const START_DELAY_MS = 2_000
const SPEC_LABELS: Readonly<Record<DeliverableSpec, string>> = { reading: '阅读', comparison: '对比', document: '文档', code: '代码' }

export interface RunCommandRecord {
  readonly id: string
  readonly runId: string
  readonly missionId: string
  readonly sessionId: string
  readonly callId: string
  readonly tool: string
  readonly cwd: string
  readonly command: string
  readonly status: CommandStatus
  readonly exitCode: number | null
  readonly stdoutRef: string | null
  readonly stderrRef: string | null
  readonly worktreeRef: string | null
  readonly startedAt: number
  readonly endedAt: number | null
}

export interface InvestigationCheckpointRecord {
  readonly id: string
  readonly runId: string
  readonly missionId: string
  readonly seq: number
  readonly phase: string
  readonly summaryRef: string
  readonly traceRef: string
  readonly artifactRefs: string[]
  readonly done: boolean
  readonly createdAt: number
}

export interface InvestigationServiceOptions {
  readonly database: IcarusDatabase
  readonly missions: MissionService
  readonly store: RunStore
  readonly now?: (() => number) | undefined
  readonly newId?: ((prefix: string) => string) | undefined
}

interface InvestigationCreateInput {
  readonly ownerMissionId: string
  readonly itemId?: string
  readonly question: string
  readonly deliverableSpec: readonly DeliverableSpec[]
  readonly stopCondition: string
  readonly verifyCommand?: string
  readonly workspaceRef?: string
  readonly budget?: number | null
  readonly maxModelRequestsPerRun?: number
  readonly searchBudget?: { readonly perRun: number; readonly perMonth: number; readonly allowPaid?: boolean }
  readonly authorizationRef?: string
}

interface CheckpointInput {
  readonly runId: string
  readonly missionId: string
  readonly seq: number
  readonly phase: string
  readonly summary: unknown
  readonly trace: unknown
  readonly artifactRefs?: readonly string[]
  readonly done: boolean
}

interface CommandInput {
  readonly runId: string
  readonly missionId: string
  readonly sessionId: string
  readonly callId: string
  readonly tool: string
  readonly cwd: string
  readonly command: string
  readonly status: CommandStatus
  readonly exitCode?: number | null
  readonly stdout?: string | null
  readonly stderr?: string | null
  readonly worktreeRef?: string | null
  readonly startedAt: number
  readonly endedAt?: number | null
}

export interface InvestigationService {
  create(input: InvestigationCreateInput): { mission: Mission; revision: MissionRevision; originSnapshotRef: string }
  list(ownerBotId?: string): Mission[]
  get(missionId: string): Mission
  bindings(missionId: string): InvestigationBinding
  checkpoints(missionId: string, runId?: string): InvestigationCheckpointRecord[]
  commands(missionId: string, runId?: string): RunCommandRecord[]
  lastCheckpoint(missionId: string): InvestigationCheckpointRecord | null
  saveCheckpoint(input: CheckpointInput): InvestigationCheckpointRecord
  recordCommand(input: CommandInput): RunCommandRecord
  /** Close a command row that was opened when the host dispatched the shell call. */
  finishCommand(input: { sessionId: string; callId: string; status: CommandStatus; exitCode?: number | null; stdout?: string | null; stderr?: string | null; endedAt?: number | null }): RunCommandRecord
  inheritedEvidence(runId: string): Map<string, ReadingFact>
  verification(runId: string, verifyCommand: string, lastMutationAt: number | null): { passed: boolean; reason: string; commandIds: string[] }
  originItem(missionId: string): unknown
  /** Read inherited or origin evidence by ref for the active investigation Run; persists a Reading row. */
  readEvidence(input: { runId: string; ref: string; startOffset?: number; length?: number }): { readingRef: string; evidenceRef: string; content: string; scope: string; startOffset: number; endOffset: number; totalLength: number; truncated: boolean; continuation: string | null }
  /** Commit the code investigation worktree and persist its diff/status as artifacts. */
  captureChanges(missionId: string): { diffRef: string; statusRef: string; head: string; baseCommit: string }
  retry(missionId: string, resumedFromRunId?: string): { runId: string; resumedFromRunId: string }
}

interface ItemRow {
  readonly id: string
  readonly ordinal: number
  readonly title: string
  readonly url: string
  readonly fields: string
  readonly evidenceRefs: string
  readonly observationIds: string
  readonly assessmentIds: string
  readonly deliverableId: string
  readonly deliverableRunId: string
  readonly deliverableContent: string
  readonly deliverableContentHash: string
  readonly deliverableEvidenceRefs: string
  readonly deliverableArtifactRefs: string
  readonly deliverableCreatedAt: number
}

interface AssessmentRow {
  readonly id: string
  readonly observationId: string
  readonly selected: number
  readonly reason: string
}

interface ReadingEvidenceRow {
  readonly evidenceRef: string
  readonly scope: string
  readonly startOffset: number
  readonly endOffset: number
  readonly totalLength: number
  readonly truncated: number
}

interface ReadingRow {
  readonly id: string
  readonly evidenceRef: string
  readonly scope: string
  readonly startOffset: number
  readonly endOffset: number
  readonly totalLength: number
  readonly truncated: number
}

interface CheckpointRow {
  readonly id: string
  readonly runId: string
  readonly missionId: string
  readonly seq: number
  readonly phase: string
  readonly summaryRef: string
  readonly traceRef: string
  readonly artifactRefs: string
  readonly done: number
  readonly createdAt: number
}

interface CommandRow {
  readonly id: string
  readonly runId: string
  readonly missionId: string
  readonly sessionId: string
  readonly callId: string
  readonly tool: string
  readonly cwd: string
  readonly command: string
  readonly status: string
  readonly exitCode: number | null
  readonly stdoutRef: string | null
  readonly stderrRef: string | null
  readonly worktreeRef: string | null
  readonly startedAt: number
  readonly endedAt: number | null
}

interface OriginAssessment {
  readonly id: string
  readonly observationId: string
  readonly selected: boolean
  readonly reason: string
}

interface OriginDeliverable {
  readonly id: string
  readonly runId: string
  readonly content: string
  readonly truncated: boolean
  readonly contentHash: string
  readonly evidenceRefs: readonly string[]
  readonly artifactRefs: readonly string[]
  readonly createdAt: number
}

interface OriginItem {
  readonly id: string
  readonly ordinal: number
  readonly title: string
  readonly url: string
  readonly fields: Record<string, unknown>
  readonly evidenceRefs: readonly string[]
  readonly observationIds: readonly string[]
  readonly assessmentIds: readonly string[]
  readonly assessments: readonly OriginAssessment[]
  readonly deliverable: OriginDeliverable
}

interface OriginEvidence {
  readonly ref: string
  readonly evidenceRef: string
  readonly scope: string
  readonly truncated: boolean
  readonly startOffset: number
  readonly endOffset: number
  readonly totalLength: number
  readonly content: string
  readonly isError?: boolean
}

interface OriginSnapshot {
  readonly kind: 'investigation-origin'
  readonly createdAt: number
  readonly parent: {
    readonly missionId: string
    readonly revision: number
    readonly objective: string
    readonly requirements: readonly string[]
    readonly timezone: string
    readonly ownerBotId: string
    readonly template?: string
  }
  readonly request: {
    readonly question: string
    readonly deliverableSpec: readonly DeliverableSpec[]
    readonly stopCondition: string
    readonly verifyCommand?: string
  }
  readonly item: OriginItem | null
  readonly evidence: readonly OriginEvidence[]
}

interface SnapshotEvidence {
  readonly ref: string
  readonly scope: string
  readonly truncated: boolean
  readonly startOffset: number
  readonly endOffset: number
  readonly totalLength: number
}

const CHECKPOINT_COLUMNS = 'id, runId, missionId, seq, phase, summaryRef, traceRef, artifactRefs, done, createdAt'
const COMMAND_COLUMNS = 'id, runId, missionId, sessionId, callId, tool, cwd, command, status, exitCode, stdoutRef, stderrRef, worktreeRef, startedAt, endedAt'
const ITEM_QUERY = `SELECT DeliverableItem.id, DeliverableItem.ordinal, DeliverableItem.title, DeliverableItem.url,
  DeliverableItem.fields, DeliverableItem.evidenceRefs, DeliverableItem.observationIds, DeliverableItem.assessmentIds,
  Deliverable.id AS deliverableId, Deliverable.runId AS deliverableRunId, Deliverable.content AS deliverableContent,
  Deliverable.contentHash AS deliverableContentHash, Deliverable.evidenceRefs AS deliverableEvidenceRefs,
  Deliverable.artifactRefs AS deliverableArtifactRefs, Deliverable.createdAt AS deliverableCreatedAt
  FROM DeliverableItem JOIN Deliverable ON Deliverable.id = DeliverableItem.deliverableId
  JOIN Run ON Run.id = Deliverable.runId WHERE DeliverableItem.id = ? AND Run.missionId = ?`

export function createInvestigationService(options: InvestigationServiceOptions): InvestigationService {
  const { database, missions, store } = options
  const { db, paths } = database
  const now = options.now ?? (() => Date.now())
  const mintId = options.newId ?? newId

  function missionOf(missionId: string): Mission {
    const mission = missions.get(missionId)
    investigationOf(mission)
    return mission
  }

  function investigationOf(mission: Mission): InvestigationBinding {
    if (mission.kind !== 'investigate' || mission.investigation === undefined) {
      throw new Error(`icarus: Mission ${JSON.stringify(mission.id)} is not an investigation`)
    }
    return mission.investigation
  }

  function itemOf(itemId: string, ownerMissionId: string): ItemRow {
    const row = db.prepare(ITEM_QUERY).get<ItemRow>(itemId, ownerMissionId)
    if (row === undefined) throw new Error(`icarus: item ${JSON.stringify(itemId)} does not belong to Mission ${JSON.stringify(ownerMissionId)}`)
    return row
  }

  function assessmentsOf(ids: readonly string[]): OriginAssessment[] {
    if (ids.length === 0) return []
    const slots = ids.map(() => '?').join(', ')
    const rows = db.prepare(`SELECT id, observationId, selected, reason FROM ObservationAssessment WHERE id IN (${slots})`).all<AssessmentRow>(...ids)
    const byId = new Map(rows.map(row => [row.id, row]))
    return ids.map(id => {
      const row = byId.get(id)
      if (row === undefined) throw new Error(`icarus: origin assessment ${JSON.stringify(id)} does not exist`)
      return { id: row.id, observationId: row.observationId, selected: row.selected === 1, reason: row.reason }
    })
  }

  function originItemOf(row: ItemRow): OriginItem {
    const assessmentIds = stringList(JSON.parse(row.assessmentIds) as unknown)
    const fields = JSON.parse(row.fields) as unknown
    if (fields === null || typeof fields !== 'object' || Array.isArray(fields)) throw new TypeError('icarus: origin item fields are not an object')
    const content = row.deliverableContent.slice(0, DELIVERABLE_EXCERPT_LIMIT)
    return {
      id: row.id,
      ordinal: row.ordinal,
      title: row.title,
      url: row.url,
      fields: fields as Record<string, unknown>,
      evidenceRefs: stringList(JSON.parse(row.evidenceRefs) as unknown),
      observationIds: stringList(JSON.parse(row.observationIds) as unknown),
      assessmentIds,
      assessments: assessmentsOf(assessmentIds),
      deliverable: {
        id: row.deliverableId,
        runId: row.deliverableRunId,
        content,
        truncated: content.length < row.deliverableContent.length,
        contentHash: row.deliverableContentHash,
        evidenceRefs: stringList(JSON.parse(row.deliverableEvidenceRefs) as unknown),
        artifactRefs: stringList(JSON.parse(row.deliverableArtifactRefs) as unknown),
        createdAt: row.deliverableCreatedAt,
      },
    }
  }

  function buildSnapshot(input: {
    missionId: string
    owner: Mission
    at: number
    question: string
    deliverableSpec: readonly DeliverableSpec[]
    stopCondition: string
    verifyCommand?: string
    itemRow: ItemRow | null
  }): { ref: string; item: OriginItem | null } {
    const item = input.itemRow === null ? null : originItemOf(input.itemRow)
    const evidence: OriginEvidence[] = []
    if (item !== null) {
      const seen = new Set<string>()
      for (const ref of item.evidenceRefs) {
        if (seen.has(ref)) continue
        seen.add(ref)
        evidence.push(evidenceOf(ref))
      }
    }
    const snapshot: OriginSnapshot = {
      kind: 'investigation-origin',
      createdAt: input.at,
      parent: {
        missionId: input.owner.id,
        revision: input.owner.revision,
        objective: input.owner.objective,
        requirements: input.owner.requirements,
        timezone: input.owner.timezone,
        ownerBotId: input.owner.ownerBotId,
        ...(input.owner.template === undefined ? {} : { template: input.owner.template.id }),
      },
      request: {
        question: input.question,
        deliverableSpec: input.deliverableSpec,
        stopCondition: input.stopCondition,
        ...(input.verifyCommand === undefined ? {} : { verifyCommand: input.verifyCommand }),
      },
      item,
      evidence,
    }
    const ref = writeArtifact(paths, `missions/${input.missionId}/investigations/origin.json`, JSON.stringify(snapshot))
    return { ref, item }
  }

  function evidenceOf(ref: string): OriginEvidence {
    const reading = db.prepare('SELECT evidenceRef, scope, startOffset, endOffset, totalLength, truncated FROM Reading WHERE id = ?').get<ReadingEvidenceRow>(ref)
    if (reading !== undefined) {
      const record = evidenceContentOf(reading.evidenceRef)
      const end = Math.min(reading.endOffset, reading.startOffset + EVIDENCE_EXCERPT_LIMIT)
      const content = record.text.slice(reading.startOffset, end)
      return {
        ref,
        evidenceRef: reading.evidenceRef,
        scope: reading.scope,
        truncated: reading.truncated === 1 || content.length < reading.endOffset - reading.startOffset,
        startOffset: reading.startOffset,
        endOffset: reading.startOffset + content.length,
        totalLength: reading.totalLength,
        content,
      }
    }
    const tool = db.prepare('SELECT evidenceRef, isError FROM ToolReading WHERE id = ?').get<{ evidenceRef: string; isError: number }>(ref)
    if (tool !== undefined) return artifactEvidence(ref, tool.evidenceRef, tool.isError === 1)
    const observation = db.prepare('SELECT evidenceRef FROM Observation WHERE id = ?').get<{ evidenceRef: string | null }>(ref)
    if (observation !== undefined) {
      if (observation.evidenceRef === null) throw new Error(`icarus: origin observation ${JSON.stringify(ref)} has no stored evidence`)
      return artifactEvidence(ref, observation.evidenceRef, false)
    }
    return artifactEvidence(ref, ref, false)
  }

  function artifactEvidence(ref: string, evidenceRef: string, isError: boolean): OriginEvidence {
    const record = evidenceContentOf(evidenceRef)
    const content = record.text.slice(0, EVIDENCE_EXCERPT_LIMIT)
    return {
      ref,
      evidenceRef,
      scope: record.scope,
      truncated: record.truncated || content.length < record.text.length,
      startOffset: 0,
      endOffset: content.length,
      totalLength: record.text.length,
      content,
      ...(isError ? { isError: true } : {}),
    }
  }

  function toCheckpoint(row: CheckpointRow): InvestigationCheckpointRecord {
    return {
      id: row.id,
      runId: row.runId,
      missionId: row.missionId,
      seq: row.seq,
      phase: row.phase,
      summaryRef: row.summaryRef,
      traceRef: row.traceRef,
      artifactRefs: stringList(JSON.parse(row.artifactRefs) as unknown),
      done: row.done === 1,
      createdAt: row.createdAt,
    }
  }

  function toCommand(row: CommandRow): RunCommandRecord {
    return {
      id: row.id,
      runId: row.runId,
      missionId: row.missionId,
      sessionId: row.sessionId,
      callId: row.callId,
      tool: row.tool,
      cwd: row.cwd,
      command: row.command,
      status: commandStatusOf(row.status),
      exitCode: row.exitCode,
      stdoutRef: row.stdoutRef,
      stderrRef: row.stderrRef,
      worktreeRef: row.worktreeRef,
      startedAt: row.startedAt,
      endedAt: row.endedAt,
    }
  }

  function checkpointsOf(missionId: string, runId?: string): InvestigationCheckpointRecord[] {
    const rows = runId === undefined
      ? db.prepare(`SELECT ${CHECKPOINT_COLUMNS} FROM InvestigationCheckpoint WHERE missionId = ? ORDER BY createdAt, id`).all<CheckpointRow>(missionId)
      : db.prepare(`SELECT ${CHECKPOINT_COLUMNS} FROM InvestigationCheckpoint WHERE missionId = ? AND runId = ? ORDER BY createdAt, id`).all<CheckpointRow>(missionId, runId)
    return rows.map(toCheckpoint)
  }

  function latestCheckpointOf(missionId: string): InvestigationCheckpointRecord | null {
    const row = db.prepare(`SELECT ${CHECKPOINT_COLUMNS} FROM InvestigationCheckpoint WHERE missionId = ? ORDER BY createdAt DESC, seq DESC, id DESC LIMIT 1`).get<CheckpointRow>(missionId)
    return row === undefined ? null : toCheckpoint(row)
  }

  function commandsOf(missionId: string, runId?: string): RunCommandRecord[] {
    const rows = runId === undefined
      ? db.prepare(`SELECT ${COMMAND_COLUMNS} FROM RunCommand WHERE missionId = ? ORDER BY startedAt, id`).all<CommandRow>(missionId)
      : db.prepare(`SELECT ${COMMAND_COLUMNS} FROM RunCommand WHERE missionId = ? AND runId = ? ORDER BY startedAt, id`).all<CommandRow>(missionId, runId)
    return rows.map(toCommand)
  }

  function commandOf(sessionId: string, callId: string): RunCommandRecord {
    const row = db.prepare(`SELECT ${COMMAND_COLUMNS} FROM RunCommand WHERE sessionId = ? AND callId = ?`).get<CommandRow>(sessionId, callId)
    if (row === undefined) throw new Error('icarus: RunCommand disappeared after it was recorded')
    return toCommand(row)
  }

  function create(input: InvestigationCreateInput): { mission: Mission; revision: MissionRevision; originSnapshotRef: string } {
    const owner = missions.get(input.ownerMissionId)
    if (owner.status !== 'active' && owner.status !== 'completed') {
      throw new MissionStateError(`owner Mission ${JSON.stringify(owner.id)} is ${owner.status}; an investigation starts from an active or completed Mission`)
    }
    const question = nonEmptyString(input.question, 'question')
    const stopCondition = nonEmptyString(input.stopCondition, 'stopCondition')
    const specs = parseSpecs(input.deliverableSpec)
    const verifyCommand = input.verifyCommand === undefined ? undefined : nonEmptyString(input.verifyCommand, 'verifyCommand')
    const workspaceRef = input.workspaceRef ?? owner.workspaceRef
    const code = specs.includes('code')
    if (code && workspaceRef === undefined) throw new TypeError('icarus: code investigation requires a workspace')
    if (code && verifyCommand === undefined) throw new TypeError('icarus: code investigation requires a verify command')
    const itemRow = input.itemId === undefined ? null : itemOf(input.itemId, owner.id)
    const missionId = mintId('mission')
    let worktree: WorktreeInfo | null = null
    if (code && workspaceRef !== undefined) worktree = ensureWorktree({ repoPath: workspaceRef, dataDir: paths.dataDir, missionId })
    const at = now()
    const snapshot = buildSnapshot({
      missionId,
      owner,
      at,
      question,
      deliverableSpec: specs,
      stopCondition,
      ...(verifyCommand === undefined ? {} : { verifyCommand }),
      itemRow,
    })
    const origin: InvestigationBinding = {
      originMissionId: owner.id,
      ...(itemRow === null ? {} : { originItemId: itemRow.id, originDeliverableId: itemRow.deliverableId, originRunId: itemRow.deliverableRunId }),
      originSnapshotRef: snapshot.ref,
      question,
      deliverableSpec: specs,
      stopCondition,
      ...(verifyCommand === undefined ? {} : { verifyCommand }),
      ...(worktree === null ? {} : { baseCommit: worktree.baseCommit, worktreeRef: worktree.worktreeRef }),
    }
    const requirements = [
      `交付类型：${specs.map(spec => SPEC_LABELS[spec]).join('、')}`,
      `结束条件：${stopCondition}`,
    ]
    if (worktree !== null && verifyCommand !== undefined) {
      requirements.push(`验证命令：${verifyCommand}`)
      requirements.push(`在独立 worktree ${worktree.worktreeRef} 中修改，不触碰原仓库的未提交改动；完成后运行验证命令，退出码为 0 才算完成`)
    }
    const discovery: CapabilityRequirement = {
      provider: 'Icarus', tool: 'icarus_web_search', required: false,
      purpose: '调查资料发现；在 DSH 插件 → Icarus → 联网搜索 配置',
    }
    const inherited = owner.capabilityRequirements ?? []
    const capabilityRequirements = inherited.some(item => item.provider === discovery.provider && item.tool === discovery.tool)
      ? [...inherited]
      : [...inherited, discovery]
    const bindings: MissionBindings = {
      ...(workspaceRef === undefined ? {} : { workspaceRef }),
      searchBudget: input.searchBudget ?? DEFAULT_SEARCH_BUDGET,
      ...(owner.contextRefs === undefined ? {} : { contextRefs: owner.contextRefs }),
      capabilityRequirements,
      ...(owner.template === undefined ? {} : { template: owner.template }),
      investigation: origin,
      maxModelRequestsPerRun: input.maxModelRequestsPerRun ?? DEFAULT_MAX_MODEL_REQUESTS,
    }
    const mission = missions.create({
      id: missionId,
      ownerBotId: owner.ownerBotId,
      kind: 'investigate',
      objective: `调查：${question}`,
      requirements,
      schedule: { kind: 'once', at: now() + START_DELAY_MS },
      timezone: owner.timezone,
      budget: parseBudget(input.budget),
      authorizationRef: input.authorizationRef ?? null,
      ...bindings,
    })
    const revision = missions.history(mission.id).find(item => item.revision === mission.revision)
    if (revision === undefined) throw new Error(`icarus: investigation Mission ${JSON.stringify(mission.id)} has no current revision`)
    return { mission, revision, originSnapshotRef: snapshot.ref }
  }

  /** Text and scope of one evidence ref: snapshot entry, reading, tool reading or observation evidence. */
  function evidenceTextOf(missionId: string, ref: string): { evidenceRef: string; content: string; scope: string } {
    const mission = missions.get(missionId)
    const investigation = mission.investigation
    if (investigation !== undefined) {
      const snapshot = JSON.parse(readArtifact(paths, investigation.originSnapshotRef)) as { evidence?: unknown }
      if (Array.isArray(snapshot.evidence)) {
        for (const value of snapshot.evidence) {
          if (value === null || typeof value !== 'object') continue
          const entry = value as Record<string, unknown>
          if (entry.ref !== ref) continue
          return { evidenceRef: typeof entry.evidenceRef === 'string' ? entry.evidenceRef : ref, scope: typeof entry.scope === 'string' ? entry.scope : 'partial', content: typeof entry.content === 'string' ? entry.content : '' }
        }
      }
    }
    const reading = db.prepare('SELECT Reading.evidenceRef, Reading.startOffset, Reading.endOffset, Reading.scope FROM Reading JOIN Run ON Run.id = Reading.runId WHERE Reading.id = ? AND Run.missionId = ?').get<{ evidenceRef: string; startOffset: number; endOffset: number; scope: string }>(ref, missionId)
    if (reading !== undefined) {
      const record = evidenceContentOf(reading.evidenceRef)
      return { evidenceRef: reading.evidenceRef, content: record.text.slice(reading.startOffset, reading.endOffset), scope: reading.scope }
    }
    const tool = db.prepare('SELECT evidenceRef FROM ToolReading WHERE id = ? AND missionId = ?').get<{ evidenceRef: string }>(ref, missionId)
    if (tool !== undefined) { const record = evidenceContentOf(tool.evidenceRef); return { evidenceRef: tool.evidenceRef, content: record.text, scope: record.scope } }
    const toolByRef = db.prepare('SELECT evidenceRef FROM ToolReading WHERE evidenceRef = ? AND missionId = ? LIMIT 1').get<{ evidenceRef: string }>(ref, missionId)
    if (toolByRef !== undefined) { const record = evidenceContentOf(toolByRef.evidenceRef); return { evidenceRef: toolByRef.evidenceRef, content: record.text, scope: record.scope } }
    const observation = db.prepare('SELECT Observation.evidenceRef FROM Observation JOIN Source ON Source.id = Observation.sourceId WHERE Observation.id = ? AND Source.missionId = ?').get<{ evidenceRef: string | null }>(ref, missionId)
    if (observation !== undefined && observation.evidenceRef !== null) { const record = evidenceContentOf(observation.evidenceRef); return { evidenceRef: observation.evidenceRef, content: record.text, scope: record.scope } }
    throw new Error('icarus: evidence ' + JSON.stringify(ref) + ' is not part of this investigation')
  }
  function evidenceContentOf(evidenceRef: string): { text: string; scope: string; truncated: boolean } {
    const record = JSON.parse(readArtifact(paths, evidenceRef)) as unknown
    const value = record !== null && typeof record === 'object' && !Array.isArray(record) ? record as Record<string, unknown> : undefined
    const reading = value === undefined || value.reading === null || typeof value.reading !== 'object' ? undefined : value.reading as Record<string, unknown>
    const scope = typeof value?.scope === 'string' ? value.scope : typeof reading?.scope === 'string' ? reading.scope : 'partial'
    const truncated = (value !== undefined && value.truncated === true) || (reading !== undefined && reading.truncated === true)
    return { text: plainTextOf(record), scope, truncated }
  }

  return {
    create,
    list(ownerBotId?: string): Mission[] {
      const filter = ownerBotId === undefined ? undefined : { ownerBotId }
      return missions.list(filter).filter(mission => mission.kind === 'investigate')
    },
    get: missionOf,
    bindings: missionId => investigationOf(missionOf(missionId)),
    checkpoints(missionId, runId) {
      const mission = missionOf(missionId)
      return checkpointsOf(mission.id, runId)
    },
    commands(missionId, runId) {
      const mission = missionOf(missionId)
      return commandsOf(mission.id, runId)
    },
    lastCheckpoint: missionId => latestCheckpointOf(missionOf(missionId).id),
    saveCheckpoint(input) {
      const mission = missionOf(input.missionId)
      const runId = nonEmptyString(input.runId, 'runId')
      if (!Number.isSafeInteger(input.seq) || input.seq < 1) throw new TypeError('icarus: checkpoint seq must be a positive integer')
      const phase = nonEmptyString(input.phase, 'phase')
      if (typeof input.done !== 'boolean') throw new TypeError('icarus: checkpoint done must be boolean')
      const artifactRefs = stringList(input.artifactRefs ?? [])
      const at = now()
      const dir = `missions/${mission.id}/investigations/${runId}/checkpoints`
      const summaryRef = writeArtifact(paths, `${dir}/${input.seq}-summary.json`, JSON.stringify(input.summary ?? null) ?? 'null')
      const traceRef = writeArtifact(paths, `${dir}/${input.seq}-trace.json`, JSON.stringify(input.trace ?? null) ?? 'null')
      const record: InvestigationCheckpointRecord = {
        id: mintId('checkpoint'), runId, missionId: mission.id, seq: input.seq, phase, summaryRef, traceRef,
        artifactRefs, done: input.done, createdAt: at,
      }
      inTransaction(database, () => {
        db.prepare(`INSERT INTO InvestigationCheckpoint (id, runId, missionId, seq, phase, summaryRef, traceRef, artifactRefs, done, createdAt)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(record.id, record.runId, record.missionId, record.seq, record.phase, record.summaryRef, record.traceRef, JSON.stringify(record.artifactRefs), record.done ? 1 : 0, record.createdAt)
      })
      return record
    },
    recordCommand(input) {
      const mission = missionOf(input.missionId)
      const runId = nonEmptyString(input.runId, 'runId')
      const sessionId = nonEmptyString(input.sessionId, 'sessionId')
      const callId = nonEmptyString(input.callId, 'callId')
      const tool = nonEmptyString(input.tool, 'tool')
      const cwd = nonEmptyString(input.cwd, 'cwd')
      const command = nonEmptyString(input.command, 'command')
      const status = commandStatusOf(input.status)
      const exitCode = input.exitCode === undefined ? null : numberOrNull(input.exitCode, 'exitCode')
      if (!Number.isSafeInteger(input.startedAt) || input.startedAt < 0) throw new TypeError('icarus: command startedAt must be a non-negative integer')
      const endedAt = input.endedAt === undefined ? null : numberOrNull(input.endedAt, 'endedAt')
      const prefix = `missions/${mission.id}/investigations/${runId}/commands/${segmentOf(sessionId)}-${segmentOf(callId)}`
      const stdoutRef = input.stdout === undefined || input.stdout === null || input.stdout === '' ? null : writeArtifact(paths, `${prefix}-stdout.txt`, input.stdout)
      const stderrRef = input.stderr === undefined || input.stderr === null || input.stderr === '' ? null : writeArtifact(paths, `${prefix}-stderr.txt`, input.stderr)
      const worktreeRef = input.worktreeRef === undefined || input.worktreeRef === null ? null : nonEmptyString(input.worktreeRef, 'worktreeRef')
      db.prepare(`INSERT INTO RunCommand (id, runId, missionId, sessionId, callId, tool, cwd, command, status, exitCode, stdoutRef, stderrRef, worktreeRef, startedAt, endedAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(sessionId, callId) DO UPDATE SET
          runId = excluded.runId, missionId = excluded.missionId, tool = excluded.tool, cwd = excluded.cwd,
          command = excluded.command, status = excluded.status, exitCode = excluded.exitCode,
          stdoutRef = COALESCE(excluded.stdoutRef, RunCommand.stdoutRef),
          stderrRef = COALESCE(excluded.stderrRef, RunCommand.stderrRef),
          worktreeRef = COALESCE(excluded.worktreeRef, RunCommand.worktreeRef),
          startedAt = excluded.startedAt, endedAt = COALESCE(excluded.endedAt, RunCommand.endedAt)`)
        .run(mintId('run_command'), runId, mission.id, sessionId, callId, tool, cwd, command, status, exitCode, stdoutRef, stderrRef, worktreeRef, input.startedAt, endedAt)
      return commandOf(sessionId, callId)
    },
    finishCommand(input) {
      const sessionId = nonEmptyString(input.sessionId, 'sessionId')
      const callId = nonEmptyString(input.callId, 'callId')
      const row = db.prepare(`SELECT ${COMMAND_COLUMNS} FROM RunCommand WHERE sessionId = ? AND callId = ?`).get<CommandRow>(sessionId, callId)
      if (row === undefined) throw new Error('icarus: no RunCommand for this shell call')
      const status = commandStatusOf(input.status)
      const exitCode = input.exitCode === undefined ? row.exitCode : numberOrNull(input.exitCode, 'exitCode')
      const endedAt = input.endedAt === undefined ? now() : numberOrNull(input.endedAt, 'endedAt')
      const prefix = `missions/${row.missionId}/investigations/${row.runId}/commands/${segmentOf(sessionId)}-${segmentOf(callId)}`
      const stdoutRef = input.stdout === undefined || input.stdout === null || input.stdout === '' ? row.stdoutRef : writeArtifact(paths, `${prefix}-stdout.txt`, input.stdout)
      const stderrRef = input.stderr === undefined || input.stderr === null || input.stderr === '' ? row.stderrRef : writeArtifact(paths, `${prefix}-stderr.txt`, input.stderr)
      db.prepare('UPDATE RunCommand SET status = ?, exitCode = ?, stdoutRef = ?, stderrRef = ?, endedAt = ? WHERE sessionId = ? AND callId = ?')
        .run(status, exitCode, stdoutRef, stderrRef, endedAt, sessionId, callId)
      return commandOf(sessionId, callId)
    },
    inheritedEvidence(runId: string): Map<string, ReadingFact> {
      const run = store.get(runId)
      const mission = missions.get(run.missionId)
      const facts = new Map<string, ReadingFact>()
      const readings = db.prepare(`SELECT Reading.id, Reading.evidenceRef, Reading.scope, Reading.startOffset, Reading.endOffset,
        Reading.totalLength, Reading.truncated FROM Reading JOIN Run ON Run.id = Reading.runId
        WHERE Run.missionId = ? ORDER BY Reading.createdAt, Reading.id`).all<ReadingRow>(mission.id)
      const grouped = new Map<string, ReadingRow[]>()
      for (const row of readings) {
        facts.set(row.id, { scope: row.scope, truncated: row.truncated === 1, startOffset: row.startOffset, endOffset: row.endOffset, totalLength: row.totalLength })
        const group = grouped.get(row.evidenceRef) ?? []
        group.push(row)
        grouped.set(row.evidenceRef, group)
      }
      for (const [ref, group] of grouped) {
        group.sort((left, right) => left.startOffset - right.startOffset)
        const first = group[0]
        if (first === undefined) continue
        let covered = first.startOffset
        for (const reading of group) {
          if (reading.startOffset > covered) break
          covered = Math.max(covered, reading.endOffset)
        }
        const complete = first.startOffset === 0 && covered === first.totalLength
        facts.set(ref, { scope: complete ? first.scope : 'partial', truncated: !complete, startOffset: first.startOffset, endOffset: covered, totalLength: first.totalLength })
      }
      const tools = db.prepare('SELECT id, evidenceRef, isError FROM ToolReading WHERE missionId = ? ORDER BY createdAt, id')
        .all<{ id: string; evidenceRef: string; isError: number }>(mission.id)
      for (const row of tools) {
        const record = JSON.parse(readArtifact(paths, row.evidenceRef)) as unknown
        const value = record !== null && typeof record === 'object' ? record as Record<string, unknown> : undefined
        const fact: ReadingFact = {
          scope: value !== undefined && typeof value.scope === 'string' ? value.scope : 'tool_result',
          truncated: value !== undefined && typeof value.truncated === 'boolean' ? value.truncated : null,
          startOffset: 0, endOffset: 0, totalLength: 0,
          ...(row.isError === 1 ? { isError: true } : {}),
        }
        facts.set(row.id, fact)
        facts.set(row.evidenceRef, fact)
      }
      const investigation = mission.investigation
      if (investigation !== undefined) {
        const snapshot = JSON.parse(readArtifact(paths, investigation.originSnapshotRef)) as { evidence?: unknown }
        if (Array.isArray(snapshot.evidence)) {
          for (const value of snapshot.evidence) {
            const entry = snapshotEvidenceOf(value)
            if (entry === null) continue
            facts.set(entry.ref, {
              scope: entry.scope,
              truncated: entry.truncated || entry.endOffset < entry.totalLength,
              startOffset: entry.startOffset,
              endOffset: entry.endOffset,
              totalLength: entry.totalLength,
            })
          }
        }
      }
      return facts
    },
    verification(runId: string, verifyCommand: string, lastMutationAt: number | null): { passed: boolean; reason: string; commandIds: string[] } {
      const command = nonEmptyString(verifyCommand, 'verifyCommand')
      // A shell call may wrap the verify command with extra inspection ("node verify.mjs; ...");
      // the command must still start with the configured verification command.
      const rows = db.prepare(`SELECT id, command, status, exitCode, startedAt FROM RunCommand WHERE runId = ? AND (command = ? OR command LIKE ?)
        ORDER BY startedAt DESC, id DESC`).all<{ id: string; command: string; status: string; exitCode: number | null; startedAt: number }>(runId, command, command + '%')
      const row = rows.find(entry => entry.command.trim() === command || entry.command.trim().startsWith(command))
      if (row === undefined) return { passed: false, reason: '验证命令未执行', commandIds: [] }
      const commandIds = [row.id]
      if (lastMutationAt !== null && row.startedAt <= lastMutationAt) return { passed: false, reason: '最后修改之后未重新验证', commandIds }
      if (row.status === 'running') return { passed: false, reason: '验证命令尚未结束', commandIds }
      if (row.status !== 'succeeded') return { passed: false, reason: '验证命令未成功', commandIds }
      if (row.exitCode === null) return { passed: false, reason: '验证命令退出码未知', commandIds }
      if (row.exitCode !== 0) return { passed: false, reason: '验证命令退出码非 0', commandIds }
      return { passed: true, reason: '验证命令通过', commandIds }
    },
    readEvidence(input) {
      const run = store.get(input.runId)
      const mission = missionOf(run.missionId)
      const ref = nonEmptyString(input.ref, 'ref')
      const startOffset = input.startOffset ?? 0
      const length = input.length ?? 6000
      if (!Number.isSafeInteger(startOffset) || startOffset < 0 || !Number.isSafeInteger(length) || length < 1 || length > 50000) throw new TypeError('icarus: invalid evidence reading range')
      const source = evidenceTextOf(mission.id, ref)
      if (startOffset > source.content.length) throw new TypeError('icarus: evidence reading starts past the content')
      const endOffset = Math.min(source.content.length, startOffset + length)
      const scope = startOffset === 0 && endOffset === source.content.length ? source.scope : 'partial'
      const readingRef = mintId('reading')
      db.prepare(`INSERT INTO Reading (id, runId, observationId, evidenceRef, scope, startOffset, endOffset, totalLength, truncated, continuation, createdAt)
        VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(readingRef, run.id, source.evidenceRef, scope, startOffset, endOffset, source.content.length, endOffset < source.content.length ? 1 : 0,
          endOffset < source.content.length ? String(endOffset) : null, now())
      return { readingRef, evidenceRef: source.evidenceRef, content: source.content.slice(startOffset, endOffset), scope, startOffset, endOffset, totalLength: source.content.length, truncated: endOffset < source.content.length, continuation: endOffset < source.content.length ? String(endOffset) : null }
    },
    captureChanges(missionId: string) {
      const mission = missionOf(missionId)
      const investigation = investigationOf(mission)
      if (investigation.worktreeRef === undefined || investigation.baseCommit === undefined) throw new Error('icarus: this investigation has no worktree to capture')
      const changes = captureWorktree({ worktreeRef: investigation.worktreeRef, baseCommit: investigation.baseCommit, missionId: mission.id })
      const dir = `missions/${mission.id}/investigations/changes`
      const diffRef = writeArtifact(paths, `${dir}/changes.diff`, changes.diff)
      const statusRef = writeArtifact(paths, `${dir}/status.txt`, changes.status)
      writeArtifact(paths, `${dir}/head.json`, JSON.stringify({ baseCommit: changes.baseCommit, head: changes.head, at: now() }))
      return { diffRef, statusRef, head: changes.head, baseCommit: changes.baseCommit }
    },
    originItem(missionId: string): unknown {
      const mission = missionOf(missionId)
      const snapshot = JSON.parse(readArtifact(paths, investigationOf(mission).originSnapshotRef)) as { item?: unknown }
      return snapshot.item ?? null
    },
    retry(missionId: string, _resumedFromRunId?: string): { runId: string; resumedFromRunId: string } {
      const mission = missionOf(missionId)
      const checkpoint = latestCheckpointOf(mission.id)
      // A Run stopped before its first checkpoint still saved tool evidence; the retry resumes
      // from that Run so the new attempt keeps the inherited evidence instead of restarting blind.
      const prior: { id: string } | undefined = checkpoint === null
        ? db.prepare("SELECT id FROM Run WHERE missionId = ? AND status IN ('failed','budget_exhausted','cancelled','superseded') ORDER BY createdAt DESC, generation DESC LIMIT 1").get<{ id: string }>(mission.id)
        : { id: checkpoint.runId }
      if (prior === undefined) throw new Error(`icarus: investigation ${JSON.stringify(missionId)} has no saved progress to resume from`)
      const run = store.enqueuePurpose(mission.id, 'investigation')
      if (run === null) throw new Error(`icarus: investigation ${JSON.stringify(missionId)} already has a Run in flight or is not active`)
      db.prepare('UPDATE Run SET resumedFromRunId = ? WHERE id = ?').run(prior.id, run.id)
      return { runId: run.id, resumedFromRunId: prior.id }
    },
  }
}

function plainTextOf(record: unknown): string {
  if (typeof record === 'string') return record
  if (record === null || typeof record !== 'object') return String(record)
  const value = record as Record<string, unknown>
  if (typeof value.content === 'string') return value.content
  const result = value.result
  if (result !== null && typeof result === 'object') {
    const payload = result as Record<string, unknown>
    if (Array.isArray(payload.content)) {
      const parts: string[] = []
      for (const part of payload.content) {
        if (part !== null && typeof part === 'object' && typeof (part as Record<string, unknown>).text === 'string') parts.push((part as Record<string, unknown>).text as string)
      }
      if (parts.length > 0) return parts.join('\n')
    }
    if (typeof payload.value === 'string') return payload.value
  }
  return JSON.stringify(record) ?? String(record)
}

function parseSpecs(value: readonly DeliverableSpec[]): DeliverableSpec[] {
  if (!Array.isArray(value) || value.length === 0) throw new TypeError('icarus: deliverableSpec must list at least one deliverable type')
  const specs: DeliverableSpec[] = []
  for (const item of value) {
    if (typeof item !== 'string' || !(DELIVERABLE_SPECS as readonly string[]).includes(item)) throw new TypeError(`icarus: unknown deliverable type ${JSON.stringify(item)}`)
    const spec = item as DeliverableSpec
    if (!specs.includes(spec)) specs.push(spec)
  }
  return specs
}

function parseBudget(value: number | null | undefined): number | null {
  if (value === undefined || value === null) return null
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('icarus: budget must be a non-negative integer or null')
  return value
}

function commandStatusOf(value: unknown): CommandStatus {
  if (typeof value !== 'string' || !(COMMAND_STATUSES as readonly string[]).includes(value)) throw new TypeError(`icarus: unknown command status ${JSON.stringify(value)}`)
  return value as CommandStatus
}

function snapshotEvidenceOf(value: unknown): SnapshotEvidence | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const entry = value as Record<string, unknown>
  const ref = entry.ref
  const scope = entry.scope
  const truncated = entry.truncated
  const startOffset = entry.startOffset
  const endOffset = entry.endOffset
  const totalLength = entry.totalLength
  if (typeof ref !== 'string' || typeof scope !== 'string' || typeof truncated !== 'boolean'
    || typeof startOffset !== 'number' || typeof endOffset !== 'number' || typeof totalLength !== 'number') return null
  return { ref, scope, truncated, startOffset, endOffset, totalLength }
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) throw new TypeError('icarus: stored reference list is not a string array')
  return value as string[]
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`icarus: ${field} must be a non-empty string`)
  return value.trim()
}

function numberOrNull(value: number | null, field: string): number | null {
  if (value === null) return null
  if (!Number.isSafeInteger(value)) throw new TypeError(`icarus: ${field} must be an integer or null`)
  return value
}

function segmentOf(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '_')
}
