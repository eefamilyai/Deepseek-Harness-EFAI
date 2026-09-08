/**
 * Locale namespace owned by the dock's conversation-header buttons.
 * @module @deepseek-ai/dsh-client-ui-dock/client/header-locales
 */

export const NS = 'dsh-client-ui-dock-header'

/** English header strings. */
export const en = {
  'menu.sessionLog': 'Session log',
  'menu.copySessionId': 'Copy session ID',
  'menu.openBrowser': 'Browser',
  'menu.openTerminal': 'Terminal',
  'menu.title': 'More actions',
  'toggle.title': 'Browser & terminal',
} as const

/** Simplified-Chinese header strings. */
export const zh: Record<keyof typeof en, string> = {
  'menu.sessionLog': 'Session 日志',
  'menu.copySessionId': '复制 Session ID',
  'menu.openBrowser': '浏览器',
  'menu.openTerminal': '终端',
  'menu.title': '更多操作',
  'toggle.title': '浏览器与终端',
}

/** Stable locale keys consumed by the header buttons. */
export type HeaderKey = keyof typeof en

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'dsh-client-ui-dock-header': HeaderKey
  }
}
