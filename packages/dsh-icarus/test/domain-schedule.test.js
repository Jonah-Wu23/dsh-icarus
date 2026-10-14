// Due time: the daily/cron/once behaviour matrix, time-zone boundaries including both DST
// discontinuities, and input validation. Runs against the built plugin.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { InvalidScheduleError, nextCronInstant, nextDueAt, parseCron, parseSchedule, wallClockOf } from '../lib/domain/index.js'

const at = iso => Date.parse(iso)

test('daily fires at the next local wall time, across midnight and across zones', () => {
  // 2026-10-14T15:00Z is 23:00 in Singapore, so 00:30 has already gone by.
  assert.equal(nextDueAt({ kind: 'daily', time: '00:30' }, 'Asia/Singapore', at('2026-10-14T15:00:00Z')), at('2026-10-14T16:30:00Z'))
  // The same wall time means different instants in different zones.
  assert.equal(nextDueAt({ kind: 'daily', time: '21:00' }, 'Asia/Singapore', at('2026-10-14T12:00:00Z')), at('2026-10-14T13:00:00Z'))
  assert.equal(nextDueAt({ kind: 'daily', time: '21:00' }, 'UTC', at('2026-10-14T12:00:00Z')), at('2026-10-14T21:00:00Z'))
  // Today's time already passed, and the boundary itself is not "after".
  assert.equal(nextDueAt({ kind: 'daily', time: '12:00' }, 'UTC', at('2026-10-14T12:00:00Z')), at('2026-10-15T12:00:00Z'))
})

test('a wall time inside a spring-forward gap takes the earlier instant', () => {
  // America/New_York jumps 02:00 -> 03:00 on 2026-03-08 (07:00Z), so 02:30 does not exist.
  assert.equal(nextDueAt({ kind: 'daily', time: '02:30' }, 'America/New_York', at('2026-03-08T00:00:00Z')), at('2026-03-08T06:30:00Z'))
  assert.deepEqual({ ...wallClockOf(at('2026-03-08T06:30:00Z'), 'America/New_York') }, { year: 2026, month: 3, day: 8, hour: 1, minute: 30, second: 0 })
  // That instant has already passed at 06:45Z, so the next occurrence is the following day.
  assert.equal(nextDueAt({ kind: 'daily', time: '02:30' }, 'America/New_York', at('2026-03-08T06:45:00Z')), at('2026-03-09T06:30:00Z'))
})

test('a wall time in a fall-back overlap takes the earlier occurrence', () => {
  // 01:30 happens twice on 2026-11-01: 05:30Z (EDT) and 06:30Z (EST).
  assert.equal(nextDueAt({ kind: 'daily', time: '01:30' }, 'America/New_York', at('2026-11-01T00:00:00Z')), at('2026-11-01T05:30:00Z'))
  assert.deepEqual({ ...wallClockOf(at('2026-11-01T06:30:00Z'), 'America/New_York') }, { year: 2026, month: 11, day: 1, hour: 1, minute: 30, second: 0 })
})

test('once schedules fire exactly once and never in the past', () => {
  const future = at('2026-10-14T13:00:00Z')
  assert.equal(nextDueAt({ kind: 'once', at: future }, 'Asia/Singapore', at('2026-10-14T12:00:00Z')), future)
  assert.throws(() => nextDueAt({ kind: 'once', at: future }, 'UTC', future), InvalidScheduleError)
  assert.throws(() => nextDueAt({ kind: 'once', at: at('2026-10-13T00:00:00Z') }, 'UTC', at('2026-10-14T12:00:00Z')), /not after/)
})

test('malformed schedules fail loudly instead of defaulting', () => {
  assert.throws(() => nextDueAt({ kind: 'daily', time: '25:00' }, 'UTC', 0), TypeError)
  assert.throws(() => nextDueAt({ kind: 'daily', time: '9:00' }, 'UTC', 0), /needs time "HH:mm"/)
  assert.throws(() => nextDueAt({ kind: 'daily', time: '09:00' }, 'Mars/Phobos', 0), /not a valid IANA time zone/)
  assert.throws(() => parseSchedule({ kind: 'weekly' }), /unknown schedule kind/)
  assert.throws(() => nextDueAt({ kind: 'weekly' }, 'UTC', 0), TypeError)
})

test('cron finds the next five-field occurrence', () => {
  const utc = 'UTC'
  assert.equal(nextCronInstant(parseCron('*/15 * * * *'), utc, at('2026-10-14T12:07:30Z')), at('2026-10-14T12:15:00Z'))
  assert.equal(nextCronInstant(parseCron('* * * * *'), utc, at('2026-10-14T12:07:00Z')), at('2026-10-14T12:08:00Z'))
  assert.equal(nextCronInstant(parseCron('30 21 * * *'), 'Asia/Singapore', at('2026-10-14T12:00:00Z')), at('2026-10-14T13:30:00Z'))
  // Day-of-month and day-of-week are both restricted: either one matches (Vixie cron).
  assert.equal(nextCronInstant(parseCron('0 9 1 * 1'), utc, at('2026-10-14T12:00:00Z')), at('2026-10-19T09:00:00Z'))
  assert.equal(nextCronInstant(parseCron('0 0 1 * *'), utc, at('2026-10-14T12:00:00Z')), at('2026-11-01T00:00:00Z'))
  // Sunday is both 0 and 7.
  assert.deepEqual([...parseCron('0 0 * * 7').daysOfWeek], [0])
  assert.deepEqual([...parseCron('0 0 * * 0-7').daysOfWeek], [0, 1, 2, 3, 4, 5, 6])
  assert.deepEqual([...parseCron('*/15 3-4 1,15 1-6 *').minutes], [0, 15, 30, 45])
})

test('cron honours the spring-forward gap in the Mission zone', () => {
  // 2026-03-08 falls on a Sunday; 02:30 does not exist that day.
  assert.equal(nextCronInstant(parseCron('30 2 * * *'), 'America/New_York', at('2026-03-08T00:00:00Z')), at('2026-03-08T06:30:00Z'))
})

test('cron rejects malformed expressions and impossible calendars', () => {
  assert.throws(() => parseCron('0 9 * *'), /needs 5 fields/)
  assert.throws(() => parseCron('60 * * * *'), /outside 0-59/)
  assert.throws(() => parseCron('*/0 * * * *'), /step must be 1 or more/)
  assert.throws(() => parseCron('0 9 5-1 * *'), /starts after it ends/)
  assert.throws(() => nextCronInstant(parseCron('0 0 30 2 *'), 'UTC', at('2026-10-14T12:00:00Z')), InvalidScheduleError)
})
