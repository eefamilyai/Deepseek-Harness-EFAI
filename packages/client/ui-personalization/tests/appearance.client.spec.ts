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
  opacityPercent,
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

  it('makes the whole window glass, and composes the surface level on top of it', () => {
    const css = appearanceCss(values({ shellOpacity: 60, surfaceOpacity: 50 }))
    // The shell is the window: the canvas and the sidebar go to 60%.
    expect(css).toContain('--dsw-alias-bg-base: color-mix(in srgb, var(--dsw-static-neutral-bluish-00) 60%, transparent);')
    expect(css).toContain('--dsw-specific-sidebar-fill: color-mix(in srgb, var(--dsw-static-neutral-bluish-50) 60%, transparent);')
    // The layers inside multiply: 60% shell x 50% surface = 30%, so the conversation is
    // softer than the frame while the window itself stays exactly as translucent as the
    // shell says.
    expect(css).toContain('--dsw-alias-bg-layer-1: color-mix(in srgb, var(--dsw-static-neutral-bluish-00) 30%, transparent);')
    // Both palettes carry a rule, because the tokens resolve differently in each.
    expect(css).toContain(':root:root body:not([data-ds-dark-theme])')
    expect(css).toContain(':root:root body[data-ds-dark-theme]')
    expect(css).toContain('var(--dsw-static-neutral-bluish-950) 30%, transparent')
  })

  it('fades every layer when only the shell is glass', () => {
    // What "literal transparency" means: with the shell at 60 and the surface untouched,
    // nothing in the window is left opaque, so the desktop behind it is what you see.
    const css = appearanceCss(values({ shellOpacity: 60 }))
    expect(css).toContain('--dsw-alias-bg-layer-1: color-mix(in srgb, var(--dsw-static-neutral-bluish-00) 60%, transparent);')
    expect(css).toContain('--dsw-alias-bg-layer-3:')
    expect(css).toContain('--dsw-alias-bg-overlay:')
    expect(css).toContain('background-color: transparent;')
  })

  it('scales the root font size on its own', () => {
    expect(appearanceCss(values({ fontScale: 115 }))).toContain('font-size: 115%;')
  })
})

describe('the fraction-to-percentage migration', () => {
  it('gives the settings panel its own level', () => {
    // The dialog draws from layer 2, so it has a control of its own: at 45% the panel
    // thins while the conversation inside the window is untouched.
    const css = appearanceCss(values({ panelOpacity: 45 }))
    expect(css).toContain('--dsw-alias-bg-layer-2: color-mix(in srgb, var(--dsw-static-neutral-bluish-00) 45%, transparent);')
    expect(css).toContain('--dsw-alias-bg-overlay: color-mix(in srgb, var(--dsw-static-neutral-bluish-150) 45%, transparent);')
    expect(css).not.toContain('--dsw-alias-bg-layer-1:')
    // And it composes with the window rather than replacing it.
    const both = appearanceCss(values({ shellOpacity: 50, panelOpacity: 50 }))
    expect(both).toContain('--dsw-alias-bg-layer-2: color-mix(in srgb, var(--dsw-static-neutral-bluish-00) 25%, transparent);')
  })

  it('reads a value the first build stored as a fraction', () => {
    // The field was 0.35-1 when the first version shipped; a profile written then still
    // holds the fraction, and the range accepts it so the stored value cannot stop the
    // row from starting.
    expect(opacityPercent(0.65)).toBe(65)
    expect(opacityPercent(1)).toBe(100)
    expect(opacityPercent(65)).toBe(65)
    const css = appearanceCss(values({ shellOpacity: 0.6, surfaceOpacity: 0.9 }))
    // The shell factor is the window: 0.6 -> 60%. The layers inside compose with the
    // surface factor: 60% x 90% = 54%.
    expect(css).toContain('--dsw-alias-bg-base: color-mix(in srgb, var(--dsw-static-neutral-bluish-00) 60%, transparent);')
    expect(css).toContain('--dsw-alias-bg-layer-1: color-mix(in srgb, var(--dsw-static-neutral-bluish-00) 54%, transparent);')
  })
})

describe('real transparency', () => {
  it('clears the window\'s own paint, not just the document', () => {
    // The dialog was the only thing that went translucent, because it is drawn from the
    // tokens this engine fades. The window itself is painted by the document, the app
    // frame, and the conversation and composer surfaces - none of which is a token.
    const css = appearanceCss(values({ shellOpacity: 65 }))
    const cleared = [
      ':root:root,',
      ':root:root body,',
      ':root:root #root,',
      ':root:root #root > * {',
      ':root:root [data-conversation-content],',
      ':root:root [data-chat-flow],',
      ':root:root [data-composer-seat] {',
    ]
    for (const selector of cleared) expect(css).toContain(selector)
    expect(css).toContain('background-color: transparent;')
  })

  it('clears the content level for either control, and the frame only for the window', () => {
    // With a solid window, the surface level still thins the content - which is what a
    // translucent card or panel is seen against - but the frame around it stays.
    const css = appearanceCss(values({ surfaceOpacity: 35 }))
    expect(css).toContain(':root:root [data-conversation-content],')
    expect(css).not.toContain(':root:root #root > * {')
  })

  it('leaves the window alone while the shell is solid', () => {
    // The surface level thins the content, so what is asserted here is the *frame*: the
    // document and the shell's own panes stay as the theme painted them.
    const css = appearanceCss(values({ surfaceOpacity: 60 }))
    expect(css).not.toContain(':root:root #root > * {')
    expect(css).not.toContain(':root:root body {')
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
