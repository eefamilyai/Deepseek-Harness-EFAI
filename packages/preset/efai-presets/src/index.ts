/**
 * The fork's agent preset roster: upstream's `AgentPresets` machinery pointed
 * at this package's own preset root instead of upstream's shipped one.
 *
 * The four rosters this package ships (`standard`, `minimal`, `ptc`,
 * `cordis`) carry the fork's acting surface — the `kernel` tool beside the
 * conventional roster — which upstream's copies cannot. A preset root is
 * ordinary configuration, but its path is not something a composition file can
 * write: the directory is inside this package, so only code that knows where
 * this package was installed can name it. That is the whole reason this plugin
 * exists, and why it is a plugin rather than a `roots` entry in YAML.
 *
 * The shipped root is dropped rather than ordered behind this one, because a
 * shipped root always wins a duplicate id: with it on, upstream's `standard`
 * would mask the fork's `standard` and the kernel would silently leave the
 * roster. `includeUserRoot` is untouched, so presets authored under
 * `$DSH_HOME` still load and still lose to these on a duplicate id.
 *
 * ```yaml
 * - id: efai-presets
 *   name: '@deepseek-ai/dsh-efai-presets'
 *   config:
 *     default: standard
 * ```
 *
 * @module @deepseek-ai/dsh-efai-presets
 */

import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { AgentPresets, type Config as AgentPresetsConfig } from '@deepseek-ai/dsh-agent-presets'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'efai-presets'

/**
 * The preset root this package ships.
 *
 * Resolved from this module's own URL so it is correct in every layout the
 * harness runs from — a source launch out of `src/`, a built launch out of
 * `lib/`, and an installed package under `node_modules` all sit exactly one
 * directory below the package root.
 */
export const EFAI_PRESET_ROOT: string = fileURLToPath(new URL('../presets', import.meta.url))

/** Plugin config: the roster's, minus the two fields this package decides. */
export type Config = Omit<AgentPresetsConfig, 'includeShippedRoot' | 'roots'> & {
  /** Extra roots scanned after this package's own, in the order given. */
  roots?: AgentPresetsConfig['roots']
}

export const Config = AgentPresets.Config as unknown as typeof AgentPresets.Config

/**
 * Mount the upstream roster over this package's presets.
 * @param ctx - the plugin context.
 * @param config - the roster configuration; `roots` is appended after this package's own.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.plugin(AgentPresets, {
    ...config,
    includeShippedRoot: false,
    roots: [
      { path: EFAI_PRESET_ROOT, trust: 'system' as const },
      ...config.roots ?? [],
    ],
  })
}
