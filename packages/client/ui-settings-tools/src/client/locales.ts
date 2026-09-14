/** Tools-section copy: two category switches, the per-tool list, and the cache notice. */

import type { ToolsKey } from './locales-keys.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Tools-section copy: categories, per-tool switches, and the cache notice. */
    tools: ToolsKey
  }
}

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'tools.nav': '工具',
  'tools.intro': '打开或关闭模型可以使用的工具。两类彼此独立，可以同时开启。',
  'tools.group.categories': '类别',
  'tools.group.tools': '工具',
  'tools.kernel.label': 'Kernel',
  'tools.kernel.hint': '在持久 Python 命名空间中运行代码，读取、编辑、搜索文件都是其中的函数调用。',
  'tools.category.label': '常规工具',
  'tools.category.hint': '关闭后一次收起本类别下的全部工具；Kernel 类别不受影响。',
  'tools.perTool.hint': '单个工具的开关。未在此列出的工具默认开启。',
  'tools.pending': '更改会在模型停止生成后生效。系统提示词随之改变，这可能会让提示词缓存失效。',
  'tools.empty': '尚未注册任何工具。',
  'tools.loadError': '无法读取设置。',
} satisfies Record<string, string>

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'tools.nav': 'Tools',
  'tools.intro': 'Turn the tools the model can use on or off. The two categories are independent and can be on at the same time.',
  'tools.group.categories': 'Categories',
  'tools.group.tools': 'Tools',
  'tools.kernel.label': 'Kernel',
  'tools.kernel.hint': 'Run code in a persistent Python namespace, where reading, editing, and searching files are function calls inside it.',
  'tools.category.label': 'Conventional tools',
  'tools.category.hint': 'Turning this off withdraws every tool in the category at once; the Kernel category is unaffected.',
  'tools.perTool.hint': 'Individual tool switches. A tool not listed here is on.',
  'tools.pending': 'Changes apply once the model stops generating. The system prompt changes with them, which can invalidate the prompt cache.',
  'tools.empty': 'No tools are registered.',
  'tools.loadError': 'Could not read settings.',
} satisfies Record<ToolsKey, string>
