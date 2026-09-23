/**
 * The agent-memory switch: one setting deciding whether the durable memory
 * engine runs, and the mount that makes it so.
 *
 * The switch owns both halves deliberately. The engine has side effects a
 * hidden tool would not stop — it observes every tool result and writes the
 * evidence to disk — so withdrawing it means not running it, which in Cordis
 * means not mounting it. Keeping that decision here rather than in a Loader
 * `disabled:` expression is what makes the switch live: an expression is read
 * once at boot, so a composition-level gate is a restart-shaped interface by
 * construction.
 *
 * This plugin stays mounted in BOTH positions of its own switch. A switch that
 * disappeared when switched off could never be switched back on.
 *
 * ```yaml
 * - id: agent-memory-mode
 *   name: '@deepseek-ai/dsh-agent-memory-mode'
 *   config:
 *     enabled: false
 * ```
 *
 * @module @deepseek-ai/dsh-agent-memory-mode
 */

import type { Context, Fiber } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import * as AgentMemory from '@deepseek-ai/dsh-agent-memory'
import type { Config as AgentMemoryConfig } from '@deepseek-ai/dsh-agent-memory'
import type {} from '@deepseek-ai/dsh-settings'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'agent-memory-mode'

/** The settings namespace holding the switch. */
export const AGENT_MEMORY_SETTINGS_NAMESPACE = 'agent-memory'

/** The document path the switch is written at. */
export const AGENT_MEMORY_ENABLED_PATH = 'agent-memory.enabled'

/** Default when the user has never touched the switch. */
export const AGENT_MEMORY_ENABLED_DEFAULT = false

/** Plugin config: the switch, and the engine settings it mounts with. */
export interface Config {
  /**
   * Whether the durable memory engine runs. On: `memory_add`,
   * `memory_recall`, and `memory_map`, automatic capture of tool output, and a
   * bounded index re-injected each turn. Off: none of it, and nothing is
   * written. Applies immediately.
   */
  enabled?: boolean
  /** Engine settings, passed through verbatim when the engine mounts. */
  engine?: AgentMemoryConfig
}

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(AGENT_MEMORY_ENABLED_DEFAULT)
    .description('Keep a durable, cache-friendly memory index of tool results and explicit notes.'
      + ' On, the engine adds memory_add/memory_recall/memory_map tools, auto-records tool output,'
      + ' and re-injects a bounded index each turn.'),
  engine: z.any().default({})
    .description('Engine settings passed through to @deepseek-ai/dsh-agent-memory when it mounts.'),
}) as z<Config>

/**
 * Publish the switch and hold the engine to it.
 *
 * `ctx.inject(['settings'])` rather than a static `inject`: a composition with
 * no settings service (the headless and test profiles) still gets the
 * composition-layer answer, and simply has no switch to publish.
 * @param ctx - the plugin context.
 * @param config - the composition-layer value, resolved under the user layer.
 */
export function apply(ctx: Context, config: Config): void {
  const composed = config.enabled ?? AGENT_MEMORY_ENABLED_DEFAULT

  ctx.inject(['settings'], (settingsCtx) => {
    const section = settingsCtx.settings.register(AGENT_MEMORY_SETTINGS_NAMESPACE, Config, {
      base: { enabled: composed },
      applies: 'live',
    })

    let engine: Fiber | undefined
    const sync = (enabled: boolean): void => {
      if (enabled === (engine !== undefined)) return
      if (enabled) {
        engine = settingsCtx.plugin(AgentMemory, config.engine ?? {})
        return
      }
      // Disposal unwinds the engine's own effects — its tools, its prompt
      // block, and its tool-result observer — so the off position leaves no
      // half-registered surface behind.
      void engine?.dispose()
      engine = undefined
    }

    sync(section.get().enabled ?? composed)
    section.watch((next) => { sync(next.enabled ?? composed) })
  })
}
