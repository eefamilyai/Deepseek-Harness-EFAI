/**
 * The profile hub: what it lists, what it creates, what it refuses, and the
 * host it starts when asked to enter a profile.
 *
 * The launcher cases run a real child process — a stand-in entry script that
 * prints the line a host prints — because reading that line out of a child's
 * output is the one thing no unit seam can stand in for.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { ProfileContext } from '@deepseek-ai/dsh-app-boot'
import { afterEach, describe, expect, it } from 'vitest'
import ProfileHub, { PROFILE_HUB_STATE_FILENAME } from '../src/index.ts'
import {
  countChats, createProfileDirectory, isIsolated, isolationPatch, readProfileBundles, readProfileDependencies,
  readProfileMeta, removeProfileDirectory, seedProfileCredentials, writeProfileMeta,
} from '../src/profiles.ts'
import { ProfileLauncher, exitedWithin, openDesktopWindow } from '../src/launcher.ts'

const dirs: string[] = []

/** A temporary harness home, removed when its case ends. */
function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-profile-hub-'))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    // A launched child is killed by its case, and Windows refuses to remove a
    // directory a dying process still holds, so removal waits it out.
    for (let attempt = 0; ; attempt += 1) {
      try {
        rmSync(dir, { recursive: true, force: true })
        break
      } catch (error) {
        if (attempt >= 40) throw error
        await new Promise(resolve => setTimeout(resolve, 100))
      }
    }
  }
})

/**
 * Write one profile directory the way `dsh plugin --profile <name>` does, with
 * the display metadata and the state roots this package adds.
 * @param home - the harness home.
 * @param name - the profile name.
 * @param bundles - the bundle layers to declare.
 * @param chats - how many sessions to stage under the profile's own root.
 * @returns the profile directory.
 */
function stageProfile(
  home: string, name: string, bundles: readonly string[], chats = 0,
  dependencies: Readonly<Record<string, string>> = {},
): string {
  const dir = join(home, 'profiles', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify({
    name: `dsh-profile-${name}`,
    private: true,
    dependencies,
    dsh: { profile: { bundles: [...bundles] } },
  }, undefined, 2)}\n`)
  if (chats > 0) {
    for (let index = 0; index < chats; index += 1) {
      mkdirSync(join(dir, 'sessions', '--project--', `session-${String(index)}`), { recursive: true })
    }
  }
  return dir
}

/** A profile context naming a staged profile, as the launcher provides it. */
function contextFor(home: string, name: string, entryExists: boolean): ProfileContext {
  const dir = join(home, 'profiles', name)
  writeFileSync(join(home, 'package.json'), '{"name":"installation","dependencies":{}}\n')
  if (entryExists) {
    mkdirSync(join(home, 'lib'), { recursive: true })
    writeFileSync(join(home, 'lib', 'bin.js'), "console.log('dsh web: http://127.0.0.1:1/?token=stub')\n")
  }
  return {
    name,
    dir,
    patchPath: join(dir, 'cordis.patch.yml'),
    installAnchor: join(home, 'package.json'),
    cwd: home,
    home,
    startedBundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'],
    overlays: [],
    telemetryDisabledEnv: undefined,
  }
}

/**
 * Mount the hub over a real context carrying one profile context.
 * @param home - the harness home.
 * @param name - the profile the launched host is running.
 * @param entryExists - whether the installation has a CLI entry to spawn.
 * @param desktopExecutable - the Desktop application to open windows with, when the case stages one.
 * @returns the mounted service.
 */
async function mount(
  home: string,
  name: string,
  entryExists = false,
  desktopExecutable?: string,
): Promise<ProfileHub> {
  const ctx = new Context()
  ctx.provide('profileContext', contextFor(home, name, entryExists))
  await ctx.plugin(ProfileHub, {
    home,
    ...desktopExecutable === undefined ? {} : { desktopExecutable },
  }).await()
  return ctx.profileHub
}

describe('profile directories', () => {
  it('reads display metadata, treating a null field as absent', () => {
    const dir = tempHome()
    expect(readProfileMeta(dir)).toEqual({})
    writeProfileMeta(dir, { title: 'School', workdir: 'C:\\School' })
    expect(readProfileMeta(dir)).toEqual({ title: 'School', workdir: 'C:\\School' })
    writeFileSync(join(dir, 'profile.json'), '{"version":1,"title":"","workdir":null}\n')
    expect(readProfileMeta(dir), 'an empty title and a null directory are both absent').toEqual({})
    writeFileSync(join(dir, 'profile.json'), '{not json')
    expect(readProfileMeta(dir), 'unreadable metadata lists the profile by name instead of failing').toEqual({})
  })

  it('reads the declared bundle layers and drops anything that is not a string', () => {
    const dir = tempHome()
    expect(readProfileBundles(dir)).toEqual([])
    writeFileSync(join(dir, 'package.json'), '{"dsh":{"profile":{"bundles":["a",7,"b"]}}}')
    expect(readProfileBundles(dir)).toEqual(['a', 'b'])
    writeFileSync(join(dir, 'package.json'), '{"dsh":{"profile":{}}}')
    expect(readProfileBundles(dir)).toEqual([])
    writeFileSync(join(dir, 'package.json'), 'nope')
    expect(readProfileBundles(dir)).toEqual([])
  })

  it('counts chats one directory deep under each project', () => {
    const root = join(tempHome(), 'sessions')
    expect(countChats(root)).toBe(0)
    mkdirSync(join(root, '--one--', 'session-a'), { recursive: true })
    mkdirSync(join(root, '--one--', 'session-b'), { recursive: true })
    mkdirSync(join(root, '--two--', 'session-c'), { recursive: true })
    writeFileSync(join(root, 'stray-file'), '')
    expect(countChats(root)).toBe(3)
  })

  it('calls a profile isolated only when it owns a session root', () => {
    const dir = tempHome()
    expect(isIsolated(dir)).toBe(false)
    mkdirSync(join(dir, 'sessions'))
    expect(isIsolated(dir)).toBe(true)
  })

  it('writes the three isolation rows against the profile directory', () => {
    const dir = join('C:', 'profiles', 'school')
    const patch = isolationPatch(dir)
    expect(patch).toContain('session-persistence-jsonl')
    expect(patch).toContain('storage-json')
    expect(patch).toContain('credentials')
    expect(patch).toContain(join(dir, 'sessions'))
    expect(patch).toContain(join(dir, 'storages'))
    expect(patch).toContain(join(dir, 'credentials.yaml'))
  })

  it('creates a self-contained profile from the caller\'s layers and tuning', () => {
    const home = tempHome()
    const dir = join(home, 'profiles', 'school')
    createProfileDirectory(
      dir, ['@deepseek-ai/dsh-base'], {}, '# tuning\n[]\n', home, { title: 'School', workdir: 'C:\\School' },
    )
    expect(readProfileBundles(dir)).toEqual(['@deepseek-ai/dsh-base'])
    expect(readProfileMeta(dir)).toEqual({ title: 'School', workdir: 'C:\\School' })
    expect(isIsolated(dir)).toBe(true)
    expect(existsSync(join(dir, 'storages'))).toBe(true)
    expect(existsSync(join(dir, 'credentials.yaml'))).toBe(true)
    const patch = readFileSync(join(dir, 'cordis.patch.yml'), 'utf8')
    expect(patch, 'the copied tuning survives and the isolation rows follow it').toContain('# tuning')
    expect(patch).toContain('session-persistence-jsonl')
  })

  it('installs the copied bundles a source profile declared, and only those', () => {
    const home = tempHome()
    const dir = join(home, 'profiles', 'school')
    createProfileDirectory(
      dir, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-efai-base'], {
        '@deepseek-ai/dsh-base': '0.2.0-rc.2',
        '@deepseek-ai/dsh-efai-base': '0.1.0-local.1',
        '@acme/dsh-sidebar': '^1.0.0',
      }, undefined, home, { title: 'School' },
    )
    expect(readProfileDependencies(dir)).toEqual({
      '@deepseek-ai/dsh-base': '0.2.0-rc.2',
      '@deepseek-ai/dsh-efai-base': '0.1.0-local.1',
    })
  })

  it('removes a profile directory and everything in it', () => {
    const dir = tempHome()
    mkdirSync(join(dir, 'nested'), { recursive: true })
    removeProfileDirectory(dir)
    expect(existsSync(dir)).toBe(false)
  })
})

describe('credential seeding', () => {
  it('copies the provider keys a machine already holds, and no login', () => {
    const home = tempHome()
    writeFileSync(join(home, '.credentials.yaml'), [
      'version: 1',
      'refs:',
      '  OPENROUTER_API_KEY: sk-test',
      'records:',
      '  deepseek-account-platform/default:',
      '    kind: grant',
      '    payload: { token: secret }',
      '',
    ].join('\n'))
    const dir = join(home, 'profiles', 'school')
    mkdirSync(dir, { recursive: true })
    seedProfileCredentials(dir, home)
    const written = readFileSync(join(dir, 'credentials.yaml'), 'utf8')
    expect(written).toContain('OPENROUTER_API_KEY')
    expect(written, 'a login belongs to the profile that signed in, not to a new one').not.toContain('deepseek-account-platform')
    expect(written).toContain('records: {}')
  })

  it('starts an empty reference list when the machine holds no document', () => {
    const home = tempHome()
    const dir = join(home, 'profiles', 'school')
    mkdirSync(dir, { recursive: true })
    seedProfileCredentials(dir, home)
    expect(readFileSync(join(dir, 'credentials.yaml'), 'utf8')).toContain('refs: {}')
  })

  it('leaves a profile\'s own document alone', () => {
    const home = tempHome()
    writeFileSync(join(home, '.credentials.yaml'), 'version: 1\nrefs:\n  KEEP: yes\n')
    const dir = join(home, 'profiles', 'school')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'credentials.yaml'), 'version: 1\nrefs:\n  MINE: yes\n')
    seedProfileCredentials(dir, home)
    expect(readFileSync(join(dir, 'credentials.yaml'), 'utf8')).toContain('MINE')
  })

  it('seeds nothing from a document it cannot parse', () => {
    const home = tempHome()
    writeFileSync(join(home, '.credentials.yaml'), 'version: [unclosed\n')
    const dir = join(home, 'profiles', 'school')
    mkdirSync(dir, { recursive: true })
    seedProfileCredentials(dir, home)
    expect(readFileSync(join(dir, 'credentials.yaml'), 'utf8')).toContain('refs: {}')
  })
})

describe('listing', () => {
  it('ranks the launcher, then the running profile, then the rest by name', async () => {
    const home = tempHome()
    stageProfile(home, 'school', ['@deepseek-ai/dsh-base'], 2)
    stageProfile(home, 'alpha', ['@deepseek-ai/dsh-base'])
    const running = stageProfile(home, 'harness', ['@deepseek-ai/dsh-base'])
    writeFileSync(join(running, 'profile.json'), '{"version":1,"title":"DeepSeek Harness","workdir":"D:\\\\repo"}\n')
    mkdirSync(join(home, 'profiles', 'node_modules'), { recursive: true })
    mkdirSync(join(home, 'profiles', 'not-a-profile'), { recursive: true })
    writeFileSync(join(home, PROFILE_HUB_STATE_FILENAME), '{"version":1,"launcher":"school"}\n')
    const hub = await mount(home, 'harness')

    const state = hub.listProfiles()
    expect(state.profiles.map(profile => profile.name)).toEqual(['school', 'harness', 'alpha'])
    const school = state.profiles[0]!
    expect(school.launcher).toBe(true)
    expect(school.chats).toBe(2)
    expect(school.isolated).toBe(true)
    const harness = state.profiles[1]!
    expect(harness.current).toBe(true)
    expect(harness.title).toBe('DeepSeek Harness')
    expect(harness.workdir).toBe('D:\\repo')
    expect(harness.chats, 'a profile with no session root reports no count').toBeUndefined()
    expect(state.landing, 'the running profile is not the launcher').toBe(false)
    expect(state.canLaunch).toBe(false)
    expect(state.home).toBe(home)
    expect(state.profilesDir).toBe(join(home, 'profiles'))
  })

  it('marks the reserved names and reports a profile that owns the landing page', async () => {
    const home = tempHome()
    stageProfile(home, 'desktop', ['@deepseek-ai/dsh-base'])
    stageProfile(home, 'web', ['@deepseek-ai/dsh-base'])
    const hub = await mount(home, 'desktop')
    const state = hub.listProfiles()
    expect(state.landing, 'the configured default launcher is this profile').toBe(true)
    expect(state.profiles.every(profile => profile.locked)).toBe(true)
  })

  it('lists nothing when the home has no profiles directory', async () => {
    const home = tempHome()
    const hub = await mount(home, 'desktop')
    expect(hub.listProfiles().profiles).toEqual([])
  })
})

describe('creating and removing', () => {
  it('creates a self-contained profile from the running profile\'s stack and tuning', async () => {
    const home = tempHome()
    stageProfile(home, 'harness', ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
    const running = join(home, 'profiles', 'harness')
    writeFileSync(join(running, 'cordis.patch.yml'), '# tuned\n[]\n')
    writeFileSync(join(home, '.credentials.yaml'), 'version: 1\nrefs:\n  KEY: value\n')
    const hub = await mount(home, 'harness')

    const state = hub.createProfile({ name: 'school', title: 'School', workdir: 'C:\\School' })
    const created = state.profiles.find(profile => profile.name === 'school')!
    expect(created.title).toBe('School')
    expect(created.workdir).toBe('C:\\School')
    expect(created.bundles).toEqual(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
    expect(created.isolated).toBe(true)
    const patch = readFileSync(join(home, 'profiles', 'school', 'cordis.patch.yml'), 'utf8')
    expect(patch, 'the running profile\'s layer is the starting point').toContain('# tuned')
    expect(patch).toContain('session-persistence-jsonl')
  })

  it('carries the running profile\'s install entries for the layers it copies', async () => {
    const home = tempHome()
    stageProfile(home, 'harness', ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'], 0, {
      '@deepseek-ai/dsh-base': '0.2.0-rc.2',
      '@deepseek-ai/dsh-web-app': '0.2.0-rc.2',
      '@acme/dsh-sidebar': '^1.0.0',
    })
    const hub = await mount(home, 'harness')
    hub.createProfile({ name: 'school' })
    expect(readProfileDependencies(join(home, 'profiles', 'school'))).toEqual({
      '@deepseek-ai/dsh-base': '0.2.0-rc.2',
      '@deepseek-ai/dsh-web-app': '0.2.0-rc.2',
    })
  })

  it('starts from an empty layer when the caller asks for no clone', async () => {
    const home = tempHome()
    stageProfile(home, 'harness', ['@deepseek-ai/dsh-base'])
    writeFileSync(join(home, 'profiles', 'harness', 'cordis.patch.yml'), '# tuned\n[]\n')
    const hub = await mount(home, 'harness')
    hub.createProfile({ name: 'plain', clone: false })
    const patch = readFileSync(join(home, 'profiles', 'plain', 'cordis.patch.yml'), 'utf8')
    expect(patch).not.toContain('# tuned')
    expect(patch).toContain('credentials')
  })

  it('names a profile after itself when no title is given', async () => {
    const home = tempHome()
    stageProfile(home, 'harness', ['@deepseek-ai/dsh-base'])
    const hub = await mount(home, 'harness')
    const created = hub.createProfile({ name: 'plain', title: '  ' }).profiles.find(profile => profile.name === 'plain')!
    expect(created.title).toBe('plain')
    expect(created.workdir).toBeUndefined()
  })

  it('refuses a name that is taken, reserved, or not a profile name', async () => {
    const home = tempHome()
    stageProfile(home, 'harness', ['@deepseek-ai/dsh-base'])
    const hub = await mount(home, 'harness')
    expect(() => hub.createProfile({ name: 'harness' })).toThrow(/already exists/)
    expect(() => hub.createProfile({ name: 'desktop' })).toThrow(/reserved/)
    expect(() => hub.createProfile({ name: 'web' })).toThrow(/reserved/)
    expect(() => hub.createProfile({ name: 'nested/name' })).toThrow(/invalid profile name/)
    expect(() => hub.createProfile({ name: '  ' })).toThrow(/needs a name/)
  })

  it('removes another profile but not the running one or a reserved name', async () => {
    const home = tempHome()
    stageProfile(home, 'harness', ['@deepseek-ai/dsh-base'])
    stageProfile(home, 'school', ['@deepseek-ai/dsh-base'])
    stageProfile(home, 'desktop', ['@deepseek-ai/dsh-base'])
    const hub = await mount(home, 'harness')

    expect(hub.removeProfile('school').profiles.map(profile => profile.name),
      'the launcher ranks first, then the running profile').toEqual(['desktop', 'harness'])
    expect(() => hub.removeProfile('harness')).toThrow(/this host booted/)
    expect(() => hub.removeProfile('desktop')).toThrow(/reserved/)
    expect(existsSync(join(home, 'profiles', 'school'))).toBe(false)
  })
})

describe('the launcher profile', () => {
  it('records the choice and answers with it', async () => {
    const home = tempHome()
    stageProfile(home, 'harness', ['@deepseek-ai/dsh-base'])
    stageProfile(home, 'school', ['@deepseek-ai/dsh-base'])
    const hub = await mount(home, 'harness')
    const state = hub.setLauncherProfile('school')
    expect(state.launcher).toBe('school')
    expect(state.landing).toBe(false)
    expect(JSON.parse(readFileSync(join(home, PROFILE_HUB_STATE_FILENAME), 'utf8'))).toEqual({ version: 1, launcher: 'school' })
    expect(hub.setLauncherProfile('harness').landing).toBe(true)
  })

  it('refuses a profile that does not exist', async () => {
    const home = tempHome()
    stageProfile(home, 'harness', ['@deepseek-ai/dsh-base'])
    const hub = await mount(home, 'harness')
    expect(() => hub.setLauncherProfile('ghost')).toThrow(/does not exist/)
  })

  it('falls back to the configured launcher when the recorded choice is unreadable', async () => {
    const home = tempHome()
    stageProfile(home, 'harness', ['@deepseek-ai/dsh-base'])
    writeFileSync(join(home, PROFILE_HUB_STATE_FILENAME), '{"version":1,"launcher":42}\n')
    const hub = await mount(home, 'harness')
    expect(hub.listProfiles().launcher, 'the shipped default names the Desktop profile').toBe('desktop')
  })
})

describe('launching', () => {
  it('starts a stand-in host and reports the URL it printed', async () => {
    const home = tempHome()
    stageProfile(home, 'harness', ['@deepseek-ai/dsh-base'])
    stageProfile(home, 'school', ['@deepseek-ai/dsh-base'])
    const hub = await mount(home, 'harness', true)
    const opened = await hub.openProfile('school', 'browser')
    expect(opened).toEqual({ opened: 'browser', url: 'http://127.0.0.1:1/?token=stub' })
    expect(hub.listProfiles().profiles.find(profile => profile.name === 'school')?.running).toBe(true)
    expect(hub.stopProfile('school').profiles.find(profile => profile.name === 'school')?.running).toBe(false)
  })

  it('refuses to launch a profile that does not exist, and one with no entry to run', async () => {
    const home = tempHome()
    stageProfile(home, 'harness', ['@deepseek-ai/dsh-base'])
    const hub = await mount(home, 'harness', true)
    await expect(hub.openProfile('ghost', 'browser')).rejects.toThrow(/does not exist/)
    // A home whose installation has no CLI entry cannot launch anything.
    const bareHome = tempHome()
    stageProfile(bareHome, 'harness', ['@deepseek-ai/dsh-base'])
    const bare = await mount(bareHome, 'harness')
    expect(bare.listProfiles().canLaunch).toBe(false)
    await expect(bare.openProfile('harness', 'browser')).rejects.toThrow(/no dsh entry/)
  })

  it('stops nothing quietly for a profile it never started', async () => {
    const home = tempHome()
    stageProfile(home, 'harness', ['@deepseek-ai/dsh-base'])
    const hub = await mount(home, 'harness')
    expect(hub.stopProfile('harness').profiles).toHaveLength(1)
  })
})

describe('desktop windows', () => {
  it('reports that a host without the Desktop application cannot open one', async () => {
    const home = tempHome()
    stageProfile(home, 'harness', ['@deepseek-ai/dsh-base'])
    stageProfile(home, 'school', ['@deepseek-ai/dsh-base'])
    const hub = await mount(home, 'harness')
    expect(hub.listProfiles().canOpenDesktop).toBe(false)
    await expect(hub.openProfile('school', 'app')).rejects.toThrow(/not started by the Desktop application/)
  })

  it('reports a window the application closed as soon as it opened', async () => {
    const home = tempHome()
    stageProfile(home, 'harness', ['@deepseek-ai/dsh-base'])
    stageProfile(home, 'school', ['@deepseek-ai/dsh-base'])
    // Node refuses the Chromium switch a window is launched with and exits, which
    // is the shape of an Electron single-instance refusal: gone at once, silently.
    const hub = await mount(home, 'harness', true, process.execPath)
    expect(hub.listProfiles().canOpenDesktop).toBe(true)
    await expect(hub.openProfile('school', 'app')).rejects.toThrow(/closed the window for "school"/)
    await expect(hub.openProfile('ghost', 'app')).rejects.toThrow(/does not exist/)
  })

  it('refuses a Desktop window when the configured executable is not there', async () => {
    const home = tempHome()
    stageProfile(home, 'harness', ['@deepseek-ai/dsh-base'])
    const hub = await mount(home, 'harness', true, join(home, 'missing-app.exe'))
    expect(hub.listProfiles().canOpenDesktop).toBe(false)
    await expect(hub.openProfile('harness', 'app')).rejects.toThrow(/not started by the Desktop application/)
  })
})

describe('the launcher', () => {
  /** A stand-in entry script, written into a temp home. */
  function entry(home: string, body: string): string {
    const file = join(home, 'entry.mjs')
    writeFileSync(file, body)
    return file
  }

  it('reports a child that exits before it serves', async () => {
    const home = tempHome()
    const launcher = new ProfileLauncher()
    await expect(launcher.start({
      name: 'school', entry: entry(home, "console.error('boom'); process.exit(3)\n"),
      home, cwd: home, timeoutMs: 30_000,
    })).rejects.toThrow(/exited with code 3 before serving: boom/)
    launcher.dispose()
  })

  it('reports a child that never serves within its bound', async () => {
    const home = tempHome()
    const launcher = new ProfileLauncher()
    await expect(launcher.start({
      name: 'school', entry: entry(home, 'setTimeout(() => {}, 60_000)\n'),
      home, cwd: home, timeoutMs: 1000,
    })).rejects.toThrow(/did not serve within 1000ms/)
    launcher.dispose()
  }, 20_000)

  it('answers with the host already running for a profile', async () => {
    const home = tempHome()
    const launcher = new ProfileLauncher()
    const options = {
      name: 'school',
      entry: entry(home, "console.log('dsh web: http://127.0.0.1:1/?token=stub')\nsetTimeout(() => {}, 60_000)\n"),
      home, cwd: home, timeoutMs: 30_000,
    }
    const first = await launcher.start(options)
    expect(await launcher.start(options), 'a second entry reuses the host already serving').toBe(first)
    expect(launcher.url('school')).toBe(first)
    expect(launcher.stop('school')).toBe(true)
    expect(launcher.url('school'), 'a stopped host is no longer a URL to enter').toBeUndefined()
    expect(launcher.stop('school'), 'stopping twice stops nothing the second time').toBe(false)
    launcher.dispose()
  })

  it('reports a spawn target that cannot start at all', async () => {
    const home = tempHome()
    const launcher = new ProfileLauncher()
    await expect(launcher.start({
      name: 'school', entry: join(home, 'missing-entry.mjs'), home, cwd: home, timeoutMs: 30_000,
    })).rejects.toThrow()
    launcher.dispose()
  })

  it('kills every host it started when it disposes', async () => {
    const home = tempHome()
    const launcher = new ProfileLauncher()
    await launcher.start({
      name: 'school',
      entry: entry(home, "console.log('dsh web: http://127.0.0.1:1/?token=stub')\nsetTimeout(() => {}, 60_000)\n"),
      home, cwd: home, timeoutMs: 30_000,
    })
    launcher.dispose()
    await new Promise(resolve => setTimeout(resolve, 500))
    expect(launcher.url('school')).toBeUndefined()
  })
})

describe('desktop windows', () => {
  it('launches the window on the named profile, as the application rather than as its Node', async () => {
    const home = tempHome()
    const report = join(home, 'window.json')
    const script = join(home, 'window.mjs')
    // A stand-in application: it records what the real one reads, then stays up.
    writeFileSync(script, [
      "import { writeFileSync } from 'node:fs'",
      `writeFileSync(${JSON.stringify(report)}, JSON.stringify({`,
      '  profile: process.env.DSH_DESKTOP_PROFILE ?? null,',
      '  nodeMode: process.env.ELECTRON_RUN_AS_NODE ?? null,',
      '  args: process.argv.slice(2),',
      '}))',
      'setTimeout(() => {}, 60000)',
      '',
    ].join('\n'))
    const child = openDesktopWindow({
      name: 'school',
      executable: process.execPath,
      args: [script, '--user-data-dir=C:\\windows\\school'],
      cwd: home,
      environment: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    })
    expect(await exitedWithin(child, 3000), 'the window stays up').toBe(false)
    const seen = JSON.parse(readFileSync(report, 'utf8')) as {
      readonly profile: string | null
      readonly nodeMode: string | null
      readonly args: readonly string[]
    }
    expect(seen.profile, 'the window is told which profile it owns').toBe('school')
    expect(seen.nodeMode, 'a window that inherited Node mode shows nothing').toBeNull()
    expect(seen.args, 'the switches it was launched with reach the application')
      .toEqual(['--user-data-dir=C:\\windows\\school'])
    child.kill()
  })

  it('reports a window that is gone before the probe elapses', async () => {
    const home = tempHome()
    const script = join(home, 'gone.mjs')
    writeFileSync(script, 'process.exit(0)\n')
    const child = openDesktopWindow({
      name: 'school',
      executable: process.execPath,
      args: [script],
      cwd: home,
      environment: { ...process.env },
    })
    expect(await exitedWithin(child, 3000), 'a refused window is gone at once').toBe(true)
  })
})
