/**
 * Tools settings section, browser half.
 *
 * Registers one `settings.section` entry rendering the two category switches
 * and the per-tool list. The tool names come from the `tools` namespace's
 * composition layer, which `@deepseek-ai/dsh-tool-roster` seeds from the
 * registry, so this package never hardcodes a roster.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the ctx.remote merge and its fixed Host facts.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
// Type-only: pulls ctx.locale into this program.
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: the settings slot declarations plus the ctx.settingsScope merge.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { ToolsSection } from './ToolsSection.tsx'
import type { NamespaceSnapshot, ToolsSectionInjected } from './ToolsSection.tsx'
import { en, zh } from './locales.ts'

export type { ToolsKey } from './locales-keys.ts'
export type {
  KernelNamespaceValue, NamespaceSnapshot, ToolsNamespaceValue,
  ToolsSectionComponentProps, ToolsSectionInjected,
} from './ToolsSection.tsx'

/** Dictionary namespace owned by this plugin. */
const NS = 'tools'

/** Stable section id used by the settings navigation ledger. */
const SECTION_ID = 'tools'

/**
 * Required services (cordis fiber inject). The target slot is declared by
 * ui-settings' apply, whose activation order relative to this one is NOT
 * constrained; the registration depends on it through `slots.inject()`.
 */
export const inject = ['slots', 'locale', 'remote', 'remote.settings']

/**
 * Register the Tools section once its slot declaration is on the ledger.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-settings-tools: dictionaries')
  const t = ctx.locale.bind(NS)
  const settings = ctx.remote.settings

  const read = async <T>(ns: string): Promise<NamespaceSnapshot<T> | undefined> => {
    const result = await settings.describe()
    if (!result.ok) return undefined
    const view = result.value.namespaces.find(entry => entry.ns === ns)
    if (view === undefined) return undefined
    return { value: view.value as T, base: view.base, revision: view.revision }
  }

  const write = async (
    ns: string,
    section: Record<string, unknown>,
    revision: number,
  ): Promise<string | undefined> => {
    const result = await settings.replace(ns, section as Record<string, JsonValue>, revision)
    return result.ok ? undefined : result.error.message
  }

  const injected = (): ToolsSectionInjected => ({ read, write })

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: SECTION_ID,
    order: 25,
    label: () => t('tools.nav'),
    locale: NS,
    inject: injected,
  }, ToolsSection))
}
