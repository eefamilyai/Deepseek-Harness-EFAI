/** Poll until the profile patch holds the write, or fail with what it holds. */
async function waitForPatch(path: string, timeoutMs = 2000): Promise<string> {
  const deadline = Date.now() + timeoutMs
  let saved = ''
  while (Date.now() < deadline) {
    saved = readFileSync(path, 'utf8')
    if (saved.includes('tool-roster')) return saved
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  return saved
}

/**
 * The roster's write path, against the real settings service.
 *
 * The Tools page renders one switch per entry of `tool-roster.tools`, and the
 * roster is what puts those entries there. That makes one question load-bearing:
 * can this plugin actually write its own namespace — a profile row it also hides
 * from the generated pages — with a nested path under a volatile dict? A unit
 * fake cannot answer it, because the answer lives in the settings service's own
 * validation of the row, the schema, and the path, so this spec boots a real
 * profile with a real `config-editor` and `settings` row and reads the patch file
 * the service wrote.
 */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { onTestFinished } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { boot, initProfile, readProfilePatches, type ProfileContext } from '@deepseek-ai/dsh-app-boot'
import ConfigEditor from '@deepseek-ai/dsh-config-editor'
import Settings from '@deepseek-ai/dsh-settings'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { describe, expect, it } from 'vitest'
import { Config, apply } from '../src/index.ts'

/** A minimal registrable tool. */
function tool(name: string): ToolDefinition {
  return {
    name,
    description: `tool ${name}`,
    parameters: { type: 'object', properties: {} },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value as string }],
    },
    execute: () => Promise.resolve(`ran:${name}`),
  }
}

/** Boot a real profile whose single row is this plugin, under the id settings writes by. */
async function bootRoster(initial: Record<string, unknown> = {}): Promise<{ ctx: Context; patchPath: string }> {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'roster-write-')))
  const dir = join(home, 'profiles', 'test')
  onTestFinished(() => { rmSync(home, { recursive: true, force: true }) })
  initProfile(dir, ['test-bundle'])
  const bundle = join(dir, 'node_modules', 'test-bundle')
  mkdirSync(bundle, { recursive: true })
  writeFileSync(join(home, 'package.json'), '{"name":"test-installation"}\n')
  writeFileSync(join(bundle, 'package.json'), JSON.stringify({
    name: 'test-bundle',
    version: '1.0.0',
    dsh: { bundle: { patch: 'cordis.patch.yml' } },
  }))
  writeFileSync(join(bundle, 'cordis.patch.yml'), JSON.stringify([{ insert: [
    { id: 'config-editor', name: 'cordis:editor' },
    { id: 'settings', name: 'cordis:settings' },
    { id: 'tool-roster', name: 'cordis:roster', config: initial },
  ] }]))
  writeFileSync(join(dir, 'cordis.yml'), '[]\n')
  const profile: ProfileContext = {
    name: 'test',
    startedBundles: ['test-bundle'],
    dir,
    patchPath: join(dir, 'cordis.patch.yml'),
    installAnchor: join(home, 'package.json'),
    cwd: home,
    home,
    overlays: [],
    telemetryDisabledEnv: undefined,
  }
  const ctx = await boot('test', join(dir, 'cordis.yml'), readProfilePatches('test', profile), (inner) => {
    inner.provide('profileContext', profile)
    inner.provide('appReady', { onReady: (listener: () => void) => { listener(); return () => {} } })
    Object.assign(inner.loader.builtins, { editor: ConfigEditor, settings: Settings, roster: { Config, apply } })
  })
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime)
  // The prompt asks the executor to describe the offered tools.
  await ctx.plugin(NativeToolExecutor)
  return { ctx, patchPath: profile.patchPath }
}

describe('the roster writes its own per-tool map', () => {
  it('records a mounted tool in the profile the settings service owns', async () => {
    const { ctx, patchPath } = await bootRoster()
    ctx.tools.register(tool('read'))
    ctx.tools.register(tool('bash'))
    // The learner runs on the assembled prompt, which is where an agent's own tools appear.
    await ctx.systemPrompt.assemble({})
    // The write is asynchronous by contract, so wait for the file rather than for a
    // fixed delay: a loaded machine is otherwise a flaky test.
    await waitForPatch(patchPath)

    const saved = readFileSync(patchPath, 'utf8')
    expect(saved).toContain('tool-roster')
    const row = ctx.settings.describe().find(entry => entry.ns === 'tool-roster')
    expect(row?.value).toMatchObject({ tools: { read: true, bash: true } })
  })

  it('keeps an entry the operator set instead of rewriting it', async () => {
    const { ctx, patchPath } = await bootRoster({ tools: { read: false } })
    ctx.tools.register(tool('read'))
    ctx.tools.register(tool('bash'))
    await ctx.systemPrompt.assemble({})
    await waitForPatch(patchPath)

    const row = ctx.settings.describe().find(entry => entry.ns === 'tool-roster')
    expect(row?.value).toMatchObject({ tools: { read: false, bash: true } })
  })
})
