import { readFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { newId } from '../domain/ids.js'
import { resolveIdentity } from '../bridge/identity.js'
import { contentHash, readArtifact, writeArtifact } from '../execution/artifacts.js'
import type { MissionRevision } from '../domain/index.js'
import type { Run } from '../execution/runs.js'
import type { IcarusDatabase } from '../storage/index.js'
import type { IcarusContext } from '../types/host.js'
import type { CapabilityService } from '../capabilities/index.js'

export interface ContextService {
  load(run: Run, revision: MissionRevision, signal: AbortSignal): Promise<{ readonly ref: string; readonly text: string }>
}

/** Preference entries effective at the Run's pinned version, with the words that produced them. */
export function preferenceSnapshot(db: IcarusDatabase['db'], missionId: string, revision: number | null): unknown {
  if (revision === null) return { revision: null, entries: [] }
  const rows = db.prepare(`SELECT id, introducedIn, retiredIn, origin, statement, scope, quote, feedbackIds, explanation, expiresAt FROM PreferenceEntry
    WHERE missionId = ? AND introducedIn <= ? AND (retiredIn IS NULL OR retiredIn > ?) ORDER BY introducedIn, id`).all<{ id: string; introducedIn: number; retiredIn: number | null; origin: string; statement: string; scope: string; quote: string | null; feedbackIds: string; explanation: string | null; expiresAt: number | null }>(missionId, revision, revision)
  return { revision, entries: rows.map(row => ({ id: row.id, origin: row.origin, statement: row.statement, scope: JSON.parse(row.scope) as unknown,
    quote: row.quote, explanation: row.explanation, expiresAt: row.expiresAt, feedbackIds: JSON.parse(row.feedbackIds) as unknown, introducedIn: row.introducedIn })) }
}

export function createContextService(ctx: IcarusContext, database: IcarusDatabase, capabilities: CapabilityService, dshHome?: string): ContextService {
  const { db, paths } = database
  return {
    async load(run, revision, signal) {
      const existing = db.prepare('SELECT contextRef FROM Run WHERE id = ?').get<{ contextRef: string | null }>(run.id)
      if (existing?.contextRef !== null && existing?.contextRef !== undefined) return { ref: existing.contextRef, text: readArtifact(paths, existing.contextRef) }
      const entries: unknown[] = []
      for (const binding of revision.contextRefs ?? []) {
        signal.throwIfAborted()
        if (binding.kind === 'file') {
          if (!isAbsolute(binding.locator)) throw new TypeError('icarus: context file path must be absolute')
          const raw = await readFile(binding.locator, 'utf8')
          const lines = raw.split('\n')
          const start = binding.startLine ?? 1
          const end = Math.min(binding.endLine ?? lines.length, lines.length)
          if (start > lines.length) throw new Error(`icarus: context range exceeds file ${binding.id}`)
          entries.push({ binding, version: contentHash(raw), content: lines.slice(start - 1, end).join('\n'), reading: { startLine: start, endLine: end, totalLines: lines.length, scope: start === 1 && end === lines.length ? 'full' : 'partial' } })
        } else {
          let sessionId = run.sessionId
          let tool = binding.locator
          let args = binding.arguments ?? {}
          if (binding.kind === 'bot') {
            const owner = db.prepare('SELECT ownerBotId FROM Mission WHERE id = ?').get<{ ownerBotId: string }>(run.missionId)
            if (owner === undefined) throw new Error('icarus: background owner is missing')
            const identity = await resolveIdentity(owner.ownerBotId, { dshHome })
            if (binding.locator !== 'own' && binding.locator !== identity.botId && binding.locator !== identity.name) throw new Error('icarus: Bot context must reference the Mission owner')
            if (ctx.agents.get(identity.sessionId) === undefined) {
              const observation = await ctx.sessionQuery.observeSession(identity.sessionId, { projectionMode: 'none' })
              try { await ctx.sessionController.create({ sessionId: identity.sessionId, ...(observation.header.cwd === undefined ? {} : { cwd: observation.header.cwd }) }) }
              finally { observation[Symbol.dispose]() }
            }
            sessionId = identity.sessionId
            tool = 'recall'
            args = binding.arguments ?? {}
          }
          if (sessionId === null) throw new Error('icarus: context tool requires an execution Session')
          const agent = ctx.agents.get(sessionId)
          if (agent === undefined) throw new Error('icarus: context Session is not loaded')
          const callId = newId('context_read')
          const result = await ctx.tools.execute({ agent, name: tool, arguments: args, callId, signal })
          const evidenceRef = capabilities.capture(run.missionId, run.id, sessionId, callId, tool, result)
          if (result.isError) throw new Error(`icarus: context tool ${tool} failed; evidence ${evidenceRef}`)
          entries.push({ binding, evidenceRef, version: contentHash(JSON.stringify(result)), result, reading: { scope: 'tool_result', truncated: null } })
        }
      }
      const preference = preferenceSnapshot(db, run.missionId, run.preferenceRevision)
      const text = JSON.stringify({ objective: revision.objective, requirements: revision.requirements, template: revision.template?.id ?? null,
        missionRevision: revision.revision, preferenceRevision: run.preferenceRevision, preference, entries })
      const ref = writeArtifact(paths, `runs/${run.id}/context.json`, text)
      db.prepare('UPDATE Run SET contextRef = ? WHERE id = ?').run(ref, run.id)
      return { ref, text }
    },
  }
}
