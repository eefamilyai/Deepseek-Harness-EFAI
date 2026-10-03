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

/** The declarations of one rule, so an assertion reads as the rule it checks. */
function ruleFor(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`)
  if (start < 0) return ''
  return css.slice(start, css.indexOf('}', start))
}

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

  it('retunes the shell curve and the elevation tokens, not the clock', () => {
    for (const token of [
      '--ds-ease-in-out', '--ds-ease-out', '--ds-ease-standard', '--ds-ease-spring',
      '--dsw-shadow-lv1', '--dsw-shadow-lv2', '--dsw-shadow-lv3',
      '--dsw-elevation-soft', '--dsw-elevation-panel', '--dsw-elevation-prominent',
    ]) {
      expect(CSS, `missing ${token}`).toMatch(new RegExp(`${token}\\s*:`))
    }
    // Durations stay the shell's own: its collapse choreography is sequenced
    // against them (150ms fade + 150ms rail entry against a 300ms track), so
    // redeclaring one desynchronises the sequence. The reduced-motion block is the
    // only place allowed to move them, and it collapses rather than retimes.
    const motion = CSS.slice(0, CSS.indexOf('prefers-reduced-motion'))
    expect(motion).not.toMatch(/--ds-transition-duration[a-z-]*:\s*\d+ms/)
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

  it('contracts provider groups except the one in use', () => {
    // The group primitive's own attributes are the contract: a section, a heading,
    // and menuitemradio rows whose aria-checked marks the current one.
    const contracted = ruleFor(CSS, '[data-menu-group] > :not([data-menu-group-heading], [data-menu-group-start])')
    expect(contracted).toContain('display: none')
    // The open state is one arm of a selector list, so it is read from the sheet.
    // A row is anything but the title and the position sentinel, so the rule holds
    // whether a provider renders bare buttons or a wrapper.
    expect(CSS).toContain("[data-menu-group]:has(> [aria-checked='true'])")
    // Only two openers: the checked row's group, and the heading's own state, which
    // the enhancer writes. Hover would open groups the pointer merely crossed, and
    // `:focus-within` would open whichever group the menu focuses first.
    expect(CSS).not.toContain(':hover > :not(')
    expect(CSS).not.toContain(':focus-within > :not(')
    // The enhancer writes aria-expanded on the heading, so the sheet must read it there.
    expect(CSS).toContain("[data-menu-group-heading][aria-expanded='true']")
  })

  it('gives a many-route provider its own scroll box', () => {
    // Keyed on the row count, never on a localized provider name.
    expect(CSS).toContain('[data-menu-group]:has(> :nth-child(n + 12))')
    const box = ruleFor(CSS, '[data-menu-group]:has(> :nth-child(n + 12))')
    expect(box).toContain('max-height')
    expect(box).toContain('overflow-y: auto')
    expect(box).toContain('overscroll-behavior: contain')
  })

  it('leaves the panel choreography alone', () => {
    // The collapse is a sequenced animation (150ms fade, then 150ms rail entry
    // against a 300ms track). Zeroing durations inside the frame during
    // `[data-animating]` — an earlier revision did — snapped it into two jumps,
    // so no rule may key on that attribute.
    expect(CSS).not.toContain('[data-animating]')
  })

  it('gives the dock a fill of its own and rounds its leading edge', () => {
    // Without a fill the dock is the canvas colour, so its rounded corners would
    // be invisible and its edge would stay a bare rule.
    const push = "[data-sidebar-right-panel='push']"
    const dock = "[data-dockkit-host='dock']"
    const surface = ruleFor(CSS, `${push} [data-dockkit-surface]`)
    expect(surface).toContain('border-top-left-radius: var(--dsw-radius-lg)')
    expect(surface).toContain('border-bottom-left-radius: var(--dsw-radius-lg)')
    expect(surface).toContain('overflow: clip')

    const leading = ruleFor(CSS, `${push} ${dock}[data-dockkit-column] > section`)
    expect(leading).toContain('background: var(--dsw-specific-sidebar-fill)')

    // The repeated attribute is deliberate: the component's own rule carries a
    // class on both the cell and its child, so this is what outweighs it.
    const edge = `${push}[data-sidebar-right-panel] ${dock}[data-dockkit-column='0'] > section`
    expect(ruleFor(CSS, edge)).toContain('border-left-color: var(--dsw-alias-border-l2)')

    // Never unscoped: a bare surface selector would round bottom docks and floats.
    expect(CSS).not.toMatch(/^\[data-dockkit-surface\]/m)
    expect(ruleFor(CSS, '[data-disclosure-row]:hover')).toContain('border-radius: var(--dsw-radius-sm)')
  })

  it('never leaves a transform on a dialog', () => {
    // `fill-mode: both` keeps the final keyframe, and a transform — even the
    // identity one — makes an element a containing block for fixed descendants,
    // which would misplace a picker opened inside the dialog.
    const dialog = CSS.slice(CSS.indexOf("[role='dialog'] {"), CSS.indexOf('@keyframes dsh-polish-fade-in'))
    expect(dialog).toContain('dsh-polish-fade-in')
    expect(dialog).not.toContain('transform')
    expect(dialog).not.toContain('pop-in')
  })

  it('covers the reading surfaces and the drag handles', () => {
    for (const contract of [
      '[data-side]::after', '[data-side]:hover::after', '[data-side][data-dragging]::after',
      '[data-disclosure-row]:hover', '[data-chat-flow]', "[role='alert']",
    ]) {
      expect(CSS, `missing ${contract}`).toContain(contract)
    }
    // The opaque token: rows inside an expanded reasoning block are sticky, and a
    // translucent wash would let scrolled content show through them.
    expect(CSS).toContain('background-color: var(--dsw-alias-interactive-bg-hover-solid)')
    expect(CSS).not.toContain('background-color: var(--dsw-alias-interactive-bg-hover)')
    // The theme curves every rounded surface along a superellipse, which squares
    // off a capsule end, so an uncapped radius has to opt out. The theme's own
    // `corner-shape-styles` spec enforces the pair across every client sheet; this
    // is the one such radius here.
    expect(CSS).toMatch(/\[data-side\]::after\s*\{[^}]*border-radius:\s*999px;[^}]*corner-shape:\s*round;/)
  })

  it('restores surface order in the light palette only', () => {
    expect(CSS).toContain('body:not([data-ds-dark-theme])')
    const light = CSS.slice(CSS.indexOf('body:not([data-ds-dark-theme])'))
    expect(light).toContain('--dsw-alias-bg-layer-1')
    expect(light).toContain('--dsw-alias-bg-layer-3')
    // The canvas axis is painted on the conversation body, which does not scroll,
    // and it sets only the background image so the canvas colour survives.
    expect(CSS).toContain('[data-conversation-content]')
    expect(CSS).toMatch(/\[data-conversation-content\]\s*\{[^}]*background-image:/)
    expect(CSS).not.toMatch(/\[data-conversation-content\]\s*\{[^}]*background:/)
    // No literal colours anywhere in the sheet: every value is a token or a
    // shadow alpha, so both palettes keep working.
    const values = CSS.replace(/--dsw-shadow-[a-z0-9-]+:[^;]+;/g, '')
    expect(values).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
  })

  it('collapses its own motion when the viewer asked for less', () => {
    const reduced = CSS.slice(CSS.indexOf('prefers-reduced-motion'))
    expect(reduced).toContain('--ds-transition-duration-slow: 1ms')
    expect(reduced).toContain('transition-duration: 1ms !important')
    expect(reduced).toContain('animation-duration: 1ms !important')
  })
})
