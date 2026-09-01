/**
 * Host registration for the visual-effects preferences. Pure UI plugin: the
 * only host behavior is registering the durable settings section.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-settings'
import { EFFECTS_SETTINGS_NAMESPACE, EffectsSettingsSchema } from './effects-settings.ts'

export {
  DEFAULT_FOCUS_ENABLED, DEFAULT_WHALE_ENABLED, EFFECTS_SETTINGS_NAMESPACE,
  FOCUS_ENABLED_FIELD, WHALE_ENABLED_FIELD, type EffectsSettings,
} from './effects-settings.ts'

/**
 * Register the durable effects section when a settings provider exists.
 * @param ctx - Host context whose optional settings service owns the section.
 */
export function apply(ctx: Context): void {
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.register(
      EFFECTS_SETTINGS_NAMESPACE,
      EffectsSettingsSchema,
    )
  })
}
