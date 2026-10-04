/**
 * The appearance engine: turn one row's values into the token overrides the page
 * wears, and keep them in step with the row.
 *
 * Two rules shape this file. The overrides are `:root:root`-scoped, because the
 * theme declares its tokens on the root element *and* on the themed body, and a
 * custom property is inherited from the nearest ancestor that sets it — a plain
 * `:root` rule would lose to `body[data-ds-dark-theme]` for everything inside the
 * body. And nothing here invents a colour: an opacity is expressed as
 * `color-mix` over the very token the theme uses for that role, so both palettes
 * keep working and an upstream palette change arrives without a second edit here.
 *
 * @module @deepseek-ai/dsh-client-ui-personalization/appearance
 */

import type { ConfigForm, ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'

/**
 * The appearance values the page wears.
 *
 * Plain, not the schema's inference: this is the resolved shape the engine and the
 * section both read, and the row's own `Config` is the declaration that produces it.
 */
export interface AppearanceValues {
  /** A CSS font stack, or empty for the theme's own. */
  fontFamily: string
  /** Root font size as a percentage of the browser default. */
  fontScale: number
  /** An accent colour value, or empty for the theme's own. */
  accent: string
  /** Multiplier for every corner radius step. */
  radiusScale: number
  /** Shell opacity in percent; 100 is solid. */
  shellOpacity: number
  /** Surface opacity in percent; 100 is solid. */
  surfaceOpacity: number
}

/** The style element the overrides live in, so a remount replaces only its own. */
export const APPEARANCE_STYLE_ID = 'dsh-personalization'

/** The values a deployment gets before it chooses anything. */
export const APPEARANCE_DEFAULTS: AppearanceValues = {
  fontFamily: '',
  fontScale: 100,
  accent: '',
  radiusScale: 1,
  shellOpacity: 100,
  surfaceOpacity: 100,
}

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
 * The light and dark expression of one token, as the theme composes it.
 *
 * A translucent surface has to name the colour it fades, and the theme's palette
 * tokens are the only honest source: they are what the opaque value resolved to, so
 * fading one keeps the hue and the palette's own step.
 */
const PALETTE_FILLS: Readonly<Record<string, { light: string; dark: string }>> = {
  // The shell: the canvas behind everything and the sidebar's own fill.
  '--dsw-alias-bg-base': { light: 'var(--dsw-static-neutral-bluish-00)', dark: 'var(--dsw-static-neutral-bluish-950)' },
  '--dsw-specific-sidebar-fill': { light: 'var(--dsw-static-neutral-bluish-50)', dark: 'var(--dsw-static-neutral-bluish-900)' },
  '--dsw-specific-sidebar-nav-item-hover': { light: 'var(--dsw-static-neutral-bluish-75)', dark: 'var(--dsw-static-neutral-bluish-850)' },
  '--dsw-specific-sidebar-nav-item-active': { light: 'var(--dsw-static-neutral-bluish-100)', dark: 'var(--dsw-static-neutral-bluish-750)' },
  // The surfaces inside it.
  '--dsw-alias-bg-layer-1': { light: 'var(--dsw-static-neutral-bluish-00)', dark: 'var(--dsw-static-neutral-bluish-950)' },
  '--dsw-alias-bg-layer-2': { light: 'var(--dsw-static-neutral-bluish-00)', dark: 'var(--dsw-static-neutral-bluish-950)' },
  '--dsw-alias-bg-layer-3': { light: 'var(--dsw-static-neutral-bluish-00)', dark: 'var(--dsw-static-neutral-bluish-950)' },
  '--dsw-alias-bg-overlay': { light: 'var(--dsw-static-neutral-bluish-150)', dark: 'var(--dsw-static-neutral-bluish-900)' },
  '--dsw-alias-bg-module-platform': { light: 'var(--dsw-static-neutral-bluish-60)', dark: 'var(--dsw-static-neutral-bluish-925)' },
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

/**
 * One opacity as a percentage.
 *
 * The field was a fraction (0.35–1) in the first build and is a percentage now, and a
 * profile written by that build still holds the fraction — which the range now accepts
 * so a stored value cannot stop the row from starting. Reading both here is what makes
 * the change a migration rather than a break: the page shows the percentage, the next
 * write stores one, and the value means the same thing either way.
 * @param value - the stored opacity.
 * @returns the opacity as a percentage.
 */
export function opacityPercent(value: number): number {
  return value <= 1 ? value * 100 : value
}

/** A percentage with no trailing noise, for a `color-mix` weight. */
function percent(fraction: number): string {
  return `${String(Math.round(fraction * 1000) / 10)}%`
}

/** Whether a font stack is safe to place in a declaration unquoted. */
function usableFontStack(value: string): boolean {
  const stack = value.trim()
  // A stack is names and generic families: letters, spaces, commas, quotes, hyphens.
  return stack.length > 0 && /^[\w\s,'"-]+$/u.test(stack) && !stack.includes(';') && !stack.includes('/*')
}

/** Whether an accent value is a plausible CSS colour rather than a declaration. */
function usableColour(value: string): boolean {
  const colour = value.trim()
  return colour.length > 0 && /^[\w\s(),.%#/-]+$/u.test(colour) && !colour.includes(';') && !colour.includes('/*')
}

/**
 * The stylesheet one set of values produces.
 *
 * Empty means the deployment default for that field, so a page that chose nothing
 * gets an empty string and no style element at all.
 * @param values - the row's resolved values.
 * @returns the CSS text, or an empty string when every value is the default.
 */
export function appearanceCss(values: AppearanceValues): string {
  const base: string[] = []
  const light: string[] = []
  const dark: string[] = []

  if (!isDefault(values, 'fontFamily') && usableFontStack(values.fontFamily)) {
    base.push(`  --dsw-font-family: ${values.fontFamily.trim()};`)
  }
  if (!isDefault(values, 'radiusScale')) {
    const scale = values.radiusScale
    for (const [token, step] of Object.entries(RADIUS_STEPS)) {
      base.push(`  ${token}: ${String(Math.round(step * scale * 100) / 100)}px;`)
    }
  }
  if (!isDefault(values, 'accent') && usableColour(values.accent)) {
    const accent = values.accent.trim()
    base.push(`  --dsw-alias-state-business-primary: ${accent};`)
    base.push(`  --dsw-alias-state-business-tertiary: color-mix(in srgb, ${accent} 18%, transparent);`)
    base.push(`  --dsw-alias-interactive-bg-hover-accent: color-mix(in srgb, ${accent} 16%, transparent);`)
  }
  // The shell and the surfaces fade the same tokens by different amounts, so one
  // value can make the frame translucent while the cards inside it stay readable.
  for (const [token, palette] of Object.entries(PALETTE_FILLS)) {
    const shell = token.startsWith('--dsw-alias-bg-base') || token.startsWith('--dsw-specific-sidebar')
    const opacity = opacityPercent(shell ? values.shellOpacity : values.surfaceOpacity)
    if (opacity >= 100) continue
    const weight = percent(opacity / 100)
    light.push(`  ${token}: color-mix(in srgb, ${palette.light} ${weight}, transparent);`)
    dark.push(`  ${token}: color-mix(in srgb, ${palette.dark} ${weight}, transparent);`)
  }

  const fadesDocument = opacityPercent(values.shellOpacity) < 100
  if (base.length === 0 && light.length === 0 && dark.length === 0 && isDefault(values, 'fontScale') && !fadesDocument) {
    return ''
  }

  const blocks: string[] = []
  const scopes = ':root:root, :root:root body, :root:root body[data-ds-dark-theme]'
  const core = [...base]
  if (!isDefault(values, 'fontScale')) core.push(`  font-size: ${String(values.fontScale)}%;`)
  if (core.length > 0) blocks.push(`${scopes} {\n${core.join('\n')}\n}`)
  // A faded shell is only *transparent* if the document itself stops painting. The
  // desktop window is created transparent over its material (acrylic on Windows, a
  // vibrancy layer on macOS), so with the page's own background gone the desktop
  // behind the window is what shows through — which is the whole point of the
  // setting, and the one piece a token override cannot reach on its own.
  if (opacityPercent(values.shellOpacity) < 100) {
    blocks.push(':root:root, :root:root body {\n  background-color: transparent;\n}')
  }
  if (light.length > 0) {
    blocks.push(`:root:root body:not([data-ds-dark-theme]) {\n${light.join('\n')}\n}`)
  }
  if (dark.length > 0) {
    blocks.push(`:root:root body[data-ds-dark-theme] {\n${dark.join('\n')}\n}`)
  }
  return `${blocks.join('\n\n')}\n`
}

/**
 * Keep the page in step with one row's values.
 *
 * @param form - the live config form over the personalization row.
 * @param doc - the document to write into, injected so a spec can drive a stand-in.
 * @returns the disposer that removes the sheet and the subscription.
 */
export function installAppearance(form: ConfigForm<Partial<AppearanceValues>>, doc: Document): () => void {
  const read = (): AppearanceValues => ({ ...APPEARANCE_DEFAULTS, ...form.getSnapshot().value })

  const sheet = doc.createElement('style')
  sheet.id = APPEARANCE_STYLE_ID

  const paint = (values: AppearanceValues): void => {
    const css = appearanceCss(values)
    if (css.length === 0) {
      sheet.remove()
      return
    }
    sheet.textContent = css
    if (sheet.parentNode === null) doc.head.append(sheet)
  }

  paint(read())
  const unsubscribe = form.subscribe(() => { paint(read()) })
  return () => {
    unsubscribe()
    sheet.remove()
  }
}

/** Re-exported so a caller can type a snapshot without reaching into the settings package. */
export type { ConfigFormSnapshot }
