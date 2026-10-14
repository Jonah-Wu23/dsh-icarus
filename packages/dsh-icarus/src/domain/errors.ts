// Domain errors carry a stable code, so callers branch on the kind of refusal instead of
// matching message text. Type errors stay `TypeError`: a malformed time zone, time, cron
// expression or budget is a value-shape problem, not a Mission-state one.
export type IcarusErrorCode = 'invalid-input' | 'invalid-schedule' | 'not-found' | 'illegal-transition' | 'mission-state'

export class IcarusDomainError extends Error {
  readonly code: IcarusErrorCode

  constructor(code: IcarusErrorCode, message: string) {
    super(message)
    this.name = new.target.name
    this.code = code
  }
}

export class MissionNotFoundError extends IcarusDomainError {
  constructor(missionId: string) {
    super('not-found', `icarus: no Mission ${JSON.stringify(missionId)}`)
  }
}

/** A well-formed schedule that cannot be used at the given instant (a `once` time already past). */
export class InvalidScheduleError extends IcarusDomainError {
  constructor(message: string) {
    super('invalid-schedule', `icarus: ${message}`)
  }
}

export class IllegalMissionTransitionError extends IcarusDomainError {
  constructor(readonly missionId: string, readonly from: string, readonly to: string) {
    super('illegal-transition', `icarus: Mission ${JSON.stringify(missionId)} cannot move from ${from} to ${to}`)
  }
}

/** The Mission's status refuses the operation without it being a status transition. */
export class MissionStateError extends IcarusDomainError {
  constructor(message: string) {
    super('mission-state', `icarus: ${message}`)
  }
}
