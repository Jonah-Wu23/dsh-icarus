// Mission record and its state machine.
//
// Statuses: active / paused / completed / cancelled. The transition table is the whole
// authority; anything not listed (a cancelled Mission coming back, a completed one being
// re-opened, a no-op pause of a paused Mission) is refused with a named error. Status is
// runtime state and never part of a revision snapshot.
import { IllegalMissionTransitionError } from './errors.js'
import type { Schedule } from './schedule.js'
import type { MissionBindings } from './bindings.js'

/** once and investigate are one-occurrence kinds; investigate is the bounded inquiry Mission. */
export const MISSION_KINDS = ['once', 'recurring', 'investigate'] as const
export type MissionKind = (typeof MISSION_KINDS)[number]

export const MISSION_STATUSES = ['active', 'paused', 'completed', 'cancelled'] as const
export type MissionStatus = (typeof MISSION_STATUSES)[number]

export interface Mission extends MissionBindings {
  readonly id: string
  readonly ownerBotId: string
  readonly kind: MissionKind
  readonly objective: string
  readonly requirements: readonly string[]
  readonly revision: number
  readonly status: MissionStatus
  readonly schedule: Schedule
  readonly timezone: string
  /** Token hard cap; null means no cap (the gate itself is M2.4). */
  readonly budget: number | null
  readonly authorizationRef: string | null
  readonly budgetUsed: number
  readonly nextDueAt: number | null
  /**
   * True when nothing will ever run this Mission again: a `once` Mission that is still `active`
   * with no due time, no Run in flight and no delivered result. `modify` re-arms exactly this
   * state; the flag exists so the state is never silent in between. A Mission whose occurrence is
   * simply running right now is not flagged.
   */
  readonly awaitingReschedule: boolean
  readonly createdAt: number
  readonly updatedAt: number
}

/** One revision of a Mission's definition, as written to `MissionRevision`. */
export interface MissionRevision extends MissionBindings {
  readonly missionId: string
  readonly revision: number
  readonly kind: MissionKind
  readonly objective: string
  readonly requirements: readonly string[]
  readonly schedule: Schedule
  readonly timezone: string
  readonly budget: number | null
  readonly authorizationRef: string | null
  readonly createdAt: number
}

const TRANSITIONS: Readonly<Record<MissionStatus, readonly MissionStatus[]>> = {
  active: ['paused', 'completed', 'cancelled'],
  paused: ['active', 'completed', 'cancelled'],
  completed: [],
  cancelled: [],
}

export function isMissionKind(value: unknown): value is MissionKind {
  return typeof value === 'string' && (MISSION_KINDS as readonly string[]).includes(value)
}

export function isMissionStatus(value: unknown): value is MissionStatus {
  return typeof value === 'string' && (MISSION_STATUSES as readonly string[]).includes(value)
}

export function canTransition(from: MissionStatus, to: MissionStatus): boolean {
  return TRANSITIONS[from].includes(to)
}

export function assertTransition(missionId: string, from: MissionStatus, to: MissionStatus): void {
  if (!canTransition(from, to)) throw new IllegalMissionTransitionError(missionId, from, to)
}

/**
 * Status a Mission holds after a successful delivery. A recurring Mission keeps the status
 * it had — a single delivery never completes it; a `once` Mission is completed.
 */
export function transitionOnDelivered(mission: Pick<Mission, 'id' | 'kind' | 'status'>): MissionStatus {
  if (mission.kind === 'recurring') return mission.status
  assertTransition(mission.id, mission.status, 'completed')
  return 'completed'
}

/** One-occurrence kinds fire a fixed instant; `recurring` uses daily or cron timing. */
export function isOneShotKind(kind: MissionKind): boolean {
  return kind === 'once' || kind === 'investigate'
}

export function assertKindSchedule(kind: MissionKind, schedule: Schedule): void {
  if (kind === 'once' && schedule.kind !== 'once') {
    throw new TypeError(`icarus: kind "once" needs a once schedule, got ${schedule.kind}`)
  }
  if (kind === 'investigate' && schedule.kind !== 'once') {
    throw new TypeError('icarus: kind "investigate" needs a once schedule')
  }
  if (kind === 'recurring' && schedule.kind === 'once') {
    throw new TypeError('icarus: kind "recurring" needs a daily or cron schedule, not once')
  }
}
