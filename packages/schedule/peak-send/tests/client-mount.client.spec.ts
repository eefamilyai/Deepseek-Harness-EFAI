/**
 * The client half: it mounts this package's own Remote namespace from the
 * generated contribution, so the installed Desktop's shared assembly never
 * has to know the `peakSend` surface exists.
 */
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import contribution from '@deepseek-ai/dsh-peak-send/remote'
import { apply as mountClient, inject as clientInject } from '../src/client/index.ts'

describe('peak-send client half', () => {
  it('requires the remote service and mounts this package its own namespace', async () => {
    expect(clientInject).toEqual(['remote'])
    const mount = vi.fn(async () => async () => {})
    const ctx: Context = { remote: { $mount: mount } } as never

    await mountClient(ctx)

    expect(mount).toHaveBeenCalledTimes(1)
    expect(mount).toHaveBeenCalledWith(contribution)
  })
})
