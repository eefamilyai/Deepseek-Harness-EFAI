/** Accounts-section key union, split out so the dictionary file can import it. */

/** Simplified Chinese key-set source of truth. */
export const zhKeys = {
  'accounts.nav': '',
  'accounts.intro': '',
  'accounts.provider.label': '',
  'accounts.provider.hint': '',
  'accounts.email.label': '',
  'accounts.email.placeholder': '',
  'accounts.mobile.label': '',
  'accounts.mobile.placeholder': '',
  'accounts.areaCode.label': '',
  'accounts.password.label': '',
  'accounts.password.placeholder': '',
  'accounts.submit': '',
  'accounts.submitting': '',
  'accounts.success': '',
  'accounts.empty': '',
  'accounts.noProviders': '',
  'accounts.loadError': '',
  'accounts.needIdentifier': '',
  'accounts.needPassword': '',
} as const

/** The Accounts-section key union. */
export type AccountsKey = keyof typeof zhKeys
