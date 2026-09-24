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

import type { Context, Fiber, Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import * as AgentMemory from '@deepseek-ai/dsh-agent-memory'
import type { Config as AgentMemoryConfig } from '@deepseek-ai/dsh-agent-memory'
import type {} from '@deepseek-ai/dsh-settings'
// The Loader's `loader/volatile-update` event and `fiber.entry`.
import type {} from '@deepseek-ai/cordis-plugin-loader'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'agent-memory-mode'

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
  enabled: Volatile<boolean>
  /** Engine settings, passed through verbatim when the engine mounts. */
  engine: AgentMemoryConfig
}

export const Config = z.object({
  enabled: z.boolean().default(AGENT_MEMORY_ENABLED_DEFAULT)
    .description('Keep a durable, cache-friendly memory index of tool results and explicit notes.'
      + ' On, the engine adds memory_add/memory_recall/memory_map tools, auto-records tool output,'
      + ' and re-injects a bounded index each turn.')
    .volatile(),
  engine: z.any().default({})
    .description('Engine settings passed through to @deepseek-ai/dsh-agent-memory when it mounts.'),
})

/**
 * Hold the engine to the switch.
 *
 * The switch is a live field of this row, so Settings edits it by this row's id
 * and the loader commits the new value without remounting the row; this plugin
 * then mounts or disposes the engine to match. The row itself stays mounted in
 * both positions, because a switch that disappeared when off could never be
 * switched back on.
 * @param ctx - the plugin context.
 * @param config - the live switch and the engine settings.
 */
export function apply(ctx: Context, config: Config): void {
  let engine: Fiber | undefined
  const sync = (): void => {
    const enabled = config.enabled.get()
    if (enabled === (engine !== undefined)) return
    if (enabled) {
      engine = ctx.plugin(AgentMemory, config.engine)
      return
    }
    // Disposal unwinds the engine's own effects — its tools, its prompt
    // block, and its tool-result observer — so the off position leaves no
    // half-registered surface behind.
    void engine?.dispose()
    engine = undefined
  }

  sync()
  ctx.on('loader/volatile-update', sync)
}
