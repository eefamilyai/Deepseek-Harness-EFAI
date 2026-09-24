/**
 * Host declaration of the visual-effects preferences. Pure UI plugin: the only
 * host behavior is owning the live config fields the browser reads and writes
 * by this row's id.
 */
import type { Context, Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-settings'
import {
  DEFAULT_FOCUS_ENABLED, DEFAULT_WHALE_ENABLED, DEFAULT_WHALE_OPACITY, DEFAULT_WHALE_SIZE, DEFAULT_WHALE_STATIC,
  FOCUS_ENABLED_FIELD, WHALE_ENABLED_FIELD, WHALE_OPACITY_FIELD, WHALE_SIZE_FIELD, WHALE_STATIC_FIELD,
} from './effects-settings.ts'

export {
  DEFAULT_FOCUS_ENABLED, DEFAULT_WHALE_ENABLED, EFFECTS_SETTINGS_NAMESPACE,
  FOCUS_ENABLED_FIELD, WHALE_ENABLED_FIELD, type EffectsSettings,
} from './effects-settings.ts'

/** The effects preferences, each editable live from the browser's own row. */
export interface Config {
  whaleEnabled: Volatile<boolean>
  focusEnabled: Volatile<boolean>
  whaleOpacity: Volatile<number>
  whaleSize: Volatile<number>
  whaleStatic: Volatile<boolean>
}

export const Config = z.object({
  [WHALE_ENABLED_FIELD]: z.boolean().default(DEFAULT_WHALE_ENABLED).volatile(),
  [FOCUS_ENABLED_FIELD]: z.boolean().default(DEFAULT_FOCUS_ENABLED).volatile(),
  [WHALE_OPACITY_FIELD]: z.number().default(DEFAULT_WHALE_OPACITY).volatile(),
  [WHALE_SIZE_FIELD]: z.number().default(DEFAULT_WHALE_SIZE).volatile(),
  [WHALE_STATIC_FIELD]: z.boolean().default(DEFAULT_WHALE_STATIC).volatile(),
})

/**
 * Keep these fields off the generated settings pages: the browser plugin
 * renders its own row for them under General.
 * @param ctx - Host context whose optional settings service lists the pages.
 */
export function apply(ctx: Context): void {
  ctx.inject(['settings'], (child) => { child.effect(() => child.settings.configure({ auto: false }, ctx.fiber)) })
}
