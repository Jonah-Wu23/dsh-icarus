import { readArtifact } from './artifacts.js'
import { requireObject, stringRefs } from './requirements.js'
import { validateItemFields, templateOf } from '../templates/index.js'
import type { TemplateDefinition, TemplateId } from '../templates/index.js'
import type { IcarusDatabase } from '../storage/index.js'

export type ItemSourceType = 'curation' | 'investigation'

export interface ItemDraft {
  readonly ordinal: number
  readonly assessmentIds: readonly string[]
  readonly observationIds: readonly string[]
  readonly evidenceRefs: readonly string[]
  readonly fields: Readonly<Record<string, unknown>>
  readonly title: string
  readonly url: string
  readonly preferenceRefs: readonly string[]
  readonly sourceType: ItemSourceType
  readonly originItemId: string | null
  readonly originSnapshotRef: string | null
  readonly checkpointId: string | null
}

export interface DeliverableItem extends ItemDraft {
  readonly id: string
  readonly deliverableId: string
}

interface ItemRow extends Omit<DeliverableItem, 'assessmentIds' | 'observationIds' | 'evidenceRefs' | 'fields' | 'preferenceRefs'> {
  readonly assessmentIds: string
  readonly observationIds: string
  readonly evidenceRefs: string
  readonly fields: string
  readonly preferenceRefs: string
}

interface RunDraftRow {
  readonly missionId: string
  readonly missionRevision: number
  readonly deliveryWindowId: string | null
  readonly purpose: string
  readonly preferenceRevision: number | null
  readonly kind: string
  readonly bindings: string
}

function draftRun(database: IcarusDatabase, runId: string): RunDraftRow {
  const row = database.db.prepare(`SELECT Run.missionId, Run.missionRevision, Run.deliveryWindowId, Run.purpose, Run.preferenceRevision,
    Mission.kind, MissionRevision.bindings FROM Run JOIN Mission ON Mission.id = Run.missionId
    JOIN MissionRevision ON MissionRevision.missionId = Run.missionId AND MissionRevision.revision = Run.missionRevision WHERE Run.id = ?`).get<RunDraftRow>(runId)
  if (row === undefined) throw new Error('icarus: item draft requires an existing Run')
  return row
}

function revisionTemplate(bindings: string): TemplateDefinition | undefined {
  const parsed = JSON.parse(bindings) as { template?: { id?: unknown } }
  return templateOf(parsed.template?.id)
}

export function listItems(database: IcarusDatabase, filter: { missionId?: string; deliverableId?: string; ordinal?: number; itemId?: string }): DeliverableItem[] {
  if (filter.ordinal !== undefined && (!Number.isSafeInteger(filter.ordinal) || filter.ordinal < 1 || filter.deliverableId === undefined)) throw new TypeError('icarus: ordinal requires a Deliverable and a positive integer')
  const clauses: string[] = []
  const values: (string | number)[] = []
  for (const [column, value] of [['Run.missionId', filter.missionId], ['DeliverableItem.deliverableId', filter.deliverableId], ['DeliverableItem.ordinal', filter.ordinal], ['DeliverableItem.id', filter.itemId]] as const) {
    if (value !== undefined) { clauses.push(`${column} = ?`); values.push(value) }
  }
  return database.db.prepare(`SELECT DeliverableItem.* FROM DeliverableItem JOIN Deliverable ON Deliverable.id = DeliverableItem.deliverableId
    JOIN Run ON Run.id = Deliverable.runId ${clauses.length === 0 ? '' : `WHERE ${clauses.join(' AND ')}`}
    ORDER BY Deliverable.createdAt, Deliverable.id, DeliverableItem.ordinal`).all<ItemRow>(...values).map(row => ({
      ...row, assessmentIds: stringRefs(JSON.parse(row.assessmentIds)), observationIds: stringRefs(JSON.parse(row.observationIds)),
      evidenceRefs: stringRefs(JSON.parse(row.evidenceRefs)), fields: requireObject(JSON.parse(row.fields)), preferenceRefs: stringRefs(JSON.parse(row.preferenceRefs)),
    }))
}

/** Effective preference entry ids at the Run's pinned version, owned by the Run's Mission. */
function effectivePreferences(database: IcarusDatabase, missionId: string, revision: number | null): Set<string> {
  if (revision === null) return new Set()
  return new Set(database.db.prepare(`SELECT id FROM PreferenceEntry WHERE missionId = ? AND introducedIn <= ? AND (retiredIn IS NULL OR retiredIn > ?)`)
    .all<{ id: string }>(missionId, revision, revision).map(row => row.id))
}

/** Evidence refs an investigation Run may cite: its own readings/tool results and the origin snapshot. */
function investigationEvidence(database: IcarusDatabase, runId: string, run: RunDraftRow): { refs: Set<string>; snapshot: Record<string, unknown> | null } {
  const refs = new Set<string>()
  // Inherited evidence is every reading of the Mission (the parent's included), not only this Run's.
  for (const row of database.db.prepare('SELECT Reading.id, Reading.evidenceRef FROM Reading JOIN Run ON Run.id = Reading.runId WHERE Run.missionId = ?').all<{ id: string; evidenceRef: string }>(run.missionId)) { refs.add(row.id); refs.add(row.evidenceRef) }
  for (const row of database.db.prepare('SELECT id, evidenceRef FROM ToolReading WHERE missionId = ? AND isError = 0').all<{ id: string; evidenceRef: string }>(run.missionId)) { refs.add(row.id); refs.add(row.evidenceRef) }
  const bindings = JSON.parse(run.bindings) as { investigation?: { originSnapshotRef?: unknown } }
  const snapshotRef = typeof bindings.investigation?.originSnapshotRef === 'string' ? bindings.investigation.originSnapshotRef : null
  let snapshot: Record<string, unknown> | null = null
  if (snapshotRef !== null) {
    snapshot = JSON.parse(readArtifact(database.paths, snapshotRef)) as Record<string, unknown>
    refs.add(snapshotRef)
    for (const ref of evidenceRefsIn(snapshot)) refs.add(ref)
  }
  return { refs, snapshot }
}

function evidenceRefsIn(node: unknown, depth = 0): string[] {
  if (depth > 4 || node === null || typeof node !== 'object') return []
  const refs: string[] = []
  if (Array.isArray(node)) {
    for (const child of node) refs.push(...evidenceRefsIn(child, depth + 1))
    return refs
  }
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if ((key === 'ref' || key === 'evidenceRef' || key === 'checkpointId') && typeof value === 'string' && value !== '') refs.push(value)
    else refs.push(...evidenceRefsIn(value, depth + 1))
  }
  return refs
}

export function parseItemDraft(database: IcarusDatabase, runId: string, value: unknown): { content: string; items: ItemDraft[] } {
  const raw = requireObject(value)
  if (typeof raw.content !== 'string' || !raw.content.trim() || !Array.isArray(raw.items)) throw new TypeError('icarus: draft requires content and items')
  const run = draftRun(database, runId)
  if (run.kind === 'investigate' || run.purpose === 'investigation') return parseInvestigationDraft(database, runId, run, raw)
  if (run.deliveryWindowId === null) throw new Error('icarus: item draft requires a delivery window')
  const template = revisionTemplate(run.bindings)
  const preferenceRevision = run.preferenceRevision
  const preferences = effectivePreferences(database, run.missionId, preferenceRevision)
  const selected = database.db.prepare(`SELECT ObservationAssessment.id, ObservationAssessment.observationId, ObservationAssessment.readingRefs, ObservationAssessment.preferenceRefs
    FROM ObservationAssessment JOIN Run AS owner ON owner.id = ObservationAssessment.runId
    WHERE owner.deliveryWindowId = ? AND ObservationAssessment.missionId = ? AND ObservationAssessment.selected = 1`)
    .all<{ id: string; observationId: string; readingRefs: string; preferenceRefs: string }>(run.deliveryWindowId, run.missionId)
  const byId = new Map(selected.map(row => [row.id, row]))
  const seen = new Set<string>()
  const items = raw.items.map((value, index) => {
    const item = requireObject(value)
    if (item.ordinal !== index + 1 || typeof item.title !== 'string' || !item.title.trim() || typeof item.url !== 'string' || !item.url.trim()) throw new TypeError('icarus: items require consecutive ordinals, title and URL')
    const url = new URL(item.url)
    if (!['https:', 'http:'].includes(url.protocol)) throw new TypeError('icarus: item URL must use HTTP or HTTPS')
    const assessmentIds = stringRefs(item.assessmentIds)
    if (assessmentIds.length === 0) throw new Error('icarus: item requires a selected assessment')
    const observations = new Set<string>()
    const evidence = new Set<string>()
    const assessmentPreferences = new Set<string>()
    for (const id of assessmentIds) {
      const assessment = byId.get(id)
      if (assessment === undefined || seen.has(id)) throw new Error('icarus: item assessment must belong to this window and appear exactly once')
      seen.add(id)
      observations.add(assessment.observationId)
      for (const ref of stringRefs(JSON.parse(assessment.readingRefs))) evidence.add(ref)
      for (const ref of stringRefs(JSON.parse(assessment.preferenceRefs))) assessmentPreferences.add(ref)
    }
    const preferenceRefs = stringRefs(item.preferenceRefs)
    for (const ref of preferenceRefs) {
      if (!preferences.has(ref)) throw new Error('icarus: item preference must be effective at this Run\'s preference version')
      if (!assessmentPreferences.has(ref)) throw new Error('icarus: item preference must be used by one of its assessments')
    }
    return { ordinal: index + 1, assessmentIds, observationIds: [...observations], evidenceRefs: [...evidence],
      fields: validateItemFields(template, item.fields), title: item.title, url: item.url, preferenceRefs,
      sourceType: 'curation' as const, originItemId: null, originSnapshotRef: null, checkpointId: null }
  })
  if (seen.size !== selected.length) throw new Error('icarus: every selected assessment must appear in one item')
  return { content: raw.content, items }
}

function parseInvestigationDraft(database: IcarusDatabase, runId: string, run: RunDraftRow, raw: Record<string, unknown>): { content: string; items: ItemDraft[] } {
  if (typeof raw.content !== 'string' || !raw.content.trim()) throw new TypeError('icarus: draft requires content')
  if (!Array.isArray(raw.items)) throw new TypeError('icarus: draft requires items')
  const available = investigationEvidence(database, runId, run)
  const bindings = JSON.parse(run.bindings) as { investigation?: { originItemId?: unknown; originSnapshotRef?: unknown } }
  const originItemId = typeof bindings.investigation?.originItemId === 'string' ? bindings.investigation.originItemId : null
  const originSnapshotRef = typeof bindings.investigation?.originSnapshotRef === 'string' ? bindings.investigation.originSnapshotRef : null
  const checkpoints = new Set(database.db.prepare('SELECT id FROM InvestigationCheckpoint WHERE runId = ?').all<{ id: string }>(runId).map(row => row.id))
  const items = (raw.items as unknown[]).map((value, index) => {
    const item = requireObject(value)
    if (item.ordinal !== index + 1 || typeof item.title !== 'string' || !item.title.trim() || typeof item.url !== 'string' || !item.url.trim()) throw new TypeError('icarus: investigation items require consecutive ordinals, title and URL')
    if (typeof item.url !== 'string' || !item.url.trim()) throw new TypeError('icarus: investigation item requires a URL or a deliverable file path')
    if (/^https?:\/\//i.test(item.url)) {
      const url = new URL(item.url)
      if (!['https:', 'http:'].includes(url.protocol)) throw new TypeError('icarus: item URL must use HTTP or HTTPS')
    } else if (!(item.url.startsWith('/') || /^[A-Za-z]:[\\/]/.test(item.url) || item.url.startsWith('file:'))) {
      throw new TypeError('icarus: investigation item URL must be a link or an absolute file path')
    }
    const evidenceRefs = stringRefs(item.evidenceRefs)
    if (evidenceRefs.length === 0) throw new Error('icarus: investigation item requires actual reading evidence')
    for (const ref of evidenceRefs) if (!available.refs.has(ref)) throw new Error(`icarus: investigation item refers to missing evidence ${ref}`)
    const checkpointId = typeof item.checkpointId === 'string' ? item.checkpointId : null
    if (checkpointId !== null && !checkpoints.has(checkpointId)) throw new Error('icarus: investigation item refers to a checkpoint outside this Run')
    return { ordinal: index + 1, assessmentIds: [], observationIds: [], evidenceRefs,
      fields: requireObject(item.fields), title: item.title, url: item.url, preferenceRefs: [],
      sourceType: 'investigation' as const, originItemId, originSnapshotRef, checkpointId }
  })
  return { content: raw.content, items }
}
