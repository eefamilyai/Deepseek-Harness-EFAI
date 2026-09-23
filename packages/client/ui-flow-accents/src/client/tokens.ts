/**
 * The flow-accent palette: one hue per compact row family, so a scrolled
 * transcript indexes by colour.
 *
 * Two layers, both supplied here. The saturated steps (`--dsw-static-*`) are
 * absolute colours and therefore identical in both palettes. The aliases
 * (`--dsw-alias-flow-*`) pick a step per palette: near-fluorescent on the dark
 * surface, full-chroma mid-tones on the light one, where a fluorescent value
 * cannot carry 13px text. Both themes take the most chromatic value their
 * surface allows at a 4.5:1 floor against `--dsw-alias-bg-base`.
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

/** The saturated steps the aliases below draw from. */
const STEPS: ThemeTokenOverrides = {
  '--dsw-static-blue-350': fixed('rgb(77, 143, 255)'),
  '--dsw-static-blue-700': fixed('rgb(0, 102, 255)'),
  '--dsw-static-cyan-400': fixed('rgb(34, 233, 255)'),
  '--dsw-static-cyan-700': fixed('rgb(0, 125, 158)'),
  '--dsw-static-green-350': fixed('rgb(61, 255, 158)'),
  '--dsw-static-green-700': fixed('rgb(0, 131, 47)'),
  '--dsw-static-lime-400': fixed('rgb(163, 255, 41)'),
  '--dsw-static-lime-700': fixed('rgb(76, 124, 0)'),
  '--dsw-static-orange-400': fixed('rgb(255, 138, 26)'),
  '--dsw-static-orange-700': fixed('rgb(212, 53, 0)'),
  '--dsw-static-pink-400': fixed('rgb(255, 77, 196)'),
  '--dsw-static-pink-700': fixed('rgb(224, 0, 122)'),
  '--dsw-static-violet-400': fixed('rgb(196, 123, 255)'),
  '--dsw-static-violet-600': fixed('rgb(124, 45, 240)'),
  '--dsw-static-yellow-400': fixed('rgb(255, 224, 26)'),
  '--dsw-static-yellow-700': fixed('rgb(143, 98, 0)'),
}

/** One hue per row family, per palette. */
const ALIASES: ThemeTokenOverrides = {
  '--dsw-alias-flow-think': { light: 'var(--dsw-static-violet-600)', dark: 'var(--dsw-static-violet-400)' },
  '--dsw-alias-flow-search': { light: 'var(--dsw-static-blue-700)', dark: 'var(--dsw-static-blue-350)' },
  '--dsw-alias-flow-read': { light: 'var(--dsw-static-cyan-700)', dark: 'var(--dsw-static-cyan-400)' },
  '--dsw-alias-flow-mutate': { light: 'var(--dsw-static-green-700)', dark: 'var(--dsw-static-green-350)' },
  '--dsw-alias-flow-shell': { light: 'var(--dsw-static-orange-700)', dark: 'var(--dsw-static-orange-400)' },
  '--dsw-alias-flow-code': { light: 'var(--dsw-static-yellow-700)', dark: 'var(--dsw-static-yellow-400)' },
  '--dsw-alias-flow-instruct': { light: 'var(--dsw-static-pink-700)', dark: 'var(--dsw-static-pink-400)' },
  '--dsw-alias-flow-generic': { light: 'var(--dsw-static-lime-700)', dark: 'var(--dsw-static-lime-400)' },
}

/** Every token this package contributes, steps first for readability. */
export const FLOW_ACCENT_TOKENS: ThemeTokenOverrides = { ...STEPS, ...ALIASES }
