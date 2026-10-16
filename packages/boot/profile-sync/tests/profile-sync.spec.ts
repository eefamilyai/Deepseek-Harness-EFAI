import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { Config, apply, linkSharedBundles, synchronize } from '../src/index.ts'
import {
  absorb, desired, emptyState, fillMissing, seedState, type ProfileSnapshot,
  readBundles, readPatch, readRefs, sameJson, writeBundles, writePatch, writeRefs,
} from '../src/sync.ts'

const PATCH = `# my profile
- id: llm-pi-ai
  config:
    providers:
      google: { baseUrl: https://g, apiKey: { ref: GOOGLE_KEY } }
- id: kernel-python
  config:
    cwd: !!js process.env.DSH_KERNEL_CWD
- id: ui-effects
  disabled: true
`

const manifest = (bundles: string[]) => `${JSON.stringify({ name: 'p', private: true, dsh: { profile: { bundles } } }, null, 2)}\n`
const CREDS = 'version: 1\nrefs:\n  GOOGLE_KEY: g-1\nrecords:\n  login: { kind: grant }\n'
const resolved = (patch: Partial<Config> = {}) => Config(patch as Config)

describe('reading and writing shared fields', () => {
  it('reads provider configs, disabled flags, bundles, and refs', () => {
    expect(readPatch(PATCH, ['llm-pi-ai'])).toEqual({
      providers: { 'llm-pi-ai': { providers: { google: { baseUrl: 'https://g', apiKey: { ref: 'GOOGLE_KEY' } } } } },
      disabled: { 'ui-effects': true },
    })
    expect(readBundles(manifest(['a', 'b']))).toEqual(['a', 'b'])
    expect(readBundles('{}')).toBeNull()
    expect(readRefs(CREDS)).toEqual({ GOOGLE_KEY: 'g-1' })
    expect(readRefs('')).toEqual({})
    expect(readRefs('version: 1\n')).toEqual({})
  })

  it('writes only what differs, keeping comments, !!js scalars, and records', () => {
    const next = writePatch(PATCH, { 'llm-pi-ai': { providers: {} } }, { 'ui-effects': false, 'web-browser': true })
    expect(next).toContain('# my profile')
    expect(next).toContain('cwd: !!js process.env.DSH_KERNEL_CWD')
    expect(readPatch(next, ['llm-pi-ai'])).toEqual({
      providers: { 'llm-pi-ai': { providers: {} } },
      disabled: { 'ui-effects': false, 'web-browser': true },
    })
    expect(writePatch(PATCH, readPatch(PATCH, ['llm-pi-ai']).providers, { 'ui-effects': true, absent: false })).toBe(PATCH)
    expect(readPatch(writePatch('', { 'llm-kiln': { a: 1 } }, {}), ['llm-kiln']).providers).toEqual({ 'llm-kiln': { a: 1 } })

    const creds = writeRefs(CREDS, { GOOGLE_KEY: 'g-2', NEW_KEY: 'n', GONE: null })
    expect(readRefs(creds)).toEqual({ GOOGLE_KEY: 'g-2', NEW_KEY: 'n' })
    expect(creds).toContain('login: { kind: grant }')
    expect(writeRefs(CREDS, { GOOGLE_KEY: 'g-1' })).toBe(CREDS)
    expect(readRefs(writeRefs(creds, { NEW_KEY: null }))).toEqual({ GOOGLE_KEY: 'g-2' })
    expect(readRefs(writeRefs('', { A: 'x' }))).toEqual({ A: 'x' })

    expect(readBundles(writeBundles(manifest(['a']), ['a', 'b']))).toEqual(['a', 'b'])
    expect(writeBundles(manifest(['a']), ['a'])).toBe(manifest(['a']))
    expect(readBundles(writeBundles('{"name":"x"}', ['z']))).toEqual(['z'])
  })

  it('skips insert rows, rows without a string id, and unreadable values', () => {
    const odd = '- insert: { id: llm-pi-ai, config: { x: 1 } }\n- id: 7\n  disabled: true\n- plain\n- id: z\n  disabled: maybe\n'
    expect(readPatch(odd, ['llm-pi-ai'])).toEqual({ providers: {}, disabled: { z: false } })
    expect(readRefs('refs:\n  A: [1]\n  ? [k]\n  : v\n  B: b\n')).toEqual({ B: 'b' })
    expect(readRefs('refs: [a]\n')).toEqual({})
  })

  it('rejects a patch that is not a sequence or not YAML', () => {
    expect(() => readPatch('a: 1\n', [])).toThrow('profile patch must be a YAML sequence')
    expect(() => readPatch('- [\n', [])).toThrow()
  })

  it('compares JSON regardless of key order', () => {
    expect(sameJson({ a: 1, b: [1, { c: 2, d: 3 }] }, { b: [1, { d: 3, c: 2 }], a: 1 })).toBe(true)
    expect(sameJson({ a: 1 }, { a: 2 })).toBe(false)
    expect(sameJson(undefined, undefined)).toBe(true)
  })
})

describe('merging edits into the store', () => {
  const snap = (overrides: Partial<ProfileSnapshot> = {}): ProfileSnapshot => ({
    providers: { p: { v: 1 } }, disabled: { x: true }, bundles: ['a'], refs: { K: '1' }, ...overrides,
  })

  it('seeds an empty store from a profile seen for the first time', () => {
    const { state, changed } = absorb(emptyState(), snap(), null, 'harness', 5)
    expect(changed).toBe(true)
    expect(desired(state)).toEqual({ providers: { p: { v: 1 } }, disabled: { x: true }, bundles: ['a'], refs: { K: '1' } })
    expect(state.providers.p).toEqual({ value: { v: 1 }, at: 5, from: 'harness' })
    // A first-seen profile only fills what the store lacks.
    expect(absorb(state, snap({ providers: { p: { v: 9 } } }), null, 'other', 6).changed).toBe(false)
  })

  it('takes only what a profile changed since its baseline', () => {
    const seeded = absorb(emptyState(), snap(), null, 'harness', 1).state
    const base = snap()
    expect(absorb(seeded, base, base, 'school', 2).changed).toBe(false)
    const change = snap({ providers: { p: { v: 2 } }, bundles: ['a', 'b'], refs: { K: '2', L: '3' } })
    const edited = absorb(seeded, change, base, 'school', 3)
    expect(edited.changed).toBe(true)
    expect(desired(edited.state)).toMatchObject({ providers: { p: { v: 2 } }, bundles: ['a', 'b'], refs: { K: '2', L: '3' } })
  })

  it('treats a dropped disabled flag as enabled and a dropped ref as a deletion', () => {
    const seeded = absorb(emptyState(), snap(), null, 'harness', 1).state
    const { state } = absorb(seeded, snap({ disabled: {}, refs: {} }), snap(), 'school', 2)
    expect(desired(state).disabled).toEqual({ x: false })
    expect(desired(state).refs).toEqual({ K: null })
    // Already recorded: nothing more changes.
    expect(absorb(state, snap({ disabled: {}, refs: {} }), snap(), 'school', 3).changed).toBe(false)
  })

  it('ignores a profile without a bundle list', () => {
    const seeded = absorb(emptyState(), snap(), null, 'harness', 1).state
    expect(absorb(seeded, snap({ bundles: null }), snap(), 'school', 2).changed).toBe(false)
  })
})

describe('the first pass', () => {
  it('fills only what the running profile lacks, keeping its own values on conflict', () => {
    expect(fillMissing({ a: { models: [1] }, b: 1 }, { a: { models: [1, 2], extra: true }, c: 3 }))
      .toEqual({ a: { models: [1], extra: true }, b: 1, c: 3 })
    expect(fillMissing([1], { a: 1 })).toEqual([1])
    expect(fillMissing({ a: 1 }, 'text')).toEqual({ a: 1 })
  })

  it('seeds from the running profile and adds the providers, bundles, and refs of other profiles', () => {
    const seed: ProfileSnapshot = {
      providers: { p: { routes: { a: { models: ['x'] } } } }, disabled: { d: true }, bundles: ['base'], refs: { K: '1' },
    }
    const other: ProfileSnapshot = {
      providers: { p: { routes: { a: { models: ['x', 'y'] }, b: {} } }, q: { z: 1 } },
      disabled: { d: false, e: true },
      bundles: ['base', 'third-party'],
      refs: { K: 'other', L: '2' },
    }
    expect(desired(seedState(seed, [other], 'harness', 1))).toEqual({
      providers: { p: { routes: { a: { models: ['x'] }, b: {} } }, q: { z: 1 } },
      disabled: { d: true, e: false },
      bundles: ['base', 'third-party'],
      refs: { K: '1', L: '2' },
    })
    expect(seedState({ ...seed, bundles: null }, [other], 'harness', 1).bundles).toBeNull()
    expect(seedState(seed, [{ ...other, bundles: null }], 'harness', 1).bundles?.value).toEqual(['base'])
  })
})

describe('synchronizing a harness home', () => {
  let home: string
  const profile = (name: string, patch: string, bundles: string[], creds?: string) => {
    const dir = join(home, 'profiles', name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'cordis.patch.yml'), patch)
    writeFileSync(join(dir, 'package.json'), manifest(bundles))
    if (creds !== undefined) writeFileSync(join(dir, 'credentials.yaml'), creds)
    return dir
  }
  const read = (name: string, file: string) => readFileSync(join(home, 'profiles', name, file), 'utf8')
  const fresh = () => {
    home = mkdtempSync(join(tmpdir(), 'dsh-profile-sync-'))
    profile('harness', PATCH, ['base', 'efai'], CREDS)
    profile('school', '- id: llm-pi-ai\n  config:\n    providers: {}\n- id: other\n  disabled: true\n', ['base'])
    profile('headless', '[]\n', ['base'])
    // Disables what the running profile disables too, and what school alone disables.
    profile('general', '- id: ui-effects\n  disabled: true\n- id: other\n  disabled: true\n', ['base', 'efai'], CREDS)
    mkdirSync(join(home, 'profiles', 'node_modules'), { recursive: true })
  }
  afterEach(() => { vi.useRealTimers() })

  it('seeds from the running profile, backs everything up, and leaves excluded profiles alone', async () => {
    fresh()
    const rewritten = await synchronize(join(home, 'profiles'), join(home, 'profile-sync'), 'harness', resolved(), 1000)
    expect(rewritten).toEqual(['general', 'school'])
    expect(readPatch(read('general', 'cordis.patch.yml'), []).disabled).toEqual({ 'ui-effects': true, other: false })
    expect(readPatch(read('school', 'cordis.patch.yml'), ['llm-pi-ai'])).toEqual({
      providers: readPatch(PATCH, ['llm-pi-ai']).providers,
      disabled: { other: false, 'ui-effects': true },
    })
    expect(readBundles(read('school', 'package.json'))).toEqual(['base', 'efai'])
    expect(readRefs(read('school', 'credentials.yaml'))).toEqual({ GOOGLE_KEY: 'g-1' })
    expect(read('school', 'credentials.yaml')).not.toContain('records')
    expect(read('headless', 'cordis.patch.yml')).toBe('[]\n')
    const backups = readdirSync(join(home, 'profile-sync')).filter(name => name.startsWith('backup-'))
    expect(backups).toHaveLength(1)
    expect(readFileSync(join(home, 'profile-sync', backups[0]!, 'school', 'package.json'), 'utf8')).toBe(manifest(['base']))
    // A second pass with nothing edited writes nothing.
    expect(await synchronize(join(home, 'profiles'), join(home, 'profile-sync'), 'harness', resolved(), 2000)).toEqual([])
  })

  it('carries a later edit in any profile to every other one', async () => {
    fresh()
    const profiles = join(home, 'profiles')
    const store = join(home, 'profile-sync')
    await synchronize(profiles, store, 'harness', resolved(), 1000)
    writeFileSync(join(profiles, 'school', 'cordis.patch.yml'),
      writePatch(read('school', 'cordis.patch.yml'),
        { 'llm-pi-ai': { providers: { nvidia: { baseUrl: 'https://n' } } } }, { 'ui-effects': false }))
    writeFileSync(join(profiles, 'school', 'credentials.yaml'), writeRefs(read('school', 'credentials.yaml'), { NV: 'k' }))
    expect(await synchronize(profiles, store, 'school', resolved(), 3000)).toEqual(['general', 'harness'])
    expect(readPatch(read('harness', 'cordis.patch.yml'), ['llm-pi-ai'])).toEqual({
      providers: { 'llm-pi-ai': { providers: { nvidia: { baseUrl: 'https://n' } } } },
      // `other` has no row in harness, which already reads as enabled.
      disabled: { 'ui-effects': false },
    })
    expect(readRefs(read('harness', 'credentials.yaml'))).toEqual({ GOOGLE_KEY: 'g-1', NV: 'k' })
    expect(read('harness', 'credentials.yaml')).toContain('login: { kind: grant }')
  })

  it('carries a provider deleted in one profile and a plugin re-enabled there to every other one', async () => {
    fresh()
    const profiles = join(home, 'profiles')
    const store = join(home, 'profile-sync')
    const two = { providers: { nvidia: { baseUrl: 'https://n' }, qwen: { baseUrl: 'https://q' } } }
    writeFileSync(join(profiles, 'harness', 'cordis.patch.yml'), writePatch(PATCH, { 'llm-pi-ai': two }, {}))
    await synchronize(profiles, store, 'harness', resolved(), 1000)
    expect(readPatch(read('general', 'cordis.patch.yml'), ['llm-pi-ai']).providers['llm-pi-ai']).toEqual(two)
    // general deletes qwen and drops its `ui-effects` disable.
    writeFileSync(join(profiles, 'general', 'cordis.patch.yml'),
      writePatch(read('general', 'cordis.patch.yml'), { 'llm-pi-ai': { providers: { nvidia: { baseUrl: 'https://n' } } } }, {})
        .replace(/- id: ui-effects\n {2}disabled: true\n/, ''))
    expect(await synchronize(profiles, store, 'general', resolved(), 3000)).toEqual(['harness', 'school'])
    for (const name of ['harness', 'school']) {
      const patch = readPatch(read(name, 'cordis.patch.yml'), ['llm-pi-ai'])
      expect(patch.providers['llm-pi-ai']).toEqual({ providers: { nvidia: { baseUrl: 'https://n' } } })
      expect(patch.disabled['ui-effects']).toBe(false)
    }
  })

  it('brings a profile created after the first pass into line', async () => {
    fresh()
    const profiles = join(home, 'profiles')
    const store = join(home, 'profile-sync')
    await synchronize(profiles, store, 'harness', resolved(), 1000)
    profile('work', '[]\n', ['base'])
    expect(await synchronize(profiles, store, 'harness', resolved(), 2000)).toEqual(['work'])
    expect(readBundles(read('work', 'package.json'))).toEqual(['base', 'efai'])
    expect(readRefs(read('work', 'credentials.yaml'))).toEqual({ GOOGLE_KEY: 'g-1' })
  })

  it('links a bundle installed in one profile where every profile resolves it', async () => {
    fresh()
    const profiles = join(home, 'profiles')
    const installed = join(profiles, 'school', 'node_modules', '@x', 'guard')
    mkdirSync(installed, { recursive: true })
    writeFileSync(join(installed, 'package.json'), '{"name":"@x/guard"}')
    writeFileSync(join(profiles, 'school', 'package.json'), manifest(['base', '@x/guard']))
    await synchronize(profiles, join(home, 'profile-sync'), 'harness', resolved(), 1000)
    expect(readBundles(read('harness', 'package.json'))).toEqual(['base', 'efai', '@x/guard'])
    expect(readFileSync(join(profiles, 'node_modules', '@x', 'guard', 'package.json'), 'utf8')).toBe('{"name":"@x/guard"}')
    // Already linked, or installed nowhere: nothing to do.
    expect(linkSharedBundles(profiles, ['school'], ['@x/guard', '@x/missing'])).toEqual([])
  })

  it('shares only what its switches allow', async () => {
    fresh()
    const rewritten = await synchronize(join(home, 'profiles'), join(home, 'profile-sync'), 'harness',
      resolved({ plugins: false, credentials: false }), 1000)
    expect(rewritten).toEqual(['general', 'school'])
    expect(readBundles(read('school', 'package.json'))).toEqual(['base'])
    expect(existsSync(join(home, 'profiles', 'school', 'credentials.yaml'))).toBe(false)
    expect(readPatch(read('school', 'cordis.patch.yml'), []).disabled).toEqual({ other: true })
  })

  it('does nothing on a first pass whose own profile is not synchronized', async () => {
    fresh()
    expect(await synchronize(join(home, 'profiles'), join(home, 'profile-sync'), 'headless', resolved(), 1000)).toEqual([])
    expect(existsSync(join(home, 'profile-sync', 'state.json'))).toBe(false)
  })
})

/** Mount the plugin with a spy on its own logger, installed before `apply` runs. */
async function mountWithLog(ctx: Context, config: Partial<Config>) {
  const calls: { level: 'info' | 'warn'; args: unknown[] }[] = []
  await ctx.plugin({
    name: 'profile-sync',
    Config,
    apply: (inner: Context, resolvedConfig: Config) => {
      vi.spyOn(inner.logger, 'info').mockImplementation((...args: unknown[]) => { calls.push({ level: 'info', args }) })
      vi.spyOn(inner.logger, 'warn').mockImplementation((...args: unknown[]) => { calls.push({ level: 'warn', args }) })
      apply(inner, resolvedConfig)
    },
  }, config as Config).await()
  return calls
}

describe('the plugin', () => {
  it('runs a pass on start and after its own files change, and stops on dispose', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-profile-sync-plugin-'))
    const dir = join(home, 'profiles', 'harness')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'cordis.patch.yml'), PATCH)
    writeFileSync(join(dir, 'package.json'), manifest(['base']))
    mkdirSync(join(home, 'profiles', 'school'), { recursive: true })
    writeFileSync(join(home, 'profiles', 'school', 'package.json'), manifest([]))
    const ctx = new Context()
    ctx.provide('profileContext', { name: 'harness', dir, home })
    const fiber = ctx.plugin({ name: 'profile-sync', apply, Config }, { debounceMs: 20 } as Config)
    await fiber.await()
    const schoolBundles = () => readBundles(readFileSync(join(home, 'profiles', 'school', 'package.json'), 'utf8'))
    await vi.waitFor(() => { expect(schoolBundles()).toEqual(['base']) })
    writeFileSync(join(dir, 'package.json'), manifest(['base', 'more']))
    await vi.waitFor(() => {
      expect(readBundles(readFileSync(join(home, 'profiles', 'school', 'package.json'), 'utf8'))).toEqual(['base', 'more'])
    }, { timeout: 5000 })
    await fiber.dispose()
  })

  it('reports a failed pass and an unwatchable profile instead of throwing', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-profile-sync-broken-'))
    const dir = join(home, 'profiles', 'harness')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), manifest([]))
    // A directory where the credentials file belongs cannot be read.
    mkdirSync(join(dir, 'credentials.yaml'))
    // A store already exists, so the pass reads profiles instead of backing them up.
    mkdirSync(join(home, 'profile-sync'))
    writeFileSync(join(home, 'profile-sync', 'state.json'), JSON.stringify({ ...emptyState(), baselines: {} }))
    const ctx = new Context()
    ctx.provide('profileContext', { name: 'harness', dir, home } as never)
    const calls = await mountWithLog(ctx, {})
    await vi.waitFor(() => {
      expect(calls).toContainEqual({ level: 'warn', args: ['profile sync failed: %s', expect.stringMatching(/EISDIR|EPERM/)] })
    })

    const missing = new Context()
    missing.provide('profileContext', { name: 'harness', dir: join(home, 'gone'), home } as never)
    const missingCalls = await mountWithLog(missing, {})
    expect(missingCalls).toContainEqual({
      level: 'warn', args: ['profile sync cannot watch %s: %s', join(home, 'gone'), expect.any(String)],
    })
  })

  it('logs nothing when a pass has nothing to rewrite', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-profile-sync-alone-'))
    const dir = join(home, 'profiles', 'harness')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), manifest(['base']))
    const ctx = new Context()
    ctx.provide('profileContext', { name: 'harness', dir, home } as never)
    const calls = await mountWithLog(ctx, {})
    await vi.waitFor(() => { expect(existsSync(join(home, 'profile-sync', 'state.json'))).toBe(true) })
    expect(calls).toEqual([])
  })

  it('does nothing when switched off, without a profile, or in an excluded profile', async () => {
    expect(await mountWithLog(new Context(), { enabled: false })).toEqual([])
    expect(await mountWithLog(new Context(), {})).toEqual([])
    const excluded = new Context()
    excluded.provide('profileContext', { name: 'headless', dir: '/nowhere', home: '/nowhere' } as never)
    expect(await mountWithLog(excluded, {})).toEqual([])
  })
})
