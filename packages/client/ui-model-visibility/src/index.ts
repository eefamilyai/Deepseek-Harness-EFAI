/**
 * Host half of provider visibility: hides chosen provider routes from the
 * model picker.
 *
 * The picker's catalog, the picker's and `/model`'s selection check, and ACP's
 * model list all read `llm.listProviders()`; this row filters that list. Turns
 * route through the registry's adapter table, not that list, so a session
 * already on a hidden provider keeps working; it is only no longer offered.
 * `hidden` is volatile and read on every call, and a settings write makes the
 * picker reload its catalog, so a toggle shows at the next menu open.
 *
 * @module @deepseek-ai/dsh-client-ui-model-visibility
 */
import type { Context, Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-llm'

/** Cordis plugin name. */
export const name = 'model-visibility'

/** Requires the LLM registry whose provider list it filters. */
export const inject = ['llm']

/** One hidden provider route, with the name the settings list shows while it is hidden. */
export interface HiddenProvider {
  /** Provider route id. */
  id: string
  /** Display name recorded when the provider was hidden. */
  name: string
}

/** The hidden provider routes. */
export interface Config {
  /** Provider routes left out of the model picker. */
  hidden: Volatile<HiddenProvider[]>
}

export const Config = z.object({
  hidden: z.array(z.object({
    id: z.string().required().description('Provider route id.'),
    name: z.string().default('').description('Display name shown in the settings list while hidden.'),
  })).default([]).description('Providers left out of the model picker. Sessions already using one keep working.').volatile(),
})

/**
 * Filter the registry's provider list for as long as the row is mounted.
 * @param ctx - the plugin context.
 * @param config - the resolved configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const llm = ctx.llm
  ctx.effect(() => {
    const own = Object.prototype.hasOwnProperty.call(llm, 'listProviders')
    // oxlint-disable-next-line typescript/unbound-method -- the original is re-bound with `.call(this)` below
    const original = llm.listProviders
    llm.listProviders = function listVisibleProviders(this: typeof llm) {
      const hidden = new Set(config.hidden.get().map(entry => entry.id))
      return original.call(this).filter(provider => !hidden.has(provider.id))
    }
    return () => {
      if (own) llm.listProviders = original
      else delete (llm as Partial<typeof llm>).listProviders
    }
  }, 'model-visibility: provider list')
}
