/**
 * Host half of the DeepSeek peak-hour indicator: owns the schedule and display
 * fields the browser half reads by this row's id. Every field is volatile, so
 * an edit reaches the open window without a restart.
 *
 * @module @deepseek-ai/dsh-client-ui-peak-hours
 */
import type { Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  DEFAULT_CALENDAR_UTC_OFFSET_MINUTES, DEFAULT_HOLIDAYS, DEFAULT_WEEKDAYS, DEFAULT_WINDOWS,
  scheduleProblems, type HolidayRange, type PeakWindow,
} from './schedule.ts'

export type { HolidayRange, PeakSchedule, PeakState, PeakWindow } from './schedule.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'ui-peak-hours'

/** The indicator's display switches and the pricing schedule it classifies time against. */
export interface Config {
  /** Show the pricing pill under the composer. */
  enabled: Volatile<boolean>
  /** Also show the off-peak reading; off leaves only peak and the lead warning visible. */
  showOffPeak: Volatile<boolean>
  /** Minutes before a peak period when the pill turns to the lead warning; 0 disables it. */
  warnBeforeMinutes: Volatile<number>
  /** Send a desktop notification when the lead warning begins and when peak pricing starts. */
  notify: Volatile<boolean>
  /** Peak windows on a working day, `HH:MM` UTC with an exclusive end. */
  windows: Volatile<PeakWindow[]>
  /** Working weekdays in the holiday calendar, 0 = Sunday to 6 = Saturday. */
  weekdays: Volatile<number[]>
  /** Public-holiday breaks, off-peak in full. */
  holidays: Volatile<HolidayRange[]>
  /** UTC offset in minutes of the calendar that dates weekdays and holidays. */
  calendarUtcOffsetMinutes: Volatile<number>
  /** Ask before sending a message on a DeepSeek API route during peak hours. */
  sendGate: Volatile<boolean>
  /** Provider routes billed at DeepSeek API rates, which the send dialog guards. */
  gatedRoutes: Volatile<string[]>
}

/** DeepSeek API routes: the official API and the Kiln bridge to it. Web-login routes are not API-priced. */
export const DEFAULT_GATED_ROUTES: readonly string[] = ['deepseek-official', 'kiln-deepseek-api']

const Window = z.object({
  start: z.string().required().description('Window start, HH:MM in UTC.'),
  end: z.string().required().description('Window end (exclusive), HH:MM in UTC, later than the start.'),
})

const Holiday = z.object({
  name: z.string().required().description('Holiday name shown in the tooltip.'),
  from: z.string().required().description('First day off, YYYY-MM-DD.'),
  to: z.string().required().description('Last day off (inclusive), YYYY-MM-DD.'),
})

export const Config = z.object({
  enabled: z.boolean().default(true)
    .description('Show the DeepSeek pricing indicator under the composer.')
    .volatile(),
  showOffPeak: z.boolean().default(true)
    .description('Also show a quiet off-peak reading with the time until peak starts. Off hides the indicator outside peak and the warning lead.')
    .volatile(),
  warnBeforeMinutes: z.number().min(0).max(240).default(15)
    .description('Minutes before a peak period starts when the indicator turns to a warning. 0 disables the lead warning.')
    .volatile(),
  notify: z.boolean().default(true)
    .description('Send a desktop notification when the lead warning begins and when peak pricing starts.')
    .volatile(),
  windows: z.array(Window).default(DEFAULT_WINDOWS.map(window => ({ ...window })))
    .description('Peak windows on a working day, in UTC. DeepSeek publishes 01:00-04:00 and 06:00-10:00.')
    .volatile(),
  weekdays: z.array(z.number()).default([...DEFAULT_WEEKDAYS])
    .description('Working weekdays in the holiday calendar, 0 = Sunday to 6 = Saturday. Every other day is off-peak in full.')
    .volatile(),
  holidays: z.array(Holiday).default(DEFAULT_HOLIDAYS.map(holiday => ({ ...holiday })))
    .description('Chinese public-holiday breaks, off-peak in full. Add each year\'s breaks once the State Council publishes them.')
    .volatile(),
  calendarUtcOffsetMinutes: z.number().min(-720).max(840).default(DEFAULT_CALENDAR_UTC_OFFSET_MINUTES)
    .description('UTC offset of the calendar that dates weekdays and holidays, in minutes. 480 is China Standard Time.')
    .volatile(),
  sendGate: z.boolean().default(true)
    .description('During peak hours, ask before sending a message on a DeepSeek API route: send anyway, schedule it for when peak ends, or keep editing.')
    .volatile(),
  gatedRoutes: z.array(z.string()).default([...DEFAULT_GATED_ROUTES])
    .description('Provider routes billed at DeepSeek API rates. DeepSeek web-login routes and other providers are never asked about.')
    .volatile(),
})

/**
 * Reject an unusable schedule at load; the browser half reports a later
 * volatile edit that breaks it on the indicator itself.
 * @param _ctx - Host context; nothing is registered.
 * @param config - the resolved configuration.
 */
export function apply(_ctx: unknown, config: Config): void {
  const problems = scheduleProblems({
    windows: config.windows.get(),
    weekdays: config.weekdays.get(),
    holidays: config.holidays.get(),
    calendarUtcOffsetMinutes: config.calendarUtcOffsetMinutes.get(),
  })
  if (problems.length > 0) throw new Error(`ui-peak-hours: invalid schedule: ${problems.join('; ')}`)
}
