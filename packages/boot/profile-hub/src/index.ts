/**
 * The `profileHub` service: every dsh profile on this machine, and the Remote
 * surface a landing page uses to list, create, remove, launch, and enter one.
 *
 * A profile is a directory under `<home>/profiles` that composes an ordered
 * stack of bundle patch layers; it is also the unit a person separates their
 * work by, because `dsh --profile <name>` boots exactly one of them. This
 * service owns the directory-level facts a person acts on (what exists, what it
 * is called, where it works, how many chats it holds) and the launch of a
 * second host for a profile other than this one.
 *
 * It deliberately owns no composition: creating a profile copies the running
 * profile's bundle layers, the install entries it declares for those layers,
 * and its patch layer, then appends the three isolation rows that keep chats,
 * workspaces, and credentials inside the profile's own directory. Everything
 * else about the profile stays the profile's own business.
 *
 * ```yaml
 * - id: profile-hub
 *   name: '@deepseek-ai/dsh-profile-hub'
 * ```
 *
 * @module @deepseek-ai/dsh-profile-hub
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { PROFILE_TEMPLATES, resolveProfileDir } from '@deepseek-ai/dsh-app-boot'
import type { ProfileContext } from '@deepseek-ai/dsh-app-boot'
import type { ChildProcess } from 'node:child_process'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import z from '@deepseek-ai/schemastery'
import { exitedWithin, openDesktopWindow, ProfileLauncher } from './launcher.ts'
import {
  countChats, createProfileDirectory, isIsolated, readProfileBundles, readProfileDependencies, readProfileMeta,
  removeProfileDirectory,
} from './profiles.ts'
import type {
  CreateProfileRequest, OpenProfileResult, OpenProfileTarget, ProfileHubState, ProfileSummary,
} from './types.ts'

export * from './types.ts'

/** The state file this package owns inside the harness home. */
export const PROFILE_HUB_STATE_FILENAME = 'profile-hub.json'

/**
 * Profile names this surface never edits: the profile the Electron application
 * boots, and every name the installation initializes from its own template.
 * They are other owners' state, not this page's to remove.
 */
const RESERVED_PROFILES = new Set<string>(['desktop', ...Object.keys(PROFILE_TEMPLATES)])

/** The directory name the shared module tree uses; not a profile. */
const SHARED_MODULES_DIR = 'node_modules'

/**
 * Where a profile's Desktop window keeps its own Chromium data. Separate per
 * profile because Electron's single-instance lock is per user-data directory:
 * one shared directory is what refuses a second window.
 */
const DESKTOP_WINDOWS_DIR = 'desktop-windows'

/** What this hub reads from its own state file. */
interface HubStateDocument {
  /** The profile whose startup opens the landing page. */
  readonly launcher?: string
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Every profile on this machine, with the launch surface a landing page calls. */
    profileHub: ProfileHub
  }
}

/** Plugin config: the locations and the launch bound this deployment varies. */
export interface Config {
  /** Harness home whose `profiles` directory this hub manages; defaults to the running launcher's. */
  home?: string
  /** Absolute path of the dsh CLI entry a launched profile runs; defaults to the running installation's. */
  dshEntry?: string
  /** Absolute path of the Desktop application to open a profile window with; defaults to the running one. */
  desktopExecutable?: string
  /** The profile whose startup opens the landing page; overridden at runtime by the hub's own state file. */
  launcher?: string
  /** How long a launched profile may take to serve before its launch is abandoned, in milliseconds. */
  startTimeoutMs?: number
  /** How long a launched Desktop window must survive before the launch counts as accepted, in milliseconds. */
  desktopProbeMs?: number
}

/** {@link Config} after its schema defaults: the launcher and both bounds are always present. */
export type ResolvedConfig = Config & Required<Pick<Config, 'launcher' | 'startTimeoutMs' | 'desktopProbeMs'>>

/**
 * The `ctx.profileHub` service. The service name is the literal the Typert
 * analyzer reads to bind the namespace, so it cannot be factored into a constant.
 */
export class ProfileHub extends TypertRemoteService {
  static inject = ['profileContext']
  static Config: z<Config, ResolvedConfig> = z.object({
    home: z.string(),
    dshEntry: z.string(),
    desktopExecutable: z.string(),
    launcher: z.string().default('desktop'),
    startTimeoutMs: z.number().step(1).min(1000).default(120000),
    desktopProbeMs: z.number().step(1).min(200).default(2000),
  })

  private readonly profile: ProfileContext
  private readonly home: string
  private readonly defaultLauncher: string
  private readonly startTimeoutMs: number
  private readonly desktopProbeMs: number
  private readonly dshEntry: string | undefined
  private readonly desktopExecutable: string | undefined
  private readonly hosts = new ProfileLauncher()
  /** Desktop windows this hub opened, so a profile opens one window rather than many. */
  private readonly desktopWindows = new Map<string, ChildProcess>()

  /**
   * @param ctx - the Host context this service is mounted on.
   * @param config - harness home, spawn target, default launcher, and launch bound.
   */
  constructor(ctx: Context, config: ResolvedConfig) {
    super(ctx, 'profileHub')
    this.profile = ctx.profileContext
    this.home = config.home ?? this.profile.home
    this.defaultLauncher = config.launcher
    this.startTimeoutMs = config.startTimeoutMs
    this.desktopProbeMs = config.desktopProbeMs
    this.dshEntry = config.dshEntry ?? join(dirname(this.profile.installAnchor), 'lib', 'bin.js')
    // A Desktop window is only reachable from the Desktop application's own
    // process, which is the one whose executable is Electron.
    this.desktopExecutable = config.desktopExecutable
      ?? (process.versions.electron === undefined ? undefined : process.execPath)
    ctx.effect(() => () => { this.hosts.dispose() }, 'profileHub: launched hosts')
  }

  /**
   * Every profile this machine holds, with the facts the landing page renders.
   * @returns the harness home, the running profile, the launcher profile, and one row per profile.
   */
  @Remote
  listProfiles(): ProfileHubState {
    return { ...this.frame(), profiles: this.readProfiles() }
  }

  /**
   * Create one self-contained profile from the running profile's own stack.
   * @param request - the name, optional title and working directory, and whether to copy the running layer.
   * @returns the machine's state after the profile exists.
   * @throws RemoteError with `profileHub/rejected` when the name is invalid, taken, or reserved.
   */
  @Remote
  createProfile(request: CreateProfileRequest): ProfileHubState {
    try {
      const dir = this.resolveTarget(request.name)
      if (existsSync(dir)) throw new Error(`profile ${JSON.stringify(request.name)} already exists at ${dir}`)
      if (RESERVED_PROFILES.has(request.name)) {
        throw new Error(`profile ${JSON.stringify(request.name)} is reserved by the installation or the Desktop app`)
      }
      const tuning = request.clone === false ? undefined : this.runningLayer()
      createProfileDirectory(
        dir,
        [...this.profile.startedBundles],
        readProfileDependencies(this.profile.dir),
        tuning,
        this.home,
        {
          title: request.title === undefined || request.title.trim() === '' ? request.name : request.title.trim(),
          ...request.workdir === undefined || request.workdir.trim() === '' ? {} : { workdir: request.workdir.trim() },
        },
      )
      return this.listProfiles()
    } catch (error) {
      throw this.rejected(error, 'create', request.name)
    }
  }

  /**
   * Remove one profile and everything it owns, including its chats and logins.
   * @param name - the profile to remove.
   * @returns the machine's state after the removal.
   * @throws RemoteError with `profileHub/rejected` when the profile is reserved, running, or this one.
   */
  @Remote
  removeProfile(name: string): ProfileHubState {
    try {
      this.assertEditable(name, 'remove')
      if (this.hosts.url(name) !== undefined) {
        throw new Error(`profile ${JSON.stringify(name)} is running; stop it before removing it`)
      }
      removeProfileDirectory(this.resolveTarget(name))
      return this.listProfiles()
    } catch (error) {
      throw this.rejected(error, 'remove', name)
    }
  }

  /**
   * Choose which profile opens the landing page at startup.
   * @param name - the profile whose startup should land on this page.
   * @returns the machine's state after the choice.
   * @throws RemoteError with `profileHub/rejected` when no such profile exists.
   */
  @Remote
  setLauncherProfile(name: string): ProfileHubState {
    try {
      const dir = this.resolveTarget(name)
      if (!existsSync(join(dir, 'package.json'))) throw new Error(`profile ${JSON.stringify(name)} does not exist`)
      writeFileSync(this.statePath(), `${JSON.stringify({ version: 1, launcher: name }, undefined, 2)}\n`)
      return this.listProfiles()
    } catch (error) {
      throw this.rejected(error, 'set-launcher', name)
    }
  }

  /**
   * Start a profile as its own host process and answer the URL to enter it at.
   *
   * A host serves exactly one profile, so entering another one starts a second
   * process rather than reconfiguring this one; a profile this hub already
   * started answers with the same URL instead of a second host.
   * @param name - the profile to enter.
   * @param target - open a second Desktop window, or start a Web Host and answer its URL.
   * @returns which surface opened, and the URL when a Web Host did.
   * @throws RemoteError with `profileHub/rejected` when the profile cannot be opened.
   */
  @Remote
  async openProfile(name: string, target: OpenProfileTarget): Promise<OpenProfileResult> {
    try {
      const dir = this.resolveTarget(name)
      if (!existsSync(join(dir, 'package.json'))) throw new Error(`profile ${JSON.stringify(name)} does not exist`)
      const { workdir } = readProfileMeta(dir)
      if (target === 'app') {
        await this.openDesktop(name, workdir ?? this.home)
        return { opened: 'app' }
      }
      // The same fact `canLaunch` reports: a host whose installation carries no
      // CLI entry names the reason instead of spawning a file that is not there.
      if (this.dshEntry === undefined || !existsSync(this.dshEntry)) {
        throw new Error('this host has no dsh entry to launch a profile with')
      }
      const url = await this.hosts.start({
        name,
        entry: this.dshEntry,
        home: this.home,
        cwd: workdir ?? this.home,
        timeoutMs: this.startTimeoutMs,
      })
      return { opened: 'browser', url }
    } catch (error) {
      throw this.rejected(error, 'open', name)
    }
  }

  /**
   * Open one profile as a second Desktop window, unless one is already open.
   * @param name - the profile the window owns.
   * @param cwd - the profile's working directory, or the harness home.
   * @throws {Error} when this host cannot open a window, or the application refused it.
   */
  private async openDesktop(name: string, cwd: string): Promise<void> {
    if (this.desktopExecutable === undefined || !existsSync(this.desktopExecutable)) {
      throw new Error('this host was not started by the Desktop application, so it cannot open a Desktop window')
    }
    const opened = this.desktopWindows.get(name)
    if (opened !== undefined && opened.exitCode === null) return
    const window = openDesktopWindow({
      name,
      executable: this.desktopExecutable,
      // Electron's single-instance lock is per user-data directory, so a window
      // that shared the primary one would be refused before it ever appeared.
      // Each profile therefore owns its own window data, exactly as it owns its
      // own chats and credentials.
      args: [`--user-data-dir=${join(this.home, DESKTOP_WINDOWS_DIR, name)}`],
      cwd,
      environment: process.env,
    })
    this.desktopWindows.set(name, window)
    window.once('exit', () => {
      if (this.desktopWindows.get(name) === window) this.desktopWindows.delete(name)
    })
    if (await exitedWithin(window, this.desktopProbeMs)) {
      this.desktopWindows.delete(name)
      throw new Error(
        `the Desktop application closed the window for ${JSON.stringify(name)} as soon as it opened; `
        + 'a build without the profile-selection patch refuses a second window',
      )
    }
  }

  /**
   * Stop a profile this hub started.
   * @param name - the profile whose host should stop.
   * @returns the machine's state after the stop.
   */
  @Remote
  stopProfile(name: string): ProfileHubState {
    try {
      this.hosts.stop(name)
      return this.listProfiles()
    } catch (error) {
      throw this.rejected(error, 'stop', name)
    }
  }

  /** The state fields that do not depend on enumerating the profiles directory. */
  private frame(): Omit<ProfileHubState, 'profiles'> {
    const launcher = this.launcherName()
    return {
      home: this.home,
      profilesDir: this.profilesDir(),
      current: this.profile.name,
      launcher,
      landing: launcher === this.profile.name,
      canLaunch: this.dshEntry !== undefined && existsSync(this.dshEntry),
      canOpenDesktop: this.desktopExecutable !== undefined && existsSync(this.desktopExecutable),
    }
  }

  /** The profiles directory under the harness home. */
  private profilesDir(): string {
    return join(this.home, 'profiles')
  }

  /** The path of this hub's own state file. */
  private statePath(): string {
    return join(this.home, PROFILE_HUB_STATE_FILENAME)
  }

  /** The profile whose startup opens the landing page: the recorded choice, else the configured default. */
  private launcherName(): string {
    try {
      const parsed = JSON.parse(readFileSync(this.statePath(), 'utf8')) as HubStateDocument | null
      const recorded = parsed?.launcher
      return typeof recorded === 'string' && recorded !== '' ? recorded : this.defaultLauncher
    } catch (error) {
      // An absent or unreadable choice file is not a boot failure: the
      // configured default still names a launcher. Only this one small file and
      // its own parse are in scope.
      if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === 'ENOENT') return this.defaultLauncher
      throw error
    }
  }

  /** The running profile's own patch layer, as the tuning a new profile starts from. */
  private runningLayer(): string | undefined {
    try {
      return readFileSync(this.profile.patchPath, 'utf8')
    } catch (error) {
      // A profile booted without a patch layer copies an empty one; the new
      // profile still gets its isolation rows.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }

  /** Every profile directory, launcher first, then the running one, then by name. */
  private readProfiles(): ProfileSummary[] {
    const dir = this.profilesDir()
    if (!existsSync(dir)) return []
    const launcher = this.launcherName()
    const rows: ProfileSummary[] = []
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === SHARED_MODULES_DIR) continue
      const profileDir = join(dir, entry.name)
      if (!existsSync(join(profileDir, 'package.json'))) continue
      const meta = readProfileMeta(profileDir)
      const isolated = isIsolated(profileDir)
      const url = this.hosts.url(entry.name)
      rows.push({
        name: entry.name,
        title: meta.title ?? entry.name,
        ...meta.workdir === undefined ? {} : { workdir: meta.workdir },
        bundles: readProfileBundles(profileDir),
        isolated,
        ...isolated ? { chats: countChats(join(profileDir, 'sessions')) } : {},
        locked: RESERVED_PROFILES.has(entry.name),
        current: entry.name === this.profile.name,
        launcher: entry.name === launcher,
        running: url !== undefined,
        ...url === undefined ? {} : { url },
      })
    }
    const rank = (row: ProfileSummary): number => row.launcher ? 0 : row.current ? 1 : 2
    return rows.sort((left, right) => rank(left) - rank(right) || left.name.localeCompare(right.name))
  }

  /** Resolve a profile name to its directory, using the launcher's own validator. */
  private resolveTarget(name: string): string {
    if (name.trim() === '') throw new Error('a profile needs a name')
    return resolveProfileDir(name.trim(), this.home)
  }

  /** Refuse an edit to a profile this surface does not own. */
  private assertEditable(name: string, action: string): void {
    if (RESERVED_PROFILES.has(name)) {
      throw new Error(`profile ${JSON.stringify(name)} is reserved by the installation or the Desktop app, so this page will not ${action} it`)
    }
    if (name === this.profile.name) {
      throw new Error(`profile ${JSON.stringify(name)} is the one this host booted, so this page will not ${action} it`)
    }
  }

  /**
   * Wrap a local failure as the namespace's structured Remote refusal.
   * @param error - the caught failure.
   * @param action - the operation that was refused.
   * @param profile - the profile it named, when it named one.
   * @returns the error to throw.
   */
  private rejected(error: unknown, action: string, profile?: string): RemoteError {
    return new RemoteError(
      'profileHub/rejected',
      error instanceof Error ? error.message : String(error),
      { action, ...profile === undefined ? {} : { profile } },
      { cause: error },
    )
  }
}

export default ProfileHub
