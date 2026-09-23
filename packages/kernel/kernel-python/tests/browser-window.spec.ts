/**
 * Where the kernel's browser-window answer comes from.
 *
 * Three sources rank: the user's settings document, then the composition, and
 * an explicit `KILN_BROWSER_HEADED` over both at the call site. The property
 * worth pinning is that a composition with no settings service still answers,
 * because this provider mounts in profiles that carry none.
 */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { Config, KERNEL_SETTINGS_NAMESPACE, resolveBrowserWindow } from '../src/index.ts'

/** A context carrying a settings service that answers with one document. */
function withSettings(section: unknown): Context {
  const ctx = new Context()
  ctx.provide('settings', { get: (ns: string) => (ns === KERNEL_SETTINGS_NAMESPACE ? section : undefined) })
  return ctx
}

describe('resolveBrowserWindow', () => {
  it('answers from the composition when no settings service is mounted', () => {
    const ctx = new Context()
    expect(resolveBrowserWindow(ctx, new Config({ browserWindow: true }))).toBe(true)
    expect(resolveBrowserWindow(ctx, new Config({ browserWindow: false }))).toBe(false)
  })

  it('lets the settings document outrank the composition', () => {
    expect(resolveBrowserWindow(withSettings({ browserWindow: true }), new Config({ browserWindow: false }))).toBe(true)
    expect(resolveBrowserWindow(withSettings({ browserWindow: false }), new Config({ browserWindow: true }))).toBe(false)
  })

  it('falls back to the composition when the namespace is absent or malformed', () => {
    const config = new Config({ browserWindow: true })
    expect(resolveBrowserWindow(withSettings(undefined), config)).toBe(true)
    expect(resolveBrowserWindow(withSettings({}), config)).toBe(true)
    expect(resolveBrowserWindow(withSettings({ browserWindow: 'yes' }), config)).toBe(true)
    expect(resolveBrowserWindow(withSettings(null), config)).toBe(true)
  })
})
