/** `skillMention` namespace dictionary for the `@skill` picker. */

/** Dictionary namespace owned by this plugin. */
export const NS = 'skillMention'

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'menu.userOnly': '仅用户',
} satisfies Record<string, string>

/** The skillMention namespace key union. */
export type SkillMentionKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'menu.userOnly': 'user-only',
} satisfies Record<SkillMentionKey, string>
