import { newId } from '../domain/ids.js'
import { inTransaction } from '../domain/missions.js'
import { nextDueAt } from '../domain/schedule.js'
import { readArtifact, writeArtifact } from './artifacts.js'
import type { MissionService, Mission } from '../domain/index.js'
import type { IcarusDatabase } from '../storage/index.js'
import type { RunStore } from './runs.js'

export interface DeliveryWindow {
  readonly id: string
  readonly missionId: string
  readonly missionRevision: number
  readonly preferenceRevision: number | null
  readonly windowKey: string
  readonly prepareAt: number
  readonly dueAt: number
  readonly timezone: string
  readonly status: 'open' | 'prepared' | 'suppressed' | 'failed' | 'superseded'
  readonly inputRefs: readonly string[]
  readonly deliverableId: string | null
  readonly outcomeRef: string | null
  readonly createdAt: number
  readonly sealedAt: number | null
}

interface WindowRow extends Omit<DeliveryWindow, 'inputRefs'> { readonly inputRefs: string }

export interface WindowService {
  get(id: string): DeliveryWindow
  list(missionId?: string): DeliveryWindow[]
  scan(): readonly string[]
  pending(windowId: string, limit?: number): readonly string[]
  suppress(windowId: string, runId: string, instanceId: string, outcome: unknown): void
  failed(windowId: string, outcome: unknown): void
  retry(windowId: string): DeliveryWindow
  outcome(windowId: string): unknown
  delivered(deliverableId: string): void
}

export function createWindowService(database: IcarusDatabase, missions: MissionService, store: RunStore, now: () => number = Date.now): WindowService {
  const { db, paths } = database
  const decode = (row: WindowRow): DeliveryWindow => ({ ...row, inputRefs: JSON.parse(row.inputRefs) as string[] })
  function get(id: string): DeliveryWindow {
    const row = db.prepare('SELECT * FROM DeliveryWindow WHERE id = ?').get<WindowRow>(id)
    if (row === undefined) throw new Error(`icarus: delivery window ${id} not found`)
    return decode(row)
  }
  function preferenceOf(missionId: string): number | null {
    return db.prepare('SELECT MAX(revision) AS revision FROM PreferenceRevision WHERE missionId = ?').get<{ revision: number | null }>(missionId)?.revision ?? null
  }
  function unassigned(mission: Mission, preference: number | null): readonly { readonly id: string; readonly observedAt: number }[] {
    return db.prepare(`SELECT Observation.id, Observation.observedAt FROM Observation JOIN Source ON Source.id = Observation.sourceId
      WHERE Source.missionId = ? AND NOT EXISTS (
        SELECT 1 FROM ObservationAssessment WHERE observationId = Observation.id AND missionId = ? AND missionRevision = ? AND preferenceRevision = ?
      ) AND NOT EXISTS (
        SELECT 1 FROM DeliveryWindow, json_each(DeliveryWindow.inputRefs) AS reserved
        WHERE DeliveryWindow.missionId = ? AND DeliveryWindow.missionRevision = ? AND DeliveryWindow.status <> 'superseded' AND reserved.value = Observation.id
      ) ORDER BY Observation.observedAt, Observation.id LIMIT 20`).all<{ id: string; observedAt: number }>(mission.id, mission.id, mission.revision, preference ?? 0, mission.id, mission.revision)
  }
  function create(mission: Mission, key: string, dueAt: number, prepareAt: number, input: readonly string[], preference: number | null): void {
    db.prepare(`INSERT INTO DeliveryWindow(id, missionId, missionRevision, preferenceRevision, windowKey, prepareAt, dueAt, timezone, status, inputRefs, createdAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?) ON CONFLICT(missionId, missionRevision, windowKey) DO NOTHING`)
      .run(newId('window'), mission.id, mission.revision, preference, key, prepareAt, dueAt, mission.timezone, JSON.stringify(input), now())
  }
  function scan(): readonly string[] {
    inTransaction(database, () => {
      db.prepare(`UPDATE DeliveryWindow SET status = 'superseded' WHERE status IN ('open', 'prepared', 'failed')
        AND EXISTS(SELECT 1 FROM Mission WHERE Mission.id = DeliveryWindow.missionId AND (Mission.revision <> DeliveryWindow.missionRevision OR Mission.status = 'cancelled'))
        AND NOT EXISTS(SELECT 1 FROM Outbox WHERE Outbox.deliverableId = DeliveryWindow.deliverableId AND Outbox.status IN ('sent','delivery_unknown'))`).run()
      for (const mission of missions.list({ status: 'active' })) {
        const sourceCount = db.prepare('SELECT COUNT(*) AS count FROM Source WHERE missionId = ?').get<{ count: number }>(mission.id)!.count
        if (sourceCount === 0 && mission.deliveryPolicy === undefined) continue
        const preference = preferenceOf(mission.id)
        if (mission.deliveryPolicy?.mode === 'changes') {
          const batch = unassigned(mission, preference)
          const first = batch[0]
          if (first !== undefined) create(mission, `changes:${first.id}`, first.observedAt, first.observedAt, batch.map(item => item.id), preference)
        } else if (mission.nextDueAt !== null) {
          const outstanding = db.prepare(`SELECT id FROM DeliveryWindow WHERE missionId = ? AND missionRevision = ? AND status IN ('open','prepared','failed')
            AND (deliverableId IS NULL OR NOT EXISTS(SELECT 1 FROM Outbox WHERE Outbox.deliverableId = DeliveryWindow.deliverableId AND Outbox.status = 'sent')) LIMIT 1`).get(mission.id, mission.revision)
          if (outstanding === undefined) {
            const due = mission.nextDueAt
            create(mission, `digest:${due}`, due, due - (mission.deliveryPolicy?.prepareAheadMs ?? 600_000), [], preference)
            const next = mission.schedule.kind === 'once' ? null : nextDueAt(mission.schedule, mission.timezone, Math.max(now(), due))
            db.prepare('UPDATE Mission SET nextDueAt = ? WHERE id = ?').run(next, mission.id)
          }
        }
      }
    })
    const ids = db.prepare(`SELECT DeliveryWindow.id FROM DeliveryWindow JOIN Mission ON Mission.id = DeliveryWindow.missionId
      WHERE DeliveryWindow.status = 'open' AND Mission.status = 'active' AND Mission.revision = DeliveryWindow.missionRevision AND prepareAt <= ?
      AND NOT EXISTS(SELECT 1 FROM Source WHERE Source.missionId = Mission.id AND Source.lastCheckedAt IS NULL)
      AND NOT EXISTS(SELECT 1 FROM Run WHERE Run.deliveryWindowId = DeliveryWindow.id AND Run.status IN ('failed','budget_exhausted'))
      ORDER BY prepareAt, DeliveryWindow.id`).all<{ id: string }>(now())
    const enqueued: string[] = []
    for (const row of ids) {
      const run = store.enqueueWindow(row.id)
      if (run !== null) {
        const window = get(row.id)
        db.prepare('UPDATE Run SET preferenceRevision = ? WHERE id = ?').run(window.preferenceRevision, run.id)
        enqueued.push(run.id)
      }
    }
    return enqueued
  }
  return {
    get,
    list: missionId => (missionId === undefined ? db.prepare('SELECT * FROM DeliveryWindow ORDER BY dueAt, id').all<WindowRow>()
      : db.prepare('SELECT * FROM DeliveryWindow WHERE missionId = ? ORDER BY dueAt, id').all<WindowRow>(missionId)).map(decode),
    scan,
    pending(windowId, limit = 20) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) throw new TypeError('icarus: candidate batches contain at most 20 observations')
      const window = get(windowId)
      if (window.status !== 'open' || window.sealedAt !== null) return []
      return db.prepare(`SELECT Observation.id FROM Observation JOIN Source ON Source.id = Observation.sourceId
        WHERE Source.missionId = ? AND NOT EXISTS(SELECT 1 FROM ObservationAssessment
          WHERE observationId = Observation.id AND missionId = ? AND missionRevision = ? AND preferenceRevision = ?)
        AND (? = '[]' OR Observation.id IN (SELECT value FROM json_each(?)))
        ORDER BY observedAt, Observation.id LIMIT ?`).all<{ id: string }>(window.missionId, window.missionId, window.missionRevision, window.preferenceRevision ?? 0, JSON.stringify(window.inputRefs), JSON.stringify(window.inputRefs), limit).map(row => row.id)
    },
    suppress(windowId, runId, instanceId, outcome) {
      store.committable(runId, instanceId)
      const ref = writeArtifact(paths, `windows/${windowId}/${runId}-outcome.json`, JSON.stringify(outcome))
      inTransaction(database, () => {
        const run = store.get(runId)
        const mission = missions.get(run.missionId)
        if (run.deliveryWindowId !== windowId || mission.status !== 'active') throw new Error('icarus: suppression lost its active Mission')
        const result = db.prepare("UPDATE DeliveryWindow SET status = 'suppressed', outcomeRef = ? WHERE id = ? AND status = 'open'").run(ref, windowId)
        if (Number(result.changes) !== 1) throw new Error('icarus: window already finalized')
        db.prepare("UPDATE Run SET status = 'succeeded', endedAt = ? WHERE id = ? AND leaseOwner = ?").run(now(), runId, instanceId)
        if (mission.kind === 'once') db.prepare("UPDATE Mission SET status = 'completed', updatedAt = ? WHERE id = ?").run(now(), mission.id)
      })
    },
    failed(windowId, outcome) {
      const ref = writeArtifact(paths, `windows/${windowId}/${newId('outcome')}.json`, JSON.stringify(outcome))
      db.prepare("UPDATE DeliveryWindow SET status = 'failed', outcomeRef = ? WHERE id = ? AND status = 'open'").run(ref, windowId)
    },
    retry(windowId) {
      const window = get(windowId)
      const mission = missions.get(window.missionId)
      if (window.status !== 'failed' || mission.status !== 'active' || mission.revision !== window.missionRevision) throw new Error('icarus: retry requires a failed window in the active Mission revision')
      db.prepare("UPDATE DeliveryWindow SET status = 'open' WHERE id = ?").run(windowId)
      // 历史失败保留，显式重试直接登记新尝试。
      store.enqueueWindow(windowId)
      return get(windowId)
    },
    outcome(windowId) { const ref = get(windowId).outcomeRef; return ref === null ? null : JSON.parse(readArtifact(paths, ref)) as unknown },
    delivered(deliverableId) {
      const row = db.prepare('SELECT missionId, missionRevision, dueAt FROM DeliveryWindow WHERE deliverableId = ?').get<{ missionId: string; missionRevision: number; dueAt: number }>(deliverableId)
      if (row === undefined) return
      const mission = missions.get(row.missionId)
      if (mission.revision === row.missionRevision && mission.kind === 'recurring' && mission.deliveryPolicy?.mode !== 'changes' && mission.nextDueAt !== null && mission.nextDueAt <= now()) {
        const ref = writeArtifact(paths, `windows/${getWindowId(deliverableId)}/catchup.json`, JSON.stringify({ scheduledAt: row.dueAt, deliveredAt: now(), mergedThrough: now(), nextMissedAt: mission.nextDueAt }))
        db.prepare('UPDATE DeliveryWindow SET outcomeRef = ? WHERE deliverableId = ?').run(ref, deliverableId)
        db.prepare('UPDATE Mission SET nextDueAt = ? WHERE id = ?').run(nextDueAt(mission.schedule, mission.timezone, now()), mission.id)
      }
    },
  }
  function getWindowId(deliverableId: string): string {
    const row = db.prepare('SELECT id FROM DeliveryWindow WHERE deliverableId = ?').get<{ id: string }>(deliverableId)
    if (row === undefined) throw new Error('icarus: delivered window disappeared')
    return row.id
  }
}
