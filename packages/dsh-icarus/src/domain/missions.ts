// Mission CRUD over the M2.1 storage layer.
//
// Every write that changes a Mission's definition happens in one transaction and adds one
// `MissionRevision` snapshot: `create` writes revision 1, `modify` moves
// `revision = revision + 1` (the database trigger refuses anything else) and writes the
// matching snapshot. Status changes (pause/resume/cancel/delivered) are runtime state and
// never create a revision. Ids come from the domain layer, timestamps from the caller's
// clock so tests and restarts stay reproducible.
//
// A `once` Mission has exactly one occurrence: `enqueueDue` consumes its due time and clears it,
// and a delivery completes the Mission. If that one occurrence ends without delivering — the Run
// failed, was superseded, or the gate refused it — nothing else would ever run the Mission, so
// `modify` re-arms it (a new once instant) instead of leaving it `active` and inert. Re-arming
// hangs off the EDIT path, never off the failure path: a retry triggered by failure would turn a
// quota or transport error into a retry loop. `Mission.awaitingReschedule` exposes the state that
// is still waiting for that edit.
import { MissionNotFoundError, MissionStateError } from './errors.js'
import { newId } from './ids.js'
import { assertKindSchedule, assertTransition, isMissionKind, isMissionStatus, transitionOnDelivered } from './mission.js'
import { assertTimeZone, nextDueAt, parseSchedule } from './schedule.js'
import type { Mission, MissionKind, MissionRevision, MissionStatus } from './mission.js'
import type { Schedule } from './schedule.js'
import { parseBindings } from './bindings.js'
import type { MissionBindings } from './bindings.js'
import type { IcarusDatabase } from '../storage/index.js'

export interface MissionService {
  subscribe(listener: (mission: Mission) => void): () => void
  create(input: CreateMissionInput): Mission
  /** The Mission, or `MissionNotFoundError`. */
  get(id: string): Mission
  list(filter?: MissionListFilter): Mission[]
  /** Write a new revision from the patch; refuses terminal Missions. */
  modify(id: string, patch: MissionPatch): Mission
  pause(id: string): Mission
  resume(id: string): Mission
  /** Terminal. A cancelled Mission cannot come back. */
  cancel(id: string): Mission
  /** Record one successful delivery; returns the status the Mission now holds. */
  recordDelivery(id: string): MissionStatus
  history(id: string): MissionRevision[]
}

export interface CreateMissionInput extends MissionBindings {
  readonly ownerBotId: string
  readonly kind: MissionKind
  readonly objective: string
  readonly requirements?: readonly string[] | undefined
  readonly schedule: Schedule
  readonly timezone: string
  /** Token hard cap; null or omitted means no cap. */
  readonly budget?: number | null | undefined
  readonly authorizationRef?: string | null | undefined
  /** Explicit id, for restored or seeded records; defaults to a minted one. */
  readonly id?: string | undefined
}

export interface MissionPatch extends MissionBindings {
  readonly kind?: MissionKind | undefined
  readonly objective?: string | undefined
  readonly requirements?: readonly string[] | undefined
  readonly schedule?: Schedule | undefined
  readonly timezone?: string | undefined
  readonly budget?: number | null | undefined
  readonly authorizationRef?: string | null | undefined
}

export interface MissionListFilter {
  readonly ownerBotId?: string | undefined
  readonly status?: MissionStatus | undefined
  readonly kind?: MissionKind | undefined
}

export interface MissionServiceOptions {
  /** Clock used for `createdAt`, `updatedAt` and due-time anchor; defaults to `Date.now`. */
  readonly now?: (() => number) | undefined
  /** Id factory; defaults to `<prefix>_<uuid>`. */
  readonly newId?: ((prefix: string) => string) | undefined
}

/** How far ahead a re-armed `once` Mission fires: far enough to survive the edit's own pass. */
export const RESCHEDULE_DELAY_MS = 5_000

/** Run statuses that mean "this Mission is being worked on right now". */
const IN_FLIGHT_RUN_STATUSES = ['queued', 'running', 'awaiting_approval'] as const

interface MissionRow {
  readonly bindings: string
  readonly id: string
  readonly ownerBotId: string
  readonly kind: string
  readonly objective: string
  readonly requirements: string
  readonly revision: number
  readonly status: string
  readonly schedule: string
  readonly timezone: string
  readonly budget: number | null
  readonly authorizationRef: string | null
  readonly budgetUsed: number
  readonly nextDueAt: number | null
  readonly createdAt: number
  readonly updatedAt: number
}

interface RevisionRow {
  readonly bindings: string
  readonly missionId: string
  readonly revision: number
  readonly kind: string
  readonly objective: string
  readonly requirements: string
  readonly schedule: string
  readonly timezone: string
  readonly budget: number | null
  readonly authorizationRef: string | null
  readonly createdAt: number
}

const MISSION_COLUMNS = `id, ownerBotId, kind, objective, requirements, revision, status, schedule, timezone,
  budget, authorizationRef, budgetUsed, nextDueAt, createdAt, updatedAt, bindings`

const INSERT_MISSION = `INSERT INTO Mission (${MISSION_COLUMNS})
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`

const INSERT_REVISION = `INSERT INTO MissionRevision (missionId, revision, kind, objective, requirements, schedule, timezone, budget, authorizationRef, createdAt, bindings)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`

export function inTransaction<T>(database: IcarusDatabase, run: () => T): T {
  database.db.exec('BEGIN IMMEDIATE')
  try {
    const value = run()
    database.db.exec('COMMIT')
    return value
  } catch (error) {
    database.db.exec('ROLLBACK')
    throw error
  }
}

export function createMissionService(database: IcarusDatabase, options: MissionServiceOptions = {}): MissionService {
  const listeners = new Set<(mission: Mission) => void>()
  function changed(mission: Mission): Mission {
    for (const listener of listeners) listener(mission)
    return mission
  }
  const now = options.now ?? (() => Date.now())
  const mintId = options.newId ?? newId

  /** Mission ids holding at least one Run in one of `statuses`; one query for a whole batch. */
  function missionIdsWithRun(ids: readonly string[], statuses: readonly string[]): Set<string> {
    if (ids.length === 0) return new Set()
    const missionSlots = ids.map(() => '?').join(', ')
    const statusSlots = statuses.map(() => '?').join(', ')
    const rows = database.db
      .prepare(`SELECT DISTINCT missionId FROM Run WHERE missionId IN (${missionSlots}) AND status IN (${statusSlots})`)
      .all<{ missionId: string }>(...ids, ...statuses)
    return new Set(rows.map(row => row.missionId))
  }

  /** Mission ids that already produced a Deliverable; one query for a whole batch. */
  function missionIdsWithDeliverable(ids: readonly string[]): Set<string> {
    if (ids.length === 0) return new Set()
    const missionSlots = ids.map(() => '?').join(', ')
    const rows = database.db
      .prepare(`SELECT DISTINCT Run.missionId AS missionId FROM Deliverable JOIN Run ON Run.id = Deliverable.runId
        JOIN Mission ON Mission.id = Run.missionId AND Mission.revision = Run.missionRevision
        WHERE Run.missionId IN (${missionSlots}) AND EXISTS(SELECT 1 FROM Outbox WHERE Outbox.deliverableId = Deliverable.id AND Outbox.purpose = 'deliverable')`)
      .all<{ missionId: string }>(...ids)
    return new Set(rows.map(row => row.missionId))
  }

  /** The rows that are `active` with nothing left that could ever run them again. */
  function rescheduleFlags(rows: readonly MissionRow[]): Set<string> {
    const ids = rows.map(row => row.id)
    const inFlight = missionIdsWithRun(ids, IN_FLIGHT_RUN_STATUSES)
    const delivered = missionIdsWithDeliverable(ids)
    return new Set(rows.filter(row => needsReschedule(row, inFlight.has(row.id), delivered.has(row.id))).map(row => row.id))
  }

  function get(id: string): Mission {
    const row = database.db.prepare(`SELECT ${MISSION_COLUMNS} FROM Mission WHERE id = ?`).get<MissionRow>(id)
    if (row === undefined) throw new MissionNotFoundError(id)
    return toMission(row, rescheduleFlags([row]).has(id))
  }

  function list(filter: MissionListFilter = {}): Mission[] {
    const clauses: string[] = []
    const params: unknown[] = []
    if (filter.ownerBotId !== undefined) {
      clauses.push('ownerBotId = ?')
      params.push(nonEmptyString(filter.ownerBotId, 'ownerBotId'))
    }
    if (filter.status !== undefined) {
      if (!isMissionStatus(filter.status)) throw new TypeError(`icarus: unknown Mission status ${JSON.stringify(filter.status)}`)
      clauses.push('status = ?')
      params.push(filter.status)
    }
    if (filter.kind !== undefined) {
      if (!isMissionKind(filter.kind)) throw new TypeError(`icarus: unknown Mission kind ${JSON.stringify(filter.kind)}`)
      clauses.push('kind = ?')
      params.push(filter.kind)
    }
    const where = clauses.length === 0 ? '' : ` WHERE ${clauses.join(' AND ')}`
    const rows = database.db.prepare(`SELECT ${MISSION_COLUMNS} FROM Mission${where} ORDER BY createdAt, id`).all<MissionRow>(...params)
    const waiting = rescheduleFlags(rows)
    return rows.map(row => toMission(row, waiting.has(row.id)))
  }

  function create(input: CreateMissionInput): Mission {
    const id = input.id === undefined ? mintId('mission') : nonEmptyString(input.id, 'id')
    const ownerBotId = nonEmptyString(input.ownerBotId, 'ownerBotId')
    const objective = nonEmptyString(input.objective, 'objective')
    const kind = requireKind(input.kind)
    const requirements = parseRequirements(input.requirements)
    const schedule = parseSchedule(input.schedule)
    const timezone = assertTimeZone(input.timezone)
    const budget = parseBudget(input.budget)
    const authorizationRef = parseAuthorizationRef(input.authorizationRef)
    assertKindSchedule(kind, schedule)
    const at = now()
    const dueAt = nextDueAt(schedule, timezone, at)
    const requirementsJson = JSON.stringify(requirements)
    const scheduleJson = JSON.stringify(schedule)
    const bindings = JSON.stringify(parseBindings({ ...bindingFields(input) }))
    inTransaction(database, () => {
      database.db.prepare(INSERT_MISSION).run(
        id, ownerBotId, kind, objective, requirementsJson, 1, 'active', scheduleJson, timezone,
        budget, authorizationRef, 0, dueAt, at, at, bindings,
      )
      database.db.prepare(INSERT_REVISION).run(id, 1, kind, objective, requirementsJson, scheduleJson, timezone, budget, authorizationRef, at, bindings)
    })
    return get(id)
  }

  function modify(id: string, patch: MissionPatch): Mission {
    const current = get(id)
    if (current.status === 'completed' || current.status === 'cancelled') {
      throw new MissionStateError(`Mission ${JSON.stringify(id)} is ${current.status}; revisions cannot be added`)
    }
    const kind = patch.kind === undefined ? current.kind : requireKind(patch.kind)
    const objective = patch.objective === undefined ? current.objective : nonEmptyString(patch.objective, 'objective')
    const requirements = patch.requirements === undefined ? current.requirements : parseRequirements(patch.requirements)
    const schedule = patch.schedule === undefined ? current.schedule : parseSchedule(patch.schedule)
    const timezone = patch.timezone === undefined ? current.timezone : assertTimeZone(patch.timezone)
    const budget = patch.budget === undefined ? current.budget : parseBudget(patch.budget)
    const authorizationRef = patch.authorizationRef === undefined ? current.authorizationRef : parseAuthorizationRef(patch.authorizationRef)
    assertKindSchedule(kind, schedule)
    const at = now()
    // Only a timing change moves nextDueAt; an overdue `once` Mission keeps its instant so
    // the scheduler still sees it as due.
    const patchedDueAt = patch.schedule === undefined && patch.timezone === undefined
      ? current.nextDueAt
      : nextDueAt(schedule, timezone, at)
    // A `once` Mission whose one occurrence is already consumed and which never delivered has no
    // other way back, so this edit re-arms it. An occurrence in flight is fine: this revision bump
    // supersedes that Run anyway, and the re-armed instant is what runs the new revision.
    const rearm = patchedDueAt === null && kind === 'once' && current.status === 'active'
    const rearmedAt = at + RESCHEDULE_DELAY_MS
    const dueAt = rearm ? rearmedAt : patchedDueAt
    const storedSchedule: Schedule = rearm ? { kind: 'once', at: rearmedAt } : schedule
    const requirementsJson = JSON.stringify(requirements)
    const scheduleJson = JSON.stringify(storedSchedule)
    const bindings = JSON.stringify(parseBindings({ ...bindingFields(current), ...bindingFields(patch) }))
    inTransaction(database, () => {
      database.db.prepare(`UPDATE Mission SET kind = ?, objective = ?, requirements = ?, schedule = ?, timezone = ?,
        budget = ?, authorizationRef = ?, revision = revision + 1, nextDueAt = ?, updatedAt = ?, bindings = ? WHERE id = ?`)
        .run(kind, objective, requirementsJson, scheduleJson, timezone, budget, authorizationRef, dueAt, at, bindings, id)
      const revision = database.db.prepare('SELECT revision FROM Mission WHERE id = ?').get<{ revision: number }>(id)
      if (revision === undefined) throw new MissionNotFoundError(id)
      database.db.prepare(INSERT_REVISION).run(id, revision.revision, kind, objective, requirementsJson, scheduleJson, timezone, budget, authorizationRef, at, bindings)
    })
    return changed(get(id))
  }

  function transition(id: string, to: MissionStatus): Mission {
    const current = get(id)
    assertTransition(id, current.status, to)
    database.db.prepare('UPDATE Mission SET status = ?, updatedAt = ? WHERE id = ?').run(to, now(), id)
    return changed(get(id))
  }

  function recordDelivery(id: string): MissionStatus {
    const current = get(id)
    const next = transitionOnDelivered(current)
    if (next === current.status) return next
    database.db.prepare('UPDATE Mission SET status = ?, updatedAt = ? WHERE id = ?').run(next, now(), id)
    return next
  }

  function history(id: string): MissionRevision[] {
    get(id)
    return database.db
      .prepare(`SELECT missionId, revision, kind, objective, requirements, schedule, timezone, budget, authorizationRef, createdAt, bindings
        FROM MissionRevision WHERE missionId = ? ORDER BY revision`)
      .all<RevisionRow>(id)
      .map(row => ({
        ...parseBindings(JSON.parse(row.bindings) as MissionBindings),
        missionId: row.missionId,
        revision: row.revision,
        kind: requireKind(row.kind),
        objective: row.objective,
        requirements: parseRequirements(JSON.parse(row.requirements) as unknown),
        schedule: parseSchedule(JSON.parse(row.schedule) as unknown),
        timezone: row.timezone,
        budget: row.budget,
        authorizationRef: row.authorizationRef,
        createdAt: row.createdAt,
      }))
  }

  return {
    subscribe: listener => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    create,
    get,
    list,
    modify,
    pause: id => transition(id, 'paused'),
    resume: id => {
      const mission = transition(id, 'active')
      const rearm = mission.kind === 'once' && mission.nextDueAt === null && !missionIdsWithDeliverable([id]).has(id)
      return rearm ? modify(id, {}) : mission
    },
    cancel: id => transition(id, 'cancelled'),
    recordDelivery,
    history,
  }
}

function toMission(row: MissionRow, awaitingReschedule: boolean): Mission {
  if (!isMissionKind(row.kind)) throw new MissionStateError(`Mission ${JSON.stringify(row.id)} has unknown kind ${JSON.stringify(row.kind)}`)
  if (!isMissionStatus(row.status)) throw new MissionStateError(`Mission ${JSON.stringify(row.id)} has unknown status ${JSON.stringify(row.status)}`)
  return {
    ...parseBindings(JSON.parse(row.bindings) as MissionBindings),
    id: row.id,
    ownerBotId: row.ownerBotId,
    kind: row.kind,
    objective: row.objective,
    requirements: parseRequirements(JSON.parse(row.requirements) as unknown),
    revision: row.revision,
    status: row.status,
    schedule: parseSchedule(JSON.parse(row.schedule) as unknown),
    timezone: row.timezone,
    budget: row.budget,
    authorizationRef: row.authorizationRef,
    budgetUsed: row.budgetUsed,
    nextDueAt: row.nextDueAt,
    awaitingReschedule,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

function bindingFields(value: MissionBindings): MissionBindings {
  return {
    ...(value.workspaceRef === undefined ? {} : { workspaceRef: value.workspaceRef }),
    ...(value.contextRefs === undefined ? {} : { contextRefs: value.contextRefs }),
    ...(value.capabilityRequirements === undefined ? {} : { capabilityRequirements: value.capabilityRequirements }),
    ...(value.deliveryPolicy === undefined ? {} : { deliveryPolicy: value.deliveryPolicy }),
  }
}

/** The view invariant: `active`, nothing due, nothing running, nothing delivered — a dead end. */
function needsReschedule(row: MissionRow, inFlight: boolean, delivered: boolean): boolean {
  return row.kind === 'once' && row.status === 'active' && row.nextDueAt === null && !inFlight && !delivered
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`icarus: ${field} must be a non-empty string`)
  return value.trim()
}

function requireKind(value: unknown): MissionKind {
  if (!isMissionKind(value)) throw new TypeError(`icarus: kind must be one of ${JSON.stringify(['once', 'recurring'])}, got ${JSON.stringify(value)}`)
  return value
}

function parseRequirements(value: unknown): readonly string[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new TypeError('icarus: requirements must be an array of strings')
  return value.map(item => nonEmptyString(item, 'requirements item'))
}

function parseBudget(value: unknown): number | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new TypeError(`icarus: budget must be a non-negative integer or null, got ${JSON.stringify(value)}`)
  }
  return value
}

function parseAuthorizationRef(value: unknown): string | null {
  if (value === undefined || value === null) return null
  return nonEmptyString(value, 'authorizationRef')
}
