/**
 * The agent-memory switch. Owns ONLY the `agentMemory.enabled` setting; the
 * composition gate mounts the engine when it is true. Stays mounted in both
 * positions so the switch can always be flipped back. Default OFF (non-default),
 * `applies: 'restart'` because the Loader `disabled` expression is read at boot.
 * @module @deepseek-ai/dsh-agent-memory-mode
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-settings'

export const name = 'agent-memory-mode'
export const AGENT_MEMORY_SETTINGS_NAMESPACE = 'agent-memory'
export const AGENT_MEMORY_ENABLED_PATH = 'agent-memory.enabled'
export const AGENT_MEMORY_ENABLED_DEFAULT = false

export interface Config {
  /**
   * Whether the durable memory engine mounts. On: the engine adds
   * `memory_add`/`memory_recall`/`memory_map`, auto-records tool output, and
   * re-injects a bounded index each turn. Off: no memory tools and no index.
   * Takes effect on restart.
   */
  enabled?: boolean
}

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(AGENT_MEMORY_ENABLED_DEFAULT)
    .description('Keep a durable, cache-friendly memory index of tool results and explicit notes.'
      + ' On, the engine adds memory_add/memory_recall/memory_map tools, auto-records tool output,'
      + ' and re-injects a bounded index each turn. Restart the harness to apply.'),
})

export function apply(ctx: Context, config: Config): void {
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.register(AGENT_MEMORY_SETTINGS_NAMESPACE, Config, {
      base: { enabled: config.enabled ?? AGENT_MEMORY_ENABLED_DEFAULT },
      applies: 'restart',
    })
  })
}
