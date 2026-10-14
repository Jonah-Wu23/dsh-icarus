// Wall-clock arithmetic over IANA time zones, built on Intl (no dependency).
//
// `instantOf` turns a local wall clock into a UTC instant and resolves the two cases a
// zone transition creates, both by taking the earlier instant:
//   * the wall time does not exist (spring-forward gap) → the instant before the gap is
//     returned, which is what an earlier-instant reading of that local time means;
//   * the wall time exists twice (fall-back overlap) → the first occurrence is returned.
// `wallClockOf` reads the local clock of an instant, used to verify candidates and to find
// the local date a search starts from.
const formatters = new Map<string, Intl.DateTimeFormat>()

export interface WallClock {
  readonly year: number
  readonly month: number
  readonly day: number
  readonly hour: number
  readonly minute: number
  readonly second: number
}

function formatterOf(timeZone: string): Intl.DateTimeFormat {
  const cached = formatters.get(timeZone)
  if (cached !== undefined) return cached
  let formatter: Intl.DateTimeFormat
  try {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
  } catch (error) {
    throw new TypeError(`icarus: ${JSON.stringify(timeZone)} is not a valid IANA time zone`, { cause: error })
  }
  formatters.set(timeZone, formatter)
  return formatter
}

/** Whether Intl accepts the name as an IANA time zone. */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    formatterOf(timeZone)
    return true
  } catch {
    return false
  }
}

/** Local clock of a UTC instant, in `timeZone`. */
export function wallClockOf(instantMs: number, timeZone: string): WallClock {
  const parts = formatterOf(timeZone).formatToParts(new Date(instantMs))
  const read = (type: string): number => {
    const part = parts.find(candidate => candidate.type === type)
    return part === undefined ? 0 : Number(part.value)
  }
  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    hour: read('hour'),
    minute: read('minute'),
    second: read('second'),
  }
}

/** Zone offset in milliseconds at an instant: local clock minus UTC, to the second. */
function offsetOf(instantMs: number, timeZone: string): number {
  const wall = wallClockOf(instantMs, timeZone)
  return Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second) - Math.floor(instantMs / 1000) * 1000
}

/** UTC instant of a local wall clock in `timeZone`. */
export function instantOf(wall: WallClock, timeZone: string): number {
  const guess = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second)
  const first = guess - offsetOf(guess, timeZone)
  const second = guess - offsetOf(first, timeZone)
  const candidates = first === second ? [first] : [Math.min(first, second), Math.max(first, second)]
  const exact = candidates.filter(candidate => sameWallClock(wallClockOf(candidate, timeZone), wall))
  const chosen = (exact.length > 0 ? exact : candidates)[0]
  if (chosen === undefined) throw new Error('icarus: no UTC instant for the requested wall clock')
  return chosen
}

function sameWallClock(left: WallClock, right: WallClock): boolean {
  return left.year === right.year
    && left.month === right.month
    && left.day === right.day
    && left.hour === right.hour
    && left.minute === right.minute
    && left.second === right.second
}
