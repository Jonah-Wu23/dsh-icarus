import { newId } from '../domain/ids.js'
import { inTransaction } from '../domain/missions.js'
import { contentHash, writeArtifact } from './artifacts.js'
import type { IcarusDatabase } from '../storage/index.js'
import type { MissionService } from '../domain/index.js'
import type { IcarusContext } from '../types/host.js'
import type { CapabilityService } from '../capabilities/index.js'
import type { WindowService } from './windows.js'

export interface FaultRecord {
  readonly id: string
  readonly missionId: string
  readonly missionRevision: number
  readonly conditionKey: string
  readonly kind: string
  readonly sourceId: string | null
  readonly runId: string
  readonly detailsRef: string
  readonly deliverableId: string
  readonly createdAt: number
  readonly clearedAt: number | null
}

export interface FaultService {
  list(missionId?: string): FaultRecord[]
  record(input: { readonly missionId: string; readonly kind: string; readonly conditionKey: string; readonly detail: unknown; readonly errorRef: string; readonly runId?: string; readonly sourceId?: string }): FaultRecord
  clearSource(sourceId: string): void
  clearPreparation(missionId: string, revision: number): void
  refresh(ctx: IcarusContext, capabilities: CapabilityService, windows: WindowService): Promise<void>
}

export function createFaultService(database: IcarusDatabase, missions: MissionService): FaultService {
  const { db, paths } = database
  const list = (missionId?: string): FaultRecord[] => missionId === undefined ? db.prepare('SELECT * FROM Fault ORDER BY createdAt, id').all<FaultRecord>()
    : db.prepare('SELECT * FROM Fault WHERE missionId = ? ORDER BY createdAt, id').all<FaultRecord>(missionId)
  let refreshing: Promise<void> | undefined
  async function refresh(ctx: IcarusContext, capabilities: CapabilityService, windows: WindowService): Promise<void> {
    for (const fault of list().filter(item => item.clearedAt === null)) {
      const mission = missions.get(fault.missionId)
      if (mission.status !== 'active' || mission.revision !== fault.missionRevision || fault.kind !== 'capability') continue
      const run = db.prepare('SELECT sessionId FROM Run WHERE id = ?').get<{ sessionId: string | null }>(fault.runId)
      if (run?.sessionId === null || run?.sessionId === undefined) continue
      const created = await ctx.sessionController.create({ sessionId: run.sessionId, cwd: mission.workspaceRef ?? paths.workspaceDir })
      const agent = ctx.agents.get(created.sessionId)
      if (agent === undefined) throw new Error('icarus: capability recovery Session is unavailable')
      const revision = missions.history(mission.id).find(item => item.revision === mission.revision)!
      const verified = await capabilities.verify(revision, agent, AbortSignal.timeout(60_000))
      if (verified.missing.length === 0) db.prepare('UPDATE Fault SET clearedAt = ? WHERE id = ?').run(Date.now(), fault.id)
    }
    for (const window of windows.list().filter(window => window.status === 'failed')) {
      const mission = missions.get(window.missionId)
      if (mission.status !== 'active' || mission.revision !== window.missionRevision) continue
      const outcome = windows.outcome(window.id) as { kind?: string } | null
      if (outcome?.kind === 'sources') {
        const healthy = db.prepare("SELECT id FROM Source WHERE missionId = ? AND json_extract(health, '$.status') = 'healthy' LIMIT 1").get(mission.id)
        if (healthy !== undefined) windows.retry(window.id)
      } else if (outcome?.kind === 'capability') {
        const fault = list(mission.id).findLast(fault => fault.kind === 'capability' && fault.missionRevision === mission.revision)
        if (fault?.clearedAt !== null && fault?.clearedAt !== undefined) windows.retry(window.id)
      }
    }
  }
  return {
    list,
    record(input) {
      const mission = missions.get(input.missionId)
      const existing = db.prepare('SELECT * FROM Fault WHERE missionId = ? AND missionRevision = ? AND conditionKey = ? AND clearedAt IS NULL').get<FaultRecord>(mission.id, mission.revision, input.conditionKey)
      if (existing !== undefined) return existing
      const id = newId('fault')
      const at = Date.now()
      const detailsRef = writeArtifact(paths, `missions/${mission.id}/faults/${id}.json`, JSON.stringify({ kind: input.kind, detail: input.detail, errorRef: input.errorRef, at }))
      const runId = input.runId ?? newId('run')
      const deliverableId = newId('fault_notice')
      const outboxId = newId('outbox')
      const content = `Icarus 委托「${mission.objective}」出现故障。\n\n${JSON.stringify(input.detail)}\n\n故障类型：${input.kind}\n错误记录：${input.errorRef}\n任务进度与已保存证据保留。查询或配置入口：icarus_results、icarus_capabilities。`
      inTransaction(database, () => {
        if (input.runId === undefined) {
          const generation = db.prepare('SELECT COALESCE(MAX(generation),0)+1 AS next FROM Run WHERE missionId = ?').get<{ next: number }>(mission.id)!.next
          db.prepare("INSERT INTO Run(id, missionId, missionRevision, status, generation, errorRef, createdAt, startedAt, endedAt, phase) VALUES (?, ?, ?, 'failed', ?, ?, ?, ?, ?, 'source-poll')")
            .run(runId, mission.id, mission.revision, generation, input.errorRef, at, at, at)
        }
        db.prepare('INSERT INTO Deliverable(id, runId, requirementResults, evidenceRefs, artifactRefs, content, contentHash, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .run(deliverableId, runId, JSON.stringify({ kind: 'fault', passed: false }), JSON.stringify([input.errorRef, detailsRef]), '[]', content, contentHash(content), at)
        db.prepare("INSERT INTO Outbox(id, deliverableId, channel, purpose, status, nextAttemptAt, createdAt, updatedAt) VALUES (?, ?, 'bot', 'fault', 'pending', ?, ?, ?)").run(outboxId, deliverableId, at, at, at)
        db.prepare('INSERT INTO Fault(id, missionId, missionRevision, conditionKey, kind, sourceId, runId, detailsRef, deliverableId, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .run(id, mission.id, mission.revision, input.conditionKey, input.kind, input.sourceId ?? null, runId, detailsRef, deliverableId, at)
      })
      return db.prepare('SELECT * FROM Fault WHERE id = ?').get<FaultRecord>(id)!
    },
    clearSource(sourceId) { db.prepare('UPDATE Fault SET clearedAt = ? WHERE sourceId = ? AND clearedAt IS NULL').run(Date.now(), sourceId) },
    clearPreparation(missionId, revision) { db.prepare('UPDATE Fault SET clearedAt = ? WHERE missionId = ? AND missionRevision = ? AND sourceId IS NULL AND clearedAt IS NULL').run(Date.now(), missionId, revision) },
    refresh(ctx, capabilities, windows) {
      if (refreshing !== undefined) return refreshing
      refreshing = refresh(ctx, capabilities, windows).finally(() => { refreshing = undefined })
      return refreshing
    },
  }
}
