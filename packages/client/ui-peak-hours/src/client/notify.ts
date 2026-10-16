/**
 * Desktop notifications for the two transitions worth interrupting for: the
 * lead warning beginning and peak pricing starting. Only a transition the
 * running window observes notifies; opening the window mid-peak shows the pill
 * without a notification.
 */
import type { PeakView } from './view.ts'

/** Which transition, if any, a pair of readings crosses. */
export type PeakTransition = 'soon' | 'peak' | null

/**
 * The transition from one reading to the next.
 * @param previous - the earlier reading.
 * @param next - the later reading.
 * @returns `peak` when peak pricing starts, `soon` when the lead warning begins, otherwise null.
 */
export function transitionOf(previous: PeakView, next: PeakView): PeakTransition {
  if (next.kind === 'peak' && previous.kind !== 'peak') return 'peak'
  if (next.kind === 'soon' && previous.kind !== 'soon' && previous.kind !== 'peak') return 'soon'
  return null
}

/** The browser notification API as this module uses it, so a test can stand one in. */
export interface NotificationApi {
  readonly permission: 'default' | 'denied' | 'granted'
  requestPermission(): Promise<'default' | 'denied' | 'granted'>
  new (title: string, options?: { body?: string; tag?: string }): unknown
}

/**
 * Show one notification, asking for permission first when it was never decided.
 * A denied or missing API shows nothing: the pill still carries the warning.
 * @param api - the Notification constructor, or undefined where the platform has none.
 * @param title - notification title.
 * @param body - notification body.
 * @returns settles once the notification is shown or skipped.
 */
export async function showNotification(api: NotificationApi | undefined, title: string, body: string): Promise<void> {
  if (api === undefined || api.permission === 'denied') return
  const permission = api.permission === 'granted' ? 'granted' : await api.requestPermission()
  if (permission !== 'granted') return
  new api(title, { body, tag: 'dsh-peak-hours' })
}
