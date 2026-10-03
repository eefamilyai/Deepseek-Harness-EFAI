/**
 * The client half: it mounts this package's own Remote namespace from the
 * generated contribution, which is the whole reason the account surface
 * exists as a package the installed Desktop cannot shadow.
 */
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import contribution from '@deepseek-ai/dsh-ai-accounts/remote'
import { apply as mountClient, inject as clientInject } from '../src/client/index.ts'

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
