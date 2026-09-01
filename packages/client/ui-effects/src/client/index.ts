/**
 * Browser half of the visual-effects surface plugin: a private React root
 * hosting the whale backdrop, the bottom-right focus button, and the rotating
 * nature focus lock; plus the Visual-effects row in General settings.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the settings surface's Context merge (ctx.settingsScope) and slot types.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls the renderer's Context merge (ctx.slots).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { EFFECTS_SETTINGS_NAMESPACE, type EffectsSettings } from '../effects-settings.ts'
import { EffectsSettingsPolicy } from './settings-store.ts'
import { EffectsOverlay } from './Overlay.tsx'
import { EffectsSettingsRow, type EffectsSettingsRowInjected } from './EffectsSettingsRow.tsx'
import { en, zh } from './locales.ts'

/** Dictionary namespace owned by this plugin's settings row. */
const NS = 'settings.effects'

/** Fixed overlay mount id, stable across re-activations. */
const ROOT_ID = 'dsh-ui-effects-root'

/** Services required by the browser effects plugin. */
export const inject = ['slots', 'locale', 'settingsScope']

/**
 * Bind the durable preferences, register the Settings row, and mount the
 * overlay React tree. Every side effect belongs to a `ctx.effect` disposer.
 * @param ctx - Client Cordis context.
 */
export function apply(ctx: ClientContext): void {
  const policy = new EffectsSettingsPolicy(
    ctx.settingsScope.bind<EffectsSettings>({ namespace: EFFECTS_SETTINGS_NAMESPACE }),
  )

  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-effects: settings dictionaries')

  ctx.slots.inject('settings.general.item', () => ctx.slots.register({
    name: 'settings.general.item',
    id: 'visual-effects',
    order: 30,
    locale: NS,
    inject: (): EffectsSettingsRowInjected => ({
      hooks: {
        whaleEnabled: policy.whaleEnabled,
        focusEnabled: policy.focusEnabled,
        whaleOpacity: policy.whaleOpacity,
        whaleSize: policy.whaleSize,
        whaleStatic: policy.whaleStatic,
      },
      setWhaleEnabled: (value) => { policy.setWhaleEnabled(value) },
      setFocusEnabled: (value) => { policy.setFocusEnabled(value) },
      setWhaleOpacity: (value) => { policy.setWhaleOpacity(value) },
      setWhaleSize: (value) => { policy.setWhaleSize(value) },
      setWhaleStatic: (value) => { policy.setWhaleStatic(value) },
    }),
  }, EffectsSettingsRow))

  ctx.effect(() => {
    let host = document.getElementById(ROOT_ID)
    if (host === null) {
      host = document.createElement('div')
      host.id = ROOT_ID
      document.body.append(host)
    }
    const root = createRoot(host)
    root.render(createElement(EffectsOverlay, {
      whaleEnabled: policy.whaleEnabled,
      focusEnabled: policy.focusEnabled,
      whaleOpacity: policy.whaleOpacity,
      whaleSize: policy.whaleSize,
      whaleStatic: policy.whaleStatic,
    }))
    return () => {
      root.unmount()
      host?.remove()
    }
  }, 'ui-effects: overlay root')
}
