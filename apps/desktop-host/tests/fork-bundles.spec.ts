import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ensureForkBundles, withForkBundles } from '../src/fork-bundles.ts'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function profile(manifest: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-fork-bundles-'))
  dirs.push(dir)
  writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest, null, 2))
  return dir
}
const read = (dir: string) => JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
  dependencies?: Record<string, string>
  dsh: { profile: { bundles: string[] } }
}

describe('fork bundles on the Desktop profile', () => {
  it('puts each fork bundle right after the upstream one it extends', () => {
    expect(withForkBundles(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'other'])).toEqual([
      '@deepseek-ai/dsh-base', '@deepseek-ai/dsh-efai-base', '@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-efai-web',
      '@deepseek-ai/dsh-experimental-schedule-bundle', '@deepseek-ai/dsh-experimental-voice-input-bundle', 'other',
    ])
    expect(withForkBundles(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-efai-base'])).toEqual(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-efai-base'])
  })

  it('adds them to a fresh profile, with installed dependencies, and changes nothing the second time', () => {
    const dir = profile({ name: 'p', dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } } })
    const forks = ['@deepseek-ai/dsh-efai-base', '@deepseek-ai/dsh-efai-web', '@deepseek-ai/dsh-experimental-schedule-bundle', '@deepseek-ai/dsh-experimental-voice-input-bundle']
    expect(ensureForkBundles(dir)).toEqual(forks)
    const after = read(dir)
    expect(after.dsh.profile.bundles).toEqual(['@deepseek-ai/dsh-base', forks[0], '@deepseek-ai/dsh-web-app', ...forks.slice(1)])
    expect(after.dependencies).toEqual(Object.fromEntries(forks.map(name => [name, '*'])))
    const text = readFileSync(join(dir, 'package.json'), 'utf8')
    expect(ensureForkBundles(dir)).toEqual([])
    expect(readFileSync(join(dir, 'package.json'), 'utf8')).toBe(text)
  })

  it('registers a dependency the profile lacks even when the bundle is already listed', () => {
    const dir = profile({ dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-efai-base'] } }, dependencies: { x: '1' } })
    expect(ensureForkBundles(dir)).toEqual([])
    expect(read(dir).dependencies).toEqual({ x: '1', '@deepseek-ai/dsh-efai-base': '*' })
  })

  it('leaves alone a missing profile, one without a bundle list, and one that opted out', () => {
    expect(ensureForkBundles(join(tmpdir(), 'no-such-profile-dir'))).toEqual([])
    expect(ensureForkBundles(profile({ name: 'x' }))).toEqual([])
    const out = profile({ dsh: { forkBundles: false, profile: { bundles: ['@deepseek-ai/dsh-base'] } } })
    expect(ensureForkBundles(out)).toEqual([])
    expect(read(out).dsh.profile.bundles).toEqual(['@deepseek-ai/dsh-base'])
  })
})
