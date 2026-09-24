/** Tools-section copy: the kernel, RLM, and conventional-tool switches, and the cache notice. */

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Tools-section copy: the three switches and the cache notice. */
    tools: ToolsKey
  }
}

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'tools.nav': '工具',
  'tools.intro': '打开或关闭模型可以使用的工具。Kernel 与常规工具彼此独立，可以同时开启。',
  'tools.kernel.label': 'Kernel',
  'tools.kernel.hint': '在持久 Python 命名空间中运行代码，读取、编辑、搜索文件都是其中的函数调用。',
  'tools.rlm.label': 'RLM 引擎',
  'tools.rlm.hint': '以递归 RLM 引擎代替单独的 Kernel 工具。需要开启 Kernel。',
  'tools.category.label': '常规工具',
  'tools.category.hint': '关闭后一次收起全部常规工具，模型只能通过 Kernel 行动；Kernel 不受影响。',
  'tools.presets.hint': '要为某个预设挑选具体工具，请在预设编辑器中修改。',
  'tools.pending': '更改会在模型停止生成后生效。系统提示词随之改变，这可能会让提示词缓存失效。',
  'tools.loadError': '无法读取设置。',
  'tools.writeError': '无法保存设置。',
} satisfies Record<string, string>

/** The section's key union: the zh dictionary's key set. */
export type ToolsKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'tools.nav': 'Tools',
  'tools.intro': 'Turn the tools the model can use on or off. The kernel and the conventional tools are independent and can be on at the same time.',
  'tools.kernel.label': 'Kernel',
  'tools.kernel.hint': 'Run code in a persistent Python namespace, where reading, editing, and searching files are function calls inside it.',
  'tools.rlm.label': 'RLM engine',
  'tools.rlm.hint': 'Offer the recursive RLM engine instead of the standalone kernel tool. Requires the kernel.',
  'tools.category.label': 'Conventional tools',
  'tools.category.hint': 'Turning this off withdraws every conventional tool at once, leaving the kernel as the only way to act; the kernel is unaffected.',
  'tools.presets.hint': 'To choose individual tools for a preset, edit it in the preset editor.',
  'tools.pending': 'Changes apply once the model stops generating. The system prompt changes with them, which can invalidate the prompt cache.',
  'tools.loadError': 'Could not read settings.',
  'tools.writeError': 'Could not save the setting.',
} satisfies Record<ToolsKey, string>
