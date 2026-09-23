/**
 * Advanced settings section, browser half.
 *
 * Registers one `settings.section` entry rendering a raw JSON editor over every
 * registered settings namespace — the escape hatch for a value no purpose-built
 * section exposes yet.
 *
 * It is its own package rather than a few lines inside
 * `@deepseek-ai/dsh-client-ui-settings-general`, because the section is a slot
 * registration and a slot registration needs no privileged position: any plugin
 * carrying `slots`, `locale`, and `remote.settings` can make one.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the ctx.remote merge and its fixed Host facts.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
// Type-only: pulls ctx.locale into this program.
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: the settings slot declarations plus the ctx.settingsScope merge.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { AdvancedSection } from './AdvancedSection.tsx'
import type { AdvancedSectionInjected } from './AdvancedSection.tsx'
import { en, zh } from './locales.ts'

export type { AdvancedKey } from './locales.ts'
export type { AdvancedSectionInjected } from './AdvancedSection.tsx'

/** Dictionary namespace owned by this plugin. */
const NS = 'advanced'

/** Stable section id used by the settings navigation ledger. */
const SECTION_ID = 'advanced'

/** Nav position: last, after every purpose-built section. */
const SECTION_ORDER = 100

/**
 * Required services (cordis fiber inject). The target slot is declared by
 * ui-settings' apply, whose activation order relative to this one is NOT
 * constrained; the registration depends on it through `slots.inject()`.
 */
export const inject = ['slots', 'locale', 'remote', 'remote.settings']

/**
 * Register the Advanced section once its slot declaration is on the ledger.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-settings-advanced: dictionaries')
  const t = ctx.locale.bind(NS)
  const injected = (): AdvancedSectionInjected => ({ settings: ctx.remote.settings })

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: SECTION_ID,
    order: SECTION_ORDER,
    label: () => t('advanced.nav'),
    locale: NS,
    inject: injected,
  }, AdvancedSection))
}
