/**
 * What the provider does with a kernel that dies while starting.
 *
 * A child that never reached its ready frame never executed the cell, so the
 * safe recovery is to try again in a fresh process. Before this, such a child
 * produced "Kernel crashed mid-run" for every cell in a row — the failure that
 * made `tool_help()` unusable and took the whole Python surface with it — even
 * though no cell source had run once.
 *
 * The complementary half matters just as much: a child that DID become ready
 * and then died gives no such guarantee, so it is reported rather than retried.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolvePython } from '../src/index.ts'
import { KilnKernelProvider } from '../src/provider.ts'

const FIXTURES = join(import.meta.dirname, 'fixtures')
const RETRY_SCRIPT = join(FIXTURES, 'exit-before-ready.py')
const FAKE_SCRIPT = join(FIXTURES, 'fake-kernel.py')

const python = await resolvePython()
// Skipped rather than failed where no interpreter exists: this package's whole
// job is driving one, so "no Python here" is an environment fact.
const describeWithPython = python === undefined ? describe.skip : describe

/** A provider over one fixture, in its own temporary working directory. */
function providerFor(script: string, env: Record<string, string> = {}): KilnKernelProvider {
  const cwd = mkdtempSync(join(tmpdir(), 'dsh-kernel-retry-'))
  return new KilnKernelProvider({
    id: 'retry-test',
    python: python ?? 'python3',
    script,
    cwd,
    env: { ...env, DSH_TEST_CWD: cwd },
  })
}

describeWithPython('kernel start-up retry', () => {
  it('retries once when the child died before its ready frame', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'dsh-kernel-retry-'))
    const marker = join(cwd, 'failed-once')
    const provider = new KilnKernelProvider({
      id: 'retry-test',
      python: python ?? 'python3',
      script: RETRY_SCRIPT,
      cwd,
      env: { DSH_TEST_FAIL_ONCE: marker },
    })
    try {
      const result = await provider.execute({ code: 'ECHO:hello', timeoutMs: 30_000 })
      // The first start really failed, so the successful cell proves a retry.
      expect(existsSync(marker)).toBe(true)
      expect(readFileSync(marker, 'utf8')).toContain('first start failed')
      expect(result.outcome).toBe('ok')
      expect(result.restarted).toBe(false)
      expect(result.output).toContain('second-start:ECHO:hello')
    } finally {
      await provider.dispose()
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('reports a crash that happened after the kernel was ready, without retrying', async () => {
    const provider = providerFor(FAKE_SCRIPT)
    try {
      // EXIT makes the ready child die without answering the cell.
      const result = await provider.execute({ code: 'EXIT', timeoutMs: 30_000 })
      expect(result.outcome).toBe('crashed')
      expect(result.restarted).toBe(true)
      expect(result.output).toContain('Kernel crashed mid-run')
    } finally {
      await provider.dispose()
    }
  })
})
