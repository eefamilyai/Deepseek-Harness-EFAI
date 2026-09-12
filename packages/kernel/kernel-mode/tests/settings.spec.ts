/**
 * The switch's settings document, including the browser-window preference.
 *
 * These pin the defaults a deployment inherits before anyone opens a settings
 * surface, because both values are read once at boot by Loader rows: a wrong
 * default here is a window on someone's desktop or a tool roster they did not
 * choose, and neither is visible until the process starts.
 */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { MemorySettings } from '../../../settings/settings/tests/memory.ts'
import {
  Config,
  KERNEL_BROWSER_WINDOW_DEFAULT,
  KERNEL_ENABLED_DEFAULT,
  KERNEL_SETTINGS_NAMESPACE,
  apply,
} from '../src/index.ts'

/** Resolve a plugin's declared config against one composition-layer value. */
function resolve(config: Record<string, unknown>): Record<string, unknown> {
  return Config(config as never) as unknown as Record<string, unknown>
}

describe('kernel settings', () => {
  it('defaults the acting roster to on and the browser window to off', () => {
    expect(KERNEL_ENABLED_DEFAULT).toBe(true)
    expect(KERNEL_BROWSER_WINDOW_DEFAULT).toBe(false)
    expect(resolve({})).toMatchObject({ enabled: true, browserWindow: false })
  })

  it('carries an explicit composition-layer value through', () => {
    expect(resolve({ enabled: false, browserWindow: true }))
      .toMatchObject({ enabled: false, browserWindow: true })
  })

  it('publishes both keys in the kernel namespace as restart-scoped', async () => {
    const ctx = new Context()
    await ctx.plugin(MemorySettings, {})
    apply(ctx, { browserWindow: true })
    // `ctx.inject` defers its callback, so the registration lands one microtask
    // after apply returns rather than inside it.
    await Promise.resolve()
    const descriptors = ctx.settings.describe()
      .filter(entry => entry.ns === KERNEL_SETTINGS_NAMESPACE)
    expect(descriptors).toHaveLength(1)
    // Exactly one entry, asserted above, so reading it is not a guess.
    const descriptor = descriptors[0]!
    expect(descriptor.applies).toBe('restart')
    expect(descriptor.value).toEqual({ enabled: true, browserWindow: true })
    await ctx.fiber.dispose()
  })
})
