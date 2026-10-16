/**
 * Launching another profile as its own host process.
 *
 * A running host serves exactly one profile: its composition is fixed at boot,
 * so entering a different profile means starting a second host rather than
 * reconfiguring this one. This module owns that child — one per profile, its
 * authenticated URL read from the line the host prints once it is serving — and
 * the teardown that guarantees no launch outlives the hub that made it.
 *
 * @module @deepseek-ai/dsh-profile-hub/launcher
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'

/** How the host prints the URL a browser enters it at. */
const URL_PATTERN = /dsh web: (http:\/\/\S+)/

/** One launched profile host. */
interface RunningProfile {
  readonly child: ChildProcess
  readonly url: string
}

/** What one launch needs. */
export interface LaunchOptions {
  /** The profile to boot. */
  readonly name: string
  /** Absolute path of the dsh CLI entry to run. */
  readonly entry: string
  /** The harness home the child must resolve profiles under. */
  readonly home: string
  /** Working directory for the child; the profile's own when it declares one. */
  readonly cwd: string
  /** How long to wait for the URL before giving up. */
  readonly timeoutMs: number
}

/** The environment key that makes the Electron binary behave as Node. */
const ELECTRON_RUN_AS_NODE = 'ELECTRON_RUN_AS_NODE'

/** The environment key by which a Desktop launch selects the profile it owns. */
const DESKTOP_PROFILE_ENV = 'DSH_DESKTOP_PROFILE'

/** How much of a failed launch's output is kept for its diagnostic. */
const OUTPUT_TAIL_CHARS = 2000

/** What one Desktop-window launch needs. */
export interface DesktopWindowOptions {
  /** The profile the window owns. */
  readonly name: string
  /** The Desktop application's own executable. */
  readonly executable: string
  /** Command-line switches the window is launched with. */
  readonly args: readonly string[]
  /** Working directory for the new application process. */
  readonly cwd: string
  /** The launcher's environment, which the window inherits. */
  readonly environment: NodeJS.ProcessEnv
}

/**
 * Open one profile as a second Desktop window.
 *
 * The window is a separate application process that owns the profile exactly as
 * the primary one owns its own — its directory, its lock, and its Host process —
 * so it is detached and unreferenced: the profile stays open when the window
 * that opened it closes, and closing it never takes another window down.
 * @param options - the profile, the application executable and its switches, and the environment.
 * @returns the launched application process.
 */
export function openDesktopWindow(options: DesktopWindowOptions): ChildProcess {
  // This process runs as Electron's Node; a window that inherited that would
  // start as a script and exit without ever showing one.
  const { [ELECTRON_RUN_AS_NODE]: _runAsNode, ...inherited } = options.environment
  const environment: NodeJS.ProcessEnv = { ...inherited, [DESKTOP_PROFILE_ENV]: options.name }
  const child = spawn(options.executable, [...options.args], {
    cwd: options.cwd,
    env: environment,
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  })
  child.unref()
  return child
}

/**
 * Whether a process is gone before a probe elapses.
 *
 * A window that was refused closes immediately instead of staying for the
 * application's lifetime, which is the only signal an Electron single-instance
 * refusal leaves: no exit code, no output, no window.
 * @param child - the launched process.
 * @param ms - how long to watch for.
 * @returns true when the process exited within the bound.
 */
export async function exitedWithin(child: ChildProcess, ms: number): Promise<boolean> {
  if (child.exitCode !== null) return true
  return await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => { resolve(false) }, ms)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve(true)
    })
  })
}

/**
 * Pick a free loopback port.
 * @returns the port the operating system just confirmed was free.
 */
async function freePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const probe = createServer()
    probe.unref()
    probe.on('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      if (address === null || typeof address === 'string') {
        probe.close(() => { reject(new Error('profileHub: could not allocate a port for the launched profile')) })
        return
      }
      probe.close(() => { resolve(address.port) })
    })
  })
}

/**
 * Child hosts this hub started, keyed by profile name.
 *
 * The map is the whole lifecycle: a profile is "running" exactly while its
 * child is in it, and disposal kills everything left.
 */
export class ProfileLauncher {
  private readonly running = new Map<string, RunningProfile>()

  /**
   * Start one profile, or answer with the host already running for it.
   * @param options - the profile, spawn target, working directory, and bound.
   * @returns the profile's authenticated URL.
   * @throws {Error} when the host exits or stays silent past the bound.
   */
  async start(options: LaunchOptions): Promise<string> {
    const existing = this.running.get(options.name)
    if (existing !== undefined && existing.child.exitCode === null) return existing.url
    const port = await freePort()
    const child = spawn(
      process.execPath,
      [options.entry, '--profile', options.name, '--no-open', '--port', String(port)],
      {
        cwd: options.cwd,
        env: { ...process.env, [ELECTRON_RUN_AS_NODE]: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      },
    )
    try {
      const url = await this.awaitUrl(child, options)
      this.running.set(options.name, { child, url })
      child.once('exit', () => {
        if (this.running.get(options.name)?.child === child) this.running.delete(options.name)
      })
      return url
    } catch (error) {
      child.kill()
      throw error
    }
  }

  /**
   * Wait for a child to report the URL it serves.
   * @param child - the spawned host.
   * @param options - the profile name and the time bound, for the diagnostic.
   * @returns the URL the host printed.
   */
  private async awaitUrl(child: ChildProcess, options: LaunchOptions): Promise<string> {
    return await new Promise<string>((resolve, reject) => {
      let output = ''
      let settled = false
      const finish = (settle: () => void): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        settle()
      }
      const consume = (chunk: Buffer): void => {
        output = (output + chunk.toString('utf8')).slice(-OUTPUT_TAIL_CHARS)
        const match = URL_PATTERN.exec(output)
        if (match !== null) finish(() => { resolve(match[1] as string) })
      }
      child.stdout?.on('data', consume)
      child.stderr?.on('data', consume)
      child.once('error', (error) => {
        finish(() => { reject(new Error(`profileHub: could not start ${options.name}: ${error.message}`)) })
      })
      child.once('exit', (code) => {
        finish(() => {
          reject(new Error(`profileHub: ${options.name} exited with code ${String(code)} before serving: ${output.trim()}`))
        })
      })
      const timer = setTimeout(() => {
        finish(() => {
          reject(new Error(`profileHub: ${options.name} did not serve within ${String(options.timeoutMs)}ms: ${output.trim()}`))
        })
      }, options.timeoutMs)
    })
  }

  /**
   * The authenticated URL of a profile this hub started, while it is alive.
   * @param name - the profile name.
   * @returns the URL, or undefined when this hub started no live host for it.
   */
  url(name: string): string | undefined {
    const entry = this.running.get(name)
    return entry !== undefined && entry.child.exitCode === null ? entry.url : undefined
  }

  /**
   * Stop one launched profile.
   * @param name - the profile name.
   * @returns whether a live host was stopped.
   */
  stop(name: string): boolean {
    const entry = this.running.get(name)
    if (entry === undefined) return false
    this.running.delete(name)
    if (entry.child.exitCode !== null) return false
    entry.child.kill()
    return true
  }

  /** Stop every host this hub started. */
  dispose(): void {
    for (const name of [...this.running.keys()]) this.stop(name)
  }
}
