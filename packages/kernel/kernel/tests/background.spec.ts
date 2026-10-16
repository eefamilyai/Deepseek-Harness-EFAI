/**
 * The kernel service forwards a backgrounded cell's poll and stop to the
 * resolved backend as method calls. A real backend is a class whose methods
 * read `this`; called detached, every backgrounded cell ended in "Cannot read
 * properties of undefined (reading 'control')" and its output was lost.
 */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { KernelRuntime } from '../src/index.ts'
import type { KernelBackgroundPoll, KernelExecuteResult, KernelProvider } from '../src/index.ts'

/** A class-based backend whose poll and stop depend on `this`, like the Python kernel. */
class ClassProvider implements KernelProvider {
  readonly id = 'class'
  readonly stopped: number[] = []
  private readonly control = async (message: { cmd: string; id: number }): Promise<KernelBackgroundPoll> => {
    if (message.cmd === 'stop') this.stopped.push(message.id)
    return { known: true, running: false, text: `cell ${String(message.id)} done` }
  }

  available(): boolean { return true }
  async execute(): Promise<KernelExecuteResult> { return { output: '', outcome: 'ok' } as KernelExecuteResult }
  async restart(): Promise<void> {}
  async names(): Promise<readonly string[]> { return [] }
  async pollBackground(id: number): Promise<KernelBackgroundPoll> { return await this.control({ cmd: 'poll', id }) }
  async stopBackground(id: number): Promise<void> { await this.control({ cmd: 'stop', id }) }
}

async function runtimeWith(provider: KernelProvider): Promise<KernelRuntime> {
  const ctx = new Context()
  const kernel = new KernelRuntime(ctx)
  kernel.registerProvider(provider)
  return kernel
}

describe('background cells', () => {
  it('polls and stops through the backend as method calls, keeping its this', async () => {
    const provider = new ClassProvider()
    const kernel = await runtimeWith(provider)
    expect(await kernel.pollBackground(4)).toEqual({ known: true, running: false, text: 'cell 4 done' })
    await kernel.stopBackground(5)
    expect(provider.stopped).toEqual([5])
  })

  it('reports a backend without the capability as unknown, and ignores a stop', async () => {
    const bare: KernelProvider = {
      id: 'bare', available: () => true, execute: async () => ({ output: '', outcome: 'ok' }) as KernelExecuteResult,
      restart: async () => {}, names: async () => [],
    }
    const kernel = await runtimeWith(bare)
    expect(await kernel.pollBackground(1)).toEqual({ known: false })
    await expect(kernel.stopBackground(1)).resolves.toBeUndefined()
  })
})
