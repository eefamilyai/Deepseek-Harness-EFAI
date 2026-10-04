/**
 * Personalization: the appearance fields one deployment can change.
 *
 * The theme owns the tokens; this row owns the *overrides*. A field left at its
 * default means "leave that part of the theme alone", which is why every value is
 * empty or neutral by default: mounting this plugin changes nothing until someone
 * chooses something. All fields are volatile, so a change reaches the page while
 * the settings dialog is still open.
 *
 * @module @deepseek-ai/dsh-client-ui-personalization
 */

import z from '@deepseek-ai/schemastery'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'ui-personalization'

export const Config = z.object({
  fontFamily: z.string().default('')
    .description('A CSS font stack for the whole interface, for example "Inter, system-ui, sans-serif". Empty keeps the theme font.')
    .volatile(),
  fontScale: z.number().min(80).max(150).default(100)
    .description('Root font size as a percentage of the browser default, so every rem in the shell scales together.')
    .volatile(),
  accent: z.string().default('')
    .description('An accent colour for selection, focus and current items, in any CSS colour syntax. Empty keeps the theme accent.')
    .volatile(),
  radiusScale: z.number().min(0).max(2.5).default(1)
    .description('Multiplier for every corner radius step: 0 squares the interface, 2 rounds it further.')
    .volatile(),
  shellOpacity: z.number().min(0.35).max(1).default(1)
    .description('Opacity of the shell around the conversation — the app frame, the sidebar, its navigation rows.')
    .volatile(),
  surfaceOpacity: z.number().min(0.35).max(1).default(1)
    .description('Opacity of the surfaces inside the shell — cards, panels, menus, dialogs — over whatever the backdrop paints.')
    .volatile(),
  backdrop: z.union([z.const('theme'), z.const('aurora'), z.const('mist'), z.const('dusk')]).default('theme')
    .description('What a translucent shell reveals: the theme background, or one of three soft backdrops behind the interface.')
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
