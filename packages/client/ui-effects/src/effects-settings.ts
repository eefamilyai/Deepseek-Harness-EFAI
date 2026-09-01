/**
 * Durable ui-effects preference section shared by the Host schema and the
 * browser scope. This file stays client-safe: only @deepseek-ai/schemastery
 * (a vendored, inline-safe library) — the host registration lives in
 * the Host half only.
 */
import z from '@deepseek-ai/schemastery'

/** Settings namespace owned by the visual-effects plugin. */
export const EFFECTS_SETTINGS_NAMESPACE = 'ui-effects'

/** Field toggling the ambient whale backdrop. */
export const WHALE_ENABLED_FIELD = 'whaleEnabled'
/** Field toggling the bottom-right focus lock button. */
export const FOCUS_ENABLED_FIELD = 'focusEnabled'
/** Whale backdrop opacity (0..1). */
export const WHALE_OPACITY_FIELD = 'whaleOpacity'
/** Whale backdrop width in px. */
export const WHALE_SIZE_FIELD = 'whaleSize'
/** Whether the whale is pinned static and centered. */
export const WHALE_STATIC_FIELD = 'whaleStatic'

/** Whale backdrop defaults to on. */
export const DEFAULT_WHALE_ENABLED = true
/** Focus lock button defaults to on. */
export const DEFAULT_FOCUS_ENABLED = true
/** Default whale opacity (soft but clearly visible). */
export const DEFAULT_WHALE_OPACITY = 0.35
/** Default whale width in px. */
export const DEFAULT_WHALE_SIZE = 540
/** Default to the drifting (non-static) whale. */
export const DEFAULT_WHALE_STATIC = false

/** Durable visual-effects section. */
export interface EffectsSettings {
  whaleEnabled: boolean
  focusEnabled: boolean
  whaleOpacity: number
  whaleSize: number
  whaleStatic: boolean
}

/** Host schema; also the wire envelope the browser scope validates against. */
export const EffectsSettingsSchema: z<EffectsSettings> = z.object({
  [WHALE_ENABLED_FIELD]: z.boolean().default(DEFAULT_WHALE_ENABLED),
  [FOCUS_ENABLED_FIELD]: z.boolean().default(DEFAULT_FOCUS_ENABLED),
  [WHALE_OPACITY_FIELD]: z.number().default(DEFAULT_WHALE_OPACITY),
  [WHALE_SIZE_FIELD]: z.number().default(DEFAULT_WHALE_SIZE),
  [WHALE_STATIC_FIELD]: z.boolean().default(DEFAULT_WHALE_STATIC),
})
