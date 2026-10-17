// Feedback and preference revisions (M4.3/M4.4), database-only.
//
// Feedback is what a reader did with one delivered item; a preference revision is the set of
// statements that feedback produced. PreferenceEntry carries its own interval, so a revision is
// the set of entries effective at it (`introducedIn <= r AND (retiredIn IS NULL OR retiredIn > r)`)
// and retiring an entry never rewrites an earlier revision. `publish` is the only writer of
// preferences: it checks the base revision, validates every statement against the feedback it
// cites, retires what expired, and returns null when the input produced no change.
import { newId } from '../domain/ids.js'
import { inTransaction } from '../domain/missions.js'
import type { IcarusDatabase } from '../storage/index.js'

export const FEEDBACK_ACTIONS = ['useful', 'not_interested', 'seen', 'saved'] as const
export type FeedbackAction = (typeof FEEDBACK_ACTIONS)[number]

export const FEEDBACK_SOURCES = ['bot', 'qq', 'ui'] as const
export type FeedbackSource = (typeof FEEDBACK_SOURCES)[number]

export const FEEDBACK_STATUSES = ['recorded', 'applied', 'superseded', 'withdrawn'] as const
export type FeedbackStatus = (typeof FEEDBACK_STATUSES)[number]

export type PreferenceOrigin = 'explicit' | 'inferred'

export interface FeedbackRecord {
  id: string
  deliverableId: string
  itemId: string | null
  action: string
  comment: string | null
  source: FeedbackSource
  channelEventRef: string | null
  sessionId: string | null
  status: FeedbackStatus
  preferenceRevision: number | null
  supersedes: string | null
  createdAt: number
}

export interface PreferenceEntryRecord {
  id: string
  missionId: string
  introducedIn: number
  retiredIn: number | null
  origin: PreferenceOrigin
  statement: string
  scope: Record<string, unknown>
  quote: string | null
  feedbackIds: string[]
  explanation: string | null
  expiresAt: number | null
  createdAt: number
}

export interface PreferenceRevisionView {
  missionId: string
  revision: number
  explicitRequirements: string[]
  inferredPreferences: string[]
  feedbackRefs: string[]
  basedOn: number | null
  changeRef: string | null
  publishedAt: number
  createdAt: number
  entries: PreferenceEntryRecord[]
}

export interface ConsolidationFeedback {
  feedback: FeedbackRecord
  item: { itemId: string; deliverableId: string; ordinal: number; title: string; url: string; fields: Record<string, unknown> } | null
  deliverable: { id: string; content: string } | null
}

export interface ConsolidationInput {
  missionId: string
  missionRevision: number
  templateId: string | null
  baseRevision: number | null
  entries: PreferenceEntryRecord[]
  expiredEntries: PreferenceEntryRecord[]
  feedback: ConsolidationFeedback[]
  withdrawn: ConsolidationFeedback[]
}

export type ConsolidationChange =
  | { readonly kind: 'add-explicit'; readonly statement: string; readonly scope: Record<string, unknown>; readonly quote: string; readonly feedbackIds: readonly string[] }
  | { readonly kind: 'add-inferred'; readonly statement: string; readonly scope: Record<string, unknown>; readonly explanation: string; readonly feedbackIds: readonly string[]; readonly expiresInDays?: number | undefined }
  | { readonly kind: 'retire'; readonly entryId: string; readonly reason: string; readonly feedbackIds: readonly string[] }

export interface FeedbackService {
  record(input: {
    missionId: string
    deliverableId: string
    itemId?: string | undefined
    action?: string | undefined
    comment?: string | undefined
    source?: string | undefined
    sessionId?: string | undefined
    channelEventRef?: string | undefined
  }): { feedback: FeedbackRecord; duplicate: boolean }
  withdraw(missionId: string, feedbackId: string): FeedbackRecord
  readEvent(input: { missionId: string; itemId: string; channel: string; channelEventRef?: string | undefined; at?: number | undefined }): { id: string; duplicate: boolean }
  get(missionId: string, feedbackId: string): FeedbackRecord
  list(missionId: string, filter?: { itemId?: string | undefined; deliverableId?: string | undefined; status?: string | undefined }): FeedbackRecord[]
  current(missionId: string): { revision: number | null; entries: PreferenceEntryRecord[] }
  effective(missionId: string, revision: number | null): PreferenceEntryRecord[]
  history(missionId: string): PreferenceRevisionView[]
  revision(missionId: string, revision: number): PreferenceRevisionView | null
  latestPublished(missionId: string): number | null
  entry(missionId: string, entryId: string): PreferenceEntryRecord
  adoption(missionId: string, entryId: string): {
    entry: PreferenceEntryRecord
    references: { runId: string; missionRevision: number; preferenceRevision: number | null; selected: number; unselected: number }[]
    assessments: { assessmentId: string; observationId: string; runId: string; selected: boolean; reason: string }[]
    items: { itemId: string; deliverableId: string; ordinal: number; title: string; url: string }[]
  }
  pending(missionId: string): FeedbackRecord[]
  needsConsolidation(): { missionId: string; reason: 'feedback' | 'expiry'; feedbackIds: string[] }[]
  consolidationInput(missionId: string): ConsolidationInput
  publish(input: { missionId: string; baseRevision: number | null; changes: readonly ConsolidationChange[]; feedbackIds: readonly string[]; changeRef: string; now?: number | undefined }): PreferenceRevisionView | null
}

export interface FeedbackServiceOptions {
  /** Clock used for record times and expiry decisions; defaults to `Date.now`. */
  readonly now?: (() => number) | undefined
}

interface FeedbackRow {
  readonly id: string
  readonly deliverableId: string
  readonly itemId: string | null
  readonly action: string
  readonly comment: string | null
  readonly createdAt: number
  readonly supersedes: string | null
  readonly source: string
  readonly channelEventRef: string | null
  readonly sessionId: string | null
  readonly status: string
  readonly preferenceRevision: number | null
}

interface EntryRow {
  readonly id: string
  readonly missionId: string
  readonly introducedIn: number
  readonly retiredIn: number | null
  readonly origin: string
  readonly statement: string
  readonly scope: string
  readonly quote: string | null
  readonly feedbackIds: string
  readonly explanation: string | null
  readonly expiresAt: number | null
  readonly createdAt: number
}

interface RevisionRow {
  readonly missionId: string
  readonly revision: number
  readonly explicitRequirements: string
  readonly inferredPreferences: string
  readonly feedbackRefs: string
  readonly basedOn: number | null
  readonly changeRef: string | null
  readonly publishedAt: number
  readonly createdAt: number
}

interface ConsolidationRow extends FeedbackRow {
  readonly deliverableContent: string
  readonly itemRowId: string | null
  readonly itemOrdinal: number | null
  readonly itemTitle: string | null
  readonly itemUrl: string | null
  readonly itemFields: string | null
}

interface PendingEntry {
  readonly origin: PreferenceOrigin
  readonly statement: string
  readonly scope: Record<string, unknown>
  readonly quote: string | null
  readonly explanation: string | null
  readonly feedbackIds: string[]
  readonly expiresAt: number | null
}

const FEEDBACK_COLUMNS = `Feedback.id, Feedback.deliverableId, Feedback.itemId, Feedback.action, Feedback.comment, Feedback.createdAt,
  Feedback.supersedes, Feedback.source, Feedback.channelEventRef, Feedback.sessionId, Feedback.status, Feedback.preferenceRevision`

const ENTRY_COLUMNS = `id, missionId, introducedIn, retiredIn, origin, statement, scope, quote, feedbackIds, explanation, expiresAt, createdAt`

const REVISION_COLUMNS = `missionId, revision, explicitRequirements, inferredPreferences, feedbackRefs, basedOn, changeRef, publishedAt, createdAt`

export function createFeedbackService(database: IcarusDatabase, options: FeedbackServiceOptions = {}): FeedbackService {
  const { db } = database
  const now = options.now ?? (() => Date.now())

  function latestPublished(missionId: string): number | null {
    return db.prepare('SELECT MAX(revision) AS revision FROM PreferenceRevision WHERE missionId = ?').get<{ revision: number | null }>(missionId)?.revision ?? null
  }

  function decodeFeedback(row: FeedbackRow): FeedbackRecord {
    return { ...row, source: sourceOf(row.source), status: statusOf(row.status) }
  }

  function decodeEntry(row: EntryRow): PreferenceEntryRecord {
    return {
      id: row.id, missionId: row.missionId, introducedIn: row.introducedIn, retiredIn: row.retiredIn,
      origin: originOf(row.origin), statement: row.statement, scope: objectOf(row.scope), quote: row.quote,
      feedbackIds: stringsOf(row.feedbackIds), explanation: row.explanation, expiresAt: row.expiresAt, createdAt: row.createdAt,
    }
  }

  function effective(missionId: string, version: number | null): PreferenceEntryRecord[] {
    if (version === null) return []
    return db.prepare(`SELECT ${ENTRY_COLUMNS} FROM PreferenceEntry
      WHERE missionId = ? AND introducedIn <= ? AND (retiredIn IS NULL OR retiredIn > ?)
      ORDER BY introducedIn, createdAt, id`).all<EntryRow>(missionId, version, version).map(decodeEntry)
  }

  function effectiveAt(candidate: PreferenceEntryRecord, version: number): boolean {
    return candidate.introducedIn <= version && (candidate.retiredIn === null || candidate.retiredIn > version)
  }

  function revisionView(row: RevisionRow, entries: PreferenceEntryRecord[]): PreferenceRevisionView {
    return {
      missionId: row.missionId,
      revision: row.revision,
      explicitRequirements: stringsOf(row.explicitRequirements),
      inferredPreferences: stringsOf(row.inferredPreferences),
      feedbackRefs: stringsOf(row.feedbackRefs),
      basedOn: row.basedOn,
      changeRef: row.changeRef,
      publishedAt: row.publishedAt,
      createdAt: row.createdAt,
      entries,
    }
  }

  function requireFeedback(missionId: string, feedbackId: string): FeedbackRecord {
    const row = db.prepare(`SELECT ${FEEDBACK_COLUMNS} FROM Feedback
      JOIN Deliverable ON Deliverable.id = Feedback.deliverableId
      JOIN Run ON Run.id = Deliverable.runId
      WHERE Feedback.id = ? AND Run.missionId = ?`).get<FeedbackRow>(feedbackId, missionId)
    if (row === undefined) throw new Error(`icarus: no Feedback ${JSON.stringify(feedbackId)} in Mission ${JSON.stringify(missionId)}`)
    return decodeFeedback(row)
  }

  function requireEntry(missionId: string, entryId: string): PreferenceEntryRecord {
    const row = db.prepare(`SELECT ${ENTRY_COLUMNS} FROM PreferenceEntry WHERE id = ? AND missionId = ?`).get<EntryRow>(entryId, missionId)
    if (row === undefined) throw new Error(`icarus: no PreferenceEntry ${JSON.stringify(entryId)} in Mission ${JSON.stringify(missionId)}`)
    return decodeEntry(row)
  }

  function markApplied(feedbackIds: readonly string[], version: number | null): void {
    if (feedbackIds.length === 0) return
    db.prepare(`UPDATE Feedback SET status = 'applied', preferenceRevision = ? WHERE id IN (${feedbackIds.map(() => '?').join(', ')})`)
      .run(version, ...feedbackIds)
  }

  function consolidationFeedback(missionId: string, clause: string, values: readonly string[]): ConsolidationFeedback[] {
    const rows = db.prepare(`SELECT ${FEEDBACK_COLUMNS},
      Deliverable.content AS deliverableContent,
      DeliverableItem.id AS itemRowId, DeliverableItem.ordinal AS itemOrdinal,
      DeliverableItem.title AS itemTitle, DeliverableItem.url AS itemUrl, DeliverableItem.fields AS itemFields
      FROM Feedback
      JOIN Deliverable ON Deliverable.id = Feedback.deliverableId
      JOIN Run ON Run.id = Deliverable.runId
      LEFT JOIN DeliverableItem ON DeliverableItem.id = Feedback.itemId AND DeliverableItem.deliverableId = Feedback.deliverableId
      WHERE Run.missionId = ? AND ${clause}
      ORDER BY Feedback.createdAt, Feedback.id`).all<ConsolidationRow>(missionId, ...values)
    return rows.map(row => ({
      feedback: decodeFeedback(row),
      item: row.itemRowId === null ? null : {
        itemId: row.itemRowId, deliverableId: row.deliverableId, ordinal: row.itemOrdinal!, title: row.itemTitle!, url: row.itemUrl!,
        fields: objectOf(row.itemFields!),
      },
      deliverable: { id: row.deliverableId, content: row.deliverableContent.slice(0, 4000) },
    }))
  }

  function record(input: {
    missionId: string
    deliverableId: string
    itemId?: string | undefined
    action?: string | undefined
    comment?: string | undefined
    source?: string | undefined
    sessionId?: string | undefined
    channelEventRef?: string | undefined
  }): { feedback: FeedbackRecord; duplicate: boolean } {
    const missionId = nonEmptyString(input.missionId, 'missionId')
    const deliverableId = nonEmptyString(input.deliverableId, 'deliverableId')
    const owned = db.prepare(`SELECT Deliverable.id FROM Deliverable JOIN Run ON Run.id = Deliverable.runId
      WHERE Deliverable.id = ? AND Run.missionId = ?`).get<{ readonly id: string }>(deliverableId, missionId)
    if (owned === undefined) throw new Error(`icarus: Deliverable ${JSON.stringify(deliverableId)} is not in Mission ${JSON.stringify(missionId)}`)
    const itemId = input.itemId === undefined ? null : nonEmptyString(input.itemId, 'itemId')
    if (itemId !== null && db.prepare('SELECT id FROM DeliverableItem WHERE id = ? AND deliverableId = ?').get<{ readonly id: string }>(itemId, deliverableId) === undefined) {
      throw new Error(`icarus: DeliverableItem ${JSON.stringify(itemId)} is not in Deliverable ${JSON.stringify(deliverableId)}`)
    }
    const comment = input.comment === undefined ? null : nonEmptyString(input.comment, 'comment')
    // A comment without an action is stored as 'comment': the action column is NOT NULL and the
    // caller named no action, so inventing one of the four would claim a judgement nobody made.
    const action = input.action === undefined ? 'comment' : nonEmptyString(input.action, 'action')
    if (comment === null && input.action === undefined) throw new TypeError('icarus: feedback requires an action or a comment')
    if (comment === null && !(FEEDBACK_ACTIONS as readonly string[]).includes(action)) {
      throw new TypeError(`icarus: feedback action must be one of ${JSON.stringify(FEEDBACK_ACTIONS)} unless the feedback carries a comment`)
    }
    const source = input.source === undefined ? 'bot' : sourceOf(nonEmptyString(input.source, 'source'))
    const channelEventRef = input.channelEventRef === undefined ? null : nonEmptyString(input.channelEventRef, 'channelEventRef')
    const sessionId = input.sessionId === undefined ? null : nonEmptyString(input.sessionId, 'sessionId')
    if (channelEventRef !== null) {
      const existing = db.prepare(`SELECT ${FEEDBACK_COLUMNS}, Run.missionId AS missionId FROM Feedback
        JOIN Deliverable ON Deliverable.id = Feedback.deliverableId
        JOIN Run ON Run.id = Deliverable.runId
        WHERE Feedback.source = ? AND Feedback.channelEventRef = ?`).get<FeedbackRow & { readonly missionId: string }>(source, channelEventRef)
      if (existing !== undefined) {
        if (existing.missionId !== missionId) throw new Error(`icarus: channel event ${JSON.stringify(channelEventRef)} is already recorded for another Mission`)
        return { feedback: decodeFeedback(existing), duplicate: true }
      }
    }
    const id = newId('feedback')
    db.prepare(`INSERT INTO Feedback (id, deliverableId, itemId, action, comment, createdAt, supersedes, source, channelEventRef, sessionId, status, preferenceRevision)
      VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, 'recorded', NULL)`)
      .run(id, deliverableId, itemId, action, comment, now(), source, channelEventRef, sessionId)
    return { feedback: requireFeedback(missionId, id), duplicate: false }
  }

  function withdraw(missionId: string, feedbackId: string): FeedbackRecord {
    const id = nonEmptyString(missionId, 'missionId')
    const ref = nonEmptyString(feedbackId, 'feedbackId')
    requireFeedback(id, ref)
    db.prepare(`UPDATE Feedback SET status = 'withdrawn' WHERE id = ?`).run(ref)
    return requireFeedback(id, ref)
  }

  function readEvent(input: {
    missionId: string
    itemId: string
    channel: string
    channelEventRef?: string | undefined
    at?: number | undefined
  }): { id: string; duplicate: boolean } {
    const missionId = nonEmptyString(input.missionId, 'missionId')
    const itemId = nonEmptyString(input.itemId, 'itemId')
    const owned = db.prepare(`SELECT DeliverableItem.id FROM DeliverableItem
      JOIN Deliverable ON Deliverable.id = DeliverableItem.deliverableId
      JOIN Run ON Run.id = Deliverable.runId
      WHERE DeliverableItem.id = ? AND Run.missionId = ?`).get<{ readonly id: string }>(itemId, missionId)
    if (owned === undefined) throw new Error(`icarus: DeliverableItem ${JSON.stringify(itemId)} is not in Mission ${JSON.stringify(missionId)}`)
    const channel = nonEmptyString(input.channel, 'channel')
    const channelEventRef = input.channelEventRef === undefined ? null : nonEmptyString(input.channelEventRef, 'channelEventRef')
    if (channelEventRef !== null) {
      const existing = db.prepare('SELECT id FROM ReadEvent WHERE channel = ? AND channelEventRef = ?').get<{ readonly id: string }>(channel, channelEventRef)
      if (existing !== undefined) return { id: existing.id, duplicate: true }
    }
    const at = input.at === undefined ? now() : timeOf(input.at, 'at')
    const id = newId('read')
    db.prepare('INSERT INTO ReadEvent (id, missionId, itemId, channel, channelEventRef, at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, missionId, itemId, channel, channelEventRef, at)
    return { id, duplicate: false }
  }

  function get(missionId: string, feedbackId: string): FeedbackRecord {
    return requireFeedback(nonEmptyString(missionId, 'missionId'), nonEmptyString(feedbackId, 'feedbackId'))
  }

  function list(missionId: string, filter: { itemId?: string | undefined; deliverableId?: string | undefined; status?: string | undefined } = {}): FeedbackRecord[] {
    const clauses = ['Run.missionId = ?']
    const values: string[] = [nonEmptyString(missionId, 'missionId')]
    if (filter.itemId !== undefined) { clauses.push('Feedback.itemId = ?'); values.push(nonEmptyString(filter.itemId, 'itemId')) }
    if (filter.deliverableId !== undefined) { clauses.push('Feedback.deliverableId = ?'); values.push(nonEmptyString(filter.deliverableId, 'deliverableId')) }
    if (filter.status !== undefined) { clauses.push('Feedback.status = ?'); values.push(statusOf(nonEmptyString(filter.status, 'status'))) }
    return db.prepare(`SELECT ${FEEDBACK_COLUMNS} FROM Feedback
      JOIN Deliverable ON Deliverable.id = Feedback.deliverableId
      JOIN Run ON Run.id = Deliverable.runId
      WHERE ${clauses.join(' AND ')} ORDER BY Feedback.createdAt, Feedback.id`).all<FeedbackRow>(...values).map(decodeFeedback)
  }

  function current(missionId: string): { revision: number | null; entries: PreferenceEntryRecord[] } {
    const id = nonEmptyString(missionId, 'missionId')
    const version = latestPublished(id)
    return { revision: version, entries: effective(id, version) }
  }

  function history(missionId: string): PreferenceRevisionView[] {
    const id = nonEmptyString(missionId, 'missionId')
    const revisions = db.prepare(`SELECT ${REVISION_COLUMNS} FROM PreferenceRevision WHERE missionId = ? ORDER BY revision`).all<RevisionRow>(id)
    if (revisions.length === 0) return []
    const entries = db.prepare(`SELECT ${ENTRY_COLUMNS} FROM PreferenceEntry WHERE missionId = ? ORDER BY introducedIn, createdAt, id`).all<EntryRow>(id).map(decodeEntry)
    return revisions.map(row => revisionView(row, entries.filter(candidate => effectiveAt(candidate, row.revision))))
  }

  function revision(missionId: string, version: number): PreferenceRevisionView | null {
    const id = nonEmptyString(missionId, 'missionId')
    const row = db.prepare(`SELECT ${REVISION_COLUMNS} FROM PreferenceRevision WHERE missionId = ? AND revision = ?`).get<RevisionRow>(id, version)
    return row === undefined ? null : revisionView(row, effective(id, version))
  }

  function entry(missionId: string, entryId: string): PreferenceEntryRecord {
    return requireEntry(nonEmptyString(missionId, 'missionId'), nonEmptyString(entryId, 'entryId'))
  }

  function adoption(missionId: string, entryId: string): {
    entry: PreferenceEntryRecord
    references: { runId: string; missionRevision: number; preferenceRevision: number | null; selected: number; unselected: number }[]
    assessments: { assessmentId: string; observationId: string; runId: string; selected: boolean; reason: string }[]
    items: { itemId: string; deliverableId: string; ordinal: number; title: string; url: string }[]
  } {
    const id = nonEmptyString(missionId, 'missionId')
    const record = requireEntry(id, nonEmptyString(entryId, 'entryId'))
    const references = db.prepare(`SELECT Run.id AS runId, Run.missionRevision AS missionRevision, Run.preferenceRevision AS preferenceRevision,
      SUM(CASE WHEN ObservationAssessment.selected = 1 THEN 1 ELSE 0 END) AS selected,
      SUM(CASE WHEN ObservationAssessment.selected = 0 THEN 1 ELSE 0 END) AS unselected
      FROM ObservationAssessment JOIN Run ON Run.id = ObservationAssessment.runId
      WHERE ObservationAssessment.missionId = ? AND EXISTS(SELECT 1 FROM json_each(ObservationAssessment.preferenceRefs) AS refs WHERE refs.value = ?)
      GROUP BY Run.id ORDER BY Run.createdAt, Run.id`).all<{
      readonly runId: string
      readonly missionRevision: number
      readonly preferenceRevision: number | null
      readonly selected: number
      readonly unselected: number
    }>(id, record.id)
    const assessments = db.prepare(`SELECT id AS assessmentId, observationId, runId, selected, reason FROM ObservationAssessment
      WHERE missionId = ? AND EXISTS(SELECT 1 FROM json_each(ObservationAssessment.preferenceRefs) AS refs WHERE refs.value = ?)
      ORDER BY createdAt, id`).all<{
      readonly assessmentId: string
      readonly observationId: string
      readonly runId: string
      readonly selected: number
      readonly reason: string
    }>(id, record.id)
    const items = db.prepare(`SELECT DeliverableItem.id AS itemId, DeliverableItem.deliverableId AS deliverableId,
      DeliverableItem.ordinal AS ordinal, DeliverableItem.title AS title, DeliverableItem.url AS url
      FROM DeliverableItem JOIN Deliverable ON Deliverable.id = DeliverableItem.deliverableId
      JOIN Run ON Run.id = Deliverable.runId
      WHERE Run.missionId = ? AND EXISTS(SELECT 1 FROM json_each(DeliverableItem.preferenceRefs) AS refs WHERE refs.value = ?)
      ORDER BY Deliverable.createdAt, Deliverable.id, DeliverableItem.ordinal`).all<{
      readonly itemId: string
      readonly deliverableId: string
      readonly ordinal: number
      readonly title: string
      readonly url: string
    }>(id, record.id)
    return {
      entry: record,
      references,
      assessments: assessments.map(row => ({ ...row, selected: row.selected === 1 })),
      items,
    }
  }

  function pending(missionId: string): FeedbackRecord[] {
    return list(missionId, { status: 'recorded' })
  }

  function needsConsolidation(): { missionId: string; reason: 'feedback' | 'expiry'; feedbackIds: string[] }[] {
    const at = now()
    const recorded = db.prepare(`SELECT Mission.id AS missionId, Feedback.id AS feedbackId FROM Feedback
      JOIN Deliverable ON Deliverable.id = Feedback.deliverableId
      JOIN Run ON Run.id = Deliverable.runId
      JOIN Mission ON Mission.id = Run.missionId
      WHERE Mission.status = 'active' AND Feedback.status = 'recorded'
      ORDER BY Mission.id, Feedback.createdAt, Feedback.id`).all<{ readonly missionId: string; readonly feedbackId: string }>()
    const expired = db.prepare(`SELECT PreferenceEntry.missionId AS missionId, PreferenceEntry.introducedIn AS introducedIn,
      PreferenceEntry.retiredIn AS retiredIn, PreferenceEntry.feedbackIds AS feedbackIds,
      (SELECT MAX(revision) FROM PreferenceRevision WHERE PreferenceRevision.missionId = PreferenceEntry.missionId) AS latest
      FROM PreferenceEntry JOIN Mission ON Mission.id = PreferenceEntry.missionId
      WHERE Mission.status = 'active' AND PreferenceEntry.origin = 'inferred'
        AND PreferenceEntry.expiresAt IS NOT NULL AND PreferenceEntry.expiresAt <= ?`).all<{
      readonly missionId: string
      readonly introducedIn: number
      readonly retiredIn: number | null
      readonly feedbackIds: string
      readonly latest: number | null
    }>(at)
    const pendingIds = new Map<string, Set<string>>()
    for (const row of recorded) {
      const group = pendingIds.get(row.missionId) ?? new Set<string>()
      pendingIds.set(row.missionId, group)
      group.add(row.feedbackId)
    }
    const expiredIds = new Map<string, Set<string>>()
    for (const row of expired) {
      // A retired entry and an entry outside the published revision are not effective, so their
      // expiry does not ask for a consolidation.
      if (row.latest === null || row.introducedIn > row.latest || (row.retiredIn !== null && row.retiredIn <= row.latest)) continue
      const group = expiredIds.get(row.missionId) ?? new Set<string>()
      expiredIds.set(row.missionId, group)
      for (const feedbackId of stringsOf(row.feedbackIds)) group.add(feedbackId)
    }
    const missions = [...new Set([...pendingIds.keys(), ...expiredIds.keys()])].sort((left, right) => left.localeCompare(right))
    const rows: { missionId: string; reason: 'feedback' | 'expiry'; feedbackIds: string[] }[] = []
    for (const missionId of missions) {
      const pending = pendingIds.get(missionId)
      if (pending !== undefined) rows.push({ missionId, reason: 'feedback', feedbackIds: [...pending] })
      else rows.push({ missionId, reason: 'expiry', feedbackIds: [...(expiredIds.get(missionId) ?? [])] })
    }
    return rows
  }

  function consolidationInput(missionId: string): ConsolidationInput {
    const id = nonEmptyString(missionId, 'missionId')
    const mission = db.prepare('SELECT revision FROM Mission WHERE id = ?').get<{ readonly revision: number }>(id)
    if (mission === undefined) throw new Error(`icarus: no Mission ${JSON.stringify(id)}`)
    const revision = db.prepare('SELECT bindings FROM MissionRevision WHERE missionId = ? AND revision = ?')
      .get<{ readonly bindings: string }>(id, mission.revision)
    if (revision === undefined) throw new Error(`icarus: Mission ${JSON.stringify(id)} has no revision ${mission.revision}`)
    const baseRevision = latestPublished(id)
    const entries = effective(id, baseRevision)
    const at = now()
    const expiredEntries = entries.filter(candidate => candidate.origin === 'inferred' && candidate.expiresAt !== null && candidate.expiresAt <= at)
    const referenced = [...new Set(entries.flatMap(candidate => candidate.feedbackIds))]
    const withdrawn = referenced.length === 0
      ? []
      : consolidationFeedback(id, `Feedback.status = 'withdrawn' AND Feedback.id IN (${referenced.map(() => '?').join(', ')})`, referenced)
    return {
      missionId: id,
      missionRevision: mission.revision,
      templateId: templateOf(revision.bindings),
      baseRevision,
      entries,
      expiredEntries,
      feedback: consolidationFeedback(id, `Feedback.status = 'recorded'`, []),
      withdrawn,
    }
  }

  function publish(input: {
    missionId: string
    baseRevision: number | null
    changes: readonly ConsolidationChange[]
    feedbackIds: readonly string[]
    changeRef: string
    now?: number | undefined
  }): PreferenceRevisionView | null {
    const missionId = nonEmptyString(input.missionId, 'missionId')
    if (input.baseRevision !== null && (!Number.isSafeInteger(input.baseRevision) || input.baseRevision < 1)) {
      throw new TypeError('icarus: baseRevision must be a positive integer or null')
    }
    const changeRef = nonEmptyString(input.changeRef, 'changeRef')
    const at = input.now === undefined ? now() : timeOf(input.now, 'now')
    return inTransaction(database, () => {
      if (latestPublished(missionId) !== input.baseRevision) throw new Error('icarus: preference base revision changed')
      const referenced = stringIds([...input.feedbackIds, ...input.changes.flatMap(change => change.feedbackIds)], 'feedbackId')
      const comments = new Map<string, string | null>()
      for (const feedbackId of referenced) {
        const row = db.prepare(`SELECT Feedback.comment FROM Feedback
          JOIN Deliverable ON Deliverable.id = Feedback.deliverableId
          JOIN Run ON Run.id = Deliverable.runId
          WHERE Feedback.id = ? AND Run.missionId = ?`).get<{ readonly comment: string | null }>(feedbackId, missionId)
        if (row === undefined) throw new Error(`icarus: no Feedback ${JSON.stringify(feedbackId)} in Mission ${JSON.stringify(missionId)}`)
        comments.set(feedbackId, row.comment)
      }
      const effectiveAtBase = effective(missionId, input.baseRevision)
      const validEntries = new Set(effectiveAtBase.map(candidate => candidate.id))
      const adds: PendingEntry[] = []
      const retired = new Set<string>()
      for (const change of input.changes) {
        if (change.kind === 'add-explicit') {
          const quote = nonEmptyString(change.quote, 'quote')
          if (!change.feedbackIds.some(feedbackId => comments.get(feedbackId)?.includes(quote) === true)) {
            throw new TypeError('icarus: explicit preference quote must appear in the comment of a referenced feedback')
          }
          adds.push({ origin: 'explicit', statement: nonEmptyString(change.statement, 'statement'), scope: scopeOf(change.scope), quote,
            explanation: null, feedbackIds: [...new Set(change.feedbackIds)], expiresAt: null })
        } else if (change.kind === 'add-inferred') {
          const days = change.expiresInDays ?? 30
          if (!Number.isSafeInteger(days) || days < 1 || days > 365) throw new TypeError('icarus: expiresInDays must be an integer between 1 and 365')
          adds.push({ origin: 'inferred', statement: nonEmptyString(change.statement, 'statement'), scope: scopeOf(change.scope), quote: null,
            explanation: nonEmptyString(change.explanation, 'explanation'), feedbackIds: [...new Set(change.feedbackIds)],
            expiresAt: at + days * 86_400_000 })
        } else {
          const entryId = nonEmptyString(change.entryId, 'entryId')
          if (!validEntries.has(entryId)) {
            throw new Error(`icarus: preference entry ${JSON.stringify(entryId)} is not effective at revision ${JSON.stringify(input.baseRevision)}`)
          }
          retired.add(entryId)
        }
      }
      for (const candidate of effectiveAtBase) {
        if (candidate.origin === 'inferred' && candidate.expiresAt !== null && candidate.expiresAt <= at) retired.add(candidate.id)
      }
      const nextRevision = (input.baseRevision ?? 0) + 1
      if (adds.length === 0 && retired.size === 0) {
        markApplied(referenced, input.baseRevision)
        return null
      }
      const explicit = adds.filter(candidate => candidate.origin === 'explicit').map(candidate => candidate.statement)
      const inferred = adds.filter(candidate => candidate.origin === 'inferred').map(candidate => candidate.statement)
      db.prepare(`INSERT INTO PreferenceRevision (missionId, revision, explicitRequirements, inferredPreferences, feedbackRefs, createdAt, basedOn, changeRef, publishedAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(missionId, nextRevision, JSON.stringify(explicit), JSON.stringify(inferred), JSON.stringify(referenced), at, input.baseRevision, changeRef, at)
      for (const add of adds) {
        db.prepare(`INSERT INTO PreferenceEntry (id, missionId, introducedIn, retiredIn, origin, statement, scope, quote, feedbackIds, explanation, expiresAt, createdAt)
          VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(newId('pref_entry'), missionId, nextRevision, add.origin, add.statement, JSON.stringify(add.scope), add.quote,
            JSON.stringify(add.feedbackIds), add.explanation, add.expiresAt, at)
      }
      for (const entryId of retired) db.prepare('UPDATE PreferenceEntry SET retiredIn = ? WHERE id = ? AND retiredIn IS NULL').run(nextRevision, entryId)
      markApplied(referenced, nextRevision)
      return {
        missionId,
        revision: nextRevision,
        explicitRequirements: explicit,
        inferredPreferences: inferred,
        feedbackRefs: referenced,
        basedOn: input.baseRevision,
        changeRef,
        publishedAt: at,
        createdAt: at,
        entries: effective(missionId, nextRevision),
      }
    })
  }

  return {
    record, withdraw, readEvent, get, list, current, effective, history, revision, latestPublished, entry, adoption, pending,
    needsConsolidation, consolidationInput, publish,
  }
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`icarus: ${field} must be a non-empty string`)
  return value.trim()
}

function timeOf(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`icarus: ${field} must be a non-negative integer`)
  return value
}

function sourceOf(value: string): FeedbackSource {
  if (!(FEEDBACK_SOURCES as readonly string[]).includes(value)) throw new TypeError(`icarus: unknown Feedback source ${JSON.stringify(value)}`)
  return value as FeedbackSource
}

function statusOf(value: string): FeedbackStatus {
  if (!(FEEDBACK_STATUSES as readonly string[]).includes(value)) throw new TypeError(`icarus: unknown Feedback status ${JSON.stringify(value)}`)
  return value as FeedbackStatus
}

function originOf(value: string): PreferenceOrigin {
  if (value !== 'explicit' && value !== 'inferred') throw new TypeError(`icarus: unknown preference origin ${JSON.stringify(value)}`)
  return value
}

function stringsOf(value: string): string[] {
  const parsed = JSON.parse(value) as unknown
  if (!Array.isArray(parsed) || parsed.some(item => typeof item !== 'string')) throw new TypeError('icarus: stored JSON must be a string array')
  return parsed as string[]
}

function objectOf(value: string): Record<string, unknown> {
  const parsed = JSON.parse(value) as unknown
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new TypeError('icarus: stored JSON must be an object')
  return parsed as Record<string, unknown>
}

function stringIds(values: readonly string[], field: string): string[] {
  return [...new Set(values.map(value => nonEmptyString(value, field)))]
}

function scopeOf(value: Record<string, unknown>): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('icarus: preference scope must be an object')
  const dimensions: unknown = value.dimensions
  if (dimensions !== undefined && (!Array.isArray(dimensions) || dimensions.length === 0 || dimensions.some(item => typeof item !== 'string' || item.trim() === ''))) {
    throw new TypeError('icarus: preference scope dimensions must be a non-empty string array')
  }
  return value
}

function templateOf(bindings: string): string | null {
  const parsed = JSON.parse(bindings) as { readonly template?: { readonly id?: unknown } }
  const id = parsed.template?.id
  return typeof id === 'string' && id !== '' ? id : null
}
