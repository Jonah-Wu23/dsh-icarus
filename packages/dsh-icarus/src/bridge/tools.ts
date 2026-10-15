import { identityForSession, resolveIdentity } from './identity.js'
import type { IcarusService } from '../index.js'
import type { IcarusExecution } from '../execution/index.js'
import type { IcarusDatabase } from '../storage/index.js'
import type { IcarusContext, HostToolDefinition, HostAgent } from '../types/host.js'
import type { CreateMissionInput, MissionPatch } from '../domain/index.js'
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
    if (!mutate && database.db.prepare('SELECT id FROM Run WHERE missionId = ? AND sessionId = ?').get(missionId, caller.id) !== undefined) return mission
    throw new Error('icarus: the calling Session does not own this Mission')
  }
  register('icarus_missions', '创建、修改和查询持续委托。将用户目标、资料引用及交付策略保存在 Mission；create 自动绑定当前 Bot。修改须来自用户的实际要求。',
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
  register('icarus_sources', '配置和查询委托的真实来源。adapter 为 rss、arxiv、github 或 web；arxiv locator 为 API 查询式，GitHub locator 为仓库 releases/issues API URL。创建须给出 sinceAt 回看时间。查询保留失败、分页游标及原始证据。',
    { action: { type: 'string', enum: ['create', 'list', 'get', 'poll', 'observations', 'attempts', 'evidence', 'requestBudget'] }, missionId: text, sourceId: text, observationId: text,
      adapter: { type: 'string', enum: ['rss', 'arxiv', 'github', 'web'] }, locator: text, sinceAt: { type: 'integer' }, pollIntervalMs: { type: 'integer' }, credentialRef: text, limit: { type: 'integer' }, offset: { type: 'integer' } }, ['action', 'missionId'], async (args, exec) => {
      const missionId = requireText(args.missionId)
      await authorize(missionId, exec.agent, ['create', 'poll'].includes(String(args.action)))
      if (args.action === 'create') return service.sources.create({ missionId, adapter: args.adapter as SourceAdapter, locator: requireText(args.locator), sinceAt: args.sinceAt as number,
        ...(args.pollIntervalMs === undefined ? {} : { pollIntervalMs: args.pollIntervalMs as number }), ...(args.credentialRef === undefined ? {} : { credentialRef: requireText(args.credentialRef) }) })
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
  register('icarus_read_evidence', '读取当前执行委托的真实观测正文，返回已持久保存的 readingRef、实际范围和继续读取位置。每次最多 50000 个字符。成果声明阅读范围时引用这些记录。',
    { observationId: text, startOffset: { type: 'integer' }, length: { type: 'integer' } }, ['observationId'], async (args, exec) => {
      const caller = requireAgent(exec.agent)
      const run = database.db.prepare("SELECT id FROM Run WHERE sessionId = ? AND status IN ('running','awaiting_approval')").get<{ id: string }>(caller.id)
      if (run === undefined) throw new Error('icarus: reading records require the active execution Session')
      return execution.curation.read(run.id, requireText(args.observationId), args.startOffset as number | undefined, args.length as number | undefined)
    })
  register('icarus_results', '查询窗口、执行进度和真实投递回执。prepared 表示成果已准备；sent 表示宿主已接受 prompt。retry 重新执行失败窗口，reconcile 只核查结果未知的原投递，不重发。',
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
}
