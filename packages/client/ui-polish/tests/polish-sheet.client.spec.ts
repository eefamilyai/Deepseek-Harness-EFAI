/**
 * The polish sheet as CSS text. It is an artifact with no behavior to drive, and
 * its whole premise is which contracts it may select on, so the specs assert the
 * contract rather than a rendering: no hashed class selector, only tokens and
 * attributes upstream publishes, the two motion rules that keep the sheet
 * harmless to loops and to component transition lists, and a reduced-motion
 * block that actually collapses the durations it introduces.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const SHEET = readFileSync(resolve(process.cwd(), 'packages/client/ui-polish/src/client/polish.css'), 'utf8')
const CSS = SHEET.replace(/\/\*[\s\S]*?\*\//g, ' ')

describe('polish sheet', () => {
  it('never selects a hashed CSS-module class', () => {
    // A class selector here would work in a source checkout and do nothing in a
    // Desktop build, where the module classes are hashed per bundle.
    expect(CSS).not.toMatch(/\.[a-zA-Z][\w-]*\s*[{,]/)
    expect(CSS).not.toMatch(/\[class[\^$*~|]?=/)
  })

  it('selects on contracts upstream publishes', () => {
    for (const contract of [
      "[role='dialog']", "[role='menu']", "[role='listbox']", "[role='tooltip']",
      "[role='menuitem']", "[role='option']", "[role='tab']", "[role='switch']",
      "[aria-disabled='true']", '[data-closing]', '[data-ds-dark-theme]',
      'prefers-reduced-motion', 'prefers-contrast',
    ]) {
      expect(CSS, `missing ${contract}`).toContain(contract)
    }
  })

  it('retunes the shell motion scale and the elevation tokens', () => {
    for (const token of [
      '--ds-ease-in-out', '--ds-ease-out', '--ds-transition-duration',
      '--ds-transition-duration-fast', '--ds-transition-duration-slow',
      '--dsw-shadow-lv1', '--dsw-shadow-lv2', '--dsw-shadow-lv3',
      '--dsw-elevation-soft', '--dsw-elevation-panel', '--dsw-elevation-prominent',
    ]) {
      expect(CSS, `missing ${token}`).toMatch(new RegExp(`${token}\\s*:`))
    }
    // Both palettes: a dark theme that keeps black-on-black elevation reads flat.
    const dark = CSS.slice(CSS.indexOf('[data-ds-dark-theme]'))
    expect(dark).toContain('--dsw-shadow-lv3')
  })

  it('re-points the curve without redefining transition or animation timing', () => {
    // `transition` would wipe each component's property list, and
    // `animation-timing-function` would ease the shimmer, marquee and spinner
    // loops, which are linear on purpose.
    expect(CSS).toMatch(/transition-timing-function:\s*var\(--ds-ease-in-out\)/)
    expect(CSS).not.toMatch(/(^|[;{\s])transition:\s/)
    expect(CSS).not.toContain('animation-timing-function')
    // The fallback has to outweigh a single class selector to beat a component's
    // own shorthand.
    expect(CSS).toMatch(/:root:root \*/)
  })

  it('collapses its own motion when the viewer asked for less', () => {
    const reduced = CSS.slice(CSS.indexOf('prefers-reduced-motion'))
    expect(reduced).toContain('--ds-transition-duration-slow: 1ms')
    expect(reduced).toContain('transition-duration: 1ms !important')
    expect(reduced).toContain('animation-duration: 1ms !important')
  })
})
