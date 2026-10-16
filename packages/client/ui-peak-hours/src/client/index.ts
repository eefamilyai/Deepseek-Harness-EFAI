/**
 * Browser half of the DeepSeek peak-hour indicator: a pill in the composer
 * dock that turns amber while DeepSeek bills peak rates (2× off-peak) and
 * shortly before, plus optional desktop notifications at those transitions.
 *
 * The reading is a pure function of the `ui-peak-hours` settings section and
 * the clock; this plugin owns the timer that re-reads the clock and republishes
 * the reading only when something visible moves.
 *
 * It also guards the composer's send: a message on a DeepSeek API route sent
 * during peak pricing opens a dialog that sends it anyway, schedules it for when
 * peak ends through the `peakSend` Remote namespace, or returns it to the
 * composer (see `send-gate.ts`).
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the renderer's Context merge (ctx.slots).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls the settings surface's Context merge (ctx.configForms).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: declares the composer dock slot this plugin fills.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: declares the shell overlay slot the send dialog fills.
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
// Type-only: pulls ctx.remote.session.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import { en, NS, zh } from './locales.ts'
import { showNotification, transitionOf, type NotificationApi } from './notify.ts'
import { PeakPill, formatClock, type PeakPillInjected } from './PeakPill.tsx'
import { peakView, sameView, settingsFrom, type PeakHoursSettings, type PeakView } from './view.ts'
import { SendGate } from './gate.ts'
import { installSendGate, senderOf, type PeakSendRemote } from './send-gate.ts'
// Type-only: the generated `peakSend` namespace on ctx.remote.
import type {} from '@deepseek-ai/dsh-peak-send/remote'
import { SendGateDialog, type SendGateDialogInjected } from './SendGateDialog.tsx'

/** Settings namespace: this plugin's profile row id. */
const SETTINGS_NAMESPACE = 'ui-peak-hours'

/** How often the clock is re-read; the countdown shows whole minutes. */
const TICK_MS = 15_000

/**
 * Services required: slots for the pill and dialog, locale for copy, configForms
 * for settings, and the session Remote for the model catalog.
 */
export const inject = ['slots', 'locale', 'configForms', 'remote', 'remote.session']

/**
 * Publish the reading, keep it current, and register the pill.
 * @param ctx - Client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-peak-hours: dictionaries')
  const t = ctx.locale.bind(NS)
  const form = ctx.configForms.get<Partial<PeakHoursSettings>>(SETTINGS_NAMESPACE)
  const settings = (): PeakHoursSettings => settingsFrom(form.getSnapshot().value)
  const peak = createSnapshotStore<PeakView>(peakView(settings(), Date.now()))
  const notifications: NotificationApi | undefined = typeof Notification === 'undefined' ? undefined : Notification

  const refresh = (): void => {
    const now = Date.now()
    const current = settings()
    const previous = peak.getSnapshot()
    const next = peakView(current, now)
    const transition = transitionOf(previous, next)
    if (current.notify && transition === 'soon' && next.kind === 'soon') {
      void showNotification(notifications, t('notify.soon.title'), t('notify.soon.body', { time: formatClock(next.startsAt, now) }))
    }
    if (current.notify && transition === 'peak' && next.kind === 'peak') {
      void showNotification(notifications, t('notify.peak.title'), t('notify.peak.body', { time: formatClock(next.endsAt, now) }))
    }
    if (!sameView(previous, next)) peak.set(next)
  }

  ctx.effect(() => form.subscribe(refresh), 'ui-peak-hours: settings')
  ctx.effect(() => {
    const timer = setInterval(refresh, TICK_MS)
    return () => { clearInterval(timer) }
  }, 'ui-peak-hours: clock')
  // A sleeping laptop freezes the interval; re-read the clock when the window returns.
  ctx.effect(() => {
    const onVisible = (): void => { if (document.visibilityState === 'visible') refresh() }
    document.addEventListener('visibilitychange', onVisible)
    return () => { document.removeEventListener('visibilitychange', onVisible) }
  }, 'ui-peak-hours: visibility')

  const gate = new SendGate()
  ctx.effect(() => () => { gate.dispose() }, 'ui-peak-hours: send gate')
  // The namespace is optional: the dialog offers scheduling only while it is mounted.
  let peakSend: PeakSendRemote | undefined
  ctx.inject(['remote', 'remote.peakSend'], (scope) => {
    scope.effect(() => {
      peakSend = scope.remote.peakSend
      return () => { peakSend = undefined }
    }, 'ui-peak-hours: deferred sends')
  })
  ctx.inject(['conversation'], (scope) => {
    // Without the send method there is nothing to guard; sending stays as it was.
    const sender = senderOf(scope.conversation)
    if (sender === undefined) return
    scope.effect(() => installSendGate(sender, {
      settings,
      gate,
      remote: () => peakSend,
      catalog: async () => {
        const answer = await ctx.remote.session.modelCatalog()
        return answer.ok ? answer.value : undefined
      },
      t: (key, params) => t(key, params),
      clock: formatClock,
    }), 'ui-peak-hours: guarded send')
  })
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'peak-hours.send-gate',
    locale: NS,
    inject: (): SendGateDialogInjected => ({ hooks: { gate: gate.view }, choose: (choice) => { gate.choose(choice) } }),
  }, SendGateDialog))

  ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
    name: 'conversation.composer.dock',
    id: 'peak-hours',
    order: 10,
    locale: NS,
    inject: (): PeakPillInjected => ({ hooks: { peak } }),
  }, PeakPill))
}
