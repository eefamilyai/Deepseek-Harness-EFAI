// @vitest-environment jsdom
/**
 * The appearance engine, driven directly.
 *
 * Two behaviours carry the feature and neither is visible in the settings form: a
 * field left at its default must produce *no* declaration at all (mounting the
 * plugin changes nothing), and every opacity is expressed as a `color-mix` over the
 * palette token the theme itself uses, in both palettes, because the shell and the
 * surfaces are faded separately and a hardcoded colour would break dark mode.
 */
import { describe, expect, it, vi } from 'vitest'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import {
  APPEARANCE_DEFAULTS,
  APPEARANCE_STYLE_ID,
  appearanceCss,
  installAppearance,
  type AppearanceValues,
} from '../src/client/appearance.ts'

/** The default values with the named ones replaced. */
function values(patch: Partial<AppearanceValues> = {}): AppearanceValues {
  return { ...APPEARANCE_DEFAULTS, ...patch }
}

describe('appearanceCss', () => {
  it('emits nothing until something is chosen', () => {
    expect(appearanceCss(values())).toBe('')
  })

  it('writes the font stack on the scopes that beat the theme', () => {
    const css = appearanceCss(values({ fontFamily: 'Inter, system-ui, sans-serif' }))
    // The theme declares tokens on the root element and on the themed body, and a
    // custom property is inherited from the nearest ancestor that sets one.
    expect(css).toContain(':root:root, :root:root body, :root:root body[data-ds-dark-theme]')
    expect(css).toContain('--dsw-font-family: Inter, system-ui, sans-serif;')
  })

  it('refuses a font stack that is not a plain stack', () => {
    expect(appearanceCss(values({ fontFamily: 'Inter; color: red' }))).toBe('')
    expect(appearanceCss(values({ fontFamily: 'Inter /* x */' }))).toBe('')
  })

  it('scales every radius step together, and squares them at zero', () => {
    const rounded = appearanceCss(values({ radiusScale: 2 }))
    expect(rounded).toContain('--dsw-radius-sm: 16px;')
    expect(rounded).toContain('--dsw-radius-panel: 56px;')
    expect(appearanceCss(values({ radiusScale: 0 }))).toContain('--dsw-radius-lg: 0px;')
  })

  it('derives the accent washes from the chosen colour', () => {
    const css = appearanceCss(values({ accent: 'oklch(0.7 0.12 250)' }))
    expect(css).toContain('--dsw-alias-state-business-primary: oklch(0.7 0.12 250);')
    expect(css).toContain('--dsw-alias-state-business-tertiary: color-mix(in srgb, oklch(0.7 0.12 250) 18%, transparent);')
  })

  it('fades the shell and the surfaces by different amounts, per palette', () => {
    const css = appearanceCss(values({ shellOpacity: 60, surfaceOpacity: 90 }))
    // The shell: the canvas and the sidebar's own fills.
    expect(css).toContain('--dsw-alias-bg-base: color-mix(in srgb, var(--dsw-static-neutral-bluish-00) 60%, transparent);')
    expect(css).toContain('--dsw-specific-sidebar-fill: color-mix(in srgb, var(--dsw-static-neutral-bluish-50) 60%, transparent);')
    // The surfaces keep more of their colour, so text over them stays readable.
    expect(css).toContain('--dsw-alias-bg-layer-1: color-mix(in srgb, var(--dsw-static-neutral-bluish-00) 90%, transparent);')
    // Both palettes carry a rule, because the tokens resolve differently in each.
    expect(css).toContain(':root:root body:not([data-ds-dark-theme])')
    expect(css).toContain(':root:root body[data-ds-dark-theme]')
    expect(css).toContain('var(--dsw-static-neutral-bluish-950) 90%, transparent')
  })

  it('scales the root font size on its own', () => {
    expect(appearanceCss(values({ fontScale: 115 }))).toContain('font-size: 115%;')
  })
})

describe('real transparency', () => {
  it('stops the document painting once the shell is faded, so the desktop shows through', () => {
    // The desktop window is created transparent over its material, so the page's own
    // background is the one thing between the operator and the desktop behind it.
    const css = appearanceCss(values({ shellOpacity: 65 }))
    expect(css).toContain(':root:root, :root:root body {\n  background-color: transparent;\n}')
  })

  it('leaves the document alone while the shell is solid', () => {
    expect(appearanceCss(values({ surfaceOpacity: 60 }))).not.toContain('background-color: transparent;')
  })
})

describe('installAppearance', () => {
  /** A stand-in form over a fixed value, with the subscription the engine uses. */
  function form(value: Partial<AppearanceValues>) {
    const listeners = new Set<() => void>()
    let current = value
    return {
      set: (next: Partial<AppearanceValues>): void => {
        current = next
        for (const listener of listeners) listener()
      },
      unsubscribe: vi.fn(),
      handle: {
        getSnapshot: () => ({ status: 'ready' as const, value: current, revision: 1, writable: true }),
        subscribe: (listener: () => void) => {
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        },
        mutate: () => Promise.resolve(true),
        set: () => Promise.resolve(true),
        unset: () => Promise.resolve(true),
      } as unknown as ConfigForm<Partial<AppearanceValues>>,
    }
  }

  it('writes a sheet only when there is something to write, and follows the row', () => {
    const doc = document.implementation.createHTMLDocument('test')
    const live = form({})
    const dispose = installAppearance(live.handle, doc)
    // Nothing chosen: no sheet at all, and the page is untouched.
    expect(doc.getElementById(APPEARANCE_STYLE_ID)).toBeNull()

    live.set({ accent: '#7c5cff', shellOpacity: 65 })
    const sheet = doc.getElementById(APPEARANCE_STYLE_ID)
    expect(sheet?.textContent).toContain('--dsw-alias-state-business-primary: #7c5cff;')
    expect(sheet?.textContent).toContain('background-color: transparent;')

    // Back to the defaults: the sheet leaves and the page publishes nothing again.
    live.set({})
    expect(doc.getElementById(APPEARANCE_STYLE_ID)).toBeNull()

    dispose()
  })

  it('removes what it added when it is disposed', () => {
    const doc = document.implementation.createHTMLDocument('test')
    const live = form({ shellOpacity: 50 })
    const dispose = installAppearance(live.handle, doc)
    expect(doc.getElementById(APPEARANCE_STYLE_ID)).not.toBeNull()
    dispose()
    expect(doc.getElementById(APPEARANCE_STYLE_ID)).toBeNull()
  })
})
