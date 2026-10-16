/**
 * Staged values of the Automation tasks creation form, their local validation,
 * and the Host create request they compose.
 *
 * Creation starts from nothing, so this model holds the wire selector directly
 * rather than translating a stored record into a draft and back the way the
 * detail's Run time card does. Only shape is checked here; the Host owns the
 * semantic rules it alone can decide, such as whether a target is still ahead,
 * and a refusal comes back as an error code the dialog localizes.
 */
import type { ScheduleCreateTaskRequest } from '@deepseek-ai/dsh-schedule/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { parseCronExpression } from './task-cron.ts'
import type { TaskManagerKey } from './task-manager-locales.ts'

/** Recurrence choices the form's Repeat menu offers, in the detail's menu order. */
export const CREATE_CHOICES = [
  'weekly', 'weekdays', 'daily', 'every-hour', 'every-minute', 'every-second', 'once', 'cron',
] as const

/** One recurrence choice the form can stage. */
export type CreateChoice = (typeof CREATE_CHOICES)[number]

/** One elapsed-interval choice; its unit is part of the user's intent, not a conversion. */
export type CreateIntervalChoice = Extract<CreateChoice, `every-${string}`>

/** ISO weekdays in display order, Monday through Sunday. */
export const CREATE_WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const

/** One ISO weekday of the weekly choice. */
export type CreateWeekday = (typeof CREATE_WEEKDAYS)[number]

/** ISO weekday set the Monday-to-Friday choice stores. */
export const CREATE_WEEKDAY_RULE: readonly CreateWeekday[] = [1, 2, 3, 4, 5]

/** Longest task name the Host accepts. The browser-safe Schedule entry exports types only, so the limit is restated here. */
export const CREATE_TITLE_MAX_LENGTH = 120

/** Shortest elapsed interval the Host accepts, in seconds. */
export const CREATE_MIN_INTERVAL_SECONDS = 60

/** Unit word each elapsed-interval choice counts in. */
export const CREATE_INTERVAL_UNITS: Readonly<Record<CreateIntervalChoice, 'hour' | 'minute' | 'second'>> = {
  'every-hour': 'hour', 'every-minute': 'minute', 'every-second': 'second',
}

/** Seconds one unit of an elapsed-interval choice represents. */
const INTERVAL_UNIT_SECONDS: Readonly<Record<'hour' | 'minute' | 'second', number>> = {
  hour: 3_600, minute: 60, second: 1,
}

/** Below-floor message of each elapsed-interval choice, stated in that choice's own unit. */
export const CREATE_INTERVAL_ERROR_KEYS: Readonly<Record<CreateIntervalChoice, TaskManagerKey>> = {
  'every-hour': 'timing.invalidInterval.hour',
  'every-minute': 'timing.invalidInterval.minute',
  'every-second': 'timing.invalidInterval.second',
}

/** Quantity each elapsed-interval choice opens with, in its own unit. */
const INTERVAL_DEFAULT_COUNT: Readonly<Record<CreateIntervalChoice, string>> = {
  'every-hour': '1', 'every-minute': '1', 'every-second': '60',
}

/** Whether one choice states its rule with a wall clock and a zone. */
export function isClockChoice(choice: CreateChoice): choice is 'daily' | 'weekdays' | 'weekly' {
  return choice === 'daily' || choice === 'weekdays' || choice === 'weekly'
}

/** Whether one choice is an elapsed interval rather than a wall clock. */
export function isIntervalChoice(choice: CreateChoice): choice is CreateIntervalChoice {
  return choice === 'every-hour' || choice === 'every-minute' || choice === 'every-second'
}

/** Values one staged creation holds; every field is text the form controls directly. */
export interface CreateDraft {
  /** Task name the Host stores and every surface names the task by. */
  readonly title: string
  /** Reminder instruction delivered when the task runs. */
  readonly prompt: string
  /** Session the task delivers into; empty until one is chosen. */
  readonly sessionId: SessionId | ''
  /** Recurrence choice the Repeat row shows. */
  readonly choice: CreateChoice
  /** `YYYY-MM-DD` target of the one-shot choice. */
  readonly date: string
  /** `HH:MM:SS` clock of the one-shot and clock-time choices. */
  readonly time: string
  /** IANA zone the clock-time and custom choices interpret their wall clock in. */
  readonly timeZone: string
  /** Quantity of an elapsed-interval choice, in that choice's own unit. */
  readonly count: string
  /** ISO weekday set the weekly choice stores. */
  readonly weekdays: readonly CreateWeekday[]
  /** Five-field expression of the custom choice. */
  readonly expression: string
}

/** Local calendar date of one instant, as `YYYY-MM-DD`. */
function isoDate(at: Date): string {
  const month = String(at.getMonth() + 1).padStart(2, '0')
  const day = String(at.getDate()).padStart(2, '0')
  return `${at.getFullYear()}-${month}-${day}`
}

/** ISO weekday of one instant, Monday 1 through Sunday 7. */
function isoWeekday(at: Date): CreateWeekday {
  return (((at.getDay() + 6) % 7) + 1) as CreateWeekday
}

/**
 * Values the form opens on.
 *
 * The clock-time choices start one hour ahead at whole minutes, so the first
 * submit names a real future moment rather than midnight of a day already past.
 * The weekly choice starts on the weekday it is opened, and the custom choice on
 * a nine-o'clock daily expression, which is the shape its own hint describes.
 * @param sessionId - Session to preselect, or empty when none is available yet.
 * @param zone - the host's current IANA zone, used by every clock-time choice.
 * @param now - instant the defaults are measured from.
 * @returns the staged draft the dialog edits.
 */
export function initialCreateDraft(sessionId: SessionId | '', zone: string, now = new Date()): CreateDraft {
  const start = new Date(now.getTime() + 3_600_000)
  start.setSeconds(0, 0)
  return {
    title: '',
    prompt: '',
    sessionId,
    choice: 'daily',
    date: isoDate(start),
    time: `${String(start.getHours()).padStart(2, '0')}:${String(start.getMinutes()).padStart(2, '0')}:00`,
    timeZone: zone,
    count: INTERVAL_DEFAULT_COUNT['every-hour'],
    weekdays: [isoWeekday(now)],
    expression: '0 9 * * *',
  }
}

/**
 * Quantity an elapsed-interval choice opens with once the choice changes, so a
 * switch never carries a number that is below the new unit's floor.
 * @param choice - elapsed-interval choice being selected.
 * @returns that choice's own opening quantity.
 */
export function intervalCountFor(choice: CreateIntervalChoice): string {
  return INTERVAL_DEFAULT_COUNT[choice]
}

/** Whether one staged text is an existing ISO calendar date. */
function validIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const parsed = new Date(`${value}T00:00:00.000Z`)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

/** Whether one staged text is a whole-second clock. */
function validClock(value: string): boolean {
  return /^\d{2}:\d{2}:\d{2}$/.test(value)
}

/** Whether one staged text names a zone this runtime can format in. */
function validZone(zone: string): boolean {
  if (zone === '') return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone })
    return true
  } catch {
    return false
  }
}

/** Seconds one elapsed-interval choice's staged quantity represents. */
function intervalSeconds(draft: CreateDraft, choice: CreateIntervalChoice): number {
  return Number(draft.count) * INTERVAL_UNIT_SECONDS[CREATE_INTERVAL_UNITS[choice]]
}

/** The selector fields one staged choice contributes to the request. */
type CreateSelector =
  | { readonly at: { readonly date: string; readonly time: string; readonly time_zone: string } }
  | { readonly every_seconds: number }
  | { readonly daily: { readonly time: string; readonly time_zone: string } }
  | { readonly weekly: { readonly time: string; readonly time_zone: string; readonly weekdays: number[] } }
  | { readonly cron: { readonly expression: string; readonly time_zone: string } }

/**
 * Outcome of staging a submission: the request to send, or the dictionary key
 * naming the first field that must be corrected.
 */
export type CreateResolution =
  | { readonly error: TaskManagerKey }
  | { readonly request: ScheduleCreateTaskRequest }

/**
 * Validate the staged values and compose the Host create request.
 *
 * The checks run in the order the form reads, so the reported field is the
 * topmost one the reader must fix.
 * @param draft - values the form shows.
 * @returns the request to send, or the message key of the invalid field.
 */
export function resolveCreate(draft: CreateDraft): CreateResolution {
  const title = draft.title.trim()
  if (title.length === 0 || title.length > CREATE_TITLE_MAX_LENGTH) return { error: 'rule.invalidTitle' }
  const prompt = draft.prompt.trim()
  if (prompt.length === 0) return { error: 'rule.invalidPrompt' }
  if (draft.sessionId === '') return { error: 'create.sessionRequired' }
  const selector = selectorOf(draft)
  if ('error' in selector) return { error: selector.error }
  return {
    request: {
      sessionId: draft.sessionId,
      title,
      prompt,
      ...selector.selector,
    },
  }
}

/**
 * The selector one staged choice contributes, or the message key that blocks it.
 * @param draft - values the form shows.
 * @returns the selector fields, or the invalid field's message key.
 */
function selectorOf(draft: CreateDraft): { readonly selector: CreateSelector } | { readonly error: TaskManagerKey } {
  const choice = draft.choice
  if (isIntervalChoice(choice)) {
    const seconds = intervalSeconds(draft, choice)
    if (!/^\d+$/.test(draft.count) || seconds < CREATE_MIN_INTERVAL_SECONDS) {
      return { error: CREATE_INTERVAL_ERROR_KEYS[choice] }
    }
    return { selector: { every_seconds: seconds } }
  }
  if (choice === 'cron') {
    if (parseCronExpression(draft.expression) === undefined) return { error: 'rule.cronInvalid' }
    if (!validZone(draft.timeZone)) return { error: 'timing.invalidZone' }
    return { selector: { cron: { expression: draft.expression.trim(), time_zone: draft.timeZone.trim() } } }
  }
  if (!validClock(draft.time)) return { error: 'timing.invalid' }
  if (choice === 'once') {
    if (!validIsoDate(draft.date)) return { error: 'timing.invalid' }
    if (!validZone(draft.timeZone)) return { error: 'timing.invalidZone' }
    return {
      selector: { at: { date: draft.date, time: draft.time, time_zone: draft.timeZone.trim() } },
    }
  }
  if (!validZone(draft.timeZone)) return { error: 'timing.invalidZone' }
  if (choice === 'daily') {
    return { selector: { daily: { time: draft.time, time_zone: draft.timeZone.trim() } } }
  }
  const weekdays = choice === 'weekdays' ? [...CREATE_WEEKDAY_RULE] : [...draft.weekdays].sort((left, right) => left - right)
  if (weekdays.length === 0) return { error: 'create.weekdaysRequired' }
  return {
    selector: {
      weekly: { time: draft.time, time_zone: draft.timeZone.trim(), weekdays },
    },
  }
}
