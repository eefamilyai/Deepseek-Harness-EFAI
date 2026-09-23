/**
 * The fork's preset root, and the two facts that make it the roster.
 *
 * The root path is resolved from this package's own location, so the test that
 * matters is that the four rosters are actually found there and that each one
 * carries the fork's acting surface — a preset root that resolved to nothing
 * would leave the harness with no presets at all, and one copied without the
 * kernel row would leave it with upstream's.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { scanRoot } from '@deepseek-ai/dsh-agent-presets'
import { EFAI_PRESET_ROOT, apply, name } from '../src/index.ts'

const EXPECTED_IDS = ['cordis', 'minimal', 'ptc', 'standard']

describe('the fork preset root', () => {
  it('resolves to a directory holding the four rosters', async () => {
    const found = await scanRoot({ path: EFAI_PRESET_ROOT, trust: 'system' }, import.meta.url)
    expect(found.map(preset => preset.id).sort()).toEqual(EXPECTED_IDS)
  })

  it('parses every roster, with breakage limited to resolving packages from a test base', async () => {
    // `scanRoot` health-checks each row against the harness base it is given.
    // A test file is not an installation, so package rows legitimately do not
    // resolve here; what this pins is that the compositions themselves parse —
    // a malformed file reports a different reason, and that would be the fork's bug.
    const found = await scanRoot({ path: EFAI_PRESET_ROOT, trust: 'system' }, import.meta.url)
    for (const preset of found) {
      if (preset.broken === undefined) continue
      expect(preset.broken).toContain('name plugins that cannot be resolved')
    }
  })

  it('gives every roster the kernel acting surface', () => {
    for (const id of EXPECTED_IDS) {
      const composition = readFileSync(join(EFAI_PRESET_ROOT, id, 'agent.cordis.yml'), 'utf8')
      expect(composition).toContain("name: '@deepseek-ai/dsh-tool-kernel'")
    }
  })

  it('decides the acting surface at runtime, never in a Loader expression', () => {
    // A `!!js` gate is read once at boot, which is what made the kernel and RLM
    // switches restart-shaped before. `tool-roster` decides per turn instead.
    for (const id of EXPECTED_IDS) {
      const composition = readFileSync(join(EFAI_PRESET_ROOT, id, 'agent.cordis.yml'), 'utf8')
      expect(composition).not.toContain('dshSettingFlag')
    }
  })
})

describe('the plugin', () => {
  it('drops the shipped root so the fork rosters win their own ids', async () => {
    const ctx = new Context()
    const mounted: { includeShippedRoot?: boolean; roots?: { path: string }[] }[] = []
    // The mount is what carries the decision, so the assertion is on the
    // configuration the child receives rather than on a rendered roster.
    ctx.plugin = ((_plugin: unknown, config: { includeShippedRoot?: boolean; roots?: { path: string }[] }) => {
      mounted.push(config)
      return { dispose: () => {} }
    }) as unknown as Context['plugin']

    apply(ctx, { default: 'standard' } as Parameters<typeof apply>[1])

    expect(mounted).toHaveLength(1)
    expect(mounted[0]!.includeShippedRoot).toBe(false)
    expect(mounted[0]!.roots?.[0]?.path).toBe(EFAI_PRESET_ROOT)
  })

  it('appends deployment roots after its own', () => {
    const ctx = new Context()
    const mounted: { roots?: { path: string }[] }[] = []
    ctx.plugin = ((_plugin: unknown, config: { roots?: { path: string }[] }) => {
      mounted.push(config)
      return { dispose: () => {} }
    }) as unknown as Context['plugin']

    apply(ctx, { default: 'standard', roots: [{ path: '/company/presets', trust: 'system' }] } as Parameters<typeof apply>[1])

    expect(mounted[0]!.roots?.map(root => root.path)).toEqual([EFAI_PRESET_ROOT, '/company/presets'])
  })

  it('names itself for loader diagnostics', () => {
    expect(name).toBe('efai-presets')
  })
})
