/**
 * `sidebarTerminal` namespace dictionaries, and the namespace's declaration.
 *
 * One namespace covers the whole package: the tab type's copy and the
 * conversation-header menu the terminal re-homed from the retired dock.
 *
 * The namespace merge lives with its key set so that any module naming
 * `TranslateNS<'sidebarTerminal'>` or `PropsLocale<'sidebarTerminal'>` needs only
 * this file, whichever entry a program loads first.
 */
import type {} from '@deepseek-ai/dsh-client-ui-slots'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Terminal tab type name, guide entry, and the pane's own status lines. */
    sidebarTerminal: SidebarTerminalKey
  }
}

/** Simplified Chinese dictionary and key-set source of truth. */
export const zh = {
  'type.label': '终端',
  'guide.title': '终端',
  'guide.description': '在本会话工作区的专用 shell 里运行命令',
  reset: '结束这个 shell 并重新开一个',
  cwdDefault: '~（默认目录）',
  connecting: '正在连接…',
  disconnected: '已断开',
  reconnect: '重新连接',
  input: '终端输入',
  'menu.sessionLog': 'Session 日志',
  'menu.copySessionId': '复制 Session ID',
  'menu.openTerminal': '终端',
  'menu.title': '更多操作',
} satisfies Record<string, string>

/** Terminal dictionary key union. */
export type SidebarTerminalKey = keyof typeof zh

/** English dictionary, checked against the Chinese key set. */
export const en = {
  'type.label': 'Terminal',
  'guide.title': 'Terminal',
  'guide.description': 'Run commands in a dedicated shell for this session\'s workspace',
  reset: 'Kill this shell and start a fresh one',
  cwdDefault: '~ (default)',
  connecting: 'connecting…',
  disconnected: 'disconnected',
  reconnect: 'reconnect',
  input: 'terminal input',
  'menu.sessionLog': 'Session log',
  'menu.copySessionId': 'Copy session ID',
  'menu.openTerminal': 'Terminal',
  'menu.title': 'More actions',
} satisfies Record<SidebarTerminalKey, string>
