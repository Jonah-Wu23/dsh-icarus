// Five-field cron (minute hour day-of-month month day-of-week), interpreted in a Mission's
// time zone. No dependency: the fields are parsed into value sets and the next occurrence
// is found by walking local dates and testing the wall times of matching days.
//
// Supported syntax: `*`, `a`, `a-b`, `*/n`, `a-b/n`, `a,b,c`, and lists of those.
// Day-of-week accepts 0-7 with both 0 and 7 meaning Sunday. Names (MON, JAN) are not
// supported. Day-of-month and day-of-week follow Vixie cron: when both are restricted the
// day matches if either does.
import { InvalidScheduleError } from './errors.js'
import { instantOf, wallClockOf } from './timezone.js'

export interface CronExpression {
  readonly source: string
  readonly minutes: readonly number[]
  readonly hours: readonly number[]
  readonly daysOfMonth: readonly number[]
  readonly months: readonly number[]
  readonly daysOfWeek: readonly number[]
  readonly dayOfMonthRestricted: boolean
  readonly dayOfWeekRestricted: boolean
}

interface FieldSpec {
  readonly name: string
  readonly min: number
  readonly max: number
}

const FIELDS: readonly FieldSpec[] = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day of month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'day of week', min: 0, max: 7 },
]

/** Days searched before giving up; an expression such as `0 0 30 2 *` can never match. */
const MAX_SEARCH_DAYS = 366 * 5

export function parseCron(expression: string): CronExpression {
  if (typeof expression !== 'string' || expression.trim() === '') throw new TypeError('icarus: cron expression must be a non-empty string')
  const fields = expression.trim().split(/\s+/)
  if (fields.length !== 5) {
    throw new TypeError(`icarus: cron expression ${JSON.stringify(expression)} needs 5 fields "minute hour day-of-month month day-of-week", got ${fields.length}`)
  }
  const sets = FIELDS.map((spec, index) => parseField(fields[index] ?? '', spec, expression))
  const daysOfWeek = [...new Set(sets[4]?.map(value => (value === 7 ? 0 : value)) ?? [])].sort((left, right) => left - right)
  return {
    source: expression,
    minutes: sets[0] ?? [],
    hours: sets[1] ?? [],
    daysOfMonth: sets[2] ?? [],
    months: sets[3] ?? [],
    daysOfWeek,
    dayOfMonthRestricted: fields[2] !== '*',
    dayOfWeekRestricted: fields[4] !== '*',
  }
}

function parseField(field: string, spec: FieldSpec, expression: string): number[] {
  const values = new Set<number>()
  for (const item of field.split(',')) {
    if (item === '') throw new TypeError(`icarus: cron expression ${JSON.stringify(expression)}: ${spec.name} has an empty item`)
    const [range, stepText, ...extra] = item.split('/')
    if (extra.length > 0) throw new TypeError(`icarus: cron expression ${JSON.stringify(expression)}: ${spec.name} item ${JSON.stringify(item)} has more than one step`)
    const step = stepText === undefined ? 1 : parseStep(stepText, spec, expression)
    const { start, end } = range === '*' ? { start: spec.min, end: spec.max } : parseRange(range ?? '', spec, expression)
    for (let value = start; value <= end; value += step) values.add(value)
  }
  if (values.size === 0) throw new TypeError(`icarus: cron expression ${JSON.stringify(expression)}: ${spec.name} matches no value`)
  return [...values].sort((left, right) => left - right)
}

function parseStep(text: string, spec: FieldSpec, expression: string): number {
  if (!/^\d+$/.test(text)) throw new TypeError(`icarus: cron expression ${JSON.stringify(expression)}: ${spec.name} step ${JSON.stringify(text)} is not a positive integer`)
  const step = Number(text)
  if (step < 1) throw new TypeError(`icarus: cron expression ${JSON.stringify(expression)}: ${spec.name} step must be 1 or more`)
  return step
}

function parseRange(text: string, spec: FieldSpec, expression: string): { start: number; end: number } {
  const bounds = text.split('-')
  if (bounds.length > 2) throw new TypeError(`icarus: cron expression ${JSON.stringify(expression)}: ${spec.name} range ${JSON.stringify(text)} is malformed`)
  const start = parseValue(bounds[0] ?? '', spec, expression)
  const end = bounds.length === 2 ? parseValue(bounds[1] ?? '', spec, expression) : start
  if (start > end) throw new TypeError(`icarus: cron expression ${JSON.stringify(expression)}: ${spec.name} range ${JSON.stringify(text)} starts after it ends`)
  return { start, end }
}

function parseValue(text: string, spec: FieldSpec, expression: string): number {
  if (!/^\d+$/.test(text)) throw new TypeError(`icarus: cron expression ${JSON.stringify(expression)}: ${spec.name} value ${JSON.stringify(text)} is not a number`)
  const value = Number(text)
  if (value < spec.min || value > spec.max) {
    throw new TypeError(`icarus: cron expression ${JSON.stringify(expression)}: ${spec.name} value ${value} is outside ${spec.min}-${spec.max}`)
  }
  return value
}

function dayMatches(cron: CronExpression, dayOfMonth: number, dayOfWeek: number): boolean {
  const byDayOfMonth = cron.daysOfMonth.includes(dayOfMonth)
  const byDayOfWeek = cron.daysOfWeek.includes(dayOfWeek)
  if (cron.dayOfMonthRestricted && cron.dayOfWeekRestricted) return byDayOfMonth || byDayOfWeek
  if (cron.dayOfMonthRestricted) return byDayOfMonth
  if (cron.dayOfWeekRestricted) return byDayOfWeek
  return true
}

/** First occurrence strictly after `afterMs`, in `timeZone`. */
export function nextCronInstant(cron: CronExpression, timeZone: string, afterMs: number): number {
  const start = wallClockOf(afterMs, timeZone)
  const startOfDay = Date.UTC(start.year, start.month - 1, start.day)
  for (let offset = 0; offset < MAX_SEARCH_DAYS; offset += 1) {
    const date = new Date(startOfDay + offset * 86_400_000)
    const year = date.getUTCFullYear()
    const month = date.getUTCMonth() + 1
    const dayOfMonth = date.getUTCDate()
    if (!cron.months.includes(month)) continue
    if (!dayMatches(cron, dayOfMonth, date.getUTCDay())) continue
    let earliest: number | undefined
    for (const hour of cron.hours) {
      for (const minute of cron.minutes) {
        const instant = instantOf({ year, month, day: dayOfMonth, hour, minute, second: 0 }, timeZone)
        if (instant <= afterMs) continue
        if (earliest === undefined || instant < earliest) earliest = instant
      }
    }
    if (earliest !== undefined) return earliest
  }
  throw new InvalidScheduleError(`cron expression ${JSON.stringify(cron.source)} has no occurrence within 5 years`)
}
