/**
 * The `aiAccounts` service: the registry of provider routes that pool logins,
 * and the Remote surface a settings page uses to add, inspect, and repair one.
 *
 * A provider that pools accounts registers an {@link AccountAdder} (to create a
 * login) and an {@link AccountAdmin} (to read and repair one). This service owns
 * neither the login nor the credential: it routes the call and, for the Remote
 * face, translates a local failure into a structured `RemoteError` so a browser
 * sees a reason rather than an internal failure.
 *
 * The namespace is its own (`aiAccounts`) rather than a corner of `llm`, so the
 * account surface ships, versions, and fails independently of the model
 * registry it happens to sit beside.
 *
 * ```yaml
 * - id: ai-accounts
 *   name: '@deepseek-ai/dsh-ai-accounts'
 * ```
 *
 * @module @deepseek-ai/dsh-ai-accounts
 */

import { Context } from '@deepseek-ai/cordis'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {
  AccountAddResult, AccountAdder, AccountAdmin, AccountDraft, AccountInfo,
  AccountLogEntry, AccountOpResult,
} from './types.ts'

export * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    aiAccounts: AiAccounts
  }
}

/**
 * The `ctx.aiAccounts` service: the account-pool registry and its Remote face.
 * The service name is the literal the Typert analyzer reads to bind the
 * namespace, so it cannot be factored into a constant.
 */
export class AiAccounts extends TypertRemoteService {
  private accountAdders = new Map<string, AccountAdder>()
  private accountAdmins = new Map<string, AccountAdmin>()

  /**
   * @param ctx - the Host context this service is mounted on.
   */
  constructor(ctx: Context) {
    super(ctx, 'aiAccounts')
  }

  /**
   * Register the handler that tests and adds a login for one account-pooling
   * provider route (`ds_direct` is the only one today). One handler per route,
   * released with the returned disposer. The handler owns making the new login
   * selectable — it re-registers its own routes — so this service only routes
   * the call.
   * @param provider - the provider route that pools logins.
   * @param add - tests a login and, on success, adds it.
   * @returns a disposer that withdraws the handler.
   */
  registerAccountProvider(provider: string, add: AccountAdder): () => void {
    const dispose = this.ctx.effect(function* (this: AiAccounts) {
      if (provider.length === 0) {
        throw new Error('an account provider needs a non-empty route')
      }
      if (this.accountAdders.has(provider)) {
        throw new Error(`an account provider for "${provider}" is already registered`)
      }
      this.accountAdders.set(provider, add)
      yield () => {
        this.accountAdders.delete(provider)
      }
    }.bind(this), 'aiAccounts.registerAccountProvider()')
    return () => void dispose()
  }

  /**
   * Register the account-ADMINISTRATION half of an account-pooling provider:
   * the read an operator surface lists, and the repairs it can ask for. Mirrors
   * {@link registerAccountProvider}: one admin per route, released with the
   * returned disposer, and a provider that pools accounts normally registers
   * both — the adder to create a login, the admin to inspect and repair one.
   * @param provider - the provider route that pools logins.
   * @param admin - the read and repair operations for that route's logins.
   * @returns a disposer that withdraws the admin.
   */
  registerAccountAdmin(provider: string, admin: AccountAdmin): () => void {
    const dispose = this.ctx.effect(function* (this: AiAccounts) {
      if (provider.length === 0) {
        throw new Error('an account admin needs a non-empty route')
      }
      if (this.accountAdmins.has(provider)) {
        throw new Error(`an account admin for "${provider}" is already registered`)
      }
      this.accountAdmins.set(provider, admin)
      yield () => {
        this.accountAdmins.delete(provider)
      }
    }.bind(this), 'aiAccounts.registerAccountAdmin()')
    return () => void dispose()
  }

  /**
   * The provider routes that accept account additions, for a surface to offer.
   * @returns the registered account-provider routes, in registration order.
   */
  @Remote
  listAccountProviders(): string[] {
    return [...this.accountAdders.keys()]
  }

  /**
   * Test a login for one account-pooling provider and, on success, make it a
   * selectable route. The password is used only for the test and never stored
   * or returned here — the reply is the account id and its route, or a reason.
   * @param provider - the provider route that pools logins.
   * @param account - the login to test.
   * @returns the added account and route, or the failure reason.
   * @throws RemoteError with `aiAccounts/account-rejected` when no route pools
   *   accounts, or when the draft is missing a password or an email/mobile.
   */
  @Remote
  async addAccount(provider: string, account: AccountDraft): Promise<AccountAddResult> {
    try {
      const add = this.accountAdders.get(provider)
      if (add === undefined) {
        throw new Error(`no account provider is registered for "${provider}"`)
      }
      if (account.password.length === 0) {
        throw new Error('an account needs a password to test the login')
      }
      if ((account.email ?? '').length === 0 && (account.mobile ?? '').length === 0) {
        throw new Error('an account needs an email or a mobile number')
      }
      return await add(account)
    } catch (error: unknown) {
      throw new RemoteError(
        'aiAccounts/account-rejected',
        error instanceof Error ? error.message : String(error),
        { provider },
        { cause: error },
      )
    }
  }

  /**
   * Every login one provider pools, for an operator surface to list and expand.
   * @param provider - the provider route that pools logins.
   * @returns one row per login, in the provider's own order.
   * @throws RemoteError with `aiAccounts/account-rejected` when no route pools accounts.
   */
  @Remote
  async listAccounts(provider: string): Promise<AccountInfo[]> {
    try {
      return [...await this.accountAdmin(provider).list()]
    } catch (error: unknown) {
      throw this.rejected(error, { provider })
    }
  }

  /**
   * Re-authenticate one login, so a session that has gone stale works again.
   * @param provider - the provider route that pools logins.
   * @param account - the login id to re-authenticate.
   * @returns whether the login now works, or a plain reason it does not.
   * @throws RemoteError with `aiAccounts/account-rejected` when no route pools accounts.
   */
  @Remote
  async reloginAccount(provider: string, account: string): Promise<AccountOpResult> {
    try {
      if (account.length === 0) throw new Error('relogin needs an account id')
      return await this.accountAdmin(provider).relogin(account)
    } catch (error: unknown) {
      throw this.rejected(error, { provider, account })
    }
  }

  /**
   * Replace one login's browser identity, so it presents as a different device.
   * The repair for a flagged fingerprint is a NEW identity, not the same one.
   * @param provider - the provider route that pools logins.
   * @param account - the login id to re-profile.
   * @returns whether a fresh identity is in place, or a plain reason it is not.
   * @throws RemoteError with `aiAccounts/account-rejected` when no route pools accounts.
   */
  @Remote
  async reprofileAccount(provider: string, account: string): Promise<AccountOpResult> {
    try {
      if (account.length === 0) throw new Error('reprofile needs an account id')
      return await this.accountAdmin(provider).reprofile(account)
    } catch (error: unknown) {
      throw this.rejected(error, { provider, account })
    }
  }

  /**
   * Forget one login, or one orphaned identity, from a provider's list.
   * @param provider - the provider route that pools logins.
   * @param account - the login id to forget; '' when only a slug is known.
   * @param slug - the profile slug, which is all an orphan carries.
   * @param purge - also delete the browser profile.
   * @returns whether the entry is gone, or a plain reason it is not.
   * @throws RemoteError with `aiAccounts/account-rejected` when no route pools accounts.
   */
  @Remote
  async removeAccount(
    provider: string,
    account: string,
    slug: string,
    purge: boolean,
  ): Promise<AccountOpResult> {
    try {
      if (account.length === 0 && slug.length === 0) {
        throw new Error('remove needs an account id or a profile slug')
      }
      return await this.accountAdmin(provider).remove(account, slug, purge)
    } catch (error: unknown) {
      throw this.rejected(error, { provider, account })
    }
  }

  /**
   * The debug trail recorded since a sequence number, oldest first. Every entry
   * names its account, which is what makes two logins running at once legible.
   * @param provider - the provider route that pools logins.
   * @param since - return only entries with a higher sequence number.
   * @returns the entries, in recording order.
   * @throws RemoteError with `aiAccounts/account-rejected` when no route pools accounts.
   */
  @Remote
  async accountLog(provider: string, since: number): Promise<AccountLogEntry[]> {
    try {
      return [...await this.accountAdmin(provider).log(since)]
    } catch (error: unknown) {
      throw this.rejected(error, { provider })
    }
  }

  /**
   * Resolve the admin for a route, or fail naming the route.
   * @param provider - the provider route that pools logins.
   * @returns the registered admin.
   */
  private accountAdmin(provider: string): AccountAdmin {
    const admin = this.accountAdmins.get(provider)
    if (admin === undefined) {
      throw new Error(`no account admin is registered for "${provider}"`)
    }
    return admin
  }

  /**
   * Wrap a local failure as the namespace's structured Remote refusal.
   * @param error - the caught failure.
   * @param details - the route, and the account when one was named.
   * @returns the error to throw.
   */
  private rejected(error: unknown, details: { provider: string; account?: string }): RemoteError {
    return new RemoteError(
      'aiAccounts/account-rejected',
      error instanceof Error ? error.message : String(error),
      details,
      { cause: error },
    )
  }
}

export default AiAccounts
