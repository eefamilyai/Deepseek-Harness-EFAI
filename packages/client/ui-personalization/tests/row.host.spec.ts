/**
 * The row's host half, mounted the way the Loader mounts it.
 *
 * The settings page said "this deployment composes no personalization row" while the
 * section itself was on screen, which can only happen one way: the browser half
 * loaded and the host row did not start. This spec pins the host half on its own
 * terms — the module exports the function-plugin form the Loader looks for, the
 * schema builds, and every default is the theme's own value rather than a value that
 * would change the page the moment the row mounts.
 */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { liveConfig } from '../../../settings/settings/tests/live-config.ts'
import { Config, apply, name } from '../src/index.ts'
import { APPEARANCE_DEFAULTS } from '../src/options.ts'

describe('the personalization row', () => {
  it('exports the function-plugin form and mounts', async () => {
    // A service package would default-export a class; a function plugin names its
    // `name`, `inject`, `Config` and `apply` and has no default export.
    expect(name).toBe('ui-personalization')
    expect(typeof apply).toBe('function')

    const ctx = new Context()
    // The mount resolving is the assertion: a schema that cannot be built, or an
    // `apply` that throws, fails here rather than in a settings page at runtime.
    const live = await liveConfig(ctx, { name, apply, Config }, {})
    await live.fiber.await()
    // A failed fiber rejects the await above, so reaching here is the assertion.
    await live.fiber.dispose()
  })

  it('accepts every field at once, and an empty document that resolves to the theme defaults', () => {
    // Every field is volatile, so the resolved document holds live references.
    const resolved = Config({}) as Record<string, { get: () => unknown }>
    expect(Object.fromEntries(Object.entries(resolved).map(([field, ref]) => [field, ref.get()]))).toEqual(APPEARANCE_DEFAULTS)
    expect(() => Config({
      fontFamily: 'Inter, system-ui, sans-serif',
      fontScale: 120,
      accent: '#7c5cff',
      radiusScale: 1.5,
      shellOpacity: 65,
      surfaceOpacity: 85,
      codeFontFamily: 'Cascadia Code, Consolas',
      lineHeight: 120,
      accentEverywhere: true,
      contentWidth: 'full',
      settingsWidth: 'wide',
      scrollbars: 'thin',
      glassBlur: 16,
      backdrop: 'image',
      backdropImage: 'https://example.com/w.jpg',
      shadows: 'strong',
      reduceMotion: true,
    })).not.toThrow()
  })

  it('rejects values outside the range the page can render', () => {
    expect(() => Config({ shellOpacity: 0.1 })).toThrow()
    expect(() => Config({ surfaceOpacity: 400 })).toThrow()
    expect(() => Config({ radiusScale: 9 })).toThrow()
    expect(() => Config({ fontScale: 10 })).toThrow()
    expect(() => Config({ contentWidth: 'huge' })).toThrow()
    expect(() => Config({ glassBlur: 200 })).toThrow()
  })

  it('accepts both spellings of an opacity, so an older profile keeps working', () => {
    // Fractions are what the first build wrote; percentages are what it writes now.
    expect(() => Config({ shellOpacity: 0.6, surfaceOpacity: 0.9 })).not.toThrow()
    expect(() => Config({ shellOpacity: 60, surfaceOpacity: 90 })).not.toThrow()
  })
})
