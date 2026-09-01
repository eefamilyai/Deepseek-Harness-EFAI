/**
 * The kernel switch: one setting deciding which roster the harness composes.
 *
 * Turned ON, the model gets the persistent Python kernel and the tools the
 * kernel cannot supply (web access, delegation, skills, goals, planning,
 * asking the user). Turned OFF, it gets the conventional roster — bash, the
 * filesystem tools, search, background jobs — and no kernel. The tools in
 * between, the ones the kernel *replaces*, are the only ones the switch moves;
 * a tool the kernel cannot do is on either way, because switching it off would
 * cost capability for nothing.
 *
 * This plugin owns only the setting. The gating itself is composition:
 * every affected row carries `disabled: !!js ...` reading this value at boot.
 * That is deliberate and is why the setting declares `applies: 'restart'`.
 * Hiding a tool at runtime is not the same as not mounting it — a mounted tool
 * plugin has already contributed its system-prompt section, so a merely-hidden
 * tool leaves the model reading instructions for something it cannot call.
 * Mounting is a Loader fact, Loader facts are decided at boot, and the honest
 * interface for that is a switch that says it needs a restart.
 *
 * The plugin stays mounted in BOTH positions of its own switch. A switch that
 * disappeared when switched off could never be switched back on.
 *
 * ```yaml
 * - id: kernel-mode
 *   name: '@deepseek-ai/dsh-kernel-mode'
 *   config:
 *     enabled: true
 * ```
 *
 * @module @deepseek-ai/dsh-kernel-mode
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-settings'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'kernel-mode'

/** The settings namespace holding the switch. */
export const KERNEL_SETTINGS_NAMESPACE = 'kernel'

/**
 * The document path compositions read through `dshSettingFlag`.
 *
 * Exported so the string appears once in TypeScript; the `!!js` expressions in
 * the YAML necessarily spell it out again, and this is what they must match.
 */
export const KERNEL_ENABLED_PATH = 'kernel.enabled'

/** Default when the user has never touched the switch. */
export const KERNEL_ENABLED_DEFAULT = true

/** Plugin config: the switch, and its composition-layer default. */
export interface Config {
  /**
   * Whether the persistent Python kernel is the model's way of acting on this
   * machine. On: the `kernel` tool, and no bash/filesystem/search/jobs tools —
   * those are function calls inside the kernel namespace instead. Off: those
   * tools, and no kernel. Takes effect on restart.
   */
  enabled?: boolean
}

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(KERNEL_ENABLED_DEFAULT)
    .description('Run Python in a persistent kernel as the model\'s way of acting on this machine.'
      + ' While on, the shell, filesystem, search, and background-job tools are replaced by'
      + ' function calls inside that namespace. Restart the harness to apply.'),
})

/**
 * Register the switch so a configuration surface can show it.
 *
 * `ctx.inject(['settings'])` rather than a static `inject`: the switch must
 * survive a composition with no settings service (the headless and test
 * profiles), where the composition still resolves the flag from the document
 * directly and this plugin simply has nothing to publish.
 * @param ctx - the plugin context.
 * @param config - the composition-layer value, resolved under the user layer.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.register(KERNEL_SETTINGS_NAMESPACE, Config, {
      base: { enabled: config.enabled ?? KERNEL_ENABLED_DEFAULT },
      // Read once at boot by every gated Loader row; see the module note.
      applies: 'restart',
    })
  })
}
