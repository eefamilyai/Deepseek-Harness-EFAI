/**
 * Agent Browser tab copy.
 *
 * `zh` is the key-set source of truth and `en` must carry exactly the same keys.
 * @module @deepseek-ai/dsh-web-browser-sidebar/locales
 */

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Agent Browser tab copy. */
    agentBrowser: AgentBrowserKey
  }
}

/** Every key the tab renders, with the Chinese copy as the source of truth. */
export type AgentBrowserKey = keyof typeof zh

/** Every key the tab renders, with the Chinese copy as the source of truth. */
export const zh = {
  'type.label': 'AI 浏览器',
  'guide.title': 'AI 浏览器',
  'guide.description': '查看 AI 正在使用的网页',
  'empty': 'AI 还没有在这个对话里打开网页',
  'back': '后退',
  'forward': '前进',
  'reload': '刷新',
  'external': '在系统浏览器中打开',
  'address': '地址',
  'status.idle': 'AI 使用的网页，你也可以直接操作',
  'status.navigate': 'AI 正在打开网页…',
  'status.evaluate': 'AI 正在读取网页…',
  'status.click': 'AI 正在点击…',
  'status.insertText': 'AI 正在输入…',
  'status.key': 'AI 正在按键…',
  'status.back': 'AI 正在后退…',
  'status.forward': 'AI 正在前进…',
  'status.settle': 'AI 正在等待网页加载…',
  'status.screenshot': 'AI 正在截图…',
} as const

/** The English side, key for key. */
export const en: Record<keyof typeof zh, string> = {
  'type.label': 'AI Browser',
  'guide.title': 'AI Browser',
  'guide.description': 'See the page the agent is using',
  'empty': 'The agent has not opened a page in this conversation yet.',
  'back': 'Back',
  'forward': 'Forward',
  'reload': 'Reload',
  'external': 'Open in system browser',
  'address': 'Address',
  'status.idle': 'The agent\'s page. You can use it too.',
  'status.navigate': 'The agent is opening a page…',
  'status.evaluate': 'The agent is reading the page…',
  'status.click': 'The agent is clicking…',
  'status.insertText': 'The agent is typing…',
  'status.key': 'The agent is pressing a key…',
  'status.back': 'The agent is going back…',
  'status.forward': 'The agent is going forward…',
  'status.settle': 'The agent is waiting for the page to load…',
  'status.screenshot': 'The agent is taking a screenshot…',
}
