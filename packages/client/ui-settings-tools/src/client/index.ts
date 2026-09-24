/**
 * Tools settings section, browser half.
 *
 * Registers one `settings.section` entry rendering the kernel, RLM, and
 * conventional-tool switches. All three are live fields of the `tool-roster`
 * row, so the section reads and writes that row's config form and nothing else.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls ctx.locale into this program.
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: the settings slot declarations plus the ctx.configForms merge.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { ToolsSection } from './ToolsSection.tsx'
import type { RosterFields, ToolsSectionInjected } from './ToolsSection.tsx'
import { en, zh } from './locales.ts'

export type { ToolsKey } from './locales.ts'
export type { RosterFields, ToolsSectionComponentProps, ToolsSectionInjected } from './ToolsSection.tsx'

/** Dictionary namespace owned by this plugin. */
const NS = 'tools'

/** Stable section id used by the settings navigation ledger. */
const SECTION_ID = 'tools'

/**
 * The profile entry id the roster is composed under. Named here rather than
 * imported: the Host package is not part of the browser program.
 */
export const TOOL_ROSTER_ENTRY_ID = 'tool-roster'

/**
 * Required services (cordis fiber inject). The target slot is declared by
 * ui-settings' apply, whose activation order relative to this one is NOT
 * constrained; the registration depends on it through `slots.inject()`.
 */
export const inject = ['slots', 'locale', 'configForms']

/**
 * Register the Tools section once its slot declaration is on the ledger.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-settings-tools: dictionaries')
  const t = ctx.locale.bind(NS)
  const form = ctx.configForms.get<RosterFields>(TOOL_ROSTER_ENTRY_ID)
  const injected = (): ToolsSectionInjected => ({ form })

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: SECTION_ID,
    order: 25,
    label: () => t('tools.nav'),
    locale: NS,
    inject: injected,
  }, ToolsSection))
}
