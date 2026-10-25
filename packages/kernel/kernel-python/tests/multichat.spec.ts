/**
 * One kernel per conversation.
 *
 * The provider used to keep a single Python process and one serialization queue
 * for every chat in the harness. Two things followed from that, both observed in
 * real use: a cell that stopped answering in one chat held every other chat's
 * cells behind it (a three-minute `tool_help()` that outlived the session), and
 * every chat's variables were visible to every other chat's cells.
 *
 * These pin the replacement: separate processes, separate queues, and background
 * handles that still name the right kernel when two conversations both detach a
 * cell with the same id.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolvePython } from '../src/index.ts'
import { KilnKernelProvider } from '../src/provider.ts'
import type { KilnKernelProviderOptions } from '../src/provider.ts'
import type { KernelExecuteRequest } from '@deepseek-ai/dsh-kernel'

const SCRIPT = join(import.meta.dirname, 'fixtures', 'conversation-kernel.py')

const python = await resolvePython()
// Skipped rather than failed where no interpreter exists: this package's whole
// job is driving one, so "no Python here" is an environment fact.
const describeWithPython = python === undefined ? describe.skip : describe

/** Directories this file created, removed after each case. */
const temps: string[] = []
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A provider over the state-keeping fixture, in its own directory. */
function provider(overrides: Partial<KilnKernelProviderOptions> = {}): KilnKernelProvider {
  const cwd = mkdtempSync(join(tmpdir(), 'dsh-multichat-'))
  temps.push(cwd)
  return new KilnKernelProvider({
    id: 'multichat-test',
    python: python ?? 'python3',
    script: SCRIPT,
    cwd,
    env: {},
    ...overrides,
  })
}

/** A cell owned by one conversation. */
function cell(conversation: string, code: string): KernelExecuteRequest {
  return {
    code,
    timeoutMs: 20_000,
    agent: { id: conversation, session: { id: conversation } },
  }
}

describeWithPython('one kernel per conversation', () => {
  it('keeps one conversation\'s namespace out of another\'s', async () => {
    const kernels = provider()
    try {
      expect((await kernels.execute(cell('chat-a', 'SET:secret=hunter2'))).output).toBe('set')
      // A different conversation runs in a different process, so it must not see it.
      expect((await kernels.execute(cell('chat-b', 'GET:secret'))).output).toBe('MISSING')
      // And the first conversation still has it.
      expect((await kernels.execute(cell('chat-a', 'GET:secret'))).output).toBe('hunter2')
    } finally {
      await kernels.dispose()
    }
  })

  it('does not hold one conversation behind another conversation\'s slow cell', async () => {
    const kernels = provider()
    try {
      const slow = kernels.execute(cell('chat-slow', 'SLEEP:1500'))
      // Give the slow cell time to reach the child and hold its own queue.
      await new Promise(resolve => setTimeout(resolve, 150))
      const startedAt = Date.now()
      const fast = await kernels.execute(cell('chat-fast', 'GET:anything'))
      const fastMs = Date.now() - startedAt
      expect(fast.output).toBe('MISSING')
      // It answered while the other conversation's cell was still running.
      expect(fastMs).toBeLessThan(1000)
      expect((await slow).output).toBe('slept')
    } finally {
      await kernels.dispose()
    }
  })

  it('still serializes cells within one conversation', async () => {
    const kernels = provider()
    try {
      const order: string[] = []
      await Promise.all([
        kernels.execute(cell('chat-a', 'SET:first=1')).then(() => order.push('set')),
        kernels.execute(cell('chat-a', 'GET:first')).then(result => order.push(`get:${result.output}`)),
      ])
      // The second cell ran after the first, and therefore saw its write.
      expect(order).toEqual(['set', 'get:1'])
    } finally {
      await kernels.dispose()
    }
  })

  it('gives colliding background cell ids distinct, routable handles', async () => {
    const kernels = provider()
    try {
      // Both children number this cell 1; the provider must not confuse them.
      const [a, b] = await Promise.all([
        kernels.execute(cell('chat-a', 'BG')),
        kernels.execute(cell('chat-b', 'BG')),
      ])
      const handleA = a.background?.id
      const handleB = b.background?.id
      expect(handleA).toBeTypeOf('number')
      expect(handleB).toBeTypeOf('number')
      expect(handleA).not.toBe(handleB)
      expect(await kernels.pollBackground(handleA as number)).toMatchObject({ known: true, text: 'bg-done' })
      expect(await kernels.pollBackground(handleB as number)).toMatchObject({ known: true, text: 'bg-done' })
      // An unknown handle is unknown, not another conversation's cell.
      expect(await kernels.pollBackground(99_999)).toEqual({ known: false })
    } finally {
      await kernels.dispose()
    }
  })

  it('reaps a conversation kernel that has sat idle past the window', async () => {
    let now = 0
    const kernels = provider({ idleKernelMs: 1_000, clock: () => now })
    try {
      await kernels.execute(cell('chat-a', 'SET:x=1'))
      now += 5_000
      // The sweep runs on the next call: this conversation starts a fresh kernel.
      expect((await kernels.execute(cell('chat-a', 'GET:x'))).output).toBe('MISSING')
    } finally {
      await kernels.dispose()
    }
  })
})
