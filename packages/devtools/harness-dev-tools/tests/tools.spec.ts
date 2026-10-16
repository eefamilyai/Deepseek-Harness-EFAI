/** The two tools' schemas, argument checks, and dispatch, over stand-in instances and packages. */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { DesktopTestInstance } from '../src/desktop-instance.ts'
import { buildRoot, buildWorkspacePackageTool, desktopTestInstanceTool, INSTANCE_ACTIONS } from '../src/tools.ts'
import { apply, Config } from '../src/index.ts'

/** The registered tool, as these specs call it. */
interface Runnable {
  name: string
  description: string
  execute: (args: unknown, exec: unknown) => Promise<{ text: string; ok?: boolean; image?: unknown }>
}

function fakeInstance() {
  return {
    launch: vi.fn(async (fresh: boolean) => `launched fresh=${String(fresh)}`),
    stop: vi.fn(async () => true),
    prepare: vi.fn(async () => 'current'),
    status: vi.fn(async () => ({ running: true, targets: [{ type: 'page', url: 'dsh-app://app/', title: 'H' }] })),
    logTail: vi.fn(() => 'line'),
    evaluate: vi.fn(async (expression: string, target?: string) => `${expression}@${target ?? 'app'}`),
    waitFor: vi.fn(async () => 'true'),
    screenshot: vi.fn(async () => ({ data: new Uint8Array([1]), path: 'C:/shot.png', target: 'page dsh-app://app/' })),
    click: vi.fn(async () => 'button "Send"'),
    type: vi.fn(async () => {}),
    key: vi.fn(async () => {}),
    reload: vi.fn(async () => {}),
  }
}

const exec = (cwd?: string) => ({
  signal: new AbortController().signal,
  agent: { options: {}, session: { header: { cwd }, requestHeader: () => undefined } },
})
const noServices = { get: () => undefined } as unknown as Context

describe('desktop_test_instance', () => {
  const tool = (instance = fakeInstance()) => ({
    instance,
    run: desktopTestInstanceTool(noServices, () => instance as unknown as DesktopTestInstance, 1000) as unknown as Runnable,
  })

  it('describes what it is for in its first sentence, which tool_help shows', () => {
    const { run } = tool()
    expect(run.name).toBe('desktop_test_instance')
    expect(run.description.split('. ')[0]).toContain('separate test copy of the installed DeepSeek Harness Desktop app')
    for (const action of INSTANCE_ACTIONS) expect(run.description).toContain(action)
  })

  it('dispatches each action to the instance', async () => {
    const { instance, run } = tool()
    expect((await run.execute({ action: 'launch', fresh: true }, exec())).text).toBe('launched fresh=true')
    expect((await run.execute({ action: 'eval', expression: 'document.title', target: 'webview' }, exec())).text).toBe('document.title@webview')
    expect((await run.execute({ action: 'click', x: 10, y: 20 }, exec())).text).toBe('clicked (10, 20) on button "Send"')
    await run.execute({ action: 'type', text: 'hi' }, exec())
    await run.execute({ action: 'key', key: 'Enter' }, exec())
    expect(instance.type).toHaveBeenCalledWith('hi', undefined)
    expect(instance.key).toHaveBeenCalledWith('Enter', undefined)
    expect((await run.execute({ action: 'targets' }, exec())).text).toContain('dsh-app://app/')
    expect((await run.execute({ action: 'stop' }, exec())).text).toBe('stopped the test instance')
  })

  it('names the argument an action is missing', async () => {
    const { run } = tool()
    await expect(run.execute({ action: 'eval' }, exec())).rejects.toThrow('eval needs an "expression"')
    await expect(run.execute({ action: 'click', x: 1 }, exec())).rejects.toThrow('click needs "y"')
  })

  it('saves a screenshot and says why no image is attached without an image-capable route', async () => {
    const { run } = tool()
    const value = await run.execute({ action: 'screenshot' }, exec())
    expect(value.text).toContain('saved to C:/shot.png')
    expect(value.text).toContain('No image is attached')
    expect(value.image).toBeUndefined()
  })
})

describe('build_workspace_package', () => {
  it('reports an unknown package with the workspace it searched', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-build-tool-'))
    try {
      writeFileSync(join(root, 'pnpm-workspace.yaml'), '')
      writeFileSync(join(root, 'tsconfig.host.json'), '{}')
      mkdirSync(join(root, 'packages', 'web', 'a'), { recursive: true })
      writeFileSync(join(root, 'packages', 'web', 'a', 'package.json'), '{"name":"@deepseek-ai/dsh-a-thing"}')
      const options = { repoRoot: '', nodeExecutable: process.execPath, scratchDir: join(root, 's'), stepOutputChars: 500 }
      const run = buildWorkspacePackageTool(options) as unknown as Runnable
      await expect(run.execute({ package: 'thing' }, exec(join(root, 'packages')))).rejects.toThrow(/did you mean: @deepseek-ai\/dsh-a-thing/)
      // A package with nothing to build reports every step skipped or failed, in order.
      const value = await run.execute({ package: 'a-thing', steps: ['typecheck', 'typert'] }, exec(root))
      expect(value.ok).toBe(true)
      expect(value.text).toContain('- typecheck: skipped, no tsconfig.json')
      expect(value.text).toContain('- typert: skipped, exports no ./typert')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('builds in the call root, then the configured one, then the Session workspace, then the install checkout', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-build-root-'))
    try {
      writeFileSync(join(root, 'pnpm-workspace.yaml'), '')
      writeFileSync(join(root, 'tsconfig.host.json'), '{}')
      mkdirSync(join(root, 'packages', 'x'), { recursive: true })
      const inside = join(root, 'packages', 'x')
      const outside = tmpdir()
      expect(buildRoot(inside, '', outside, undefined)).toBe(root)
      expect(buildRoot(undefined, inside, outside, undefined)).toBe(root)
      expect(buildRoot('', '', inside, undefined)).toBe(root)
      // A Session outside the checkout falls back to where this package is installed.
      expect(buildRoot(undefined, '', outside, inside)).toBe(root)
      expect(() => buildRoot(outside, '', inside, undefined)).toThrow(/is not inside a DeepSeek Harness workspace/)
      expect(() => buildRoot(undefined, '', outside, outside)).toThrow(/pass root, or set repoRoot/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('reads a live repoRoot at each call', async () => {
    let configured = ''
    const options = { repoRoot: () => configured, nodeExecutable: process.execPath, scratchDir: tmpdir(), stepOutputChars: 500 }
    const run = buildWorkspacePackageTool(options) as unknown as Runnable
    await expect(run.execute({ package: 'x' }, exec(tmpdir()))).rejects.toThrow(/no DeepSeek Harness workspace above/)
    configured = tmpdir()
    await expect(run.execute({ package: 'x' }, exec(tmpdir()))).rejects.toThrow(/is not inside a DeepSeek Harness workspace/)
  })

  it('refuses outside a workspace', async () => {
    const run = buildWorkspacePackageTool({ repoRoot: '', nodeExecutable: process.execPath, scratchDir: tmpdir(), stepOutputChars: 500 }) as unknown as Runnable
    await expect(run.execute({ package: 'x' }, exec(tmpdir()))).rejects.toThrow(/no DeepSeek Harness workspace above/)
  })
})

it('registers both tools and unregisters them with the plugin', () => {
  const registered = new Map<string, unknown>()
  const disposers: (() => unknown)[] = []
  const ctx = {
    tools: {
      register: (definition: { name: string }) => {
        registered.set(definition.name, definition)
        return () => { registered.delete(definition.name) }
      },
    },
    effect: (fn: () => () => unknown) => { disposers.push(fn()) },
    get: () => undefined,
  }
  apply(ctx as unknown as Context, Config({}))
  expect([...registered.keys()].sort()).toEqual(['build_workspace_package', 'desktop_test_instance'])
  for (const dispose of disposers) void dispose()
  expect(registered.size).toBe(0)
})
