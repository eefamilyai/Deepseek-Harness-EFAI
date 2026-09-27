/** Accounts-section copy: the login form, its hints, and its outcomes. */

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Accounts-section copy: the add-login form and its outcomes. */
    accounts: AccountsKey
  }
}

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'accounts.nav': '账号',
  'accounts.intro': '直接在这里添加 DeepSeek 网页版账号，不必手工编辑 ds_config.json。密码只用于验证登录，不会被保存或回显。',
  'accounts.provider.label': '账号池',
  'accounts.provider.hint': '接受新登录的提供方路由。',
  'accounts.email.label': '邮箱',
  'accounts.email.placeholder': 'you@example.com',
  'accounts.mobile.label': '手机号',
  'accounts.mobile.placeholder': '13800138000',
  'accounts.areaCode.label': '区号',
  'accounts.password.label': '密码',
  'accounts.password.placeholder': '登录密码',
  'accounts.submit': '添加账号',
  'accounts.submitting': '正在验证登录…',
  'accounts.success': '已添加账号，并生成对应路由。',
  'accounts.empty': '请填写邮箱或手机号。',
  'accounts.noProviders': '当前没有可添加账号的提供方。请先在模型设置中登录 DeepSeek。',
  'accounts.loadError': '无法读取提供方列表。',
  'accounts.needIdentifier': '请填写邮箱或手机号。',
  'accounts.needPassword': '请填写密码。',
  'accounts.list.title': '已有账号',
  'accounts.list.hint': '每个账号各自的设备标识与浏览器配置文件。展开可查看全部身份字段。',
  'accounts.list.empty': '还没有任何账号。',
  'accounts.list.loadError': '无法读取账号列表。',
  'accounts.list.refresh': '刷新',
  'accounts.list.expand': '展开',
  'accounts.list.collapse': '收起',
  'accounts.list.configured': '已配置',
  'accounts.list.orphan': '未配置',
  'accounts.relogin': '重新登录',
  'accounts.relogin.busy': '正在重新登录…',
  'accounts.relogin.ok': '已重新登录。',
  'accounts.reprofile': '重建配置文件',
  'accounts.reprofile.busy': '正在重建配置文件…',
  'accounts.reprofile.ok': '已生成新的设备身份与配置文件。',
  'accounts.reprofile.warn': '会删除该账号现有的浏览器配置文件，并生成新的设备标识。',
  'accounts.log.title': '账号调试日志',
  'accounts.log.hint': '每个账号的登录、重新登录与重建记录，用于同时运行多个账号时排查问题。',
  'accounts.log.empty': '暂无日志。',
  'accounts.log.clear': '清空显示',
} satisfies Record<string, string>

/** The section's key union: the zh dictionary's key set. */
export type AccountsKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'accounts.nav': 'Accounts',
  'accounts.intro': 'Add a DeepSeek web login here instead of editing ds_config.json by hand. The password is used only to test the login and is never stored or echoed back.',
  'accounts.provider.label': 'Account pool',
  'accounts.provider.hint': 'The provider route that accepts new logins.',
  'accounts.email.label': 'Email',
  'accounts.email.placeholder': 'you@example.com',
  'accounts.mobile.label': 'Mobile',
  'accounts.mobile.placeholder': '13800138000',
  'accounts.areaCode.label': 'Area code',
  'accounts.password.label': 'Password',
  'accounts.password.placeholder': 'Login password',
  'accounts.submit': 'Add account',
  'accounts.submitting': 'Testing the login…',
  'accounts.success': 'Account added, and its route is now selectable.',
  'accounts.empty': 'Enter an email or a mobile number.',
  'accounts.noProviders': 'No provider accepts accounts right now. Sign in to DeepSeek in the Models settings first.',
  'accounts.loadError': 'Could not read the provider list.',
  'accounts.needIdentifier': 'Enter an email or a mobile number.',
  'accounts.needPassword': 'Enter the password.',
  'accounts.list.title': 'Existing accounts',
  'accounts.list.hint': 'Each account owns its own device identity and browser profile. Expand one to see every identity field.',
  'accounts.list.empty': 'No accounts yet.',
  'accounts.list.loadError': 'Could not read the account list.',
  'accounts.list.refresh': 'Refresh',
  'accounts.list.expand': 'Expand',
  'accounts.list.collapse': 'Collapse',
  'accounts.list.configured': 'Configured',
  'accounts.list.orphan': 'Unconfigured',
  'accounts.relogin': 'Relogin',
  'accounts.relogin.busy': 'Relogging in…',
  'accounts.relogin.ok': 'Logged in again.',
  'accounts.reprofile': 'Reprofile',
  'accounts.reprofile.busy': 'Reprofiling…',
  'accounts.reprofile.ok': 'A fresh device identity and profile are in place.',
  'accounts.reprofile.warn': 'Deletes this account\u2019s browser profile and mints a new device identity.',
  'accounts.log.title': 'Account debug log',
  'accounts.log.hint': 'Login, relogin, and reprofile activity per account, for telling two logins apart when both run at once.',
  'accounts.log.empty': 'No log entries yet.',
  'accounts.log.clear': 'Clear view',
} satisfies Record<AccountsKey, string>
