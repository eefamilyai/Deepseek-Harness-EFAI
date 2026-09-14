/** The Tools-section key union, split out so the dictionary file can import it. */

/** Simplified Chinese key-set source of truth. */
export const zhKeys = {
  'tools.nav': '',
  'tools.intro': '',
  'tools.group.categories': '',
  'tools.group.tools': '',
  'tools.kernel.label': '',
  'tools.kernel.hint': '',
  'tools.category.label': '',
  'tools.category.hint': '',
  'tools.perTool.hint': '',
  'tools.pending': '',
  'tools.empty': '',
  'tools.loadError': '',
} as const

/** The Tools-section key union. */
export type ToolsKey = keyof typeof zhKeys
