/**
 * The Python kernel reaches both tools through its `tools.*` seam: the plugin mounted on
 * a real tool registry lists them with their descriptions, and a kernel call runs one
 * through the registry pipeline. The kernel turns that listing into `tool_help()` lines
 * and generated `desktop_test_instance(...)` / `build_workspace_package(...)` functions.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { dispatchSeam } from '@deepseek-ai/dsh-kernel-python/src/seam.ts'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry from '@deepseek-ai/dsh-tools'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import * as DevTools from '../src/index.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

async function mounted(config: Record<string, unknown> = {}): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRegistry)
  await ctx.plugin(NativeToolExecutor)
  // The loader validates plain config itself; a pre-validated one carries volatile references.
  await ctx.plugin(DevTools, config)
  return ctx
}

it('lists both tools to the kernel with descriptions that say what each is for', async () => {
  const ctx = await mounted()
  const response = await dispatchSeam(ctx, undefined, { id: 'a', op: 'tools.schemas', args: {} })
  expect(response.ok).toBe(true)
  const listed = (response as { value: { name: string; description: string }[] }).value
  const byName = new Map(listed.map(tool => [tool.name, tool.description]))
  expect(byName.get('desktop_test_instance')).toMatch(/^Start, drive, and stop a separate test copy of the installed DeepSeek Harness Desktop app/)
  expect(byName.get('build_workspace_package')).toMatch(/^Build ONE package of the DeepSeek Harness workspace/)
})

it('runs a kernel call through the registry', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-devtools-seam-'))
  roots.push(root)
  writeFileSync(join(root, 'pnpm-workspace.yaml'), '')
  writeFileSync(join(root, 'tsconfig.host.json'), '{}')
  mkdirSync(join(root, 'packages', 'x', 'y'), { recursive: true })
  writeFileSync(join(root, 'packages', 'x', 'y', 'package.json'), '{"name":"@deepseek-ai/dsh-y"}')
  const ctx = await mounted({ repoRoot: root })
  const response = await dispatchSeam(ctx, undefined, {
    id: 'b', op: 'tools.call', args: { name: 'build_workspace_package', arguments: { package: 'y', steps: ['typecheck'] } },
  })
  expect(response.ok).toBe(true)
  const outcome = (response as { value: { isError: boolean; value: { text: string; ok: boolean } } }).value
  expect(outcome.isError).toBe(false)
  expect(outcome.value.ok).toBe(true)
  expect(outcome.value.text).toContain('- typecheck: skipped, no tsconfig.json')
})
