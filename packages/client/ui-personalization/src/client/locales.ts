/**
 * Personalization-section copy.
 *
 * `zh` is the key-set source of truth and `en` must carry exactly the same keys.
 * @module @deepseek-ai/dsh-client-ui-personalization/locales
 */

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Personalization-section copy: one label and hint per appearance field. */
    appearance: AppearanceKey
  }
}

/** Every key this section renders, with the Chinese copy as the source of truth. */
export type AppearanceKey = keyof typeof zh

/** Every key this section renders, with the Chinese copy as the source of truth. */
export const zh = {
  'appearance.nav': '个性化',
  'appearance.title': '个性化',
  'appearance.hint': '改动立即生效，并保存在此部署的配置里。每一项留空或保持默认时，就沿用主题自己的取值。',

  'appearance.font.label': '界面字体',
  'appearance.font.hint': '填写 CSS 字体栈，例如 "Inter, system-ui, sans-serif"。留空则使用主题字体。',
  'appearance.fontPreset.system': '系统默认',
  'appearance.fontPreset.sans': '无衬线',
  'appearance.fontPreset.serif': '衬线',
  'appearance.fontPreset.mono': '等宽',

  'appearance.fontScale.label': '字号',
  'appearance.fontScale.hint': '整体界面的根字号百分比：整个外壳会一起缩放。100% 为主题默认。',

  'appearance.accent.label': '强调色',
  'appearance.accent.hint': '用于选中、焦点和当前项的强调色，支持任意 CSS 颜色写法。留空则使用主题强调色。',
  'appearance.accentPreset.deepseek': 'DeepSeek',
  'appearance.accentPreset.violet': '紫罗兰',
  'appearance.accentPreset.emerald': '翡翠',
  'appearance.accentPreset.amber': '琥珀',
  'appearance.accentPreset.rose': '玫瑰',

  'appearance.radius.label': '圆角倍率',
  'appearance.radius.hint': '所有圆角档位的倍率：0 完全直角，1 为主题默认，2 更圆。',

  'appearance.shell.label': '外壳不透明度',
  'appearance.shell.hint': '整个窗口的不透明度：窗口背景、侧边栏、对话区一起变成玻璃。低于 100% 时窗口真的透明，能直接看到后面的浏览器标签页或桌面。',

  'appearance.surface.label': '内层不透明度',
  'appearance.surface.hint': '窗口内对话区与内容面板的不透明度。它与窗口叠加，因此可以把内容做得比窗口更透。',

  'appearance.opacity.title': '不透明度',
  'appearance.panel.label': '设置面板',
  'appearance.panel.hint': '设置对话框、菜单和其他浮层的不透明度。它与窗口叠加，因此可以让设置面板比窗口更不透。',
  'appearance.opacity.solid': '不透明',
  'appearance.opacity.soft': '微透',
  'appearance.opacity.glass': '玻璃',
  'appearance.opacity.clear': '全透',
  'appearance.reset': '恢复默认',
  'appearance.reset.hint': '把上面每一项都恢复为主题自己的取值。',
  'appearance.loading': '正在读取个性化配置…',
  'appearance.unavailable': '此部署没有装载个性化配置行。',
  'appearance.failed': '无法写入个性化配置。',
} as const

/** The English side, key for key. */
export const en: Record<keyof typeof zh, string> = {
  'appearance.nav': 'Personalization',
  'appearance.title': 'Personalization',
  'appearance.hint': 'Every change applies immediately and is stored in this deployment. A field left empty or at its default keeps what the theme already says.',

  'appearance.font.label': 'Interface font',
  'appearance.font.hint': 'A CSS font stack, for example "Inter, system-ui, sans-serif". Empty keeps the theme font.',
  'appearance.fontPreset.system': 'System',
  'appearance.fontPreset.sans': 'Sans',
  'appearance.fontPreset.serif': 'Serif',
  'appearance.fontPreset.mono': 'Mono',

  'appearance.fontScale.label': 'Font size',
  'appearance.fontScale.hint': 'Root font size for the whole interface, so the entire shell scales together. 100% is the theme default.',

  'appearance.accent.label': 'Accent',
  'appearance.accent.hint': 'The accent used for selection, focus, and current items, in any CSS colour syntax. Empty keeps the theme accent.',
  'appearance.accentPreset.deepseek': 'DeepSeek',
  'appearance.accentPreset.violet': 'Violet',
  'appearance.accentPreset.emerald': 'Emerald',
  'appearance.accentPreset.amber': 'Amber',
  'appearance.accentPreset.rose': 'Rose',

  'appearance.radius.label': 'Corner scale',
  'appearance.radius.hint': 'Multiplier for every corner radius step: 0 squares the interface, 1 is the theme default, 2 rounds it further.',

  'appearance.shell.label': 'Shell opacity',
  'appearance.shell.hint': 'Opacity of the whole window: its background, the sidebar, and the conversation surface together. Below 100% the window is genuinely glass, so another browser tab or the desktop behind it shows through.',

  'appearance.surface.label': 'Surface opacity',
  'appearance.surface.hint': 'Opacity of the surfaces inside the shell: cards, panels, menus, and dialogs. Lower it to see what sits underneath them.',

  'appearance.opacity.title': 'Opacity',
  'appearance.panel.label': 'Settings panel',
  'appearance.panel.hint': 'Opacity of the settings dialog, menus, and every other floating surface. It composes with the window, so a panel can read more solid than the glass around it.',
  'appearance.opacity.solid': 'Solid',
  'appearance.opacity.soft': 'Soft',
  'appearance.opacity.glass': 'Glass',
  'appearance.opacity.clear': 'Clear',
  'appearance.reset': 'Reset to defaults',
  'appearance.reset.hint': 'Returns every field above to what the theme already says.',
  'appearance.loading': 'Reading the personalization row…',
  'appearance.unavailable': 'This deployment composes no personalization row.',
  'appearance.failed': 'The personalization row could not be written.',
}
