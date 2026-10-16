/**
 * Personalization: the appearance fields one deployment can change.
 *
 * The theme owns the tokens; this row owns the *overrides*. A field left at its
 * default means "leave that part of the theme alone", which is why every default is
 * empty or neutral: mounting this plugin changes nothing until someone chooses
 * something. All fields are volatile, so a change reaches the page while the
 * settings dialog is still open.
 *
 * @module @deepseek-ai/dsh-client-ui-personalization
 */

import z from '@deepseek-ai/schemastery'
import {
  APPEARANCE_DEFAULTS as D, APPEARANCE_RANGES as R, BACKDROPS, CONTENT_WIDTHS, SCROLLBAR_STYLES, SETTINGS_WIDTHS,
  SHADOW_STRENGTHS,
} from './options.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'ui-personalization'

/** Lower bound of an opacity field: a fraction the first build wrote (0.35-1) still validates. */
const OPACITY_FLOOR = 0.35

export const Config = z.object({
  fontFamily: z.string().default(D.fontFamily)
    .description('A CSS font stack for the whole interface, for example "Inter, system-ui, sans-serif". Empty keeps the theme font.')
    .volatile(),
  codeFontFamily: z.string().default(D.codeFontFamily)
    .description('A CSS font stack for code blocks, inline code, and terminals, for example "Cascadia Code, Consolas". Empty keeps the theme code font.')
    .volatile(),
  fontScale: z.number().min(R.fontScale.min).max(R.fontScale.max).default(D.fontScale)
    .description('Root font size as a percentage of the browser default, so every rem in the shell scales together.')
    .volatile(),
  lineHeight: z.number().min(R.lineHeight.min).max(R.lineHeight.max).default(D.lineHeight)
    .description('Line spacing of message text as a percentage of the theme\'s own.')
    .volatile(),
  accent: z.string().default(D.accent)
    .description('An accent colour for selection, focus and current items, in any CSS colour syntax. Empty keeps the theme accent.')
    .volatile(),
  accentEverywhere: z.boolean().default(D.accentEverywhere)
    .description('Also tint links, your message bubbles, and the current sidebar row with the accent.')
    .volatile(),
  contentWidth: z.union([...CONTENT_WIDTHS]).default(D.contentWidth)
    .description('Conversation column width. "default" keeps the theme\'s adaptive width and its drag handles.')
    .volatile(),
  settingsWidth: z.union([...SETTINGS_WIDTHS]).default(D.settingsWidth)
    .description('Settings panel width. "default" keeps the theme\'s 800px panel.')
    .volatile(),
  radiusScale: z.number().min(R.radiusScale.min).max(R.radiusScale.max).default(D.radiusScale)
    .description('Multiplier for every corner radius step: 0 squares the interface, 2 rounds it further.')
    .volatile(),
  scrollbars: z.union([...SCROLLBAR_STYLES]).default(D.scrollbars)
    .description('Scrollbar presentation: the theme\'s, a thinner bar, or none.')
    .volatile(),
  shellOpacity: z.number().min(OPACITY_FLOOR).max(R.opacity.max).default(D.shellOpacity)
    .description('Shell opacity: the app frame, the sidebar, and its navigation rows. Below 100 the window stops painting its own background, so the desktop behind it - blurred by the window material - shows through. A value written before this field became a percentage (0.35-1) is read as that fraction.')
    .volatile(),
  surfaceOpacity: z.number().min(OPACITY_FLOOR).max(R.opacity.max).default(D.surfaceOpacity)
    .description('Surface opacity: the conversation, cards, and panels. Lower it to read what sits underneath them. A value written before this field became a percentage (0.35-1) is read as that fraction.')
    .volatile(),
  panelOpacity: z.number().min(OPACITY_FLOOR).max(R.opacity.max).default(D.panelOpacity)
    .description('Settings panel opacity: the settings dialog, menus, and every other floating surface. A value written before this field existed is 100.')
    .volatile(),
  glassBlur: z.number().min(R.glassBlur.min).max(R.glassBlur.max).default(D.glassBlur)
    .description('Blur radius in pixels behind menus and translucent panels. 40 is the theme\'s own.')
    .volatile(),
  backdrop: z.union([...BACKDROPS]).default(D.backdrop)
    .description('What translucent layers show: "none" shows the desktop, a named gradient replaces it, "image" shows backdropImage.')
    .volatile(),
  backdropImage: z.string().default(D.backdropImage)
    .description('The image a backdrop of "image" shows: an https:, http:, or data:image/ URL.')
    .volatile(),
  shadows: z.union([...SHADOW_STRENGTHS]).default(D.shadows)
    .description('Shadow strength under menus, panels, cards, and inputs.')
    .volatile(),
  reduceMotion: z.boolean().default(D.reduceMotion)
    .description('Cut animations and transitions to an instant.')
    .volatile(),
})

/**
 * The host half owns nothing but the row.
 *
 * The fields live here so the profile persists them and Settings edits them; the
 * browser half reads the same row through its config form and writes the token
 * overrides. There is no host behaviour to apply.
 */
export function apply(): void {}
