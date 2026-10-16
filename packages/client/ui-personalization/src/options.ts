/**
 * The vocabulary both halves of the row share: every field's type, its choices, and
 * the value that leaves the theme alone.
 *
 * The Host half validates the row with these values and the browser half paints from
 * them, so a choice exists in exactly one place. The module holds plain values only,
 * which keeps the schema library out of the browser bundle.
 *
 * @module @deepseek-ai/dsh-client-ui-personalization/options
 */

/** Conversation column widths: the theme's adaptive width, or a fixed wider column. */
export const CONTENT_WIDTHS = ['default', 'wide', 'wider', 'full'] as const
/** One conversation column width. */
export type ContentWidth = typeof CONTENT_WIDTHS[number]

/** Settings panel widths: the theme's 800px panel, or a wider one. */
export const SETTINGS_WIDTHS = ['default', 'wide', 'wider'] as const
/** One settings panel width. */
export type SettingsWidth = typeof SETTINGS_WIDTHS[number]

/** Scrollbar presentations. */
export const SCROLLBAR_STYLES = ['default', 'thin', 'hidden'] as const
/** One scrollbar presentation. */
export type ScrollbarStyle = typeof SCROLLBAR_STYLES[number]

/** Shadow strengths under menus, panels, cards, and inputs. */
export const SHADOW_STRENGTHS = ['none', 'default', 'strong'] as const
/** One shadow strength. */
export type ShadowStrength = typeof SHADOW_STRENGTHS[number]

/** What translucent layers show: the desktop, a gradient, or an image the operator names. */
export const BACKDROPS = ['none', 'aurora', 'sunset', 'ocean', 'forest', 'grape', 'peach', 'graphite', 'image'] as const
/** One backdrop. */
export type Backdrop = typeof BACKDROPS[number]

/**
 * The appearance values the page wears.
 *
 * Plain, not the schema's inference: this is the resolved record the engine and the
 * section both read, and the row's own `Config` is the declaration that produces it.
 */
export interface AppearanceValues {
  /** A CSS font stack for the interface, or empty for the theme's own. */
  fontFamily: string
  /** A CSS font stack for code, or empty for the theme's own. */
  codeFontFamily: string
  /** Root font size as a percentage of the browser default. */
  fontScale: number
  /** Message text line spacing as a percentage of the theme's. */
  lineHeight: number
  /** An accent colour value, or empty for the theme's own. */
  accent: string
  /** Whether the accent also tints links, message bubbles, and the current sidebar row. */
  accentEverywhere: boolean
  /** Conversation column width. */
  contentWidth: ContentWidth
  /** Settings panel width. */
  settingsWidth: SettingsWidth
  /** Multiplier for every corner radius step. */
  radiusScale: number
  /** Scrollbar presentation. */
  scrollbars: ScrollbarStyle
  /** Window opacity as a percentage; 100 is solid. */
  shellOpacity: number
  /** Opacity of the layers inside the window as a percentage; 100 is solid. */
  surfaceOpacity: number
  /** Opacity of the settings panel, menus, and dialogs as a percentage; 100 is solid. */
  panelOpacity: number
  /** Blur radius, in pixels, behind menus and translucent panels. */
  glassBlur: number
  /** What translucent layers show. */
  backdrop: Backdrop
  /** The image `backdrop: 'image'` shows: an `https:`, `http:`, or `data:image/` URL. */
  backdropImage: string
  /** Shadow strength. */
  shadows: ShadowStrength
  /** Whether animations and transitions are cut to an instant. */
  reduceMotion: boolean
}

/** One field of the row. */
export type AppearanceField = keyof AppearanceValues

/** The values a deployment gets before it chooses anything: each leaves its part of the theme alone. */
export const APPEARANCE_DEFAULTS: Readonly<AppearanceValues> = Object.freeze({
  fontFamily: '',
  codeFontFamily: '',
  fontScale: 100,
  lineHeight: 100,
  accent: '',
  accentEverywhere: false,
  contentWidth: 'default',
  settingsWidth: 'default',
  radiusScale: 1,
  scrollbars: 'default',
  shellOpacity: 100,
  surfaceOpacity: 100,
  panelOpacity: 100,
  glassBlur: 40,
  backdrop: 'none',
  backdropImage: '',
  shadows: 'default',
  reduceMotion: false,
})

/** Every field, in the order the section lists and the reset writes them. */
export const APPEARANCE_FIELDS: readonly AppearanceField[] = Object.freeze(Object.keys(APPEARANCE_DEFAULTS) as AppearanceField[])

/** Inclusive numeric ranges, shared by the schema and the section's number fields. */
export const APPEARANCE_RANGES = Object.freeze({
  fontScale: { min: 80, max: 150, step: 5 },
  lineHeight: { min: 80, max: 180, step: 5 },
  radiusScale: { min: 0, max: 2.5, step: 0.25 },
  opacity: { min: 35, max: 100, step: 5 },
  glassBlur: { min: 0, max: 80, step: 4 },
})
