/**
 * The Personalization section, browser half.
 *
 * Registers one `settings.section` entry over this plugin's own row and installs
 * the appearance engine, which turns that row's live fields into the token
 * overrides the page wears. The row is the host half's `Config`, so the profile
 * persists every choice and this file owns no state of its own.
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
import { AppearanceSection, type AppearanceFields, type AppearanceSectionInjected } from './AppearanceSection.tsx'
import { en, zh } from './locales.ts'

export type { AppearanceFields, AppearanceSectionComponentProps, AppearanceSectionInjected } from './AppearanceSection.tsx'
export type { AppearanceValues } from './appearance.ts'

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
  const appearance = ctx.configForms.get<AppearanceFields>(APPEARANCE_ENTRY_ID)
  // The engine follows the same live form the section writes, so the page changes
  // as the control moves and no second source of truth exists.
  ctx.effect(() => installAppearance(appearance, document), 'ui-personalization: tokens')
  const injected = (): AppearanceSectionInjected => ({ appearance })

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: SECTION_ID,
    order: 26,
    label: () => t('appearance.nav'),
    locale: NS,
    inject: injected,
  }, AppearanceSection))
}
