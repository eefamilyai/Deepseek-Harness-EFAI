/** `settings.effects` namespace dictionaries (the Visual effects row's copy). */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'effects.title': '视觉效果',
  'effects.whale': '鲸鱼背景',
  'effects.whale.desc': '在界面后方显示一只柔和漂移的 DeepSeek 鲸鱼。',
  'effects.whale.opacity': '鲸鱼透明度',
  'effects.whale.size': '鲸鱼大小',
  'effects.whale.static': '静态鲸鱼',
  'effects.whale.static.desc': '固定在聊天界面中央。',
  'effects.focus': '专注模式',
  'effects.focus.desc': '在右下角显示专注锁按钮，开启旋转自然场景。',
} satisfies Record<string, string>

/** The settings.effects namespace key union. */
export type EffectsKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'effects.title': 'Visual effects',
  'effects.whale': 'Whale backdrop',
  'effects.whale.desc': 'Show a soft drifting DeepSeek whale behind the interface.',
  'effects.whale.opacity': 'Whale opacity',
  'effects.whale.size': 'Whale size',
  'effects.whale.static': 'Static whale',
  'effects.whale.static.desc': 'Pin the whale to the center of the chat.',
  'effects.focus': 'Focus mode',
  'effects.focus.desc': 'Show the bottom-right focus button with a rotating nature scene.',
} satisfies Record<EffectsKey, string>

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The Visual effects settings row's copy. */
    'settings.effects': EffectsKey
  }
}
