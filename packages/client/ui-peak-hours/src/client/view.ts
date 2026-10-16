/**
 * What the indicator shows at one instant: a pure function of the accepted
 * settings and the clock, so the timer that drives it owns nothing but time.
 */
import {
  DEFAULT_CALENDAR_UTC_OFFSET_MINUTES, DEFAULT_HOLIDAYS, DEFAULT_WEEKDAYS, DEFAULT_WINDOWS,
  peakState, scheduleProblems, windowMinutes,
  type HolidayRange, type OffPeakReason, type PeakSchedule, type PeakState, type PeakWindow,
} from '../schedule.ts'

/** The accepted `ui-peak-hours` section as the browser reads it. */
export interface PeakHoursSettings {
  enabled: boolean
  showOffPeak: boolean
  warnBeforeMinutes: number
  notify: boolean
  windows: readonly PeakWindow[]
  weekdays: readonly number[]
  holidays: readonly HolidayRange[]
  calendarUtcOffsetMinutes: number
  sendGate: boolean
  gatedRoutes: readonly string[]
}

/** The section the indicator uses until the Host's arrives, matching the Host defaults. */
export const DEFAULT_SETTINGS: PeakHoursSettings = {
  enabled: true,
  showOffPeak: true,
  warnBeforeMinutes: 15,
  notify: true,
  windows: DEFAULT_WINDOWS,
  weekdays: DEFAULT_WEEKDAYS,
  holidays: DEFAULT_HOLIDAYS,
  calendarUtcOffsetMinutes: DEFAULT_CALENDAR_UTC_OFFSET_MINUTES,
  sendGate: true,
  gatedRoutes: ['deepseek-official', 'kiln-deepseek-api'],
}

/** Today's peak windows as epoch ms, for showing them in the reader's own time zone. */
export interface LocalWindow {
  start: number
  end: number
}

/** The indicator's reading. */
export type PeakView =
  | { kind: 'hidden' }
  | { kind: 'invalid'; problems: readonly string[] }
  | { kind: 'peak'; endsAt: number; remainingMs: number; windows: readonly LocalWindow[] }
  | { kind: 'soon'; startsAt: number; remainingMs: number; windows: readonly LocalWindow[] }
  | {
    kind: 'off-peak'
    reason: OffPeakReason
    holiday: string | null
    nextPeakAt: number | null
    remainingMs: number | null
    windows: readonly LocalWindow[]
  }

const MINUTE = 60_000
const DAY = 86_400_000

/**
 * The schedule fields of a settings section.
 * @param settings - accepted settings.
 * @returns the schedule the classification reads.
 */
export function scheduleOf(settings: PeakHoursSettings): PeakSchedule {
  return {
    windows: settings.windows,
    weekdays: settings.weekdays,
    holidays: settings.holidays,
    calendarUtcOffsetMinutes: settings.calendarUtcOffsetMinutes,
  }
}

/**
 * The configured windows placed on the UTC day of `now`.
 * @param windows - valid windows.
 * @param now - epoch ms.
 * @returns the windows as epoch ms intervals.
 */
function windowsOn(windows: readonly PeakWindow[], now: number): LocalWindow[] {
  const day = Math.floor(now / DAY) * DAY
  return windows.map((window) => {
    const minutes = windowMinutes(window)
    return { start: day + minutes.start * MINUTE, end: day + minutes.end * MINUTE }
  })
}

/**
 * Derive the indicator's reading.
 * @param settings - accepted settings.
 * @param now - epoch ms.
 * @returns what to show.
 */
export function peakView(settings: PeakHoursSettings, now: number): PeakView {
  if (!settings.enabled) return { kind: 'hidden' }
  const problems = scheduleProblems(scheduleOf(settings))
  if (problems.length > 0) return { kind: 'invalid', problems }
  const state: PeakState = peakState(scheduleOf(settings), now)
  const windows = windowsOn(settings.windows, now)
  if (state.kind === 'peak') return { kind: 'peak', endsAt: state.endsAt, remainingMs: state.endsAt - now, windows }
  const remainingMs = state.nextPeakAt === null ? null : state.nextPeakAt - now
  if (state.nextPeakAt !== null && remainingMs !== null && remainingMs <= settings.warnBeforeMinutes * MINUTE) {
    return { kind: 'soon', startsAt: state.nextPeakAt, remainingMs, windows }
  }
  if (!settings.showOffPeak) return { kind: 'hidden' }
  return {
    kind: 'off-peak',
    reason: state.reason,
    holiday: state.holiday ?? null,
    nextPeakAt: state.nextPeakAt,
    remainingMs,
    windows,
  }
}

/**
 * Whether two readings render the same, so the store keeps one snapshot
 * reference until something visible moves. The countdown is shown in whole
 * minutes, so a tick inside the same minute is no change.
 * @param a - previous reading.
 * @param b - next reading.
 * @returns true when nothing visible differs.
 */
export function sameView(a: PeakView, b: PeakView): boolean {
  if (a.kind !== b.kind) return false
  return JSON.stringify(rounded(a)) === JSON.stringify(rounded(b))
}

/**
 * A reading with its countdown at minute resolution.
 * @param view - a reading.
 * @returns the reading as compared by {@link sameView}.
 */
function rounded(view: PeakView): PeakView {
  if (!('remainingMs' in view) || view.remainingMs === null) return view
  return { ...view, remainingMs: Math.ceil(view.remainingMs / MINUTE) }
}

/**
 * Split a positive duration into whole hours and minutes, rounding up so a
 * countdown never reads zero while time remains.
 * @param ms - duration.
 * @returns days, hours, and minutes.
 */
export function splitDuration(ms: number): { days: number; hours: number; minutes: number } {
  const total = Math.max(1, Math.ceil(ms / MINUTE))
  return { days: Math.floor(total / 1440), hours: Math.floor((total % 1440) / 60), minutes: total % 60 }
}

/**
 * Read an accepted Host section, keeping the defaults for any field it lacks.
 * @param value - the section the Host accepted, or undefined before one arrives.
 * @returns complete settings.
 */
export function settingsFrom(value: Partial<PeakHoursSettings> | undefined): PeakHoursSettings {
  return { ...DEFAULT_SETTINGS, ...value }
}
