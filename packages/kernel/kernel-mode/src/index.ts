/**
 * The kernel switch: one setting deciding whether the persistent Python kernel
 * is available.
 *
 * Turned ON, the model can run Python in a namespace that outlives a single
 * call, so reading a file, editing it, searching a tree, and running a command
 * are all function calls inside it. Turned OFF, the `kernel` tool is withdrawn.
 *
 * The switch owns ONE tool and one category. It no longer decides whether the
 * conventional roster — bash, the filesystem tools, search, background jobs —
 * is mounted: that is the separate `tools` category, and the two are
 * independent, so the kernel and the conventional tools can be on at once. The
 * previous either/or arrangement made the kernel *replace* those rows, which
 * meant the switch could only ever trade one set for the other.
 *
 * This plugin owns only the setting. Enforcing it is `tool-roster`, which
 * filters the assembled prompt and guards execution; the affected rows are
 * mounted unconditionally so nothing has to be unmounted to withdraw a tool.
 * That is also why this setting is `live` rather than `restart`: a change lands
 * at the end of the turn in flight, and no boot-time Loader expression reads it
 * any more.
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

/**
 * The document path for the browser-window preference.
 *
 * Exported so the string appears once in TypeScript; the `!!js` expression in
 * the bundle YAML necessarily spells it out again, and this is what it matches.
 */
export const KERNEL_BROWSER_WINDOW_PATH = 'kernel.browserWindow'

/** Default when the user has never touched the preference: no window appears. */
export const KERNEL_BROWSER_WINDOW_DEFAULT = false

/** Plugin config: the switch, and its composition-layer default. */
export interface Config {
  /**
   * Whether the persistent Python kernel is available to the model. On: the
   * `kernel` tool. Off: no kernel, while the conventional tool roster is
   * unaffected. Applies when the model next stops generating.
   */
  enabled?: boolean
  /**
   * Whether the agent's browser may open a real Chromium window on the desktop.
   * Off: the browser runs windowless and nothing appears while the agent works —
   * screenshots and the live view still work. On: a genuine window opens that
   * you can watch and take over. Takes effect on restart.
   */
  browserWindow?: boolean
}

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(KERNEL_ENABLED_DEFAULT)
    .description('Make the kernel tool available: run Python in a persistent namespace, where'
      + ' reading a file, editing it, searching the tree, and running a command are'
      + ' function calls inside it. Independent of the conventional tool roster.'
      + ' Applies when the model next stops generating.'),
  browserWindow: z.boolean().default(KERNEL_BROWSER_WINDOW_DEFAULT)
    .description('Let the agent open a real Chromium window on your desktop. Off, it browses'
      + ' windowless and nothing appears while it works; screenshots and the live view still'
      + ' work. Restart the harness to apply.'),
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
      base: {
        enabled: config.enabled ?? KERNEL_ENABLED_DEFAULT,
        browserWindow: config.browserWindow ?? KERNEL_BROWSER_WINDOW_DEFAULT,
      },
      // Applied by `tool-roster` at the end of the turn in flight; no Loader
      // expression reads it any more, so a restart is not required.
      applies: 'live',
    })
  })
}
