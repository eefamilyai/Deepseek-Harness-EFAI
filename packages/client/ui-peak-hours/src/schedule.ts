/**
 * DeepSeek API peak-hour schedule: the published rule as data, and the pure
 * classification of one instant against it.
 *
 * DeepSeek bills peak hours at twice the off-peak rate. Peak hours are fixed
 * UTC windows on working days; weekends and Chinese public holidays are
 * off-peak in full. Working days and holidays are calendar dates in China
 * Standard Time, the calendar the holiday notices are written in.
 *
 * This file is shared by the Host Config schema and the browser half, so it
 * imports nothing.
 */

/** One peak window as `HH:MM` UTC wall-clock times; `end` is exclusive and later than `start`. */
export interface PeakWindow {
  /** Window start, `HH:MM` UTC. */
  start: string
  /** Window end, `HH:MM` UTC, exclusive and later than `start`. */
  end: string
}

/** One public-holiday break as inclusive `YYYY-MM-DD` dates in the schedule's calendar. */
export interface HolidayRange {
  /** Holiday name the pill's tooltip shows. */
  name: string
  /** First day off, `YYYY-MM-DD`. */
  from: string
  /** Last day off, `YYYY-MM-DD`, inclusive. */
  to: string
}

/** The whole schedule a classification reads. */
export interface PeakSchedule {
  /** Peak windows on a working day, in UTC. */
  windows: readonly PeakWindow[]
  /** Working weekdays in the schedule's calendar, 0 = Sunday … 6 = Saturday. */
  weekdays: readonly number[]
  /** Holiday breaks, off-peak in full even on a working weekday. */
  holidays: readonly HolidayRange[]
  /** UTC offset of the calendar that dates weekdays and holidays, in minutes. */
  calendarUtcOffsetMinutes: number
}

/** Peak windows DeepSeek publishes: 01:00–04:00 and 06:00–10:00 UTC. */
export const DEFAULT_WINDOWS: readonly PeakWindow[] = [
  { start: '01:00', end: '04:00' },
  { start: '06:00', end: '10:00' },
]

/** Monday through Friday. */
export const DEFAULT_WEEKDAYS: readonly number[] = [1, 2, 3, 4, 5]

/** China Standard Time, UTC+8, which has no daylight saving. */
export const DEFAULT_CALENDAR_UTC_OFFSET_MINUTES = 480

/**
 * The 2026 public-holiday breaks from the State Council notice 国办发明电〔2025〕7号.
 * Make-up working days on weekends are not listed: DeepSeek prices every weekend
 * as off-peak.
 */
export const DEFAULT_HOLIDAYS: readonly HolidayRange[] = [
  { name: "New Year's Day", from: '2026-01-01', to: '2026-01-03' },
  { name: 'Spring Festival', from: '2026-02-15', to: '2026-02-23' },
  { name: 'Qingming Festival', from: '2026-04-04', to: '2026-04-06' },
  { name: 'Labour Day', from: '2026-05-01', to: '2026-05-05' },
  { name: 'Dragon Boat Festival', from: '2026-06-19', to: '2026-06-21' },
  { name: 'Mid-Autumn Festival', from: '2026-09-25', to: '2026-09-27' },
  { name: 'National Day', from: '2026-10-01', to: '2026-10-07' },
]

/** Price multiplier DeepSeek applies during peak hours, relative to off-peak. */
export const PEAK_PRICE_MULTIPLIER = 2

/** Matches a `HH:MM` time from 00:00 to 24:00. */
const TIME = /^(?:([01]\d|2[0-3]):([0-5]\d)|24:00)$/

/** Matches a `YYYY-MM-DD` date. */
const DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/

/** Days searched ahead for the next peak window; covers the longest holiday break plus its weekends. */
const LOOKAHEAD_DAYS = 31

const MINUTE = 60_000
const DAY = 86_400_000

/**
 * Parse a `HH:MM` time into minutes after midnight.
 * @param value - the time text.
 * @returns minutes, or undefined when the text is not a valid time.
 */
export function parseTime(value: string): number | undefined {
  const match = TIME.exec(value)
  if (match === null) return undefined
  if (match[1] === undefined) return 24 * 60
  return Number(match[1]) * 60 + Number(match[2])
}

/**
 * A valid window as minutes after midnight.
 * @param window - a window with no {@link scheduleProblems}.
 * @returns start and end minutes.
 * @throws Error when either time is malformed, which a validated schedule excludes.
 */
export function windowMinutes(window: PeakWindow): { start: number; end: number } {
  const start = parseTime(window.start)
  const end = parseTime(window.end)
  if (start === undefined || end === undefined) throw new Error(`invalid peak window ${window.start}-${window.end}`)
  return { start, end }
}

/**
 * Whether a text is a `YYYY-MM-DD` date.
 * @param value - the date text.
 * @returns true for a well-formed date.
 */
export function isDate(value: string): boolean {
  return DATE.test(value)
}

/**
 * List every problem in a schedule, so a misconfiguration fails at load
 * instead of silently classifying every hour as off-peak.
 * @param schedule - the configured schedule.
 * @returns one message per problem; empty when the schedule is usable.
 */
export function scheduleProblems(schedule: PeakSchedule): string[] {
  const problems: string[] = []
  schedule.windows.forEach((window, index) => {
    const start = parseTime(window.start)
    const end = parseTime(window.end)
    if (start === undefined) problems.push(`windows[${index}].start "${window.start}" is not HH:MM`)
    if (end === undefined) problems.push(`windows[${index}].end "${window.end}" is not HH:MM`)
    if (start !== undefined && end !== undefined && end <= start) {
      problems.push(`windows[${index}] ends at or before it starts; split a window that crosses midnight in two`)
    }
  })
  for (const day of schedule.weekdays) {
    if (!Number.isInteger(day) || day < 0 || day > 6) problems.push(`weekday ${day} is not 0-6`)
  }
  schedule.holidays.forEach((holiday, index) => {
    if (!isDate(holiday.from)) problems.push(`holidays[${index}].from "${holiday.from}" is not YYYY-MM-DD`)
    if (!isDate(holiday.to)) problems.push(`holidays[${index}].to "${holiday.to}" is not YYYY-MM-DD`)
    if (isDate(holiday.from) && isDate(holiday.to) && holiday.to < holiday.from) {
      problems.push(`holidays[${index}] ends before it starts`)
    }
  })
  return problems
}

/** Why an off-peak instant is off-peak. */
export type OffPeakReason = 'hours' | 'weekend' | 'holiday'

/** The pricing period one instant falls in. */
export type PeakState =
  | {
    kind: 'peak'
    /** Start of the peak period, merged across adjacent windows, in epoch ms. */
    startedAt: number
    /** End of the peak period, merged across adjacent windows, in epoch ms. */
    endsAt: number
  }
  | {
    kind: 'off-peak'
    reason: OffPeakReason
    /** The holiday's name when `reason` is `holiday`. */
    holiday?: string
    /** Start of the next peak period, or null when none falls within the lookahead. */
    nextPeakAt: number | null
  }

/** One UTC interval in epoch ms, end exclusive. */
interface Interval {
  start: number
  end: number
}

/**
 * The calendar date and weekday of an instant in the schedule's calendar.
 * @param instant - epoch ms.
 * @param offsetMinutes - the calendar's UTC offset.
 * @returns `YYYY-MM-DD` and 0-6 weekday.
 */
function calendarDay(instant: number, offsetMinutes: number): { date: string; weekday: number } {
  const local = new Date(instant + offsetMinutes * MINUTE)
  return { date: local.toISOString().slice(0, 10), weekday: local.getUTCDay() }
}

/**
 * The holiday covering a calendar date.
 * @param holidays - configured breaks.
 * @param date - `YYYY-MM-DD`.
 * @returns the covering break, or undefined.
 */
function holidayOn(holidays: readonly HolidayRange[], date: string): HolidayRange | undefined {
  return holidays.find(holiday => holiday.from <= date && date <= holiday.to)
}

/**
 * Peak intervals from the UTC day before `from` through the lookahead, merged
 * where one window ends exactly where the next starts. A window belongs to the
 * calendar day its start falls on.
 * @param schedule - a schedule with no {@link scheduleProblems}.
 * @param from - epoch ms the search is anchored at.
 * @returns ordered, non-overlapping intervals.
 */
function peakIntervals(schedule: PeakSchedule, from: number): Interval[] {
  const firstDay = Math.floor(from / DAY) * DAY - DAY
  const raw: Interval[] = []
  for (let day = firstDay; day <= firstDay + (LOOKAHEAD_DAYS + 1) * DAY; day += DAY) {
    for (const window of schedule.windows) {
      const minutes = windowMinutes(window)
      const start = day + minutes.start * MINUTE
      const end = day + minutes.end * MINUTE
      const { date, weekday } = calendarDay(start, schedule.calendarUtcOffsetMinutes)
      if (!schedule.weekdays.includes(weekday)) continue
      if (holidayOn(schedule.holidays, date) !== undefined) continue
      raw.push({ start, end })
    }
  }
  raw.sort((a, b) => a.start - b.start)
  const merged: Interval[] = []
  for (const interval of raw) {
    const last = merged.at(-1)
    if (last !== undefined && interval.start <= last.end) last.end = Math.max(last.end, interval.end)
    else merged.push({ ...interval })
  }
  return merged
}

/**
 * Classify one instant against the schedule.
 * @param schedule - a schedule with no {@link scheduleProblems}.
 * @param now - epoch ms.
 * @returns the peak period containing `now`, or why it is off-peak and when peak resumes.
 */
export function peakState(schedule: PeakSchedule, now: number): PeakState {
  const intervals = peakIntervals(schedule, now)
  const current = intervals.find(interval => interval.start <= now && now < interval.end)
  if (current !== undefined) return { kind: 'peak', startedAt: current.start, endsAt: current.end }
  const next = intervals.find(interval => interval.start > now)
  const { date, weekday } = calendarDay(now, schedule.calendarUtcOffsetMinutes)
  const holiday = holidayOn(schedule.holidays, date)
  const nextPeakAt = next?.start ?? null
  if (holiday !== undefined) return { kind: 'off-peak', reason: 'holiday', holiday: holiday.name, nextPeakAt }
  if (!schedule.weekdays.includes(weekday)) return { kind: 'off-peak', reason: 'weekend', nextPeakAt }
  return { kind: 'off-peak', reason: 'hours', nextPeakAt }
}

/**
 * Milliseconds until the classification of `now` can next change: the end of
 * the current peak, the start of the next one, or the lookahead horizon.
 * @param state - the classification of `now`.
 * @param now - epoch ms.
 * @returns a positive delay.
 */
export function msUntilChange(state: PeakState, now: number): number {
  const at = state.kind === 'peak' ? state.endsAt : state.nextPeakAt ?? now + DAY
  return Math.max(1_000, at - now)
}
