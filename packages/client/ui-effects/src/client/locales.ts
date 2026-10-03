/** `settings.effects` namespace dictionaries (the Visual effects row's copy, and the overlay's). */

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
  'effects.focus.enter': '进入专注模式',
  'effects.focus.button': '专注',
  'effects.focus.dialog': '专注锁',
  'effects.focus.locked': '已锁定',
  'effects.focus.hint': '输入密码解锁',
  'effects.focus.passcode': '专注锁密码',
  'effects.focus.unlock': '解锁',
  'effects.scene.aurora': '极光',
  'effects.scene.alpine-lake': '高山湖泊',
  'effects.scene.misty-pines': '雾中松林',
  'effects.scene.turquoise-coast': '绿松石海岸',
  'effects.scene.dunes': '沙漠沙丘',
  'effects.scene.dolomites': '多洛米蒂',
  'effects.scene.autumn-woods': '秋日林间',
  'effects.scene.cliff-coast': '悬崖海岸',
  'effects.scene.canyon': '峡谷',
  'effects.scene.starry-night': '星空',
  'effects.scene.snow-peaks': '雪山',
  'effects.scene.bamboo': '竹林',
  'effects.scene.still-lake': '静湖',
  'effects.scene.desert-rock': '荒漠岩丘',
  'effects.scene.green-hills': '青翠山丘',
  'effects.scene.alpine-dawn': '高山晨曦',
  'effects.scene.redwood': '红杉林',
  'effects.scene.waterfall': '瀑布',
  'effects.scene.tropical-island': '热带海岛',
  'effects.scene.iceland-falls': '冰岛瀑布',
  'effects.scene.sunset-valley': '落日山谷',
  'effects.scene.reef': '珊瑚礁',
  'effects.scene.pine-forest': '松林',
  'effects.scene.mountain-night': '山间夜色',
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
  'effects.focus.enter': 'Enter focus mode',
  'effects.focus.button': 'Focus',
  'effects.focus.dialog': 'Focus lock',
  'effects.focus.locked': 'Focus locked',
  'effects.focus.hint': 'Enter passcode to unlock',
  'effects.focus.passcode': 'Focus lock passcode',
  'effects.focus.unlock': 'Unlock',
  'effects.scene.aurora': 'Aurora',
  'effects.scene.alpine-lake': 'Alpine Lake',
  'effects.scene.misty-pines': 'Misty Pines',
  'effects.scene.turquoise-coast': 'Turquoise Coast',
  'effects.scene.dunes': 'Desert Dunes',
  'effects.scene.dolomites': 'Dolomites',
  'effects.scene.autumn-woods': 'Autumn Woods',
  'effects.scene.cliff-coast': 'Cliff Coast',
  'effects.scene.canyon': 'Canyon',
  'effects.scene.starry-night': 'Starry Night',
  'effects.scene.snow-peaks': 'Snow Peaks',
  'effects.scene.bamboo': 'Bamboo Grove',
  'effects.scene.still-lake': 'Still Lake',
  'effects.scene.desert-rock': 'Desert Rock',
  'effects.scene.green-hills': 'Green Hills',
  'effects.scene.alpine-dawn': 'Alpine Dawn',
  'effects.scene.redwood': 'Redwood',
  'effects.scene.waterfall': 'Waterfall',
  'effects.scene.tropical-island': 'Tropical Island',
  'effects.scene.iceland-falls': 'Iceland Falls',
  'effects.scene.sunset-valley': 'Sunset Valley',
  'effects.scene.reef': 'Reef',
  'effects.scene.pine-forest': 'Pine Forest',
  'effects.scene.mountain-night': 'Mountain Night',
} satisfies Record<EffectsKey, string>

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The Visual effects settings row's copy. */
    'settings.effects': EffectsKey
  }
}
