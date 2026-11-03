/**
 * The flow-accent palette: one hue per compact row family, so a scrolled
 * transcript indexes by colour.
 *
 * Two layers, both supplied here. The saturated steps (`--dsw-static-flow-*`)
 * are absolute colours and therefore identical in both palettes; they live in
 * this package's own namespace so no alias layer here repaints a design-system
 * token something else also reads. The aliases (`--dsw-alias-flow-*`) pick a
 * step per palette: the bright step on the dark surface, the deep step on the
 * light one, where a bright value cannot carry 13px text.
 *
 * Hues are spaced in OKLCH, where equal steps look equally far apart, at one
 * perceived lightness per palette, so no family shouts louder than the rest.
 * Every value clears 4.5:1 against `--dsw-alias-bg-base` in its palette — the
 * measured ratios are 8.0–9.1:1 on the dark surface and 4.9–5.8:1 on the light
 * one — and the chroma is capped at what sRGB holds at that lightness, which is
 * what keeps the bright steps vivid instead of clipped.
 *
 * The aliases sit deliberately outside the `--dsw-alias-state-*` group, which
 * means run state: an accent borrowing the error red or the warn amber would
 * read as a failed or warning row, which is also why no flow hue sits on those
 * two ramps.
 */
import type { ThemeTokenOverrides } from '@deepseek-ai/dsh-client-ui-theme/client'

/** A colour that does not change with the palette. */
function fixed(value: string): { light: string; dark: string } {
  return { light: value, dark: value }
}

/** The saturated steps the aliases below draw from: bright for dark, deep for light. */
const STEPS: ThemeTokenOverrides = {
  '--dsw-static-flow-instruct-bright': fixed('rgb(252, 134, 189)'),
  '--dsw-static-flow-instruct-deep': fixed('rgb(172, 58, 117)'),
  '--dsw-static-flow-bash-bright': fixed('rgb(255, 144, 105)'),
  '--dsw-static-flow-bash-deep': fixed('rgb(183, 62, 0)'),
  '--dsw-static-flow-code-bright': fixed('rgb(223, 169, 12)'),
  '--dsw-static-flow-code-deep': fixed('rgb(136, 102, 0)'),
  '--dsw-static-flow-write-bright': fixed('rgb(131, 200, 106)'),
  '--dsw-static-flow-write-deep': fixed('rgb(50, 128, 0)'),
  '--dsw-static-flow-edit-bright': fixed('rgb(63, 201, 205)'),
  '--dsw-static-flow-edit-deep': fixed('rgb(0, 123, 127)'),
  '--dsw-static-flow-read-bright': fixed('rgb(80, 193, 238)'),
  '--dsw-static-flow-read-deep': fixed('rgb(0, 119, 155)'),
  '--dsw-static-flow-search-bright': fixed('rgb(133, 179, 255)'),
  '--dsw-static-flow-search-deep': fixed('rgb(44, 103, 201)'),
  '--dsw-static-flow-think-bright': fixed('rgb(196, 155, 255)'),
  '--dsw-static-flow-think-deep': fixed('rgb(126, 79, 183)'),
  '--dsw-static-flow-generic-bright': fixed('rgb(173, 178, 192)'),
  '--dsw-static-flow-generic-deep': fixed('rgb(101, 107, 126)'),
}

/** One hue per row family, per palette. */
const ALIASES: ThemeTokenOverrides = {
  '--dsw-alias-flow-think': { light: 'var(--dsw-static-flow-think-deep)', dark: 'var(--dsw-static-flow-think-bright)' },
  '--dsw-alias-flow-search': { light: 'var(--dsw-static-flow-search-deep)', dark: 'var(--dsw-static-flow-search-bright)' },
  '--dsw-alias-flow-read': { light: 'var(--dsw-static-flow-read-deep)', dark: 'var(--dsw-static-flow-read-bright)' },
  '--dsw-alias-flow-edit': { light: 'var(--dsw-static-flow-edit-deep)', dark: 'var(--dsw-static-flow-edit-bright)' },
  '--dsw-alias-flow-write': { light: 'var(--dsw-static-flow-write-deep)', dark: 'var(--dsw-static-flow-write-bright)' },
  '--dsw-alias-flow-shell': { light: 'var(--dsw-static-flow-bash-deep)', dark: 'var(--dsw-static-flow-bash-bright)' },
  '--dsw-alias-flow-code': { light: 'var(--dsw-static-flow-code-deep)', dark: 'var(--dsw-static-flow-code-bright)' },
  '--dsw-alias-flow-instruct': { light: 'var(--dsw-static-flow-instruct-deep)', dark: 'var(--dsw-static-flow-instruct-bright)' },
  '--dsw-alias-flow-generic': { light: 'var(--dsw-static-flow-generic-deep)', dark: 'var(--dsw-static-flow-generic-bright)' },
}

/** Every token this package contributes, steps first for readability. */
export const FLOW_ACCENT_TOKENS: ThemeTokenOverrides = { ...STEPS, ...ALIASES }
