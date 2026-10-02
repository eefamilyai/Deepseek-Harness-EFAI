import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { RemoteError, remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import contribution from '@deepseek-ai/dsh-ai-accounts/remote'
import AiAccounts from '../src/index.ts'
import { apply as mountClient, inject as clientInject } from '../src/client/index.ts'
import type { AccountAdmin, AccountDraft, AccountInfo, AccountLogEntry } from '../src/types.ts'

/** Every Context a test mounted, disposed in reverse so no fiber outlives its test. */
const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
})

/** Mount the service on a fresh Context and hand back both halves. */
async function harness(): Promise<{ ctx: Context; service: AiAccounts }> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(AiAccounts)
  return { ctx, service: ctx.aiAccounts }
}

/** One draft that passes local validation. */
const draft: AccountDraft = { email: 'operator@example.com', password: 'tested-not-stored' }

/** An info row, as a provider reports one. */
const info: AccountInfo = {
  id: 'acct-1', slug: 'profile-1', provider: 'kiln-deepseek', label: 'acct-1',
  configured: true, fields: [{ label: 'X device id', value: 'abc' }],
}

/** A log entry, as a provider records one. */
const entry: AccountLogEntry = {
  seq: 4, at: 1_790_000_000, account: 'acct-1', event: 'login', level: 'info', detail: 'tested',
}

/** An admin whose every operation succeeds, with spies for the routing assertions. */
function workingAdmin(): AccountAdmin & { readonly calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    list: async () => { calls.push('list'); return [info] },
    relogin: async (account: string) => { calls.push(`relogin:${account}`); return { ok: true } },
    reprofile: async (account: string) => { calls.push(`reprofile:${account}`); return { ok: true } },
    remove: async (account: string, slug: string, purge: boolean) => {
      calls.push(`remove:${account}:${slug}:${String(purge)}`)
      return { ok: true }
    },
    log: async (since: number) => { calls.push(`log:${String(since)}`); return [entry] },
  }
}

/** The structured refusal one call rejected with. */
async function rejection(call: Promise<unknown>): Promise<RemoteError> {
  try {
    await call
  } catch (error: unknown) {
    if (error instanceof RemoteError) return error
    throw error
  }
  throw new Error('expected the call to be rejected')
}

describe('ai-accounts service', () => {
  it('mounts as ctx.aiAccounts and publishes its Remote methods in declaration order', async () => {
    const { service } = await harness()
    expect(service).toBeInstanceOf(AiAccounts)
    expect(remoteMethods(service).map(marker => marker.method)).toEqual([
      'listAccountProviders', 'addAccount', 'listAccounts', 'reloginAccount',
      'reprofileAccount', 'removeAccount', 'accountLog',
    ])
  })

  it('names registered routes in registration order and withdraws one on disposal', async () => {
    const { service } = await harness()
    expect(service.listAccountProviders()).toEqual([])

    const first = service.registerAccountProvider('kiln-deepseek', async () => ({ ok: true }))
    service.registerAccountProvider('second-route', async () => ({ ok: true }))
    expect(service.listAccountProviders()).toEqual(['kiln-deepseek', 'second-route'])

    first()
    expect(service.listAccountProviders()).toEqual(['second-route'])
  })

  it('refuses an empty route, and a second handler or admin for one route', async () => {
    const { service } = await harness()
    expect(() => service.registerAccountProvider('', async () => ({ ok: true })))
      .toThrow('an account provider needs a non-empty route')
    expect(() => service.registerAccountAdmin('', workingAdmin()))
      .toThrow('an account admin needs a non-empty route')

    service.registerAccountProvider('kiln-deepseek', async () => ({ ok: true }))
    expect(() => service.registerAccountProvider('kiln-deepseek', async () => ({ ok: true })))
      .toThrow('an account provider for "kiln-deepseek" is already registered')
    service.registerAccountAdmin('kiln-deepseek', workingAdmin())
    expect(() => service.registerAccountAdmin('kiln-deepseek', workingAdmin()))
      .toThrow('an account admin for "kiln-deepseek" is already registered')
  })

  it('drops a route registration when its mounting fiber is disposed', async () => {
    const { ctx, service } = await harness()
    service.registerAccountAdmin('kiln-deepseek', workingAdmin())
    await ctx.fiber.dispose()
    expect((await rejection(service.listAccounts('kiln-deepseek'))).message)
      .toBe('no account admin is registered for "kiln-deepseek"')
  })

  it('adds a login through the route that pools accounts', async () => {
    const { service } = await harness()
    const seen: AccountDraft[] = []
    service.registerAccountProvider('kiln-deepseek', async (account) => {
      seen.push(account)
      return { ok: true, account: 'acct-1', route: 'kiln-deepseek@acct-1' }
    })

    await expect(service.addAccount('kiln-deepseek', draft)).resolves.toEqual({
      ok: true, account: 'acct-1', route: 'kiln-deepseek@acct-1',
    })
    expect(seen).toEqual([draft])
  })

  it('refuses an unknown route and an unusable draft without calling any provider', async () => {
    const { service } = await harness()
    const adder = vi.fn(async () => ({ ok: true }))
    service.registerAccountProvider('kiln-deepseek', adder)

    const unknown = await rejection(service.addAccount('not-a-route', draft))
    expect(unknown.code).toBe('aiAccounts/account-rejected')
    expect(unknown.details).toEqual({ provider: 'not-a-route' })
    expect(unknown.message).toBe('no account provider is registered for "not-a-route"')

    const noPassword = await rejection(service.addAccount('kiln-deepseek', { email: 'a@b.c', password: '' }))
    expect(noPassword.message).toBe('an account needs a password to test the login')
    const noIdentity = await rejection(service.addAccount('kiln-deepseek', { password: 'pw' }))
    expect(noIdentity.message).toBe('an account needs an email or a mobile number')
    expect(adder).not.toHaveBeenCalled()
  })

  it('reports a provider failure as the namespace refusal, never the credential', async () => {
    const { service } = await harness()
    service.registerAccountProvider('kiln-deepseek', async () => {
      throw new Error('the login was rejected')
    })

    const failure = await rejection(service.addAccount('kiln-deepseek', draft))
    expect(failure.code).toBe('aiAccounts/account-rejected')
    expect(failure.message).toBe('the login was rejected')
    expect(failure.details).toEqual({ provider: 'kiln-deepseek' })
  })

  it('routes every admin operation to the registered admin', async () => {
    const { service } = await harness()
    const admin = workingAdmin()
    service.registerAccountAdmin('kiln-deepseek', admin)

    await expect(service.listAccounts('kiln-deepseek')).resolves.toEqual([info])
    await expect(service.reloginAccount('kiln-deepseek', 'acct-1')).resolves.toEqual({ ok: true })
    await expect(service.reprofileAccount('kiln-deepseek', 'acct-1')).resolves.toEqual({ ok: true })
    await expect(service.removeAccount('kiln-deepseek', 'acct-1', 'profile-1', true)).resolves.toEqual({ ok: true })
    await expect(service.accountLog('kiln-deepseek', 3)).resolves.toEqual([entry])
    expect(admin.calls).toEqual([
      'list', 'relogin:acct-1', 'reprofile:acct-1', 'remove:acct-1:profile-1:true', 'log:3',
    ])
  })

  it('refuses an admin operation for a route with no admin', async () => {
    const { service } = await harness()
    const failure = await rejection(service.listAccounts('kiln-deepseek'))
    expect(failure.code).toBe('aiAccounts/account-rejected')
    expect(failure.message).toBe('no account admin is registered for "kiln-deepseek"')
    expect(failure.details).toEqual({ provider: 'kiln-deepseek' })
  })

  it('validates the account id before an admin operation runs', async () => {
    const { service } = await harness()
    const admin = workingAdmin()
    service.registerAccountAdmin('kiln-deepseek', admin)

    expect((await rejection(service.reloginAccount('kiln-deepseek', ''))).message)
      .toBe('relogin needs an account id')
    expect((await rejection(service.reprofileAccount('kiln-deepseek', ''))).message)
      .toBe('reprofile needs an account id')
    expect((await rejection(service.removeAccount('kiln-deepseek', '', '', false))).message)
      .toBe('remove needs an account id or a profile slug')
    expect(admin.calls).toEqual([])
  })

  it('carries the account into the refusal details when one was named', async () => {
    const { service } = await harness()
    service.registerAccountAdmin('kiln-deepseek', {
      ...workingAdmin(),
      remove: async () => { throw new Error('the profile is in use') },
      log: async () => { throw new Error('the trail is unreadable') },
      list: async () => { throw new Error('the pool is unreadable') },
      relogin: async () => { throw new Error('the login is gone') },
      reprofile: async () => { throw new Error('the identity is pinned') },
    })

    expect((await rejection(service.listAccounts('kiln-deepseek'))).details).toEqual({ provider: 'kiln-deepseek' })
    expect((await rejection(service.reloginAccount('kiln-deepseek', 'acct-1'))).details)
      .toEqual({ provider: 'kiln-deepseek', account: 'acct-1' })
    expect((await rejection(service.reprofileAccount('kiln-deepseek', 'acct-1'))).details)
      .toEqual({ provider: 'kiln-deepseek', account: 'acct-1' })
    expect((await rejection(service.removeAccount('kiln-deepseek', 'acct-1', 'profile-1', false))).details)
      .toEqual({ provider: 'kiln-deepseek', account: 'acct-1' })
    expect((await rejection(service.accountLog('kiln-deepseek', 0))).details).toEqual({ provider: 'kiln-deepseek' })
  })

  it('forgets an orphan by its profile slug alone', async () => {
    const { service } = await harness()
    const admin = workingAdmin()
    service.registerAccountAdmin('kiln-deepseek', admin)

    await expect(service.removeAccount('kiln-deepseek', '', 'profile-1', false)).resolves.toEqual({ ok: true })
    expect(admin.calls).toEqual(['remove::profile-1:false'])
  })
})

describe('ai-accounts client half', () => {
  it('requires the remote service and mounts this package its own namespace', async () => {
    expect(clientInject).toEqual(['remote'])
    const mount = vi.fn(async () => async () => {})
    const ctx = { remote: { $mount: mount } } as unknown as Context

    await mountClient(ctx)

    expect(mount).toHaveBeenCalledTimes(1)
    expect(mount).toHaveBeenCalledWith(contribution)
  })
})
