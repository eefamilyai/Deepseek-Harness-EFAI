/**
 * The Desktop test instance without a real Desktop: locating the app and profile,
 * preparing the copy and the test profile, and refusing to drive an instance that is
 * not running. Starting the real executable is covered by running the tool against the
 * installed Desktop app.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DesktopTestInstance, desktopProfile, runningDesktop, type DesktopInstanceSpec } from '../src/desktop-instance.ts'
import { CdpError } from '../src/cdp.ts'
import { vi } from 'vitest'
import { resolveInstanceSpec, Config } from '../src/index.ts'

let home: string
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'dsh-desktop-instance-')) })
afterEach(() => { rmSync(home, { recursive: true, force: true }) })

/** Write an installed app whose archive manifest the copy can rename. */
function installedApp(): string {
  const app = join(home, 'installed')
  mkdirSync(join(app, 'resources'), { recursive: true })
  writeFileSync(join(app, 'App.exe'), 'binary')
  const json = Buffer.from(JSON.stringify({ files: { 'package.json': { size: 14, offset: '0' } } }))
  const header = Buffer.alloc(8 + json.length)
  header.writeUInt32LE(4 + json.length, 0)
  header.writeUInt32LE(json.length, 4)
  json.copy(header, 8)
  const size = Buffer.alloc(8)
  size.writeUInt32LE(4, 0)
  size.writeUInt32LE(header.length, 4)
  writeFileSync(join(app, 'resources', 'app.asar'), Buffer.concat([size, header, Buffer.from('{"name":"app"}')]))
  return app
}

function profile(name: string): string {
  const dir = join(home, 'profiles', name)
  mkdirSync(join(dir, 'sessions'), { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: `dsh-profile-${name}`, dependencies: {} }))
  writeFileSync(join(dir, 'profile.json'), JSON.stringify({ version: 1, title: 'Mine' }))
  writeFileSync(join(dir, 'cordis.patch.yml'), '- id: x\n')
  writeFileSync(join(dir, 'sessions', 'log.jsonl'), 'secret')
  return dir
}

function spec(appDir: string): DesktopInstanceSpec {
  return {
    appDir, exeName: 'App.exe', dshHome: home, stateDir: join(home, 'state'), sourceProfile: 'harness',
    testProfile: 'desktop-test-instance', port: 9399, launchTimeoutMs: 1000, commandTimeoutMs: 1000, nodeExecutable: process.execPath,
  }
}

describe('locating the Desktop app and profile', () => {
  it('reads the executable this Host runs as, and nothing under plain Node', () => {
    expect(runningDesktop('D:\\Apps\\DeepSeek Harness.exe')).toEqual({ dir: 'D:\\Apps', exe: 'DeepSeek Harness.exe' })
    expect(runningDesktop('/usr/bin/node')).toBeUndefined()
    expect(runningDesktop('C:\\node\\node.exe')).toBeUndefined()
  })

  it('picks the profile the Desktop starts on, by its own rule', () => {
    expect(desktopProfile(home, { DSH_DESKTOP_PROFILE: 'pinned' })).toBe('pinned')
    expect(desktopProfile(home, {})).toBe('desktop')
    profile('harness')
    writeFileSync(join(home, 'profile-hub.json'), JSON.stringify({ launcher: 'harness' }))
    expect(desktopProfile(home, {})).toBe('harness')
  })

  it('explains a Host under plain Node instead of guessing an app directory', () => {
    const config = Config({})
    expect(resolveInstanceSpec(config, '/usr/bin/node')).toMatch(/set desktopDir and desktopExecutable/)
    const resolved = resolveInstanceSpec(Object.assign({}, config, { desktopDir: 'D:\\Apps', desktopExecutable: 'App.exe' }), '/usr/bin/node')
    expect(resolved).toMatchObject({ appDir: 'D:\\Apps', exeName: 'App.exe', testProfile: 'desktop-test-instance', port: 9333 })
  })
})

describe('preparing', () => {
  it('copies the app and clones the profile without its sessions, once', async () => {
    const app = installedApp()
    profile('harness')
    const instance = new DesktopTestInstance(spec(app))
    expect(await instance.prepare()).toMatch(/copied .* \(application name app -> apx\); cloned profile harness to desktop-test-instance/)
    const clone = join(home, 'profiles', 'desktop-test-instance')
    const read = (file: string): Record<string, unknown> => JSON.parse(readFileSync(join(clone, file), 'utf8')) as Record<string, unknown>
    expect(read('package.json').name).toBe('dsh-profile-desktop-test-instance')
    expect(read('profile.json').title).toBe('Test instance (harness)')
    expect(readFileSync(join(clone, 'cordis.patch.yml'), 'utf8')).toBe('- id: x\n')
    expect(existsSync(join(clone, 'sessions'))).toBe(false)
    expect(await instance.prepare()).toBe('the copy and the test profile are current')
  })

  it('refuses an app directory with no executable and a missing source profile', async () => {
    await expect(new DesktopTestInstance(spec(join(home, 'nowhere'))).prepare()).rejects.toThrow(/no Desktop application/)
    const app = installedApp()
    await expect(new DesktopTestInstance(spec(app)).prepare()).rejects.toThrow(/no source profile/)
  })
})

describe('an instance that is not running', () => {
  it('reports itself stopped, and refuses to be driven', async () => {
    const instance = new DesktopTestInstance(spec(installedApp()))
    expect(await instance.stop()).toBe(false)
    expect(await instance.status()).toMatchObject({ running: false, pid: undefined, targets: [], logTail: '' })
    await expect(instance.evaluate('1')).rejects.toThrow(/not running; call it with action "launch" first/)
  })
})

describe('waiting for a condition', () => {
  const spec = (): DesktopInstanceSpec => ({
    appDir: home, exeName: 'App.exe', dshHome: home, stateDir: join(home, 'state'), sourceProfile: 'a', testProfile: 'b',
    port: 1, launchTimeoutMs: 1000, commandTimeoutMs: 1000, nodeExecutable: process.execPath,
  })

  it('treats a dropped connection as not yet, and returns once the page answers', async () => {
    const instance = new DesktopTestInstance(spec())
    const answers = [new CdpError('the target closed the connection'), 'false', '"ready"']
    vi.spyOn(instance, 'evaluate').mockImplementation(async () => {
      const next = answers.shift()
      if (next instanceof Error) throw next
      return next ?? '"ready"'
    })
    expect(await instance.waitFor('x', 5000)).toBe('"ready"')
  })

  it('still fails on an error from the page, and names the last transport error on a timeout', async () => {
    const instance = new DesktopTestInstance(spec())
    vi.spyOn(instance, 'evaluate').mockRejectedValueOnce(new Error('the page threw: boom'))
    await expect(instance.waitFor('x', 5000)).rejects.toThrow('the page threw: boom')
    vi.spyOn(instance, 'evaluate').mockRejectedValue(new CdpError('gone'))
    await expect(instance.waitFor('x', 300)).rejects.toThrow('last value (gone)')
  })
})
