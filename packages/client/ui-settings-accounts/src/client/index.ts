/**
 * Accounts settings section, browser half.
 *
 * Registers one `settings.section` entry that adds a DeepSeek web login from
 * the UI. The Host calls go through the `llm` Remote namespace: `listAccountProviders`
 * names the routes that pool accounts, and `addAccount` tests one login and, on
 * success, persists it and publishes its new per-login route so the model
 * picker can select it.
 *
 * Nothing here knows what an account is beyond the draft the wire takes, so a
 * second account-pooling provider appears without a change to this file.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the ctx.remote merge and its fixed Host facts.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
// Type-only: pulls ctx.locale into this program.
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: the settings slot declarations plus the ctx.settingsScope merge.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { AccountsSection } from './AccountsSection.tsx'
import type { AccountsSectionInjected } from './AccountsSection.tsx'
import { en, zh } from './locales.ts'

export type { AccountsKey } from './locales.ts'
export type { AccountsSectionComponentProps, AccountsSectionInjected } from './AccountsSection.tsx'

/** Dictionary namespace owned by this plugin. */
const NS = 'accounts'

/** Stable section id used by the settings navigation ledger. */
const SECTION_ID = 'accounts'

/**
 * Required services (cordis fiber inject). The target slot is declared by
 * ui-settings' apply, whose activation order relative to this one is NOT
 * constrained; the registration depends on it through `slots.inject()`.
 */
export const inject = ['slots', 'locale', 'remote', 'remote.llm']

/**
 * Register the Accounts section once its slot declaration is on the ledger.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-settings-accounts: dictionaries')
  const t = ctx.locale.bind(NS)

  const injected = (): AccountsSectionInjected => ({
    listProviders: async () => {
      const result = await ctx.remote.llm.listAccountProviders()
      return result.ok ? result.value : undefined
    },
    addAccount: async (provider, account) => {
      const result = await ctx.remote.llm.addAccount(provider, account)
      if (!result.ok) return { ok: false, message: result.error.message }
      // A refused login answers `ok: false` in the payload rather than as a
      // Remote failure, so the reason rides through untouched.
      return result.value.ok
        ? { ok: true, ...result.value.account === undefined ? {} : { account: result.value.account } }
        : { ok: false, message: result.value.message ?? t('accounts.needIdentifier') }
    },
  })

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: SECTION_ID,
    order: 30,
    label: () => t('accounts.nav'),
    locale: NS,
    inject: injected,
  }, AccountsSection))
}
