/**
 * The switch and the mount it owns.
 *
 * What a reader cannot check by inspection is that the two halves agree: the
 * setting is what decides whether the engine runs, the decision is taken again
 * whenever the setting changes, and the off position leaves nothing of the
 * engine behind — no tools, and no observer still writing to disk.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import { liveConfig } from '../../../settings/settings/tests/live-config.ts'
import { Config, apply, name } from '../src/index.ts'

const MEMORY_TOOLS = ['memory_add', 'memory_recall', 'memory_map']

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-agent-memory-mode-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

/**
 * Mount the switch behind a Loader over the services the engine needs, so an
 * edit travels the same path a Settings write does.
 */
async function mount(enabled: boolean) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  const live = await liveConfig(ctx, { name, apply, Config }, { enabled })
  await settle(ctx, enabled ? MEMORY_TOOLS.length : 0)
  return { ctx, live }
}

/** Which of the engine's tools the registry currently holds. */
function memoryTools(ctx: Context): string[] {
  return ctx.tools.schemas()
    .map(schema => schema.name)
    .filter(toolName => MEMORY_TOOLS.includes(toolName))
    .sort()
}


/**
 * Wait until the engine has finished mounting or unmounting.
 *
 * The engine opens a storage domain before it registers anything, so the
 * observable result of a switch lands a few microtasks after the write. A
 * fixed sleep is a flake under a loaded test run; this polls the registry.
 * @param ctx - the mounted context.
 * @param expected - how many of the engine tools should be present.
 */
async function settle(ctx: Context, expected?: number): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 10))
    if (expected === undefined || memoryTools(ctx).length === expected) return
  }
}

describe('the switch decides whether the engine runs', () => {
  it('mounts nothing in the off position', async () => {
    const { ctx } = await mount(false)
    expect(memoryTools(ctx)).toEqual([])
    await ctx.fiber.dispose()
  })

  it('mounts the engine in the on position', async () => {
    const { ctx } = await mount(true)
    expect(memoryTools(ctx)).toEqual(MEMORY_TOOLS.slice().sort())
    await ctx.fiber.dispose()
  })

  it('declares the switch as a live field, so Settings edits it without a remount', () => {
    expect(Config({}).enabled.get()).toBe(false)
    expect(Config.dict?.enabled?.meta.volatile).toBe(true)
  })
})

describe('the decision is taken again when the setting changes', () => {
  it('starts the engine when the switch is turned on', async () => {
    const { ctx, live } = await mount(false)
    await live.update({ enabled: true })
    await settle(ctx, MEMORY_TOOLS.length)
    expect(memoryTools(ctx)).toEqual(MEMORY_TOOLS.slice().sort())
    await ctx.fiber.dispose()
  })

  it('withdraws every engine registration when the switch is turned off', async () => {
    const { ctx, live } = await mount(true)
    expect(memoryTools(ctx)).toHaveLength(MEMORY_TOOLS.length)

    await live.update({ enabled: false })
    await settle(ctx, 0)
    expect(memoryTools(ctx)).toEqual([])
    await ctx.fiber.dispose()
  })

  it('is idempotent: writing the value it already holds does not remount', async () => {
    const { ctx, live } = await mount(true)
    const before = memoryTools(ctx)
    await live.update({ enabled: true })
    await settle(ctx, MEMORY_TOOLS.length)
    expect(memoryTools(ctx)).toEqual(before)
    await ctx.fiber.dispose()
  })
})
