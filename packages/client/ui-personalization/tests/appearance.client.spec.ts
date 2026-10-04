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
import { describe, expect, it } from 'vitest'
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

  it('makes the window glass without touching the surfaces inside it', () => {
    // The three controls are independent: the shell owns the window's own paint, and a
    // card or a panel inside a glass window is still its own level.
    const css = appearanceCss(values({ shellOpacity: 60, surfaceOpacity: 50, panelOpacity: 45 }))
    // The shell is the window: the canvas and the sidebar go to 60%.
    expect(css).toContain('--dsw-alias-bg-base: color-mix(in srgb, var(--dsw-static-neutral-bluish-00) 60%, transparent);')
    expect(css).toContain('--dsw-specific-sidebar-fill: color-mix(in srgb, var(--dsw-static-neutral-bluish-50) 60%, transparent);')
    // Moving the shell must not move anything else: the content and the dialog keep their
    // own numbers, not the window's.
    expect(css).toContain('--dsw-alias-bg-layer-1: color-mix(in srgb, var(--dsw-static-neutral-bluish-00) 50%, transparent);')
    expect(css).toContain('--dsw-alias-settings-card-fill: color-mix(in srgb, var(--dsw-static-neutral-bluish-00) 45%, transparent);')
    // Both palettes carry a rule, because the tokens resolve differently in each.
    expect(css).toContain(':root:root body:not([data-ds-dark-theme])')
    expect(css).toContain(':root:root body[data-ds-dark-theme]')
    expect(css).toContain('var(--dsw-static-neutral-bluish-950) 50%, transparent')
  })

  it('leaves the content and the dialog alone when only the shell is glass', () => {
    // The regression the operator reported: Shell changed the settings dialog, because the
    // window's opacity was multiplied into every level. Each control owns its own level.
    const css = appearanceCss(values({ shellOpacity: 60 }))
    expect(css).not.toContain('--dsw-alias-bg-layer-1:')
    expect(css).not.toContain('--dsw-alias-bg-layer-2:')
    expect(css).not.toContain('--dsw-alias-settings-card-fill:')
    expect(css).not.toContain('--dsw-alias-bg-overlay:')
    // It does clear the window's own paint and the document behind it.
    expect(css).toContain('background-color: transparent;')
  })

  it('scales the root font size on its own', () => {
    expect(appearanceCss(values({ fontScale: 115 }))).toContain('font-size: 115%;')
  })
})

describe('the three opacity levels', () => {
  it('gives the settings panel the dialog and the floating surfaces', () => {
    const css = appearanceCss(values({ panelOpacity: 45 }))
    // `--dsw-alias-settings-card-fill` is the theme's own name for the dialog's surface.
    expect(css).toContain('--dsw-alias-settings-card-fill: color-mix(in srgb, var(--dsw-static-neutral-bluish-00) 45%, transparent);')
    expect(css).toContain('--dsw-alias-bg-overlay: color-mix(in srgb, var(--dsw-static-neutral-bluish-150) 45%, transparent);')
    // Not the content, and not the window.
    expect(css).not.toContain('--dsw-alias-bg-layer-1:')
    expect(css).not.toContain('--dsw-alias-bg-base:')
  })

  it('reads a value the first build stored as a fraction', () => {
    // The field was 0.35-1 when the first version shipped; a profile written then still
    // holds the fraction, and the range accepts it so the stored value cannot stop the
    // row from starting.
    expect(opacityPercent(0.65)).toBe(65)
    expect(opacityPercent(1)).toBe(100)
    expect(opacityPercent(65)).toBe(65)
    const css = appearanceCss(values({ shellOpacity: 0.6, surfaceOpacity: 0.9 }))
    expect(css).toContain('--dsw-alias-bg-base: color-mix(in srgb, var(--dsw-static-neutral-bluish-00) 60%, transparent);')
    expect(css).toContain('--dsw-alias-bg-layer-1: color-mix(in srgb, var(--dsw-static-neutral-bluish-00) 90%, transparent);')
  })
})

describe('real transparency', () => {
  it('clears the window\'s own paint, not just the document', () => {
    // The dialog was the only thing that went translucent, because it is drawn from the
    // tokens this engine fades. The window itself is painted by the document and the app
    // frame - neither of which is a token - so the shell clears those by hand.
    const css = appearanceCss(values({ shellOpacity: 65 }))
    const cleared = [
      ':root:root,',
      ':root:root body,',
      ':root:root #root,',
      ':root:root #root > * {',
    ]
    for (const selector of cleared) expect(css).toContain(selector)
    expect(css).toContain('background-color: transparent;')
  })

  it('clears the content scroller for the surface control, and the frame only for the window', () => {
    // The conversation's scroller and the composer are what a card or panel is seen
    // against, so the surface control owns them.
    const css = appearanceCss(values({ surfaceOpacity: 35 }))
    expect(css).toContain(':root:root [data-conversation-content],')
    expect(css).toContain(':root:root [data-chat-flow],')
    expect(css).toContain(':root:root [data-composer-seat] {')
    expect(css).not.toContain(':root:root #root > * {')
  })

  it('leaves the window alone while the shell is solid', () => {
    const css = appearanceCss(values({ surfaceOpacity: 60 }))
    expect(css).not.toContain(':root:root #root > * {')
    expect(css).not.toContain(':root:root body {')
  })
})

describe('installAppearance', () => {
  /** A stand-in appearance source over a fixed value, with the subscription the engine uses. */
  function source(value: Partial<AppearanceValues>) {
    const listeners = new Set<() => void>()
    let current: AppearanceValues = { ...APPEARANCE_DEFAULTS, ...value }
    return {
      set: (next: Partial<AppearanceValues>): void => {
        current = { ...APPEARANCE_DEFAULTS, ...next }
        for (const listener of listeners) listener()
      },
      handle: {
        values: () => current,
        subscribe: (listener: () => void) => {
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        },
      },
    }
  }

  it('writes a sheet only when there is something to write, and follows the policy', () => {
    const doc = document.implementation.createHTMLDocument('test')
    const live = source({})
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
    const live = source({ shellOpacity: 50 })
    const dispose = installAppearance(live.handle, doc)
    expect(doc.getElementById(APPEARANCE_STYLE_ID)).not.toBeNull()
    dispose()
    expect(doc.getElementById(APPEARANCE_STYLE_ID)).toBeNull()
  })
})
