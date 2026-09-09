/**
 * The RLM switch: one setting deciding whether the first-party recursive RLM
 * engine — not the standalone `kernel` tool — is the model's way of acting on
 * this machine.
 *
 * This plugin owns ONLY the setting, exactly as `@deepseek-ai/dsh-kernel-mode`
 * owns `kernel.enabled`. It stays mounted in BOTH positions of its own switch
 * (a switch that disappeared when off could never be turned back on), and the
 * gating itself is composition: the rows in the shipped agent presets read
 * `dshSettingFlag('rlm.enabled', false)` once at boot (`applies: 'restart'`).
 *
 * RLM mode still needs the persistent Python kernel *seam* underneath — the
 * engine executes cells through `ctx.kernel` — so a profile that turns RLM on
 * must also keep `kernel.enabled` true (the shipped default).
 *
 * ```yaml
 * - id: rlm-mode
 *   name: '@deepseek-ai/dsh-rlm-mode'
 *   config:
 *     enabled: false
 * ```
 *
 * @module @deepseek-ai/dsh-rlm-mode
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-settings'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'rlm-mode'

/** The settings namespace holding the switch. */
export const RLM_SETTINGS_NAMESPACE = 'rlm'

/** The document path compositions read through `dshSettingFlag`. */
export const RLM_ENABLED_PATH = 'rlm.enabled'

/** Default when the user has never touched the switch: conventional kernel tool, no RLM. */
export const RLM_ENABLED_DEFAULT = false

/** Plugin config: the switch, and its composition-layer default. */
export interface Config {
  enabled?: boolean
}

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(RLM_ENABLED_DEFAULT)
    .description('Replace the standalone Python kernel tool with the recursive RLM engine.'
      + ' While on, the kernel, filesystem, shell, and background-job tools unmount'
      + ' and the model instead runs one `rlm` recursive completion. Requires kernel.enabled.'
      + ' Restart the harness to apply.'),
})

/** Register the switch so a configuration surface can show it. */
export function apply(ctx: Context, config: Config): void {
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.register(RLM_SETTINGS_NAMESPACE, Config, {
      base: { enabled: config.enabled ?? RLM_ENABLED_DEFAULT },
      applies: 'restart',
    })
  })
}
