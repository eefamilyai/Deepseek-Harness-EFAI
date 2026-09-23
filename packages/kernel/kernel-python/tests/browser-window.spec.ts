/**
 * The kernel's browser-window preference.
 *
 * It is a live field of this plugin's own configuration, so the Settings page
 * edits it by this row's id and no switch package or settings namespace sits in
 * between. The property worth pinning is the default: an agent working on the
 * user's behalf browses without putting a window on their desktop.
 */
import { describe, expect, it } from 'vitest'
import { isVolatile } from '@deepseek-ai/cosmokit'
import { Config } from '../src/index.ts'

describe('browserWindow', () => {
  it('is a live field that defaults to no window', () => {
    const config = Config({})
    expect(isVolatile(config.browserWindow)).toBe(true)
    expect(config.browserWindow.get()).toBe(false)
  })

  it('carries the composition value when one is given', () => {
    expect(Config({ browserWindow: true }).browserWindow.get()).toBe(true)
  })
})
