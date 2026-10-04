/**
 * The Personalization section, browser half.
 *
 * Registers one `settings.section` entry over this plugin's own row and installs
 * the appearance engine, which turns the policy's live values into the token
 * overrides the page wears. The row is the host half's `Config`, so the profile
 * persists every choice.
 *
 * The values themselves live in one {@link AppearancePolicy}: the section writes
 * through it and the engine paints from it, so a control changes the window in
 * the same step and the row is adopted whenever it answers. The slot hands the
 * policy's stores to the section through the inject `hooks` compartment, which
 * the renderer binds as `use<Name>` selector hooks.
 *
 * @module @deepseek-ai/dsh-client-ui-personalization/client
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls ctx.locale into this program.
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the slot registry's ctx merge, which is where `ctx.slots` comes from.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: the settings slot declarations plus the ctx.configForms merge.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { installAppearance } from './appearance.ts'
import { AppearancePolicy } from './appearance-store.ts'
import { AppearanceSection, type AppearanceFields, type AppearanceSectionInjected } from './AppearanceSection.tsx'
import { en, zh } from './locales.ts'

export type { AppearanceFields, AppearanceSectionComponentProps, AppearanceSectionInjected } from './AppearanceSection.tsx'
export type { AppearanceValues } from './appearance.ts'
export type { AppearanceField, AppearanceSource } from './appearance-store.ts'

/** The locale namespace this section registers its copy under. */
const NS = 'appearance'

/** The settings nav entry's id. */
const SECTION_ID = 'ui-personalization'

/** The row this section edits: the id the bundle mounts it under. */
export const APPEARANCE_ENTRY_ID = 'ui-personalization'

/** The services this plugin reads. */
export const inject = ['slots', 'locale', 'configForms']

/**
 * Register the section and start applying the appearance.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-personalization: dictionaries')
  const t = ctx.locale.bind(NS)
  const form = ctx.configForms.get<AppearanceFields>(APPEARANCE_ENTRY_ID)
  const policy = new AppearancePolicy(form)
  ctx.effect(() => installAppearance(policy, document), 'ui-personalization: tokens')
  ctx.effect(() => () => { policy.dispose() }, 'ui-personalization: row subscription')

  const injected = (): AppearanceSectionInjected => ({
    status: form === undefined ? 'unavailable' : 'ready',
    hooks: {
      fontFamily: policy.fontFamily,
      fontScale: policy.fontScale,
      accent: policy.accent,
      radiusScale: policy.radiusScale,
      shellOpacity: policy.shellOpacity,
      surfaceOpacity: policy.surfaceOpacity,
      panelOpacity: policy.panelOpacity,
    },
    setFontFamily: (value) => { policy.setFontFamily(value) },
    setFontScale: (value) => { policy.setFontScale(value) },
    setAccent: (value) => { policy.setAccent(value) },
    setRadiusScale: (value) => { policy.setRadiusScale(value) },
    setShellOpacity: (value) => { policy.setShellOpacity(value) },
    setSurfaceOpacity: (value) => { policy.setSurfaceOpacity(value) },
    setPanelOpacity: (value) => { policy.setPanelOpacity(value) },
    reset: () => { policy.reset() },
  })

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: SECTION_ID,
    order: 26,
    label: () => t('appearance.nav'),
    locale: NS,
    inject: injected,
  }, AppearanceSection))
}
