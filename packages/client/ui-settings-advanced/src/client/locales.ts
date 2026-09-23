/**
 * Dictionaries for the Advanced settings section.
 *
 * One key: the navigation label. The section's body is a raw JSON editor over
 * namespaces other packages own, and their names are data rather than copy.
 */

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Advanced-section copy: one navigation label. */
    advanced: AdvancedKey
  }
}

/** Keys this section's dictionary declares. */
export type AdvancedKey = 'advanced.nav'

/** Simplified Chinese dictionary. */
export const zh: Record<AdvancedKey, string> = {
  'advanced.nav': '高级设置',
}

/** English dictionary. */
export const en: Record<AdvancedKey, string> = {
  'advanced.nav': 'Advanced',
}
