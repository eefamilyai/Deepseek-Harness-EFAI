/** `modelVisibility` namespace dictionaries. */

/** Dictionary namespace owned by this plugin. */
export const NS = 'modelVisibility'

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  title: '模型选择器中的其他提供商',
  hint: '这些提供商没有自己的卡片。关闭的提供商不会出现在模型选择器中，已在使用它的会话不受影响。',
  loading: '正在读取提供商…',
  unavailable: '此配置未加载提供商可见性插件。',
  error: '无法读取提供商：{message}',
  empty: '没有可显示的提供商。',
  saveFailed: '未能保存更改。',
  hiddenTag: '已隐藏',
  toggle: '在模型选择器中显示 {name}',
  cardShown: '显示在模型选择器中',
  cardHidden: '已从模型选择器中隐藏',
} satisfies Record<string, string>

/** The namespace key union. */
export type ModelVisibilityKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  title: 'Other providers in the model picker',
  hint: 'Providers without a card of their own. A provider switched off is left out of the model picker; sessions already using it keep working.',
  loading: 'Reading providers…',
  unavailable: 'This profile does not load the provider visibility plugin.',
  error: 'Could not read providers: {message}',
  empty: 'No providers to show.',
  saveFailed: 'The change was not saved.',
  hiddenTag: 'Hidden',
  toggle: 'Show {name} in the model picker',
  cardShown: 'Shown in the model picker',
  cardHidden: 'Hidden from the model picker',
} satisfies Record<ModelVisibilityKey, string>

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The provider visibility list's copy. */
    modelVisibility: ModelVisibilityKey
  }
}
