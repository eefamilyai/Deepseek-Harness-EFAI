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
} satisfies Record<AccountsKey, string>
