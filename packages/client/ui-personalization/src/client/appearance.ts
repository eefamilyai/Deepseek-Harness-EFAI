/**
 * The appearance engine: turn one row's values into the token overrides the page
 * wears, and keep them in step with the row.
 *
 * Two rules shape this file. The overrides are `:root:root`-scoped, because the
 * theme declares its tokens on the root element *and* on the themed body, and a
 * custom property is inherited from the nearest ancestor that sets it — a plain
 * `:root` rule would lose to `body[data-ds-dark-theme]` for everything inside the
 * body. And nothing here invents a palette colour: an opacity is expressed as
 * `color-mix` over the very token the theme uses for that role, so both palettes
 * keep working and an upstream palette change arrives without a second edit here.
 * The backdrop gradients are the one exception, because they replace the desktop
 * behind the window rather than recolour a theme role.
 *
 * @module @deepseek-ai/dsh-client-ui-personalization/appearance
 */

import {
  APPEARANCE_DEFAULTS, type AppearanceValues, type Backdrop, type ContentWidth, type SettingsWidth, type ShadowStrength,
} from '../options.ts'
import type { AppearanceSource } from './appearance-store.ts'

export { APPEARANCE_DEFAULTS, type AppearanceValues } from '../options.ts'

/** The style element the overrides live in, so a remount replaces only its own. */
export const APPEARANCE_STYLE_ID = 'dsh-personalization'

/** The radius steps the scale multiplies, with the theme's own values. */
const RADIUS_STEPS: Readonly<Record<string, number>> = {
  '--dsw-radius-xs': 4,
  '--dsw-radius-sm': 8,
  '--dsw-radius-md': 12,
  '--dsw-radius-lg': 16,
  '--dsw-radius-xl': 20,
  '--dsw-radius-panel': 28,
}

/**
 * The light and dark expression of one opaque fill, as the theme composes it.
 *
 * A translucent window has to name the colour it fades, and the theme's palette
 * tokens are the only honest source: they are what the opaque value resolved to, so
 * fading one keeps the hue and the palette's own step. `level` names the one control
 * that owns the token: the three are independent, because a panel inside a glass window
 * is still its own surface.
 */
const PALETTE_FILLS: Readonly<Record<string, { light: string; dark: string; level: 'shell' | 'surface' | 'panel' }>> = {
  // The chrome around the content: the sidebar.
  '--dsw-specific-sidebar-fill': { light: 'var(--dsw-static-neutral-bluish-50)', dark: 'var(--dsw-static-neutral-bluish-900)', level: 'shell' },
  '--dsw-specific-sidebar-nav-item-hover': { light: 'var(--dsw-static-neutral-bluish-75)', dark: 'var(--dsw-static-neutral-bluish-850)', level: 'shell' },
  '--dsw-specific-sidebar-nav-item-active': { light: 'var(--dsw-static-neutral-bluish-100)', dark: 'var(--dsw-static-neutral-bluish-750)', level: 'shell' },
  // The content surface and everything on it: the conversation's own background, its
  // cards, bubbles, pills, and inputs. `--dsw-alias-bg-base` paints the conversation area
  // as well as the document, which is why the shell level pins the document directly
  // instead of fading this token.
  '--dsw-alias-bg-base': { light: 'var(--dsw-static-neutral-bluish-00)', dark: 'var(--dsw-static-neutral-bluish-950)', level: 'surface' },
  '--dsw-alias-bg-layer-1': { light: 'var(--dsw-static-neutral-bluish-00)', dark: 'var(--dsw-static-neutral-bluish-950)', level: 'surface' },
  '--dsw-alias-bg-layer-2': { light: 'var(--dsw-static-neutral-bluish-00)', dark: 'var(--dsw-static-neutral-bluish-950)', level: 'surface' },
  '--dsw-alias-bg-layer-3': { light: 'var(--dsw-static-neutral-bluish-00)', dark: 'var(--dsw-static-neutral-bluish-950)', level: 'surface' },
  '--dsw-alias-bg-module-platform': { light: 'var(--dsw-static-neutral-bluish-60)', dark: 'var(--dsw-static-neutral-bluish-925)', level: 'surface' },
  // What floats above the window. `--dsw-alias-settings-card-fill` is the theme's own name
  // for the settings dialog's surface (an alias of layer 2, declared on `body`), and
  // overriding that alias is what separates the dialog from everything else drawn from the
  // same layer.
  '--dsw-alias-settings-card-fill': { light: 'var(--dsw-static-neutral-bluish-00)', dark: 'var(--dsw-static-neutral-bluish-950)', level: 'panel' },
  '--dsw-alias-bg-overlay': { light: 'var(--dsw-static-neutral-bluish-150)', dark: 'var(--dsw-static-neutral-bluish-900)', level: 'panel' },
}

/**
 * The conversation column each wider choice declares. The theme's own width is
 * `clamp(680px, column * 0.64, 920px)`; every choice stays inside the column it is
 * drawn in, so a narrow window keeps its margins.
 */
const CONTENT_WIDTH_VALUES: Readonly<Record<Exclude<ContentWidth, 'default'>, string>> = {
  wide: 'min(calc(100% - 32px), clamp(720px, calc(var(--dsh-conversation-column-width, 0px) * 0.8), 1180px))',
  wider: 'min(calc(100% - 32px), clamp(760px, calc(var(--dsh-conversation-column-width, 0px) * 0.9), 1560px))',
  full: 'calc(100% - 48px)',
}

/** The settings panel width each wider choice declares; the theme's own panel is 800px. */
const SETTINGS_WIDTH_VALUES: Readonly<Record<Exclude<SettingsWidth, 'default'>, string>> = {
  wide: '1040px',
  wider: '1320px',
}

/** The scrollbar width each non-default presentation declares; the theme's own is 5px. */
const SCROLLBAR_WIDTHS: Readonly<Record<'thin' | 'hidden', string>> = {
  thin: '3px',
  hidden: '0px',
}

/**
 * The gradients a named backdrop paints behind the window. They are fixed to the
 * viewport, so scrolling content slides over a still backdrop.
 */
export const BACKDROP_GRADIENTS: Readonly<Record<Exclude<Backdrop, 'none' | 'image'>, string>> = {
  aurora: 'radial-gradient(at 12% 18%, #7c5cff 0, transparent 55%), radial-gradient(at 88% 12%, #22d3ee 0, transparent 50%), radial-gradient(at 62% 92%, #10b981 0, transparent 55%), linear-gradient(135deg, #1e1b4b, #0f172a)',
  sunset: 'linear-gradient(135deg, #ff7e5f 0%, #feb47b 42%, #6a3093 100%)',
  ocean: 'linear-gradient(160deg, #0f2027 0%, #203a43 48%, #2c5364 100%)',
  forest: 'linear-gradient(150deg, #134e5e 0%, #71b280 100%)',
  grape: 'linear-gradient(135deg, #41295a 0%, #2f0743 100%)',
  peach: 'linear-gradient(135deg, #ffecd2 0%, #fcb69f 100%)',
  graphite: 'linear-gradient(160deg, #232526 0%, #414345 100%)',
}

/** The shadow tokens each non-default strength declares. */
const SHADOW_VALUES: Readonly<Record<Exclude<ShadowStrength, 'default'>, { readonly shadows: readonly string[]; readonly elevation: readonly string[] }>> = {
  none: {
    shadows: ['--dsw-shadow-lv1: none;', '--dsw-shadow-lv1-blur: none;', '--dsw-shadow-lv2: none;', '--dsw-shadow-lv3: none;'],
    elevation: [
      '--dsw-elevation-panel: var(--dsw-elevation-stroke);',
      '--dsw-elevation-prominent: var(--dsw-elevation-stroke);',
      '--dsw-elevation-soft: var(--dsw-elevation-stroke);',
    ],
  },
  strong: {
    shadows: [
      '--dsw-shadow-lv1: 0 2px 6px 0 rgba(0, 0, 0, 0.12);',
      '--dsw-shadow-lv1-blur: 0 6px 18px 0 rgba(0, 0, 0, 0.10);',
      '--dsw-shadow-lv2: 0 8px 24px 0 rgba(0, 0, 0, 0.12), 0 2px 8px 0 rgba(0, 0, 0, 0.10);',
      '--dsw-shadow-lv3: 0 0 1px 0 rgba(0, 0, 0, 0.3), 0 4px 12px 0 rgba(0, 0, 0, 0.08), 0 20px 48px 0 rgba(0, 0, 0, 0.22);',
    ],
    elevation: [
      '--dsw-elevation-panel: var(--dsw-elevation-stroke), 0 6px 18px 0 rgba(0, 0, 0, 0.10), 0 0 28px 0 rgba(0, 0, 0, 0.08);',
      '--dsw-elevation-prominent: var(--dsw-elevation-stroke), 0 10px 28px 0 rgba(0, 0, 0, 0.16), 0 0 40px 0 rgba(0, 0, 0, 0.12);',
      '--dsw-elevation-soft: var(--dsw-elevation-stroke), 0 8px 28px 0 rgba(0, 0, 0, 0.10), 0 0 36px 0 rgba(0, 0, 0, 0.08);',
    ],
  },
}

/**
 * One opacity as a percentage.
 *
 * The field was a fraction (0.35–1) in the first build and is a percentage now, and a
 * profile written by that build still holds the fraction — which the range accepts so
 * that a stored value cannot stop the row from starting. Reading both here makes the
 * change a migration rather than a break: the page shows the percentage, the next
 * write stores one, and the value means the same thing either way.
 * @param value - the stored opacity.
 * @returns the opacity as a percentage.
 */
export function opacityPercent(value: number): number {
  return value <= 1 ? value * 100 : value
}

/**
 * Whether one value is still the deployment default, so its rule can be omitted.
 * @param values - the row's resolved values.
 * @param key - the field to test.
 * @returns whether the field holds its default.
 */
function isDefault(values: AppearanceValues, key: keyof AppearanceValues): boolean {
  return values[key] === APPEARANCE_DEFAULTS[key]
}

/** A percentage with no trailing noise, for a `color-mix` weight. */
function percent(fraction: number): string {
  return `${String(Math.round(fraction * 1000) / 10)}%`
}

/** A number with at most three decimals, for a CSS multiplier. */
function factor(value: number): string {
  return String(Math.round(value * 1000) / 1000)
}

/**
 * Whether a font stack is safe to place in a declaration unquoted.
 * @param value - the stack as written.
 * @returns whether it holds only names, generic families, quotes, commas, and hyphens.
 */
export function usableFontStack(value: string): boolean {
  const stack = value.trim()
  return stack.length > 0 && /^[\w\s,'"-]+$/u.test(stack) && !stack.includes(';') && !stack.includes('/*')
}

/**
 * Whether an accent value is a plausible CSS colour rather than a declaration.
 * @param value - the colour as written.
 * @returns whether it can be placed in a declaration.
 */
export function usableColour(value: string): boolean {
  const colour = value.trim()
  return colour.length > 0 && /^[\w\s(),.%#/-]+$/u.test(colour) && !colour.includes(';') && !colour.includes('/*')
}

/**
 * Whether a backdrop image address can be placed in a quoted `url()`.
 * @param value - the address as written.
 * @returns whether it is an `https:`, `http:`, or `data:image/` URL with no quote, parenthesis, backslash, or space,
 *   which are the characters that could end the quoted `url()` it is placed in.
 */
export function usableImageUrl(value: string): boolean {
  const url = value.trim()
  return /^(?:https?:\/\/|data:image\/)[^\s"'()\\]+$/u.test(url)
}

/** The theme's message-text composites, re-declared with the line spacing multiplied. */
function lineHeightDeclarations(scale: number): string[] {
  const line = `calc((24px + var(--dsh-content-font-delta)) * ${factor(scale)})`
  const size = 'var(--dsh-content-font-size, 14px)'
  return [
    `  --dsw-font-markdown-base: ${size} / ${line} var(--dsw-font-family);`,
    `  --dsw-font-markdown-base-line-height: ${line};`,
    `  --dsw-font-markdown-base-strong: 600 ${size} / ${line} var(--dsw-font-family);`,
    `  --dsw-font-markdown-base-strong-line-height: ${line};`,
    `  --dsw-font-markdown-base-italic: italic ${size} / ${line} var(--dsw-font-family);`,
    `  --dsw-font-markdown-base-italic-line-height: ${line};`,
    `  --dsw-font-markdown-base-strong-italic: italic 600 ${size} / ${line} var(--dsw-font-family);`,
    `  --dsw-font-markdown-base-strong-italic-line-height: ${line};`,
  ]
}

/** The accent tints `accentEverywhere` adds beyond selection and focus. */
function accentEverywhereDeclarations(accent: string): string[] {
  return [
    `  --dsw-alias-link: ${accent};`,
    `  --dsw-specific-bubble: color-mix(in srgb, ${accent} 16%, var(--dsw-alias-bg-layer-1));`,
    `  --dsw-specific-bubble-highlight: color-mix(in srgb, ${accent} 30%, var(--dsw-alias-bg-layer-1));`,
    `  --dsw-specific-sidebar-nav-item-active-accent: color-mix(in srgb, ${accent} 22%, transparent);`,
  ]
}

/**
 * The stylesheet one set of values produces.
 *
 * Every field at its default contributes nothing but the caption band, so a page that
 * chose nothing wears the theme exactly.
 * @param values - the row's resolved values.
 * @returns the CSS text.
 */
export function appearanceCss(values: AppearanceValues): string {
  const base: string[] = []
  const bodyOnly: string[] = []
  const light: string[] = []
  const dark: string[] = []
  // The caption band is unconditional: it restores the fill the OS caption already paints on
  // the desktop, and is inert wherever the desktop publishes no caption height.
  const band = [
    ':root:root body::before {',
    "  content: '';",
    '  position: fixed;',
    '  inset: 0 0 auto 0;',
    '  height: var(--dsh-windows-titlebar-height, 0px);',
    '  background-color: var(--dsw-specific-sidebar-fill);',
    '  pointer-events: none;',
    '  z-index: 2147483647;',
    '}',
  ].join('\n')

  if (!isDefault(values, 'fontFamily') && usableFontStack(values.fontFamily)) {
    base.push(`  --dsw-font-family: ${values.fontFamily.trim()};`)
  }
  if (!isDefault(values, 'codeFontFamily') && usableFontStack(values.codeFontFamily)) {
    base.push(`  --ds-font-family-code: ${values.codeFontFamily.trim()};`)
  }
  if (!isDefault(values, 'radiusScale')) {
    const scale = values.radiusScale
    for (const [token, step] of Object.entries(RADIUS_STEPS)) {
      base.push(`  ${token}: ${String(Math.round(step * scale * 100) / 100)}px;`)
    }
  }
  const accentSet = !isDefault(values, 'accent') && usableColour(values.accent)
  if (accentSet) {
    const accent = values.accent.trim()
    base.push(`  --dsw-alias-state-business-primary: ${accent};`)
    base.push(`  --dsw-alias-state-business-tertiary: color-mix(in srgb, ${accent} 18%, transparent);`)
    base.push(`  --dsw-alias-interactive-bg-hover-accent: color-mix(in srgb, ${accent} 16%, transparent);`)
    if (values.accentEverywhere) bodyOnly.push(...accentEverywhereDeclarations(accent))
  }
  if (!isDefault(values, 'lineHeight')) bodyOnly.push(...lineHeightDeclarations(values.lineHeight / 100))
  if (!isDefault(values, 'glassBlur')) {
    bodyOnly.push(`  --dsw-menu-backdrop-filter: blur(${String(Math.round(values.glassBlur))}px) saturate(150%);`)
  }
  if (values.shadows !== 'default') bodyOnly.push(...SHADOW_VALUES[values.shadows].shadows.map(line => `  ${line}`))
  if (values.scrollbars !== 'default') bodyOnly.push(`  --dsh-scrollbar-width: ${SCROLLBAR_WIDTHS[values.scrollbars]};`)

  const shellFactor = opacityPercent(values.shellOpacity) / 100
  const surfaceFactor = opacityPercent(values.surfaceOpacity) / 100
  const panelFactor = opacityPercent(values.panelOpacity) / 100
  /**
   * The declarations for one level.
   * @param levels - which entries to emit.
   * @param fade - the opacity to fade them by.
   * @param palette - which palette's expression of each token to use.
   * @param emitWhenSolid - keep the declarations at 100%, so a scope can override an
   * inherited value with a solid fill instead of leaving it to the ancestor.
   * @returns one CSS declaration per token.
   */
  const fills = (
    levels: readonly ('shell' | 'surface' | 'panel')[],
    fade: number,
    palette: 'light' | 'dark',
    emitWhenSolid = false,
  ): string[] => {
    if (fade >= 1 && !emitWhenSolid) return []
    const weight = percent(fade)
    const lines: string[] = []
    for (const [token, fill] of Object.entries(PALETTE_FILLS)) {
      if (!levels.includes(fill.level)) continue
      lines.push(`  ${token}: color-mix(in srgb, ${palette === 'light' ? fill.light : fill.dark} ${weight}, transparent);`)
    }
    return lines
  }

  light.push(...fills(['shell'], shellFactor, 'light'), ...fills(['surface'], surfaceFactor, 'light'),
    ...fills(['panel'], panelFactor, 'light'))
  dark.push(...fills(['shell'], shellFactor, 'dark'), ...fills(['surface'], surfaceFactor, 'dark'),
    ...fills(['panel'], panelFactor, 'dark'))

  const blocks: string[] = []
  const scopes = ':root:root, :root:root body, :root:root body[data-ds-dark-theme]'
  const core = [...base]
  if (!isDefault(values, 'fontScale')) core.push(`  font-size: ${String(values.fontScale)}%;`)
  if (core.length > 0) blocks.push(`${scopes} {\n${core.join('\n')}\n}`)
  // Tokens the theme declares on `body` itself: a declaration on the root alone would be
  // shadowed by the body's own, which is the nearest ancestor every element inherits from.
  if (bodyOnly.length > 0) blocks.push(`:root:root body, :root:root body[data-ds-dark-theme] {\n${bodyOnly.join('\n')}\n}`)
  if (light.length > 0) {
    blocks.push(`:root:root body:not([data-ds-dark-theme]) {\n${light.join('\n')}\n}`)
  }
  if (dark.length > 0) {
    blocks.push(`:root:root body[data-ds-dark-theme] {\n${dark.join('\n')}\n}`)
  }
  // The theme re-declares elevation and the scrollbar width on every element, so a value
  // set on `body` alone would stop at the first child; these follow it down.
  if (values.shadows !== 'default') {
    blocks.push(`:root:root body, :root:root body * {\n${SHADOW_VALUES[values.shadows].elevation.map(line => `  ${line}`).join('\n')}\n}`)
  }
  if (values.scrollbars !== 'default') {
    const width = SCROLLBAR_WIDTHS[values.scrollbars]
    blocks.push([
      ':root:root body * {',
      `  --dsh-scrollbar-width: ${width};`,
      '}',
      ...values.scrollbars === 'hidden' ? [':root:root body, :root:root body * {', '  scrollbar-width: none;', '}'] : [],
    ].join('\n'))
  }
  // The settings dialog and everything inside it are the settings-panel control's, not the
  // surface control's: the layer tokens are re-declared on the dialog itself, and the
  // nearest ancestor that declares a custom property is the one its whole subtree inherits.
  // Without this, lowering Surface thinned the dialog's own cards - which reads as the two
  // controls being swapped.
  const dialogLevels = ['surface', 'panel'] as const
  // Emitted whenever either control is faded, and always at a solid weight when the panel
  // is at 100%: the dialog has to re-declare the tokens to escape the surface fade it
  // would otherwise inherit.
  const scopesDialog = panelFactor < 1 || surfaceFactor < 1
  const dialogLight = scopesDialog ? fills(dialogLevels, panelFactor, 'light', true) : []
  const dialogDark = scopesDialog ? fills(dialogLevels, panelFactor, 'dark', true) : []
  if (dialogLight.length > 0) {
    blocks.push(`:root:root body:not([data-ds-dark-theme]) [role='dialog'] {\n${dialogLight.join('\n')}\n}`)
  }
  if (dialogDark.length > 0) {
    blocks.push(`:root:root body[data-ds-dark-theme] [role='dialog'] {\n${dialogDark.join('\n')}\n}`)
  }
  // A translucent dialog blurs what it floats over by the glass radius, as a menu does.
  if (panelFactor < 1) {
    blocks.push(`:root:root [role='dialog'] {\n  backdrop-filter: blur(${String(Math.round(values.glassBlur))}px) saturate(150%);\n}`)
  }
  // The window itself, including the region the content surface's rounded corner exposes:
  // the frame around the surface is cleared, so that corner shows this paint - the shell's
  // own colour - rather than the desktop, and the corner reads as part of the shell. The
  // document is painted at the shell's opacity rather than cleared,
  // so a partly transparent shell reads as a translucent window over whatever the platform
  // composites behind it, and the frame around the content is cleared so nothing of the
  // shell paints over the surface inside it. The document is pinned here whenever either
  // control is faded, because the content token paints the document too.
  if (shellFactor < 1 || surfaceFactor < 1) {
    const weight = percent(shellFactor)
    blocks.push([
      ':root:root {',
      '  background-color: transparent;',
      '}',
      ':root:root body:not([data-ds-dark-theme]) {',
      `  background-color: color-mix(in srgb, var(--dsw-static-neutral-bluish-00) ${weight}, transparent);`,
      '}',
      ':root:root body[data-ds-dark-theme] {',
      `  background-color: color-mix(in srgb, var(--dsw-static-neutral-bluish-950) ${weight}, transparent);`,
      '}',
    ].join('\n'))
  }
  if (shellFactor < 1) {
    blocks.push([
      ':root:root #root,',
      ':root:root #root > * {',
      '  background-color: transparent;',
      '}',
    ].join('\n'))
  }
  // The content level: the conversation's scroller and the composer, whose own paint is
  // what a card or a panel is seen against. The shell leaves these alone: a surface inside
  // the window belongs to the surface control.
  if (surfaceFactor < 1) {
    blocks.push([
      ':root:root [data-conversation-content],',
      ':root:root [data-chat-flow],',
      ':root:root [data-composer-seat] {',
      '  background-color: transparent;',
      '}',
    ].join('\n'))
  }
  // The backdrop replaces what the translucent layers show: it paints the document
  // itself, so it is seen exactly where the shell and the surfaces let it through.
  const backdrop = backdropImage(values)
  if (backdrop !== undefined) {
    blocks.push([
      ':root:root body, :root:root body[data-ds-dark-theme] {',
      `  background-image: ${backdrop};`,
      '  background-size: cover;',
      '  background-position: center;',
      '  background-repeat: no-repeat;',
      '  background-attachment: fixed;',
      '}',
    ].join('\n'))
  }
  // A fixed conversation width owns the column outright, so the drag handles that would
  // otherwise move it are hidden while one is chosen.
  if (values.contentWidth !== 'default') {
    blocks.push([
      ':root:root [data-conversation-content] {',
      `  --dsh-chat-content-width: ${CONTENT_WIDTH_VALUES[values.contentWidth]};`,
      '}',
      ':root:root [data-width-handle] {',
      '  display: none;',
      '}',
    ].join('\n'))
  }
  if (values.settingsWidth !== 'default') {
    blocks.push(`:root:root [data-shortcut-modal='settings'] {\n  width: ${SETTINGS_WIDTH_VALUES[values.settingsWidth]};\n}`)
  }
  if (values.reduceMotion) {
    blocks.push([
      ':root:root *, :root:root *::before, :root:root *::after {',
      '  animation-duration: 0.01ms !important;',
      '  animation-delay: 0ms !important;',
      '  transition-duration: 0.01ms !important;',
      '  transition-delay: 0ms !important;',
      '  scroll-behavior: auto !important;',
      '}',
    ].join('\n'))
  }
  return blocks.length === 0 ? `${band}\n` : `${band}\n\n${blocks.join('\n\n')}\n`
}

/**
 * The `background-image` value a backdrop choice paints.
 * @param values - the row's resolved values.
 * @returns the CSS value, or undefined when the desktop shows through or the image address is unusable.
 */
function backdropImage(values: AppearanceValues): string | undefined {
  switch (values.backdrop) {
    case 'none': return undefined
    case 'image': return usableImageUrl(values.backdropImage) ? `url("${values.backdropImage.trim()}")` : undefined
    default: return BACKDROP_GRADIENTS[values.backdrop]
  }
}

/**
 * Keep the page in step with the live values.
 *
 * @param source - the appearance policy: current values and an invalidation callback.
 * @param doc - the document to write into, injected so a spec can drive a stand-in.
 * @returns the disposer that removes the sheet and the subscription.
 */
export function installAppearance(source: AppearanceSource, doc: Document): () => void {
  const sheet = doc.createElement('style')
  sheet.id = APPEARANCE_STYLE_ID

  const paint = (): void => {
    sheet.textContent = appearanceCss(source.values())
    if (sheet.parentNode === null) doc.head.append(sheet)
  }

  paint()
  const unsubscribe = source.subscribe(paint)
  return () => {
    unsubscribe()
    sheet.remove()
  }
}
