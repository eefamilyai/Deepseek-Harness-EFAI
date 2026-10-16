/**
 * The DeepSeek pricing pill under the composer: amber while peak pricing is on
 * or about to start, a quiet tertiary reading off-peak. Hover or focus shows
 * the schedule in the reader's own time zone.
 */
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { LocaleKeysOf } from '@deepseek-ai/dsh-client-ui-slots'
import { splitDuration, type LocalWindow, type PeakView } from './view.ts'
import css from './PeakPill.module.css'

/** Injected face: the live reading. */
export interface PeakPillInjected {
  hooks: {
    /** The indicator's current reading, republished when something visible moves. */
    peak: HostObservable<PeakView>
  }
}

/** Full pill props. */
export type PeakPillProps =
  PropsRuntime<'conversation.composer.dock'>
  & PropsLocale<'peakHours'>
  & InjectFace<PeakPillInjected>

type T = PeakPillProps['t']

/**
 * A countdown in the active locale.
 * @param ms - remaining time.
 * @param t - translate.
 * @returns e.g. "1h 20m".
 */
export function formatRemaining(ms: number, t: T): string {
  const { days, hours, minutes } = splitDuration(ms)
  if (days > 0) return t('duration.days', { days, hours })
  if (hours > 0) return t('duration.hours', { hours, minutes })
  return t('duration.minutes', { minutes })
}

/**
 * A clock time in the reader's time zone, with the weekday when it is not today.
 * @param at - epoch ms.
 * @param now - epoch ms of the reading.
 * @returns the formatted time.
 */
export function formatClock(at: number, now: number): string {
  const sameDay = new Date(at).toDateString() === new Date(now).toDateString()
  return new Intl.DateTimeFormat(undefined, sameDay
    ? { hour: '2-digit', minute: '2-digit' }
    : { weekday: 'short', hour: '2-digit', minute: '2-digit' }).format(at)
}

/**
 * The working-day windows in the reader's time zone.
 * @param windows - today's windows as epoch ms.
 * @returns e.g. "09:00–12:00, 14:00–18:00".
 */
function formatWindows(windows: readonly LocalWindow[]): string {
  const clock = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' })
  return windows.map(window => `${clock.format(window.start)}–${clock.format(window.end)}`).join(', ')
}

/**
 * Label and tooltip text for a visible reading.
 * @param view - the reading; not hidden.
 * @param t - translate.
 * @returns the pill label and its tooltip.
 */
export function describe(view: Exclude<PeakView, { kind: 'hidden' }>, t: T): { label: string; tip: string } {
  if (view.kind === 'invalid') {
    return { label: t('pill.invalid'), tip: t('tip.invalid', { problems: view.problems.join('; ') }) }
  }
  const now = Date.now()
  const schedule = t('tip.windows', { windows: formatWindows(view.windows) })
  switch (view.kind) {
    case 'peak':
      return {
        label: t('pill.peak', { remaining: formatRemaining(view.remainingMs, t) }),
        tip: `${t('tip.peak', { time: formatClock(view.endsAt, now) })} ${schedule}`,
      }
    case 'soon':
      return {
        label: t('pill.soon', { remaining: formatRemaining(view.remainingMs, t) }),
        tip: `${t('tip.soon', { time: formatClock(view.startsAt, now) })} ${schedule}`,
      }
    case 'off-peak': {
      const label = view.remainingMs === null
        ? t('pill.offPeakNone')
        : t('pill.offPeak', { remaining: formatRemaining(view.remainingMs, t) })
      const time = view.nextPeakAt === null ? null : formatClock(view.nextPeakAt, now)
      const key: LocaleKeysOf<'peakHours'> = view.reason === 'holiday'
        ? 'tip.offPeak.holiday'
        : view.reason === 'weekend' ? 'tip.offPeak.weekend' : 'tip.offPeak.hours'
      const lead = time === null ? t('tip.noNext') : t(key, { time, holiday: view.holiday ?? '' })
      return { label, tip: `${lead} ${schedule}` }
    }
  }
}

/**
 * Render the pricing pill, or nothing while hidden.
 * @param props - the composed slot props.
 * @returns the pill.
 */
export function PeakPill({ usePeak, t }: PeakPillProps) {
  const view = usePeak(value => value)
  if (view.kind === 'hidden') return null
  const { label, tip } = describe(view, t)
  const tone = view.kind === 'peak' ? css.peak : view.kind === 'soon' || view.kind === 'invalid' ? css.soon : css.offPeak
  return (
    <Tooltip label={tip} side="top" portal maxWidth={340}>
      <span className={`${css.pill} ${tone}`} tabIndex={0} data-peak-hours={view.kind} role="status">
        <span className={css.dot} aria-hidden />
        <span className={css.label}>{label}</span>
      </span>
    </Tooltip>
  )
}
