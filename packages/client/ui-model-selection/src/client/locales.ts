/**
 * `model` namespace dictionaries.
 *
 * `trigger.selectAria` intentionally matches `trigger.fallback` but remains a
 * separate key: the visible fallback label and the accessible name of
 * an unset trigger are free to diverge per locale, and folding it into
 * `trigger.aria` would announce the degenerate "Select model, current Select
 * model".
 */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'provider.account': 'DeepSeek 账号',
  'command.label': '模型',
  'command.description': '选择本会话使用的模型',
  'option.loadError': '目录加载失败：{message}',
  'trigger.fallback': '请选择模型',
  'trigger.loading': '正在加载模型…',
  'trigger.selectAria': '请选择模型',
  'trigger.aria': '选择模型，当前 {model}',
  'trigger.ariaEffort': '选择模型，当前 {model}，推理等级 {effort}',
  'menu.aria': '模型与推理等级',
  'menu.model': '模型',
  'menu.effort': '推理等级',
  'effort.providerDefault': 'Default',
  'status.loading': '正在刷新模型列表…',
  'error.action': '模型操作失败：{message}',
  'error.sessionInUse': '当前会话已被占用，可能是其他正在运行的 DSH 导致的（如其他 dsh web、桌面端），请退出其他正在运行的 DSH 后重试。',
  'action.reload': '重新加载',
  'warning.groupLoad': '{name} 加载失败：{message}',
  'search.placeholder': '搜索模型…',
  'search.clear': '清除搜索',
  'search.empty': '没有匹配的模型。',
  'empty.models': '没有可用的模型。',
  'empty.efforts': '当前模型未提供推理等级。',
  // DSH-FORK(browser): fork edit on an upstream-owned file. EXIT: upstream ships account-route copy.
  'provider.accounts': '{count} 个账号',
  'provider.models': '{count} 个模型',
  'provider.noModels': '未查询到模型',
  'provider.configure': '请在设置中配置该提供方以加载模型。',
  'account.add': '添加账号',
  'account.needEmail': '请先输入邮箱。',
  'account.needPassword': '请先输入密码。',
  'account.testing': '正在测试登录…',
  'account.added': '已添加 {account}，在上方点击即可使用。',
  'account.failed': '登录测试失败。',
  'account.emailPlaceholder': 'name@company.com',
  'account.passwordPlaceholder': '密码',
  'account.testAdd': '测试并添加',
  'account.cancel': '取消',
  // The unpinned pooled route: no single login is pinned, so it must not read
  // as one of the logins listed around it.
  'account.auto': '自动（任选账号）',
} satisfies Record<string, string>

/** The model namespace key union. */
export type ModelKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'provider.account': 'DeepSeek Account',
  'command.label': 'Model',
  'command.description': 'Select the model for this conversation',
  'option.loadError': 'Catalog failed to load: {message}',
  'trigger.fallback': 'Select model',
  'trigger.loading': 'Loading models…',
  'trigger.selectAria': 'Select model',
  'trigger.aria': 'Select model, current {model}',
  'trigger.ariaEffort': 'Select model, current {model}, reasoning effort {effort}',
  'menu.aria': 'Model and reasoning effort',
  'menu.model': 'Model',
  'menu.effort': 'Effort',
  'effort.providerDefault': 'Default',
  'status.loading': 'Refreshing model list…',
  'error.action': 'Model operation failed: {message}',
  'error.sessionInUse': 'This session is already in use, possibly by another running DSH instance (such as dsh web or the desktop app). Quit other running DSH instances and try again.',
  'action.reload': 'Reload',
  'warning.groupLoad': '{name} failed to load: {message}',
  'search.placeholder': 'Search models…',
  'search.clear': 'Clear search',
  'search.empty': 'No matching models.',
  'empty.models': 'No models available.',
  'empty.efforts': 'This model provides no reasoning effort levels.',
  'provider.accounts': '{count} accounts',
  'provider.models': '{count} models',
  'provider.noModels': 'No models yet',
  'provider.configure': 'Configure this provider in Settings to load its models.',
  'account.add': 'Add account',
  'account.needEmail': 'Enter an email first.',
  'account.needPassword': 'Enter a password first.',
  'account.testing': 'Testing sign-in…',
  'account.added': 'Added {account} — tap it above to use it.',
  'account.failed': 'The login test failed.',
  'account.emailPlaceholder': 'name@company.com',
  'account.passwordPlaceholder': 'Password',
  'account.testAdd': 'Test and add',
  'account.cancel': 'Cancel',
  'account.auto': 'Automatic (any account)',
} satisfies Record<ModelKey, string>
