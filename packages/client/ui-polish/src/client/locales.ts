/** Model-menu copy: the account pool's choice row, which is the only text this plugin owns. */

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Model-menu copy owned by this plugin. */
    polish: PolishKey
  }
}

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'polish.account.legend': '账号',
  'polish.account.auto': '自动',
} satisfies Record<string, string>

/** The plugin's key union: the zh dictionary's key set. */
export type PolishKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'polish.account.legend': 'Account',
  'polish.account.auto': 'Auto',
} satisfies Record<PolishKey, string>
