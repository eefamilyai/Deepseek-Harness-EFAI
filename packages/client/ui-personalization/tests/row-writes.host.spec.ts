/**
 * The personalization row against the real settings service.
 *
 * The engine has its own specs, but they drive it with values this file made up. What
 * they cannot see is the pipeline the operator actually uses: a control writes a field,
 * the Host validates it against the row's schema, the profile keeps it, and the live
 * value comes back to the page. That is the path that broke - a field the browser offered
 * but the Host's schema did not have, so the write was refused and the number snapped
 * back - and the only way to hold it is to mount the row the Loader mounts and write to
 * it the way a control does.
 */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { boot, initProfile, readProfilePatches, type ProfileContext } from '@deepseek-ai/dsh-app-boot'
import ConfigEditor from '@deepseek-ai/dsh-config-editor'
import Settings from '@deepseek-ai/dsh-settings'
import { onTestFinished } from 'vitest'
import { describe, expect, it } from 'vitest'
import { Config, apply } from '../src/index.ts'

/** Boot a real profile whose one row is this plugin, under the id its section writes to. */
async function bootRow(): Promise<{ ctx: Context; patchPath: string }> {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'personalization-row-')))
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
    { id: 'ui-personalization', name: 'cordis:personalization' },
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
    Object.assign(inner.loader.builtins, { editor: ConfigEditor, settings: Settings, personalization: { Config, apply } })
  })
  onTestFinished(async () => { await ctx.fiber.dispose() })
  return { ctx, patchPath: profile.patchPath }
}

/** Wait for the profile patch to hold a value, or report what it holds. */
async function settled(path: string, expected: string, timeoutMs = 10000): Promise<string> {
  const deadline = Date.now() + timeoutMs
  let saved = ''
  while (Date.now() < deadline) {
    saved = readFileSync(path, 'utf8')
    if (saved.includes(expected)) return saved
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  return saved
}

describe('the personalization row, through the real settings service', () => {
  it('exposes every field its section writes, and accepts a write per field', async () => {
    const { ctx, patchPath } = await bootRow()

    // Every field the browser half writes must exist in the Host's schema: a field the
    // page offers and the Host does not know is a write the operator makes that does
    // nothing at all.
    const declared = Object.keys(Config({}) as Record<string, unknown>)
    expect(declared).toEqual(expect.arrayContaining([
      'fontFamily', 'fontScale', 'accent', 'radiusScale',
      'shellOpacity', 'surfaceOpacity', 'panelOpacity',
    ]))

    for (const [field, value, expected] of [
      ['shellOpacity', 35, 'shellOpacity: 35'],
      ['surfaceOpacity', 45, 'surfaceOpacity: 45'],
      ['panelOpacity', 55, 'panelOpacity: 55'],
      ['radiusScale', 1.5, 'radiusScale: 1.5'],
      ['accent', '#7c5cff', 'accent: "#7c5cff"'],
      ['fontFamily', 'Inter, system-ui, sans-serif', 'fontFamily: Inter, system-ui, sans-serif'],
    ] as const) {
      // A write that the Host refuses rejects here, which is the failure the operator saw
      // as a number that snapped back.
      await expect(ctx.settings.update('ui-personalization', { [field]: value })).resolves.toBeUndefined()
      const saved = await settled(patchPath, String(expected))
      expect(saved, `${field} never reached the profile`).toContain(expected)
      // And the live view the page reads agrees with it.
      const row = ctx.settings.describe().find(entry => entry.ns === 'ui-personalization')
      expect((row?.value as Record<string, unknown> | undefined)?.[field], `${field} not live`).toEqual(value)
    }
  })

  it('refuses a value outside the range the page renders', async () => {
    const { ctx } = await bootRow()
    await expect(ctx.settings.update('ui-personalization', { shellOpacity: 400 })).rejects.toThrow()
    await expect(ctx.settings.update('ui-personalization', { panelOpacity: 0.1 })).rejects.toThrow()
  })
})
