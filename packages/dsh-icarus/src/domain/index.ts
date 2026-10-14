// Domain layer of the Icarus plugin (M2.2): the Mission state machine, schedule due-time
// computation and the Mission service. M2.3 mounts the executor and scheduler on top.
export { IcarusDomainError, IllegalMissionTransitionError, InvalidScheduleError, MissionNotFoundError, MissionStateError } from './errors.js'
export type { IcarusErrorCode } from './errors.js'
export { newId } from './ids.js'
export { canTransition, isMissionKind, isMissionStatus, transitionOnDelivered, MISSION_KINDS, MISSION_STATUSES } from './mission.js'
export type { Mission, MissionKind, MissionRevision, MissionStatus } from './mission.js'
export { createMissionService, inTransaction } from './missions.js'
export type { CreateMissionInput, MissionListFilter, MissionPatch, MissionService, MissionServiceOptions } from './missions.js'
export { assertTimeZone, nextDueAt, parseSchedule } from './schedule.js'
export type { CronSchedule, DailySchedule, OnceSchedule, Schedule } from './schedule.js'
export { nextCronInstant, parseCron } from './cron.js'
export type { CronExpression } from './cron.js'
export { instantOf, isValidTimeZone, wallClockOf } from './timezone.js'
export type { WallClock } from './timezone.js'

import { createMissionService } from './missions.js'
import type { MissionService, MissionServiceOptions } from './missions.js'
import type { IcarusDatabase } from '../storage/index.js'

/** Everything the plugin exposes to the host under `ctx.icarus`. */
export interface IcarusDomain {
  readonly missions: MissionService
  /** Close the storage connection. The domain owns no other resource. */
  close(): void
}

export function createIcarusDomain(database: IcarusDatabase, options: MissionServiceOptions = {}): IcarusDomain {
  return {
    missions: createMissionService(database, options),
    close: () => database.close(),
  }
}
