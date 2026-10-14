// Mission schedule: the JSON shape stored in `Mission.schedule`, its validation, and the
// due-time computation that fills `nextDueAt`.
//
// Kinds:
//   * `{ kind: 'daily', time: 'HH:mm' }` — every day at that local wall time;
//   * `{ kind: 'cron', expr: 'm h dom mon dow' }` — five-field cron in the local zone;
//   * `{ kind: 'once', at: <epoch ms> }`     — one instant.
// A `once` time already past is refused; the other kinds always resolve forward.
import { InvalidScheduleError } from './errors.js'
import { nextCronInstant, parseCron } from './cron.js'
import { instantOf, isValidTimeZone, wallClockOf } from './timezone.js'

export interface DailySchedule {
  readonly kind: 'daily'
  readonly time: string
}

export interface CronSchedule {
  readonly kind: 'cron'
  readonly expr: string
}

export interface OnceSchedule {
  readonly kind: 'once'
  readonly at: number
}

export type Schedule = DailySchedule | CronSchedule | OnceSchedule

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/

/** IANA zone name, or a TypeError naming the offending value. */
export function assertTimeZone(timeZone: unknown): string {
  if (typeof timeZone !== 'string' || timeZone.trim() === '') throw new TypeError('icarus: timezone must be a non-empty IANA name')
  const value = timeZone.trim()
  if (!isValidTimeZone(value)) throw new TypeError(`icarus: ${JSON.stringify(timeZone)} is not a valid IANA time zone`)
  return value
}

/** Validate an untrusted schedule value (config, DB JSON) into a typed Schedule. */
export function parseSchedule(value: unknown): Schedule {
  if (typeof value !== 'object' || value === null) throw new TypeError('icarus: schedule must be an object')
  const kind = (value as { kind?: unknown }).kind
  if (kind === 'daily') {
    const time = (value as { time?: unknown }).time
    if (typeof time !== 'string' || !TIME_PATTERN.test(time)) {
      throw new TypeError(`icarus: daily schedule needs time "HH:mm" in 24-hour form, got ${JSON.stringify(time)}`)
    }
    return { kind: 'daily', time }
  }
  if (kind === 'cron') {
    const expr = (value as { expr?: unknown }).expr
    if (typeof expr !== 'string') throw new TypeError(`icarus: cron schedule needs expr as a string, got ${JSON.stringify(expr)}`)
    parseCron(expr)
    return { kind: 'cron', expr }
  }
  if (kind === 'once') {
    const at = (value as { at?: unknown }).at
    if (typeof at !== 'number' || !Number.isInteger(at)) throw new TypeError(`icarus: once schedule needs at as epoch milliseconds, got ${JSON.stringify(at)}`)
    return { kind: 'once', at }
  }
  throw new TypeError(`icarus: unknown schedule kind ${JSON.stringify(kind)}; expected daily, cron or once`)
}

/** Next due instant strictly after `after`. */
export function nextDueAt(schedule: Schedule, timeZone: string, after: number): number {
  if (schedule.kind === 'once') {
    if (schedule.at <= after) {
      throw new InvalidScheduleError(`once schedule at ${new Date(schedule.at).toISOString()} is not after ${new Date(after).toISOString()}`)
    }
    return schedule.at
  }
  if (schedule.kind === 'cron') return nextCronInstant(parseCron(schedule.expr), timeZone, after)
  const match = TIME_PATTERN.exec(schedule.time)
  if (match === null) throw new TypeError(`icarus: daily schedule needs time "HH:mm", got ${JSON.stringify(schedule.time)}`)
  const hour = Number(match[1])
  const minute = Number(match[2])
  const start = wallClockOf(after, timeZone)
  // Today or tomorrow: a wall time inside a spring-forward gap can resolve to an instant
  // that has already passed, and then the following day is the answer.
  for (let add = 0; add <= 2; add += 1) {
    const date = new Date(Date.UTC(start.year, start.month - 1, start.day + add))
    const instant = instantOf(
      { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(), hour, minute, second: 0 },
      timeZone,
    )
    if (instant > after) return instant
  }
  throw new InvalidScheduleError(`daily schedule ${schedule.time} has no occurrence within 3 days in ${timeZone}`)
}
