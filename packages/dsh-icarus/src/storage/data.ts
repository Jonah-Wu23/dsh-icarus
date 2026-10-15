// Deletion of a Mission or of everything one Bot owns (PRD §8.1, M2 plan §M2.1).
//
// The schema makes Mission the only deletion root, so one DELETE per Mission removes its
// Sources, Observations, Runs, Deliverables, Feedback, preference revisions, revision
// snapshots and Outbox rows. Files are a second store: the refs those rows point at are
// unlinked from `artifacts/` after the rows are gone, and a ref that resolves outside that
// directory is never touched. M2 connects no UI; these functions are the whole capability.
import { existsSync, rmSync, statSync, readFileSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import type { IcarusDatabase } from './database.js'

export interface DeleteResult {
  /** Mission rows removed; the cascade removed every row below them. */
  readonly missions: number
  /** Files unlinked under `artifacts/`. */
  readonly artifacts: number
}

/** Delete one Mission with everything derived from it. */
export function deleteMissionData(database: IcarusDatabase, missionId: string): DeleteResult {
  const refs = collectArtifactRefs(database, [missionId])
  const directories = ownedDirectories(database, [missionId])
  const removed = database.db.prepare('DELETE FROM Mission WHERE id = ?').run(missionId)
  const missions = Number(removed.changes)
  const artifacts = missions === 0 ? 0 : removeArtifacts(database.paths.artifactsDir, refs)
  if (missions > 0) for (const path of directories) if (existsSync(path)) rmSync(path, { recursive: true })
  return { missions, artifacts }
}

/** Delete every Mission owned by one Bot, with everything derived from them. */
export function deleteBotData(database: IcarusDatabase, ownerBotId: string): DeleteResult {
  const missionIds = database.db
    .prepare('SELECT id FROM Mission WHERE ownerBotId = ?')
    .all<{ id: string }>(ownerBotId)
    .map(row => row.id)
  if (missionIds.length === 0) return { missions: 0, artifacts: 0 }
  const refs = collectArtifactRefs(database, missionIds)
  const directories = ownedDirectories(database, missionIds)
  const removed = database.db.prepare('DELETE FROM Mission WHERE ownerBotId = ?').run(ownerBotId)
  const artifacts = removeArtifacts(database.paths.artifactsDir, refs)
  for (const path of directories) if (existsSync(path)) rmSync(path, { recursive: true })
  return { missions: Number(removed.changes), artifacts }
}

/** Columns holding a path or a JSON list of paths, read before the rows disappear. */
function collectArtifactRefs(database: IcarusDatabase, missionIds: readonly string[]): Set<string> {
  const refs = new Set<string>()
  const ids = missionIds.map(() => '?').join(', ')
  const sources: readonly { readonly sql: string; readonly list: boolean }[] = [
    { sql: `SELECT inputRefs AS value FROM Run WHERE missionId IN (${ids})`, list: true },
    { sql: `SELECT errorRef AS value FROM Run WHERE missionId IN (${ids})`, list: false },
    { sql: `SELECT contextRef AS value FROM Run WHERE missionId IN (${ids})`, list: false },
    { sql: `SELECT capabilityRef AS value FROM Run WHERE missionId IN (${ids})`, list: false },
    { sql: `SELECT outcomeRef AS value FROM DeliveryWindow WHERE missionId IN (${ids})`, list: false },
    { sql: `SELECT evidenceRef AS value FROM CapabilityCheck WHERE missionId IN (${ids})`, list: false },
    { sql: `SELECT evidenceRef AS value FROM CapabilityRecommendation WHERE missionId IN (${ids})`, list: false },
    { sql: `SELECT evidenceRef AS value FROM ToolReading WHERE missionId IN (${ids})`, list: false },
    { sql: `SELECT detailsRef AS value FROM Fault WHERE missionId IN (${ids})`, list: false },
    { sql: `SELECT receiptRef AS value FROM Outbox WHERE deliverableId IN (SELECT Deliverable.id FROM Deliverable JOIN Run ON Run.id = Deliverable.runId WHERE Run.missionId IN (${ids}))`, list: false },
    { sql: `SELECT receiptRef AS value FROM OutboxAttempt WHERE outboxId IN (SELECT Outbox.id FROM Outbox JOIN Deliverable ON Deliverable.id = Outbox.deliverableId JOIN Run ON Run.id = Deliverable.runId WHERE Run.missionId IN (${ids}))`, list: false },
    { sql: `SELECT errorRef AS value FROM OutboxAttempt WHERE outboxId IN (SELECT Outbox.id FROM Outbox JOIN Deliverable ON Deliverable.id = Outbox.deliverableId JOIN Run ON Run.id = Deliverable.runId WHERE Run.missionId IN (${ids}))`, list: false },
    { sql: `SELECT promptRef AS value FROM RunStep WHERE runId IN (SELECT id FROM Run WHERE missionId IN (${ids}))`, list: false },
    { sql: `SELECT responseRef AS value FROM RunStep WHERE runId IN (SELECT id FROM Run WHERE missionId IN (${ids}))`, list: false },
    { sql: `SELECT responseRef AS value FROM SourceAttempt WHERE sourceId IN (SELECT id FROM Source WHERE missionId IN (${ids}))`, list: false },
    { sql: `SELECT errorRef AS value FROM SourceAttempt WHERE sourceId IN (SELECT id FROM Source WHERE missionId IN (${ids}))`, list: false },
    { sql: `SELECT evidenceRef AS value FROM Observation WHERE sourceId IN (SELECT id FROM Source WHERE missionId IN (${ids}))`, list: false },
    { sql: `SELECT evidenceRefs AS value FROM Deliverable WHERE runId IN (SELECT id FROM Run WHERE missionId IN (${ids}))`, list: true },
    { sql: `SELECT artifactRefs AS value FROM Deliverable WHERE runId IN (SELECT id FROM Run WHERE missionId IN (${ids}))`, list: true },
  ]
  for (const source of sources) {
    for (const row of database.db.prepare(source.sql).all<{ value: string | null }>(...missionIds)) {
      if (row.value === null || row.value === '') continue
      if (source.list) addListRefs(row.value, refs)
      else refs.add(row.value)
    }
  }
  return refs
}

function ownedDirectories(database: IcarusDatabase, missionIds: readonly string[]): readonly string[] {
  const directories: string[] = []
  for (const missionId of missionIds) {
    const records = [
      { directory: 'missions', id: missionId },
      ...database.db.prepare('SELECT id FROM Run WHERE missionId = ?').all<{ id: string }>(missionId).map(row => ({ directory: 'runs', id: row.id })),
      ...database.db.prepare('SELECT id FROM Source WHERE missionId = ?').all<{ id: string }>(missionId).map(row => ({ directory: 'sources', id: row.id })),
      ...database.db.prepare('SELECT id FROM DeliveryWindow WHERE missionId = ?').all<{ id: string }>(missionId).map(row => ({ directory: 'windows', id: row.id })),
      ...database.db.prepare('SELECT Outbox.id FROM Outbox JOIN Deliverable ON Deliverable.id = Outbox.deliverableId JOIN Run ON Run.id = Deliverable.runId WHERE Run.missionId = ?').all<{ id: string }>(missionId).map(row => ({ directory: 'deliveries', id: row.id })),
    ]
    for (const record of records) {
      const namespace = resolve(database.paths.artifactsDir, record.directory)
      const target = resolve(namespace, record.id)
      if (!target.startsWith(namespace + sep) || target.slice(namespace.length + 1).includes(sep)) throw new Error('icarus: invalid owned artifact directory')
      directories.push(target)
    }
  }
  return directories
}

export function exportMissionData(database: IcarusDatabase, missionId: string): unknown {
  const mission = database.db.prepare('SELECT * FROM Mission WHERE id = ?').get(missionId)
  if (mission === undefined) throw new Error('icarus: Mission does not exist')
  const result: Record<string, unknown> = { Mission: mission }
  const direct = ['MissionRevision', 'Source', 'Run', 'PreferenceRevision', 'DeliveryWindow', 'ObservationAssessment', 'CapabilityCheck', 'CapabilityRecommendation', 'ToolReading', 'Fault']
  for (const table of direct) result[table] = database.db.prepare(`SELECT * FROM ${table} WHERE missionId = ?`).all(missionId)
  const queries: Record<string, string> = {
    Observation: 'sourceId IN (SELECT id FROM Source WHERE missionId = ?)',
    SourceAttempt: 'sourceId IN (SELECT id FROM Source WHERE missionId = ?)',
    Deliverable: 'runId IN (SELECT id FROM Run WHERE missionId = ?)',
    RunStep: 'runId IN (SELECT id FROM Run WHERE missionId = ?)',
    Reading: 'runId IN (SELECT id FROM Run WHERE missionId = ?)',
    ModelCall: 'runId IN (SELECT id FROM Run WHERE missionId = ?)',
    Feedback: 'deliverableId IN (SELECT Deliverable.id FROM Deliverable JOIN Run ON Run.id = Deliverable.runId WHERE Run.missionId = ?)',
    Outbox: 'deliverableId IN (SELECT Deliverable.id FROM Deliverable JOIN Run ON Run.id = Deliverable.runId WHERE Run.missionId = ?)',
    OutboxAttempt: 'outboxId IN (SELECT Outbox.id FROM Outbox JOIN Deliverable ON Deliverable.id = Outbox.deliverableId JOIN Run ON Run.id = Deliverable.runId WHERE Run.missionId = ?)',
  }
  for (const [table, where] of Object.entries(queries)) result[table] = database.db.prepare(`SELECT * FROM ${table} WHERE ${where}`).all(missionId)
  const refs = collectArtifactRefs(database, [missionId])
  const files: Record<string, string> = {}
  for (const ref of refs) {
    const root = resolve(database.paths.artifactsDir)
    const path = resolve(root, ref)
    if (path.startsWith(root + sep) && existsSync(path) && statSync(path).isFile()) files[ref] = readFileSync(path, 'utf8')
  }
  result.artifacts = files
  return result
}

function addListRefs(json: string, refs: Set<string>): void {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    // A stored value that is not JSON is still a ref; keep it verbatim.
    refs.add(json)
    return
  }
  const items = Array.isArray(parsed) ? parsed : [parsed]
  for (const item of items) if (typeof item === 'string' && item !== '') refs.add(item)
}

/** Unlink file refs that resolve inside `artifactsDir`; anything else is left alone. */
function removeArtifacts(artifactsDir: string, refs: ReadonlySet<string>): number {
  const root = resolve(artifactsDir)
  const prefix = root + sep
  let removed = 0
  for (const ref of refs) {
    const target = resolve(root, ref)
    // Refs are stored relative to artifactsDir. A path outside it, or a directory ref,
    // is never touched: over-deletion would reach data of another Mission.
    if (!target.startsWith(prefix)) continue
    if (!existsSync(target) || !statSync(target).isFile()) continue
    rmSync(target, { force: true })
    removed += 1
  }
  return removed
}
