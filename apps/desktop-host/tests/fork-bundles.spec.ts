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

const FORKS = ['@deepseek-ai/dsh-efai-base', '@deepseek-ai/dsh-efai-web',
  '@deepseek-ai/dsh-experimental-schedule-bundle', '@deepseek-ai/dsh-experimental-voice-input-bundle']

describe('fork bundles on the Desktop profile', () => {
  it('puts each fork bundle right after the upstream one it extends', () => {
    expect(withForkBundles(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'other'])).toEqual([
      '@deepseek-ai/dsh-base', '@deepseek-ai/dsh-efai-base', '@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-efai-web',
      '@deepseek-ai/dsh-experimental-schedule-bundle', '@deepseek-ai/dsh-experimental-voice-input-bundle', 'other',
    ])
    expect(withForkBundles(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-efai-base'])).toEqual(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-efai-base'])
  })

  it('adds them to a fresh profile without a dependency, and changes nothing the second time', () => {
    const dir = profile({ name: 'p', dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } } })
    expect(ensureForkBundles(dir)).toEqual(FORKS)
    const after = read(dir)
    expect(after.dsh.profile.bundles).toEqual(['@deepseek-ai/dsh-base', FORKS[0], '@deepseek-ai/dsh-web-app', ...FORKS.slice(1)])
    expect(after.dependencies).toEqual({})
    const text = readFileSync(join(dir, 'package.json'), 'utf8')
    expect(ensureForkBundles(dir)).toEqual([])
    expect(readFileSync(join(dir, 'package.json'), 'utf8')).toBe(text)
  })

  it('removes a dependency an older build recorded, keeping everything else', () => {
    const dir = profile({
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-efai-base'] } },
      dependencies: {
        '@deepseek-ai/dsh-efai-base': '0.1.0-local.1',
        '@deepseek-ai/dsh-efai-web': '*',
        'some-plugin': 'file:../some-plugin',
      },
    })
    expect(ensureForkBundles(dir)).toEqual([])
    expect(read(dir).dependencies).toEqual({ 'some-plugin': 'file:../some-plugin' })
    expect(read(dir).dsh.profile.bundles).toEqual(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-efai-base'])
  })

  it('leaves alone a missing profile, one without a bundle list, and one that opted out', () => {
    expect(ensureForkBundles(join(tmpdir(), 'no-such-profile-dir'))).toEqual([])
    expect(ensureForkBundles(profile({ name: 'x' }))).toEqual([])
    const out = profile({ dsh: { forkBundles: false, profile: { bundles: ['@deepseek-ai/dsh-base'] } } })
    expect(ensureForkBundles(out)).toEqual([])
    expect(read(out).dsh.profile.bundles).toEqual(['@deepseek-ai/dsh-base'])
  })
})
