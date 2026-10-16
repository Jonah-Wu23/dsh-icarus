import { newId } from '../domain/ids.js'
import { writeArtifact } from '../execution/artifacts.js'
import { CAPABILITY_CATALOG } from './catalog.js'
import { fileURLToPath } from 'node:url'
import type { MissionService, MissionRevision } from '../domain/index.js'
import type { IcarusDatabase } from '../storage/index.js'
import type { IcarusContext, HostAgent, ToolResult } from '../types/host.js'
import type { SearchService } from '../search/service.js'
import { SearchUnavailableError } from '../search/types.js'

export type CapabilityStatus = 'available' | 'missing' | 'needs_auth' | 'unavailable' | 'unknown'
export interface CapabilityCheck {
  readonly id: string
  readonly missionId: string
  readonly missionRevision: number
  readonly provider: string
  readonly tool: string
  readonly workspaceRef: string
  readonly status: CapabilityStatus
  readonly evidenceRef: string | null
  readonly checkedAt: number
}

export interface CapabilityService {
  catalog(missionId: string): unknown
  recommend(missionId: string, recommendations: readonly { readonly candidateId: string; readonly reason: string }[]): string
  checks(missionId: string): CapabilityCheck[]
  check(missionId: string, sessionId: string): Promise<CapabilityCheck[]>
  verify(revision: MissionRevision, agent: HostAgent, signal: AbortSignal): Promise<{ readonly ref: string; readonly missing: readonly string[] }>
  capture(missionId: string, runId: string | null, sessionId: string, callId: string, tool: string, result: ToolResult): string
}

export function createCapabilityService(ctx: IcarusContext, database: IcarusDatabase, missions: MissionService, search?: SearchService): CapabilityService {
  const { db, paths } = database
  function capture(missionId: string, runId: string | null, sessionId: string, callId: string, tool: string, result: ToolResult): string {
    const existing = db.prepare('SELECT evidenceRef FROM ToolReading WHERE sessionId = ? AND callId = ?').get<{ evidenceRef: string }>(sessionId, callId)
    if (existing !== undefined) return existing.evidenceRef
    const id = newId('tool_reading')
    const scope = tool === 'icarus_web_search' ? 'snippet' : tool === 'icarus_web_fetch' ? 'vendor_extract' : 'tool_result'
    const value = result.value as { truncated?: boolean } | undefined
    const ref = writeArtifact(paths, `missions/${missionId}/tools/${id}.json`, JSON.stringify({ tool, sessionId, callId, result, scope, truncated: value?.truncated ?? null, continuation: null }))
    db.prepare('INSERT INTO ToolReading(id, missionId, runId, sessionId, callId, tool, evidenceRef, isError, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(sessionId, callId) DO NOTHING')
      .run(id, missionId, runId, sessionId, callId, tool, ref, result.isError ? 1 : 0, Date.now())
    return ref
  }
  async function verify(revision: MissionRevision, agent: HostAgent, signal: AbortSignal) {
    const checks: CapabilityCheck[] = []
    for (const requirement of revision.capabilityRequirements ?? []) {
      let status: CapabilityStatus = 'unknown'
      let evidenceRef: string | null = null
      if (requirement.tool === 'icarus_web_search' && search !== undefined) {
        const callId = newId('capability_probe')
        try {
          const result = await search.test(undefined, signal, { missionId: revision.missionId, sessionId: agent.id, purpose: 'capability-check', test: true })
          evidenceRef = capture(revision.missionId, null, agent.id, callId, requirement.tool, { content: [{ type: 'text', text: JSON.stringify(result) }], value: result })
          status = 'available'
        } catch (error) {
          if (!(error instanceof SearchUnavailableError)) throw error
          const configured = error.providers.filter(item => item.status !== 'unconfigured')
          status = configured.length === 0 ? 'missing' : configured.every(item => item.status === 'auth_failed') ? 'needs_auth' : 'unavailable'
          evidenceRef = capture(revision.missionId, null, agent.id, callId, requirement.tool, { isError: true, content: [{ type: 'text', text: JSON.stringify({ message: error.message, providers: error.providers }) }] })
        }
      } else if (ctx.tools.get(requirement.tool, agent) === undefined) status = 'missing'
      else if (requirement.verificationArgs !== undefined) {
        const callId = newId('capability_probe')
        const result = await ctx.tools.execute({ agent, name: requirement.tool, arguments: requirement.verificationArgs, callId, signal })
        evidenceRef = capture(revision.missionId, null, agent.id, callId, requirement.tool, result)
        const value = result.value
        const failed = result.isError || (typeof value === 'object' && value !== null && 'ok' in value && value.ok === false)
        const info = result.error?.info
        const auth = typeof info === 'object' && info !== null && (('status' in info && info.status === 401) || ('code' in info && ['AUTH_REQUIRED', 'UNAUTHORIZED', 'MCP_AUTH_REQUIRED'].includes(String(info.code))))
        status = auth ? 'needs_auth' : failed ? 'unavailable' : 'available'
      }
      const item: CapabilityCheck = { id: newId('capability_check'), missionId: revision.missionId, missionRevision: revision.revision,
        provider: requirement.provider, tool: requirement.tool, workspaceRef: agent.session.header.cwd ?? '', status, evidenceRef, checkedAt: Date.now() }
      db.prepare('INSERT INTO CapabilityCheck(id, missionId, missionRevision, provider, tool, workspaceRef, status, evidenceRef, checkedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(item.id, item.missionId, item.missionRevision, item.provider, item.tool, item.workspaceRef, item.status, item.evidenceRef, item.checkedAt)
      checks.push(item)
    }
    const missing = (revision.capabilityRequirements ?? []).filter(requirement => requirement.required && !checks.some(check => check.tool === requirement.tool && check.provider === requirement.provider && check.status === 'available'))
      .map(requirement => `${requirement.provider}/${requirement.tool}：${requirement.purpose}`)
    const ref = writeArtifact(paths, `missions/${revision.missionId}/capabilities/${newId('snapshot')}.json`, JSON.stringify({ revision: revision.revision, sessionId: agent.id, workspaceRef: agent.session.header.cwd, checks, missing, externalCost: { status: 'unknown', providers: checks.map(check => check.provider) } }))
    return { ref, missing }
  }
  return {
    catalog(missionId) {
      const mission = missions.get(missionId)
      const candidates = CAPABILITY_CATALOG.map(candidate => candidate.id === 'fetch' ? { ...candidate, connection: {
        transport: 'stdio', command: process.execPath, args: [fileURLToPath(new URL('../fetch.js', import.meta.url).href), '--allow-private-ips'],
      } } : candidate)
      return { objective: mission.objective, requirements: mission.requirements, workspaceRef: mission.workspaceRef ?? database.paths.workspaceDir, candidates,
        tools: ctx.tools.schemas(), checks: this.checks(missionId) }
    },
    recommend(missionId, recommendations) {
      const mission = missions.get(missionId)
      for (const item of recommendations) if (!CAPABILITY_CATALOG.some(candidate => candidate.id === item.candidateId) || typeof item.reason !== 'string' || !item.reason.trim()) throw new TypeError('icarus: recommendation requires a catalog candidate and its reason')
      const id = newId('recommendation')
      const ref = writeArtifact(paths, `missions/${missionId}/capabilities/${id}.json`, JSON.stringify({ missionRevision: mission.revision, objective: mission.objective, recommendations, candidates: CAPABILITY_CATALOG }))
      db.prepare('INSERT INTO CapabilityRecommendation(id, missionId, missionRevision, evidenceRef, createdAt) VALUES (?, ?, ?, ?, ?)').run(id, missionId, mission.revision, ref, Date.now())
      return ref
    },
    checks: missionId => db.prepare('SELECT * FROM CapabilityCheck WHERE missionId = ? ORDER BY checkedAt, id').all<CapabilityCheck>(missionId),
    async check(missionId, sessionId) {
      const agent = ctx.agents.get(sessionId)
      if (agent === undefined) throw new Error('icarus: capability check requires a loaded workspace Session')
      const mission = missions.get(missionId)
      const workspace = mission.workspaceRef ?? paths.workspaceDir
      if (agent.session.header.cwd !== workspace) throw new Error('icarus: capability check Session belongs to another workspace')
      await verify(missions.history(missionId).find(item => item.revision === mission.revision)!, agent, AbortSignal.timeout(60_000))
      return this.checks(missionId)
    }, verify, capture,
  }
}
