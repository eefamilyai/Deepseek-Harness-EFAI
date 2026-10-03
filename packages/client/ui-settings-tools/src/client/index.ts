/**
 * Tools settings section, browser half.
 *
 * Registers one `settings.section` entry that edits the live fields of three
 * composed host rows: `tool-roster` (availability), `kernel-python` (the kernel
 * window) and `web-browser` (timeouts and output caps). Each is read and written
 * through its own config form, so the section owns no configuration of its own.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls ctx.locale into this program.
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: the settings slot declarations plus the ctx.configForms merge.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls the ctx.remote merge and the agentPresets namespace.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-agent-preset-registry/remote'
import { ToolsSection } from './ToolsSection.tsx'
import type {
  BrowserFields, KernelFields, PresetRow, RosterFields, ToolsSectionInjected,
} from './ToolsSection.tsx'
import { en, zh } from './locales.ts'

export type { ToolsKey } from './locales.ts'
export type {
  BrowserFields, KernelFields, PresetRow, RosterFields, ToolsSectionComponentProps, ToolsSectionInjected,
} from './ToolsSection.tsx'

/** Dictionary namespace owned by this plugin. */
const NS = 'tools'

/** Stable section id used by the settings navigation ledger. */
const SECTION_ID = 'tools'

/**
 * The profile entry ids this section edits. Named here rather than imported: the
 * Host packages are not part of the browser program.
 */
export const TOOL_ROSTER_ENTRY_ID = 'tool-roster'
export const KERNEL_PYTHON_ENTRY_ID = 'kernel-python'
export const WEB_BROWSER_ENTRY_ID = 'web-browser'

/**
 * The settings section the preset rows hand off to. Presets are edited there,
 * through the settings namespace their own plugin owns; this section only lists
 * them and points at it, because the preset registry publishes no write.
 */
export const AGENT_PRESET_SECTION_ID = 'agent-presets'

/**
 * Required services (cordis fiber inject). The target slot is declared by
 * ui-settings' apply, whose activation order relative to this one is NOT
 * constrained; the registration depends on it through `slots.inject()`.
 */
export const inject = ['slots', 'locale', 'configForms', 'remote', 'remote.agentPresets']

/**
 * Register the Tools section once its slot declaration is on the ledger.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-settings-tools: dictionaries')
  const t = ctx.locale.bind(NS)
  const roster = ctx.configForms.get<RosterFields>(TOOL_ROSTER_ENTRY_ID)
  const kernel = ctx.configForms.get<KernelFields>(KERNEL_PYTHON_ENTRY_ID)
  const browser = ctx.configForms.get<BrowserFields>(WEB_BROWSER_ENTRY_ID)
  // A deployment that composes none of the three still registers the section: it
  // reports each missing row itself, so the nav never shows an empty page.
  // The Remote face folds carrier failures into the result's error branch, so the
  // loader raises them and the section reports a failed read rather than an empty
  // roster: an unreadable preset list is not a deployment without presets.
  const listPresets = async (): Promise<readonly PresetRow[]> => {
    const result = await ctx.remote.agentPresets.list()
    if (!result.ok) throw new Error(result.error.message)
    return result.value.presets
  }
  const injected = (): ToolsSectionInjected => ({ roster, kernel, browser, listPresets })

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: SECTION_ID,
    order: 25,
    label: () => t('tools.nav'),
    locale: NS,
    inject: injected,
  }, ToolsSection))
}
