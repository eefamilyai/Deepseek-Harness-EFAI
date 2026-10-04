/** Tools-section copy: the availability switches, the per-tool roster, the Python
 * kernel, the browser tools, and the notices. */

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Tools-section copy: the switches and the notices. */
    tools: ToolsKey
  }
}

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'tools.nav': '工具',
  'tools.intro': '打开或关闭模型可以使用的工具。Kernel 与常规工具彼此独立，可以同时开启。',
  'tools.kernel.label': 'Kernel',
  'tools.kernel.hint': '在持久 Python 命名空间中运行代码，读取、编辑、搜索文件都是其中的函数调用。',
  'tools.category.label': '常规工具',
  'tools.category.hint': '关闭后一次收起全部常规工具，模型只能通过 Kernel 行动；Kernel 不受影响。',
  'tools.roster.title': '单个工具',
  'tools.roster.hint': '每个工具一个开关。清单来自实际装载的工具，改动同样在模型停止生成后生效。',
  'tools.roster.filter': '筛选工具…',
  'tools.roster.empty': '没有匹配的工具。',
  'tools.pending': '更改会在模型停止生成后生效。系统提示词随之改变，这可能会让提示词缓存失效。',
  'tools.loadError': '无法读取设置。',
  'tools.writeError': '无法保存设置。',
  'tools.availability.title': '可用性',
  'tools.availability.hint': '这些开关决定模型能看到哪些工具。',
  'tools.python.title': 'Python Kernel',
  'tools.python.hint': 'Kernel 进程的行为。改动在下次启动 Kernel 时生效。',
  'tools.python.window.label': '显示 Kernel 窗口',
  'tools.python.window.hint': '让 Kernel 的浏览器窗口保持可见，便于观察它正在做什么。',
  'tools.browser.title': '浏览器工具',
  'tools.browser.hint': '网页抓取与浏览器操作的超时和输出上限。',
  'tools.browser.headless.label': '无头运行',
  'tools.browser.headless.hint': '关闭后浏览器窗口可见，便于手工排查页面问题。',
  'tools.browser.fetch.label': '内置抓取',
  'tools.browser.fetch.hint': '允许常规抓取工具直接取回页面，不必启动浏览器。',
  'tools.browser.navigation.label': '导航超时',
  'tools.browser.navigation.hint': '打开一个页面允许等待的毫秒数。',
  'tools.browser.action.label': '操作超时',
  'tools.browser.action.hint': '点击、输入等单步操作允许等待的毫秒数。',
  'tools.browser.text.label': '文本上限',
  'tools.browser.text.hint': '一次取回页面的最大字符数，超出部分会被截断。',
  'tools.browser.output.label': '输出上限',
  'tools.browser.output.hint': '一次工具结果的最大字符数。',
  'tools.browser.userAgent.label': 'User-Agent',
  'tools.browser.userAgent.hint': '浏览器请求使用的标识字符串。',
  'tools.seconds': '毫秒',
  'tools.browser.missing': '此部署没有装载浏览器工具。',
  'tools.python.missing': '此部署没有装载 Python Kernel。',
} satisfies Record<string, string>

/** The section's key union: the zh dictionary's key set. */
export type ToolsKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'tools.nav': 'Tools',
  'tools.intro': 'Turn the tools the model can use on or off. The kernel and the conventional tools are independent and can be on at the same time.',
  'tools.kernel.label': 'Kernel',
  'tools.kernel.hint': 'Run code in a persistent Python namespace, where reading, editing, and searching files are function calls inside it.',
  'tools.category.label': 'Conventional tools',
  'tools.category.hint': 'Turning this off withdraws every conventional tool at once, leaving the kernel as the only way to act; the kernel is unaffected.',
  'tools.roster.title': 'Individual tools',
  'tools.roster.hint': 'One switch per tool, listed from what this deployment actually mounts. Changes apply once the model stops generating, like the switches above.',
  'tools.roster.filter': 'Filter tools…',
  'tools.roster.empty': 'No tool matches.',
  'tools.pending': 'Changes apply once the model stops generating. The system prompt changes with them, which can invalidate the prompt cache.',
  'tools.loadError': 'Could not read settings.',
  'tools.writeError': 'Could not save the setting.',
  'tools.availability.title': 'Availability',
  'tools.availability.hint': 'What the model can see at all.',
  'tools.python.title': 'Python kernel',
  'tools.python.hint': 'How the kernel process behaves. Changes take effect the next time it starts.',
  'tools.python.window.label': 'Show the kernel window',
  'tools.python.window.hint': 'Leave the kernel browser window visible, so you can watch what it does.',
  'tools.browser.title': 'Browser tools',
  'tools.browser.hint': 'Timeouts and output caps for fetching and browsing pages.',
  'tools.browser.headless.label': 'Run headless',
  'tools.browser.headless.hint': 'Off shows the browser window, for inspecting a page by hand.',
  'tools.browser.fetch.label': 'Direct fetch',
  'tools.browser.fetch.hint': 'Let the fetch tool retrieve a page without starting a browser.',
  'tools.browser.navigation.label': 'Navigation timeout',
  'tools.browser.navigation.hint': 'How long opening one page may take.',
  'tools.browser.action.label': 'Action timeout',
  'tools.browser.action.hint': 'How long one click or keystroke may take.',
  'tools.browser.text.label': 'Text cap',
  'tools.browser.text.hint': 'Most characters one page read returns; the rest is truncated.',
  'tools.browser.output.label': 'Output cap',
  'tools.browser.output.hint': 'Most characters one tool result may carry.',
  'tools.browser.userAgent.label': 'User-Agent',
  'tools.browser.userAgent.hint': 'The identity string browser requests use.',
  'tools.seconds': 'ms',
  'tools.browser.missing': 'This deployment composes no browser tools.',
  'tools.python.missing': 'This deployment composes no Python kernel.',
} satisfies Record<ToolsKey, string>
