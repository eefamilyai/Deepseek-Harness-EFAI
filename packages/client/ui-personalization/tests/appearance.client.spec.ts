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
  usableImageUrl,
  type AppearanceValues,
} from '../src/client/appearance.ts'

/** The default values with the named ones replaced. */
function values(patch: Partial<AppearanceValues> = {}): AppearanceValues {
  return { ...APPEARANCE_DEFAULTS, ...patch }
}

describe('appearanceCss', () => {
  it('emits only the caption band until something is chosen', () => {
    // The band is unconditional: it restores the fill the OS caption paints on the desktop,
    // and resolves to nothing where no caption height is published. No token moves until a
    // value differs from the deployment's own.
    const css = appearanceCss(values())
    expect(css).toContain('body::before {')
    // No token is overridden and no rule but the band is written.
    expect(css).not.toContain('--dsw-font-family')
    expect(css).not.toContain(':root:root body:not([data-ds-dark-theme]) {')
    expect(css.trim().split('}').length).toBe(2)
  })

  it('writes the font stack on the scopes that beat the theme', () => {
    const css = appearanceCss(values({ fontFamily: 'Inter, system-ui, sans-serif' }))
    // The theme declares tokens on the root element and on the themed body, and a
    // custom property is inherited from the nearest ancestor that sets one.
    expect(css).toContain(':root:root, :root:root body, :root:root body[data-ds-dark-theme]')
    expect(css).toContain('--dsw-font-family: Inter, system-ui, sans-serif;')
  })

  it('refuses a font stack that is not a plain stack', () => {
    expect(appearanceCss(values({ fontFamily: 'Inter; color: red' }))).not.toContain('--dsw-font-family')
    expect(appearanceCss(values({ fontFamily: 'Inter /* x */' }))).not.toContain('--dsw-font-family')
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

  it('separates the window from the surface inside it', () => {
    // The complaint this answers: choosing Shell glass made the whole interface glass,
    // because the token that paints the conversation also paints the document. The window
    // now paints through the document at the shell's opacity, the chrome follows the shell,
    // and the conversation's own background belongs to the surface control.
    const css = appearanceCss(values({ shellOpacity: 60, surfaceOpacity: 50, panelOpacity: 45 }))
    // The window: the document at 60%, and the frame around the content cleared.
    expect(css).toContain(':root:root body:not([data-ds-dark-theme]) {\n  background-color: color-mix(in srgb, var(--dsw-static-neutral-bluish-00) 60%, transparent);')
    expect(css).toContain(':root:root #root > * {')
    // The chrome follows the shell.
    expect(css).toContain('--dsw-specific-sidebar-fill: color-mix(in srgb, var(--dsw-static-neutral-bluish-50) 60%, transparent);')
    // The content surface follows its own control, at its own number.
    expect(css).toContain('--dsw-alias-bg-base: color-mix(in srgb, var(--dsw-static-neutral-bluish-00) 50%, transparent);')
    expect(css).toContain('--dsw-alias-bg-layer-1: color-mix(in srgb, var(--dsw-static-neutral-bluish-00) 50%, transparent);')
    expect(css).toContain('--dsw-alias-settings-card-fill: color-mix(in srgb, var(--dsw-static-neutral-bluish-00) 45%, transparent);')
    expect(css).toContain(':root:root body[data-ds-dark-theme]')
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

  it('keeps the settings dialog on the panel control, whatever Surface is set to', () => {
    // The reported defect: lowering Surface thinned the settings dialog's own cards, which
    // reads as the two controls being swapped. The dialog re-declares the layer tokens, and
    // the nearest ancestor that declares one is what its subtree inherits.
    const css = appearanceCss(values({ surfaceOpacity: 45, panelOpacity: 100 }))
    const dialog = css.slice(css.indexOf(":root:root body:not([data-ds-dark-theme]) [role='dialog']"))
    expect(dialog).toContain('--dsw-alias-bg-layer-2: color-mix(in srgb, var(--dsw-static-neutral-bluish-00) 100%, transparent);')
    expect(dialog).toContain('--dsw-alias-settings-card-fill:')
    // And the panel control moves the dialog, at its own number.
    const panel = appearanceCss(values({ panelOpacity: 45 }))
    expect(panel).toContain(":root:root body:not([data-ds-dark-theme]) [role='dialog']")
    expect(panel).toContain('--dsw-alias-bg-layer-2: color-mix(in srgb, var(--dsw-static-neutral-bluish-00) 45%, transparent);')
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
    // Not the app-wide content, and not the window: the only layer declarations here are
    // the dialog's own, which is what keeps the two controls from reading as swapped.
    const appWide = css.slice(0, css.indexOf("[role='dialog']"))
    expect(appWide).not.toContain('--dsw-alias-bg-layer-1:')
    expect(appWide).not.toContain('--dsw-alias-bg-base:')
  })

  it('reads a value the first build stored as a fraction', () => {
    // The field was 0.35-1 when the first version shipped; a profile written then still
    // holds the fraction, and the range accepts it so the stored value cannot stop the
    // row from starting.
    expect(opacityPercent(0.65)).toBe(65)
    expect(opacityPercent(1)).toBe(100)
    expect(opacityPercent(65)).toBe(65)
    const css = appearanceCss(values({ shellOpacity: 0.6, surfaceOpacity: 0.9 }))
    // The window's paint takes the shell's fraction, the content surface the other.
    expect(css).toContain('background-color: color-mix(in srgb, var(--dsw-static-neutral-bluish-00) 60%, transparent);')
    expect(css).toContain('--dsw-alias-bg-base: color-mix(in srgb, var(--dsw-static-neutral-bluish-00) 90%, transparent);')
    expect(css).toContain('--dsw-alias-bg-layer-1: color-mix(in srgb, var(--dsw-static-neutral-bluish-00) 90%, transparent);')
  })
})

describe('real transparency', () => {
  it('paints the window itself, and clears what would cover it', () => {
    // The dialog was the only thing that went translucent, because it is drawn from the
    // tokens this engine fades. The window is painted by the document - not by a token this
    // engine could fade without also fading the conversation - so the shell level paints it
    // and clears the frame around the content.
    const css = appearanceCss(values({ shellOpacity: 65 }))
    expect(css).toContain(':root:root {\n  background-color: transparent;\n}')
    expect(css).toContain('background-color: color-mix(in srgb, var(--dsw-static-neutral-bluish-00) 65%, transparent);')
    expect(css).toContain(':root:root #root,\n:root:root #root > * {\n  background-color: transparent;\n}')
    // Nothing of the content surface is faded by the shell on its own.
    expect(css).not.toContain('--dsw-alias-bg-base:')
  })

  it('paints the corner the content surface exposes, so it belongs to the shell', () => {
    // The content surface keeps its rounded corner. The frame above it is cleared, so the
    // corner shows the window's own paint - the shell's colour - and never the desktop.
    const glass = appearanceCss(values({ shellOpacity: 45 }))
    expect(glass).toContain(':root:root #root,\n:root:root #root > * {\n  background-color: transparent;\n}')
    expect(glass).toContain('background-color: color-mix(in srgb, var(--dsw-static-neutral-bluish-00) 45%, transparent);')
    // The shape itself is never changed.
    expect(glass).not.toContain('border-top-left-radius')
    expect(appearanceCss(values({ surfaceOpacity: 45 }))).not.toContain('border-top-left-radius')
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

  it('paints the caption band, which the page otherwise leaves bare', () => {
    // The OS draws the caption in that band and the page paints nothing there, so on a
    // translucent window it shows a strip of whatever sits behind the app across the top.
    // The page fills it in the application's own chrome colour, at the height the desktop
    // preload publishes - unset elsewhere, so no band is painted off Windows.
    const css = appearanceCss(values({}))
    expect(css).toContain('body::before {')
    expect(css).toContain('height: var(--dsh-windows-titlebar-height, 0px);')
    expect(css).toContain('background-color: var(--dsw-specific-sidebar-fill);')
    expect(css).toContain('pointer-events: none;')
  })

  it('leaves the window paint alone while the shell is solid', () => {
    const css = appearanceCss(values({ surfaceOpacity: 60 }))
    expect(css).not.toContain(':root:root #root > * {')
    // The document is pinned at the shell's opacity either way - full here - because the
    // content token paints the document too and a surface fade would otherwise take the
    // window with it.
    expect(css).toContain(':root:root body:not([data-ds-dark-theme]) {\n  background-color: color-mix(in srgb, var(--dsw-static-neutral-bluish-00) 100%, transparent);')
  })

  it('leaves the window shape to the platform', () => {
    // Windows rounds an ordinary window itself. A page arc on top of that shows the window's
    // material as a wedge inside the corner, so the page never clips the document.
    expect(appearanceCss(values({ radiusScale: 2.5, shellOpacity: 45 }))).not.toContain('clip-path')
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
    // Nothing chosen: the sheet holds the caption band and no token override.
    expect(doc.getElementById(APPEARANCE_STYLE_ID)?.textContent).toContain('body::before')
    expect(doc.getElementById(APPEARANCE_STYLE_ID)?.textContent).not.toContain('--dsw-font-family')

    live.set({ accent: '#7c5cff', shellOpacity: 65 })
    const sheet = doc.getElementById(APPEARANCE_STYLE_ID)
    expect(sheet?.textContent).toContain('--dsw-alias-state-business-primary: #7c5cff;')
    expect(sheet?.textContent).toContain('background-color: transparent;')

    // Back to the defaults: only the band is left, and no token is published again.
    live.set({})
    expect(doc.getElementById(APPEARANCE_STYLE_ID)?.textContent).not.toContain('--dsw-font-family')

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

describe('the wider choices', () => {
  it('sets the code font on the root and the body, where the code composites resolve it', () => {
    const css = appearanceCss(values({ codeFontFamily: '"Cascadia Code", Consolas' }))
    expect(css).toContain(':root:root, :root:root body, :root:root body[data-ds-dark-theme] {')
    expect(css).toContain('--ds-font-family-code: "Cascadia Code", Consolas;')
    expect(appearanceCss(values({ codeFontFamily: 'x; color: red' }))).not.toContain('--ds-font-family-code')
  })

  it('multiplies the message-text line height inside every base composite', () => {
    const css = appearanceCss(values({ lineHeight: 125 }))
    expect(css).toContain('--dsw-font-markdown-base-line-height: calc((24px + var(--dsh-content-font-delta)) * 1.25);')
    expect(css).toContain('--dsw-font-markdown-base-strong-italic: italic 600 var(--dsh-content-font-size, 14px) / calc((24px + var(--dsh-content-font-delta)) * 1.25) var(--dsw-font-family);')
  })

  it('tints links, bubbles, and the current row only when the accent is meant everywhere', () => {
    expect(appearanceCss(values({ accent: '#10b981' }))).not.toContain('--dsw-alias-link')
    const css = appearanceCss(values({ accent: '#10b981', accentEverywhere: true }))
    expect(css).toContain('--dsw-alias-link: #10b981;')
    expect(css).toContain('--dsw-specific-bubble: color-mix(in srgb, #10b981 16%, var(--dsw-alias-bg-layer-1));')
    // Without an accent there is nothing to spread.
    expect(appearanceCss(values({ accentEverywhere: true }))).not.toContain('--dsw-alias-link')
  })

  it('fixes the conversation width and hides the drag handles that would move it', () => {
    const css = appearanceCss(values({ contentWidth: 'wider' }))
    expect(css).toContain(':root:root [data-conversation-content] {\n  --dsh-chat-content-width: min(calc(100% - 32px)')
    expect(css).toContain(':root:root [data-width-handle] {\n  display: none;')
    expect(appearanceCss(values({ contentWidth: 'full' }))).toContain('--dsh-chat-content-width: calc(100% - 48px);')
    expect(appearanceCss(values())).not.toContain('[data-width-handle]')
  })

  it('widens the settings panel', () => {
    expect(appearanceCss(values({ settingsWidth: 'wide' }))).toContain("[data-shortcut-modal='settings'] {\n  width: 1040px;")
    expect(appearanceCss(values({ settingsWidth: 'wider' }))).toContain('width: 1320px;')
  })

  it('thins or hides the scrollbar on every element, since the theme re-binds it per surface', () => {
    const thin = appearanceCss(values({ scrollbars: 'thin' }))
    expect(thin).toContain(':root:root body * {\n  --dsh-scrollbar-width: 3px;')
    expect(thin).not.toContain('scrollbar-width: none;')
    expect(appearanceCss(values({ scrollbars: 'hidden' }))).toContain('scrollbar-width: none;')
  })

  it('changes the glass blur, and blurs a translucent dialog by the same radius', () => {
    expect(appearanceCss(values({ glassBlur: 12 }))).toContain('--dsw-menu-backdrop-filter: blur(12px) saturate(150%);')
    expect(appearanceCss(values())).not.toContain('--dsw-menu-backdrop-filter')
    expect(appearanceCss(values({ panelOpacity: 60, glassBlur: 20 }))).toContain("[role='dialog'] {\n  backdrop-filter: blur(20px) saturate(150%);")
  })

  it('removes or strengthens shadows on every element that re-declares elevation', () => {
    const none = appearanceCss(values({ shadows: 'none' }))
    expect(none).toContain('--dsw-shadow-lv2: none;')
    expect(none).toContain(':root:root body, :root:root body * {\n  --dsw-elevation-panel: var(--dsw-elevation-stroke);')
    expect(appearanceCss(values({ shadows: 'strong' }))).toContain('--dsw-elevation-prominent: var(--dsw-elevation-stroke), 0 10px 28px')
  })

  it('paints a named backdrop, or a usable image, on the document', () => {
    const aurora = appearanceCss(values({ backdrop: 'aurora', shellOpacity: 80, surfaceOpacity: 80 }))
    expect(aurora).toContain('background-image: radial-gradient(')
    expect(aurora).toContain('background-attachment: fixed;')
    const image = appearanceCss(values({ backdrop: 'image', backdropImage: 'https://example.com/w.jpg' }))
    expect(image).toContain('background-image: url("https://example.com/w.jpg");')
    // An address that could break out of the url() paints nothing.
    expect(appearanceCss(values({ backdrop: 'image', backdropImage: 'https://x/a.jpg") ; color: red' }))).not.toContain('background-image')
    expect(appearanceCss(values({ backdrop: 'image', backdropImage: '' }))).not.toContain('background-image')
  })

  it('accepts only https, http, and inline image addresses', () => {
    expect(usableImageUrl('https://example.com/a.png')).toBe(true)
    expect(usableImageUrl('data:image/png;base64,AAAA')).toBe(true)
    expect(usableImageUrl('javascript:alert(1)')).toBe(false)
    expect(usableImageUrl('file:///C:/a.png')).toBe(false)
  })

  it('cuts animations and transitions to an instant', () => {
    const css = appearanceCss(values({ reduceMotion: true }))
    expect(css).toContain('animation-duration: 0.01ms !important;')
    expect(css).toContain('transition-duration: 0.01ms !important;')
  })
})
