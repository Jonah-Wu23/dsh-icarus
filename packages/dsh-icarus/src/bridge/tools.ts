import { identityForSession, resolveIdentity } from './identity.js'
import { listItems } from '../execution/items.js'
import type { IcarusService } from '../index.js'
import type { IcarusExecution } from '../execution/index.js'
import type { IcarusDatabase } from '../storage/index.js'
import type { IcarusContext, HostToolDefinition, HostAgent } from '../types/host.js'
import type { CreateMissionInput, MissionPatch } from '../domain/index.js'
import type { DeliverableSpec, InvestigationBinding, SearchBudget } from '../domain/bindings.js'
import type { MissionBindings } from '../domain/bindings.js'
import type { SourceAdapter } from '../sources/index.js'

const text = { type: 'string' }
const object = { type: 'object', additionalProperties: true }
const output = { schema: {}, render: (_args: Readonly<Record<string, unknown>>, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }] }

export function registerBotTools(ctx: IcarusContext, service: IcarusService, execution: IcarusExecution, database: IcarusDatabase, dshHome?: string): void {
  function register(name: string, description: string, properties: Record<string, unknown>, required: readonly string[], execute: HostToolDefinition['execute']) {
    ctx.tools.register({ name, description, parameters: { type: 'object', properties, required, additionalProperties: false }, output, execute })
  }
  function requireText(value: unknown): string { if (typeof value !== 'string' || !value.trim()) throw new TypeError('icarus: nonempty string required'); return value }
  function requireAgent(agent: HostAgent | undefined): HostAgent { if (agent === undefined) throw new Error('icarus: a calling Session is required'); return agent }
  async function authorize(missionId: string, agent: HostAgent | undefined, mutate = false) {
    const caller = requireAgent(agent)
    const mission = service.missions.get(missionId)
    const owner = await resolveIdentity(mission.ownerBotId, { dshHome })
    if (owner.sessionId === caller.id || owner.botId === caller.id) return mission
    // A Bot whose own chat moved to a new Session keeps its ownership; the identity file records
    // every segment, so a later segment of the same Bot is still the owner.
    try {
      const identity = await identityForSession(caller.id, { dshHome })
      if (identity.botId === owner.botId) return mission
    } catch { /* a non-Bot execution Session is handled below */ }
    if (!mutate && database.db.prepare('SELECT id FROM Run WHERE missionId = ? AND sessionId = ?').get(missionId, caller.id) !== undefined) return mission
    throw new Error('icarus: the calling Session does not own this Mission')
  }
  register('icarus_missions', '创建、修改和查询持续委托。将用户目标、资料引用及交付策略保存在 Mission；create 自动绑定当前 Bot。data.template 选择 paper、application、interest 或 generic 模板（模板给出默认要求与条目字段）；data.explorationPolicy 保存用户明确预授权的主动调查主题、每周次数与 token 上限；data.investigation 仅由 icarus_investigations 写入。修改须来自用户的实际要求。',
    { action: { type: 'string', enum: ['create', 'get', 'list', 'modify', 'pause', 'resume', 'cancel', 'history'] }, missionId: text, data: object }, ['action'], async (args, exec) => {
      const caller = requireAgent(exec.agent)
      if (args.action === 'create') {
        const owner = await identityForSession(caller.id, { dshHome })
        const data = args.data
        if (typeof data !== 'object' || data === null || Array.isArray(data)) throw new TypeError('icarus: Mission data required')
        return service.missions.create({ ...data as Omit<CreateMissionInput, 'ownerBotId'>, ownerBotId: owner.botId })
      }
      if (args.action === 'list') {
        const owner = await identityForSession(caller.id, { dshHome })
        return service.missions.list().filter(mission => mission.ownerBotId === owner.botId || mission.ownerBotId === owner.name)
      }
      const id = requireText(args.missionId)
      await authorize(id, caller, !['get', 'history'].includes(String(args.action)))
      switch (args.action) {
        case 'get': return service.missions.get(id)
        case 'modify': return service.missions.modify(id, args.data as MissionPatch)
        case 'pause': return service.missions.pause(id)
        case 'resume': return service.missions.resume(id)
        case 'cancel': return service.missions.cancel(id)
        case 'history': return service.missions.history(id)
        default: throw new TypeError('icarus: unknown Mission action')
      }
    })
  register('icarus_sources', '配置和查询委托的真实来源。adapter 为 rss、arxiv、github、web 或 search；search locator 为查询式，config 保存 timeRange、maxResults 和 site；搜索来源默认每六小时轮询，最短一小时，自动绑定必需搜索能力。创建须给出 sinceAt 回看时间。',
    { action: { type: 'string', enum: ['create', 'list', 'get', 'poll', 'observations', 'attempts', 'evidence', 'requestBudget'] }, missionId: text, sourceId: text, observationId: text,
      adapter: { type: 'string', enum: ['rss', 'arxiv', 'github', 'web', 'search'] }, config: object, locator: text, sinceAt: { type: 'integer' }, pollIntervalMs: { type: 'integer' }, credentialRef: text, limit: { type: 'integer' }, offset: { type: 'integer' } }, ['action', 'missionId'], async (args, exec) => {
      const missionId = requireText(args.missionId)
      await authorize(missionId, exec.agent, ['create', 'poll'].includes(String(args.action)))
      if (args.action === 'create') return service.sources.create({ missionId, adapter: args.adapter as SourceAdapter, locator: requireText(args.locator), sinceAt: args.sinceAt as number,
        ...(args.pollIntervalMs === undefined ? {} : { pollIntervalMs: args.pollIntervalMs as number }), ...(args.config === undefined ? {} : { config: args.config as Pick<import('../sources/types.js').SourceConfig, 'timeRange' | 'maxResults' | 'site'> }), ...(args.credentialRef === undefined ? {} : { credentialRef: requireText(args.credentialRef) }) })
      if (args.action === 'list') return service.sources.list(missionId)
      if (args.action === 'evidence') {
        const observationId = requireText(args.observationId)
        const row = database.db.prepare('SELECT Source.missionId FROM Observation JOIN Source ON Source.id = Observation.sourceId WHERE Observation.id = ?').get<{ missionId: string }>(observationId)
        if (row?.missionId !== missionId) throw new Error('icarus: observation belongs to another Mission')
        return service.sources.evidence(observationId)
      }
      const sourceId = requireText(args.sourceId)
      if (service.sources.get(sourceId).missionId !== missionId) throw new Error('icarus: source belongs to another Mission')
      switch (args.action) {
        case 'get': return service.sources.get(sourceId)
        case 'poll': return service.sources.poll(sourceId)
        case 'observations': return service.sources.observations(sourceId, args.limit as number | undefined, args.offset as number | undefined)
        case 'attempts': return service.sources.attempts(sourceId)
        case 'requestBudget': return service.sources.requestBudget(sourceId)
        default: throw new TypeError('icarus: unknown source action')
      }
    })
  register('icarus_capabilities', '读取完整委托目标、扩展候选和实际工具描述后，由你推荐适合的免费能力，并用 recommend 保存具体理由。bind 保存用户选定的 contextRefs、workspaceRef 或 capabilityRequirements。check 在所选工作区真实调用 verificationArgs；未调用的扩展保持 unknown。',
    { action: { type: 'string', enum: ['catalog', 'recommend', 'bind', 'check', 'checks'] }, missionId: text, sessionId: text, bindings: object,
      recommendations: { type: 'array', items: { type: 'object', properties: { candidateId: text, reason: text }, required: ['candidateId', 'reason'], additionalProperties: false } } }, ['action', 'missionId'], async (args, exec) => {
      const id = requireText(args.missionId)
      await authorize(id, exec.agent, !['catalog', 'checks'].includes(String(args.action)))
      switch (args.action) {
        case 'catalog': return service.capabilities.catalog(id)
        case 'recommend': return { evidenceRef: service.capabilities.recommend(id, args.recommendations as { candidateId: string; reason: string }[]) }
        case 'bind': return service.missions.modify(id, args.bindings as MissionBindings)
        case 'checks': return service.capabilities.checks(id)
        case 'check': {
          const mission = service.missions.get(id)
          const session = args.sessionId === undefined ? await ctx.sessionController.create({ cwd: mission.workspaceRef ?? database.paths.workspaceDir }) : { sessionId: requireText(args.sessionId) }
          return service.capabilities.check(id, session.sessionId)
        }
        default: throw new TypeError('icarus: unknown capability action')
      }
    })
  register('icarus_read_evidence', '读取当前执行会话可用的真实证据正文：策展执行会话按 observationId 读取观测；调查会话按证据 ref 读取继承证据、快照证据、本 Run 的工具结果或历史阅读。返回已持久保存的 readingRef、实际范围和继续读取位置。每次最多 50000 个字符。成果声明阅读范围时引用这些记录。',
    { observationId: text, evidenceRef: text, startOffset: { type: 'integer' }, length: { type: 'integer' } }, [], async (args, exec) => {
      const caller = requireAgent(exec.agent)
      const run = database.db.prepare("SELECT id, purpose FROM Run WHERE sessionId = ? AND status IN ('running','awaiting_approval')").get<{ id: string; purpose: string }>(caller.id)
      if (run === undefined) throw new Error('icarus: reading records require the active execution Session')
      const ref = args.evidenceRef === undefined ? requireText(args.observationId) : requireText(args.evidenceRef)
      if (run.purpose === 'investigation') return execution.investigation.readEvidence({ runId: run.id, ref, ...(args.startOffset === undefined ? {} : { startOffset: args.startOffset as number }), ...(args.length === undefined ? {} : { length: args.length as number }) })
      return execution.curation.read(run.id, ref, args.startOffset as number | undefined, args.length as number | undefined)
    })
  register('icarus_items', '查询成果条目及其评估、来源证据和实际阅读范围。追问“第二篇”时给出 deliverableId 和 ordinal=2；也可用 itemId 精确读取。list 可按 Mission 或 Deliverable 查询。旧成果返回空条目列表。',
    { action: { type: 'string', enum: ['get', 'list'] }, missionId: text, deliverableId: text, itemId: text, ordinal: { type: 'integer', minimum: 1 } }, ['action', 'missionId'], async (args, exec) => {
      const missionId = requireText(args.missionId)
      await authorize(missionId, exec.agent)
      if (!['get', 'list'].includes(String(args.action))) throw new TypeError('icarus: unknown item action')
      const deliverableId = args.deliverableId === undefined ? undefined : requireText(args.deliverableId)
      if (deliverableId !== undefined) {
        const owner = database.db.prepare('SELECT Run.missionId FROM Deliverable JOIN Run ON Run.id = Deliverable.runId WHERE Deliverable.id = ?').get<{ missionId: string }>(deliverableId)
        if (owner?.missionId !== missionId) throw new Error('icarus: Deliverable does not belong to this Mission')
      }
      const itemId = args.itemId === undefined ? undefined : requireText(args.itemId)
      if (args.action === 'get' && itemId === undefined && (deliverableId === undefined || args.ordinal === undefined)) throw new TypeError('icarus: get requires itemId or deliverableId and ordinal')
      const items = listItems(database, { missionId, ...(deliverableId === undefined ? {} : { deliverableId }), ...(itemId === undefined ? {} : { itemId }), ...(args.ordinal === undefined ? {} : { ordinal: args.ordinal as number }) })
      const details = items.map(item => {
        const run = database.db.prepare('SELECT runId FROM Deliverable WHERE id = ?').get<{ runId: string }>(item.deliverableId)!
        const facts = new Map(execution.curation.evidenceFacts(run.runId))
        const inherited = item.sourceType === 'investigation' ? execution.investigation.inheritedEvidence(run.runId) : new Map()
        return { ...item, itemId: item.id, readingFacts: item.evidenceRefs.map(ref => {
          const fact = facts.get(ref) ?? inherited.get(ref)
          if (fact === undefined) throw new Error(`icarus: item refers to missing reading evidence ${ref}`)
          return { ref, ...fact }
        }),
          assessments: item.assessmentIds.map(id => {
            const assessment = database.db.prepare('SELECT * FROM ObservationAssessment WHERE id = ?').get<{ readingRefs: string }>(id)!
            return { ...assessment, readingRefs: JSON.parse(assessment.readingRefs) as unknown }
          }), evidence: item.observationIds.map(id => ({ observationId: id, ...service.sources.evidence(id) as object })) }
      })
      if (args.action === 'list') return details
      if (details.length !== 1) throw new Error('icarus: item not found in this Mission')
      return details[0]
    })
  register('icarus_results', '查询窗口、执行进度和真实投递回执。run 与 runs 中的成果包含稳定条目身份和序号。prepared 表示成果已准备；sent 表示宿主已接受 prompt。retry 重新执行失败窗口，reconcile 只核查结果未知的原投递，不重发。',
    { action: { type: 'string', enum: ['windows', 'window', 'outcome', 'retry', 'runs', 'run', 'receipt', 'delivery', 'attempts', 'reconcile', 'export'] }, missionId: text, windowId: text, runId: text, outboxId: text }, ['action', 'missionId'], async (args, exec) => {
      const id = requireText(args.missionId)
      await authorize(id, exec.agent, ['retry', 'reconcile'].includes(String(args.action)))
      if (['window', 'outcome', 'retry'].includes(String(args.action))) {
        const windowId = requireText(args.windowId)
        if (service.windows.get(windowId).missionId !== id) throw new Error('icarus: window belongs to another Mission')
        if (args.action === 'window') return service.windows.get(windowId)
        if (args.action === 'outcome') return service.windows.outcome(windowId)
        return service.windows.retry(windowId)
      }
      if (args.action === 'windows') return service.windows.list(id)
      if (args.action === 'runs') return service.runs.list({ missionId: id })
      if (args.action === 'run') { const run = service.runs.get(requireText(args.runId)); if (run.missionId !== id) throw new Error('icarus: Run belongs to another Mission'); return run }
      if (args.action === 'export') return service.data.exportMission(id)
      const outboxId = requireText(args.outboxId)
      const owner = database.db.prepare('SELECT Run.missionId FROM Outbox JOIN Deliverable ON Deliverable.id = Outbox.deliverableId JOIN Run ON Run.id = Deliverable.runId WHERE Outbox.id = ?').get<{ missionId: string }>(outboxId)
      if (owner?.missionId !== id) throw new Error('icarus: delivery belongs to another Mission')
      switch (args.action) {
        case 'receipt': return service.deliveries.receipt(outboxId)
        case 'delivery': return service.deliveries.get(outboxId)
        case 'attempts': return service.deliveries.attempts(outboxId)
        case 'reconcile': return service.deliveries.reconcile(outboxId)
        default: throw new TypeError('icarus: unknown results action')
      }
    })
  register('icarus_feedback', '记录用户对具体成果条目的评价与文字纠正，记录链接打开行为，查询偏好版本与采用情况，或排队偏好整理。action 为 record、withdraw、read、current、history、adoption、consolidate。record 与 read 必须给出具体成果的 itemId；没有反馈时保持未知，不要替用户编造喜好。',
    { action: { type: 'string', enum: ['record', 'withdraw', 'read', 'current', 'history', 'adoption', 'consolidate'] }, missionId: text, deliverableId: text, itemId: text, feedbackId: text, entryId: text,
      feedbackAction: { type: 'string', enum: ['useful', 'not_interested', 'seen', 'saved'] }, comment: text, source: { type: 'string', enum: ['bot', 'qq', 'ui'] }, channel: text, channelEventRef: text }, ['action', 'missionId'], async (args, exec) => {
      const missionId = requireText(args.missionId)
      await authorize(missionId, exec.agent, ['record', 'withdraw', 'read', 'consolidate'].includes(String(args.action)))
      switch (args.action) {
        case 'record':
          return execution.feedback.record({ missionId, deliverableId: requireText(args.deliverableId), ...(args.itemId === undefined ? {} : { itemId: requireText(args.itemId) }),
            ...(args.feedbackAction === undefined ? {} : { action: args.feedbackAction as string }), ...(args.comment === undefined ? {} : { comment: args.comment as string }),
            ...(args.source === undefined ? {} : { source: args.source as string }), ...(args.channelEventRef === undefined ? {} : { channelEventRef: args.channelEventRef as string }), ...(exec.agent === undefined ? {} : { sessionId: exec.agent.id }) })
        case 'withdraw': return execution.feedback.withdraw(missionId, requireText(args.feedbackId))
        case 'read': return execution.feedback.readEvent({ missionId, itemId: requireText(args.itemId), channel: args.channel === undefined ? 'ui' : requireText(args.channel), ...(args.channelEventRef === undefined ? {} : { channelEventRef: requireText(args.channelEventRef) }) })
        case 'current': return { ...execution.feedback.current(missionId), pending: execution.feedback.pending(missionId) }
        case 'history': return execution.feedback.history(missionId)
        case 'adoption': return execution.feedback.adoption(missionId, requireText(args.entryId))
        case 'consolidate': {
          const pending = execution.feedback.pending(missionId)
          const queued = database.db.prepare("SELECT id, status FROM Run WHERE missionId = ? AND status IN ('queued','running','awaiting_approval') ORDER BY createdAt DESC LIMIT 1").get(missionId)
          if (queued !== undefined) return { status: 'running', run: queued, pending: pending.length }
          const run = pending.length === 0 ? null : execution.store.enqueuePurpose(missionId, 'preference', pending.map(item => item.id))
          return { status: run === null ? 'idle' : 'queued', run, pending: pending.length }
        }
        default: throw new TypeError('icarus: unknown feedback action')
      }
    })
  register('icarus_investigations', '从成果条目创建关联调查、查询调查进度、检查点与真实命令记录，或从中断处重试。action 为 create、get、list、checkpoints、commands、retry。create 的 missionId 是原委托，必须给出 itemId、question、deliverableSpec 与 stopCondition；code 类型还必须有 verifyCommand，workspaceRef 缺省继承原委托。调查是独立的 investigate Mission，继承背景与能力引用，交付类型为 reading、comparison、document 或 code 的组合。',
    { action: { type: 'string', enum: ['create', 'get', 'list', 'checkpoints', 'commands', 'retry'] }, missionId: text, itemId: text, question: text,
      deliverableSpec: { type: 'array', items: { type: 'string', enum: ['reading', 'comparison', 'document', 'code'] } }, stopCondition: text, verifyCommand: text, workspaceRef: text,
      budget: { type: 'integer', minimum: 0 }, maxModelRequestsPerRun: { type: 'integer', minimum: 1 }, searchBudget: object, runId: text }, ['action'], async (args, exec) => {
      if (args.action === 'list') {
        const owner = await identityForSession(requireAgent(exec.agent).id, { dshHome })
        return execution.investigation.list(owner.botId)
      }
      const missionId = requireText(args.missionId)
      if (args.action === 'create') {
        const owner = await authorize(missionId, exec.agent)
        const specs = args.deliverableSpec === undefined ? [] : args.deliverableSpec as DeliverableSpec[]
        return execution.investigation.create({ ownerMissionId: missionId, ...(args.itemId === undefined ? {} : { itemId: requireText(args.itemId) }), question: requireText(args.question),
          deliverableSpec: specs, stopCondition: requireText(args.stopCondition), ...(args.verifyCommand === undefined ? {} : { verifyCommand: requireText(args.verifyCommand) }),
          ...(args.workspaceRef === undefined ? {} : { workspaceRef: requireText(args.workspaceRef) }), ...(args.budget === undefined ? {} : { budget: args.budget as number }),
          ...(args.maxModelRequestsPerRun === undefined ? {} : { maxModelRequestsPerRun: args.maxModelRequestsPerRun as number }), ...(args.searchBudget === undefined ? {} : { searchBudget: args.searchBudget as SearchBudget }) })
      }
      const mission = await authorize(missionId, exec.agent, args.action === 'retry')
      if (mission.kind !== 'investigate') throw new Error('icarus: this Mission is not an investigation')
      switch (args.action) {
        case 'get': return execution.investigation.originItem(missionId) === null ? mission : { mission, origin: execution.investigation.originItem(missionId), binding: execution.investigation.bindings(missionId) }
        case 'checkpoints': return execution.investigation.checkpoints(missionId, args.runId === undefined ? undefined : requireText(args.runId))
        case 'commands': return execution.investigation.commands(missionId, args.runId === undefined ? undefined : requireText(args.runId))
        case 'retry': return execution.investigation.retry(missionId)
        default: throw new TypeError('icarus: unknown investigation action')
      }
    })
}
