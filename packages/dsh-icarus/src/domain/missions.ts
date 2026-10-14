// Mission CRUD over the M2.1 storage layer.
//
// Every write that changes a Mission's definition happens in one transaction and adds one
// `MissionRevision` snapshot: `create` writes revision 1, `modify` moves
// `revision = revision + 1` (the database trigger refuses anything else) and writes the
// matching snapshot. Status changes (pause/resume/cancel/delivered) are runtime state and
// never create a revision. Ids come from the domain layer, timestamps from the caller's
// clock so tests and restarts stay reproducible.
import { MissionNotFoundError, MissionStateError } from './errors.js'
import { newId } from './ids.js'
import { assertKindSchedule, assertTransition, isMissionKind, isMissionStatus, transitionOnDelivered } from './mission.js'
import { assertTimeZone, nextDueAt, parseSchedule } from './schedule.js'
import type { Mission, MissionKind, MissionRevision, MissionStatus } from './mission.js'
import type { Schedule } from './schedule.js'
import type { IcarusDatabase } from '../storage/index.js'

export interface MissionService {
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

export interface CreateMissionInput {
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

export interface MissionPatch {
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

interface MissionRow {
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
  budget, authorizationRef, budgetUsed, nextDueAt, createdAt, updatedAt`

const INSERT_MISSION = `INSERT INTO Mission (${MISSION_COLUMNS})
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`

const INSERT_REVISION = `INSERT INTO MissionRevision (missionId, revision, kind, objective, requirements, schedule, timezone, budget, authorizationRef, createdAt)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`

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
  const now = options.now ?? (() => Date.now())
  const mintId = options.newId ?? newId

  function get(id: string): Mission {
    const row = database.db.prepare(`SELECT ${MISSION_COLUMNS} FROM Mission WHERE id = ?`).get<MissionRow>(id)
    if (row === undefined) throw new MissionNotFoundError(id)
    return toMission(row)
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
    return database.db.prepare(`SELECT ${MISSION_COLUMNS} FROM Mission${where} ORDER BY createdAt, id`).all<MissionRow>(...params).map(toMission)
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
    inTransaction(database, () => {
      database.db.prepare(INSERT_MISSION).run(
        id, ownerBotId, kind, objective, requirementsJson, 1, 'active', scheduleJson, timezone,
        budget, authorizationRef, 0, dueAt, at, at,
      )
      database.db.prepare(INSERT_REVISION).run(id, 1, kind, objective, requirementsJson, scheduleJson, timezone, budget, authorizationRef, at)
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
    const dueAt = patch.schedule === undefined && patch.timezone === undefined
      ? current.nextDueAt
      : nextDueAt(schedule, timezone, at)
    const requirementsJson = JSON.stringify(requirements)
    const scheduleJson = JSON.stringify(schedule)
    inTransaction(database, () => {
      database.db.prepare(`UPDATE Mission SET kind = ?, objective = ?, requirements = ?, schedule = ?, timezone = ?,
        budget = ?, authorizationRef = ?, revision = revision + 1, nextDueAt = ?, updatedAt = ? WHERE id = ?`)
        .run(kind, objective, requirementsJson, scheduleJson, timezone, budget, authorizationRef, dueAt, at, id)
      const revision = database.db.prepare('SELECT revision FROM Mission WHERE id = ?').get<{ revision: number }>(id)
      if (revision === undefined) throw new MissionNotFoundError(id)
      database.db.prepare(INSERT_REVISION).run(id, revision.revision, kind, objective, requirementsJson, scheduleJson, timezone, budget, authorizationRef, at)
    })
    return get(id)
  }

  function transition(id: string, to: MissionStatus): Mission {
    const current = get(id)
    assertTransition(id, current.status, to)
    database.db.prepare('UPDATE Mission SET status = ?, updatedAt = ? WHERE id = ?').run(to, now(), id)
    return get(id)
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
      .prepare(`SELECT missionId, revision, kind, objective, requirements, schedule, timezone, budget, authorizationRef, createdAt
        FROM MissionRevision WHERE missionId = ? ORDER BY revision`)
      .all<RevisionRow>(id)
      .map(row => ({
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
    create,
    get,
    list,
    modify,
    pause: id => transition(id, 'paused'),
    resume: id => transition(id, 'active'),
    cancel: id => transition(id, 'cancelled'),
    recordDelivery,
    history,
  }
}

function toMission(row: MissionRow): Mission {
  if (!isMissionKind(row.kind)) throw new MissionStateError(`Mission ${JSON.stringify(row.id)} has unknown kind ${JSON.stringify(row.kind)}`)
  if (!isMissionStatus(row.status)) throw new MissionStateError(`Mission ${JSON.stringify(row.id)} has unknown status ${JSON.stringify(row.status)}`)
  return {
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
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
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
