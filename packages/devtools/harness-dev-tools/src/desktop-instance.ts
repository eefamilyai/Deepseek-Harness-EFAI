/**
 * The Desktop test instance: a separate copy of the installed Desktop application,
 * started on its own profile with a debugging port, so a change can be seen in a
 * real window without restarting the window the operator is using.
 *
 * The instance owns three things on disk under its state directory: the
 * application copy, the `instance.json` record of the running process, and the
 * process log. The copy is refreshed when the installed archive changes size or
 * modification time, and the test profile is cloned from the source profile without
 * its sessions or storage.
 *
 * @module @deepseek-ai/dsh-harness-dev-tools/desktop-instance
 */

import { spawn, spawnSync } from 'node:child_process'
import * as nodeFs from 'node:fs'
import { createWriteStream, existsSync, readFileSync } from 'node:fs'
import { copyFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename, join } from 'node:path'
import { appendFileSync } from 'node:fs'
import { APP_COPY_SCRIPT, type AppCopyArgs, type AppCopyResult } from './app-copy.ts'
import { foregroundWindow, restoreForeground } from './focus.ts'
import { CdpConnection, CdpError, keyPress, listTargets, selectTarget, type CdpTarget } from './cdp.ts'

/** Every path and limit the instance works with, resolved from the plugin config. */
export interface DesktopInstanceSpec {
  /** The installed Desktop application directory. */
  readonly appDir: string
  /** The Desktop executable's file name inside `appDir`. */
  readonly exeName: string
  /** The harness home whose `profiles/` holds both profiles. */
  readonly dshHome: string
  /** Where the copy, the record, the log, and screenshots live. */
  readonly stateDir: string
  /** The profile the test profile is cloned from. */
  readonly sourceProfile: string
  /** The test instance's own profile. */
  readonly testProfile: string
  /** The debugging port the instance listens on. */
  readonly port: number
  /** Upper bound on a launch reaching a debuggable window, in milliseconds. */
  readonly launchTimeoutMs: number
  /** Upper bound on one protocol command, in milliseconds. */
  readonly commandTimeoutMs: number
  /** The executable that runs the copy child as Node. */
  readonly nodeExecutable: string
  /** Give the foreground back to the window that had it once the copy's window is up (Windows). */
  readonly keepFocus?: boolean
}

/** What `instance.json` records about the running process and the copy. */
interface InstanceRecord {
  readonly pid?: number
  readonly port?: number
  readonly startedAt?: string
  readonly copiedFrom?: { readonly size: number; readonly mtimeMs: number }
  readonly appName?: string
  /** The installed application's manifest name, which a swapped archive carries again. */
  readonly installedName?: string
}

/** Archive backups an installation may keep beside `app.asar`; the copy leaves them out. */
const COPY_EXCLUDE = ['app.asar.orig', 'app.asar.broken', 'app.asar.bak']

/** Profile entries that are per-profile state, not configuration, and are never cloned. */
const PROFILE_STATE = new Set(['sessions', 'storages', 'node_modules', 'lock', '.kiln_kernel_state'])

/**
 * Environment variables a child of this Host must not inherit into the Desktop executable:
 * the Host runs as the Desktop executable in Node mode, and the window would start as Node too.
 */
const STRIPPED_ENV = ['ELECTRON_RUN_AS_NODE', 'ELECTRON_NO_ATTACH_CONSOLE']

/**
 * The file system without Electron's archive support. Under that support an `.asar`
 * path stats as a directory, so the archive's own size and time come from Electron's
 * `original-fs`; under plain Node there is no archive support and `node:fs` is it.
 * @returns the unpatched `fs` module.
 */
function rawFs(): typeof nodeFs {
  try {
    return createRequire(import.meta.url)('original-fs') as typeof nodeFs
  } catch (_plainNode) {
    // Not running inside Electron, so node:fs has no archive support to bypass.
    return nodeFs
  }
}

/** Resolve after `ms`. */
function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** A start whose process exited before its window came up. */
class EarlyExit extends Error {}

/**
 * One log line for a console or exception event, or undefined for any other event.
 * @param method - the protocol event.
 * @param params - its parameters.
 * @returns the line, prefixed with where it came from.
 */
export function consoleLine(method: string, params: Record<string, unknown>): string | undefined {
  const text = (value: unknown): string => {
    const arg = value as { value?: unknown; description?: string; type?: string }
    if (arg.value !== undefined) return typeof arg.value === 'string' ? arg.value : JSON.stringify(arg.value)
    return arg.description ?? arg.type ?? ''
  }
  if (method === 'Runtime.consoleAPICalled') {
    const args = Array.isArray(params.args) ? params.args : []
    const kind = typeof params.type === 'string' ? params.type : 'log'
    return `[window ${kind}] ${args.map(text).join(' ')}`
  }
  if (method === 'Runtime.exceptionThrown') {
    const details = params.exceptionDetails as { exception?: { description?: string }; text?: string } | undefined
    return `[window exception] ${details?.exception?.description ?? details?.text ?? 'an exception'}`
  }
  if (method === 'Log.entryAdded') {
    const entry = params.entry as { level?: string; text?: string; url?: string } | undefined
    if (entry?.level !== 'error' && entry?.level !== 'warning') return undefined
    return `[window ${entry.level}] ${entry.text ?? ''}${entry.url === undefined ? '' : ` (${entry.url})`}`
  }
  return undefined
}

/** Whether a process id names a live process. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (_gone) {
    // ESRCH: no such process; EPERM would mean alive but foreign, which a recorded child is not.
    return false
  }
}

/** The status `desktop_test_instance` reports. */
export interface InstanceStatus {
  readonly running: boolean
  readonly pid: number | undefined
  readonly port: number
  readonly profile: string
  readonly appCopy: string
  readonly targets: readonly { readonly type: string; readonly url: string; readonly title: string }[]
  readonly logTail: string
}

/** A captured screenshot. */
export interface InstanceScreenshot {
  readonly data: Uint8Array
  readonly path: string
  readonly target: string
}

/** The Desktop test instance this Host prepares, starts, drives, and stops. */
export class DesktopTestInstance {
  /** @param spec - resolved paths and limits. */
  constructor(private readonly spec: DesktopInstanceSpec) {}

  private get copyDir(): string { return join(this.spec.stateDir, 'app') }
  private get recordPath(): string { return join(this.spec.stateDir, 'instance.json') }
  private get logPath(): string { return join(this.spec.stateDir, 'desktop.log') }
  private get archive(): string { return join(this.spec.appDir, 'resources', 'app.asar') }

  private record(): InstanceRecord {
    if (!existsSync(this.recordPath)) return {}
    return JSON.parse(readFileSync(this.recordPath, 'utf8')) as InstanceRecord
  }

  private async writeRecord(record: InstanceRecord): Promise<void> {
    await mkdir(this.spec.stateDir, { recursive: true })
    await writeFile(this.recordPath, `${JSON.stringify(record, null, 2)}\n`)
  }

  /**
   * Copy the application and clone the profile when either is missing or stale.
   * @param fresh - copy and clone even when both are current.
   * @returns what was refreshed, in words.
   */
  async prepare(fresh = false): Promise<string> {
    const notes: string[] = []
    if (!existsSync(join(this.spec.appDir, this.spec.exeName))) {
      throw new Error(`no Desktop application at ${this.spec.appDir}; set desktopDir in the plugin config`)
    }
    const stats = rawFs().statSync(this.archive)
    const source = { size: stats.size, mtimeMs: Math.round(stats.mtimeMs) }
    const record = this.record()
    const stale = record.copiedFrom?.size !== source.size || record.copiedFrom.mtimeMs !== source.mtimeMs
    const copyArchive = join(this.copyDir, 'resources', 'app.asar')
    if (fresh || stale || !existsSync(join(this.copyDir, this.spec.exeName)) || !existsSync(copyArchive)) {
      if (record.pid !== undefined && alive(record.pid)) await this.stop()
      const result = await this.copyApp()
      await this.writeRecord({ ...this.record(), copiedFrom: source, appName: result.name, installedName: result.original })
      notes.push(`copied ${this.spec.appDir} to ${this.copyDir} (application name ${result.original} -> ${result.name})`)
    } else if (record.installedName !== undefined) {
      // An archive swapped into the copy (a patched build under test) carries the installed
      // name again, and then the copy exits at once on the operator's single-instance lock.
      const result = await this.copyApp({ renameOnly: true, installedName: record.installedName })
      if (result.changed === true) notes.push(`renamed the copy's archive to ${result.name} (it carried the installed name)`)
    }
    const profileDir = join(this.spec.dshHome, 'profiles', this.spec.testProfile)
    if (fresh || !existsSync(join(profileDir, 'package.json'))) {
      await this.cloneProfile(profileDir)
      notes.push(`cloned profile ${this.spec.sourceProfile} to ${this.spec.testProfile}`)
    }
    return notes.length === 0 ? 'the copy and the test profile are current' : notes.join('; ')
  }

  private copyApp(extra: Pick<AppCopyArgs, 'renameOnly' | 'installedName'> = {}): Promise<AppCopyResult> {
    const args: AppCopyArgs = { source: this.spec.appDir, target: this.copyDir, exclude: COPY_EXCLUDE, ...extra }
    return new Promise((resolve, reject) => {
      const child = spawn(this.spec.nodeExecutable, ['-e', APP_COPY_SCRIPT], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_APP_COPY_ARGS: JSON.stringify(args) },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
      let out = ''
      let err = ''
      child.stdout.on('data', (chunk: Buffer) => { out += chunk.toString('utf8') })
      child.stderr.on('data', (chunk: Buffer) => { err += chunk.toString('utf8') })
      child.on('error', reject)
      child.on('close', (code) => {
        const last = out.trim().split('\n').at(-1) ?? ''
        if (code !== 0 || !last.startsWith('{')) {
          reject(new Error(`copying the application failed (exit ${String(code)}): ${err.trim().slice(-800)}`))
          return
        }
        resolve(JSON.parse(last) as AppCopyResult)
      })
    })
  }

  private async cloneProfile(target: string): Promise<void> {
    const source = join(this.spec.dshHome, 'profiles', this.spec.sourceProfile)
    if (!existsSync(join(source, 'package.json'))) throw new Error(`no source profile at ${source}`)
    await mkdir(target, { recursive: true })
    for (const entry of await readdir(source, { withFileTypes: true })) {
      if (!entry.isFile() || PROFILE_STATE.has(entry.name)) continue
      await copyFile(join(source, entry.name), join(target, entry.name))
    }
    const manifestPath = join(target, 'package.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>
    manifest.name = `dsh-profile-${this.spec.testProfile}`
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    const metaPath = join(target, 'profile.json')
    if (existsSync(metaPath)) {
      const meta = JSON.parse(await readFile(metaPath, 'utf8')) as Record<string, unknown>
      meta.title = `Test instance (${this.spec.sourceProfile})`
      meta.badge = 'T'
      await writeFile(metaPath, `${JSON.stringify(meta, null, 2)}\n`)
    }
  }

  /**
   * Start the copy, preparing it first, and wait for its window to become debuggable.
   * A running instance is stopped and started again, which also loads rebuilt bundles.
   * @param fresh - recopy the application and reclone the profile.
   * @returns a description of the started instance.
   */
  async launch(fresh = false): Promise<string> {
    try {
      return await this.start(fresh)
    } catch (error) {
      // A copy that exits during start is most often stale in a way size and time do not show
      // (a half-finished copy, an archive swapped in by hand): one fresh copy is worth a retry.
      if (fresh || !(error instanceof EarlyExit)) throw error
      return `${await this.start(true)} (the first start exited at once, so the copy was refreshed)`
    }
  }

  private async start(fresh: boolean): Promise<string> {
    const prepared = await this.prepare(fresh)
    await this.stop()
    try {
      await listTargets(this.spec.port)
      throw new Error(`port ${String(this.spec.port)} is already used by another process; set port in the plugin config`)
    } catch (error) {
      if (!(error instanceof CdpError)) throw error
    }
    await mkdir(this.spec.stateDir, { recursive: true })
    const previous = this.spec.keepFocus === false ? undefined : foregroundWindow()
    const env: NodeJS.ProcessEnv = { ...process.env, DSH_DESKTOP_PROFILE: this.spec.testProfile }
    for (const name of STRIPPED_ENV) Reflect.deleteProperty(env, name)
    const log = createWriteStream(this.logPath, { flags: 'w' })
    await new Promise<void>((resolve) => { log.once('open', () => { resolve() }) })
    const child = spawn(join(this.copyDir, this.spec.exeName), [`--remote-debugging-port=${String(this.spec.port)}`], {
      cwd: this.copyDir,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    })
    child.stdout.pipe(log)
    child.stderr.pipe(log)
    child.unref()
    if (child.pid === undefined) throw new Error('the Desktop executable did not start')
    await this.writeRecord({ ...this.record(), pid: child.pid, port: this.spec.port, startedAt: new Date().toISOString() })
    const deadline = Date.now() + this.spec.launchTimeoutMs
    while (Date.now() < deadline) {
      if (!alive(child.pid)) throw new EarlyExit(`the Desktop executable exited during start; log tail:\n${this.logTail(30)}`)
      try {
        const targets = await listTargets(this.spec.port)
        const page = targets.find(target => target.type === 'page' && !target.url.startsWith('about:') && !target.url.startsWith('devtools://'))
        if (page !== undefined) {
          await this.watchConsole(page)
          const kept = restoreForeground(previous) ? ' in the background (focus returned to your window)' : ''
          return `${prepared}. Started pid ${String(child.pid)} on profile ${this.spec.testProfile}, debugging port ${String(this.spec.port)}${kept}: ${page.url} "${page.title}"`
        }
      } catch (error) {
        if (!(error instanceof CdpError)) throw error
      }
      await delay(500)
    }
    throw new Error(`the window did not become debuggable within ${String(this.spec.launchTimeoutMs)} ms; log tail:\n${this.logTail(30)}`)
  }

  /**
   * Stop the recorded instance and every process it started.
   * @returns whether a running instance was stopped.
   */
  async stop(): Promise<boolean> {
    this.console?.close()
    this.console = undefined
    const { pid } = this.record()
    if (pid === undefined || !alive(pid)) return false
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true })
    } else {
      try {
        process.kill(-pid, 'SIGTERM')
      } catch (_gone) {
        // The group leader exited between the liveness check and the signal.
      }
    }
    for (let waited = 0; waited < 10_000 && alive(pid); waited += 200) await delay(200)
    const { pid: _stopped, startedAt: _since, ...rest } = this.record()
    await this.writeRecord(rest)
    return true
  }

  /**
   * Report whether the instance runs, its targets, and the end of its log.
   * @param lines - how many log lines to include.
   * @returns the status.
   */
  async status(lines = 20): Promise<InstanceStatus> {
    const { pid } = this.record()
    const running = pid !== undefined && alive(pid)
    let targets: CdpTarget[] = []
    if (running) {
      try {
        targets = await listTargets(this.spec.port)
      } catch (error) {
        if (!(error instanceof CdpError)) throw error
      }
    }
    return {
      running,
      pid: running ? pid : undefined,
      port: this.spec.port,
      profile: this.spec.testProfile,
      appCopy: this.copyDir,
      targets: targets.map(target => ({ type: target.type, url: target.url, title: target.title })),
      logTail: this.logTail(lines),
    }
  }

  /** The connection that copies the window's console into the log, while the instance runs. */
  private console: CdpConnection | undefined

  /**
   * Copy the window's console messages and uncaught exceptions into the process log.
   * Enabling the domains replays what the window logged before the connection, so a
   * plugin that failed during boot still shows its error.
   * @param target - the application window.
   */
  private async watchConsole(target: CdpTarget): Promise<void> {
    this.console?.close()
    try {
      const connection = await CdpConnection.open(target, this.spec.commandTimeoutMs)
      this.console = connection
      connection.onEvent((method, params) => {
        const line = consoleLine(method, params)
        if (line !== undefined) appendFileSync(this.logPath, `${line}\n`)
      })
      await connection.send('Runtime.enable', {}, this.spec.commandTimeoutMs)
      await connection.send('Log.enable', {}, this.spec.commandTimeoutMs)
    } catch (_unavailable) {
      // The process log still works without the console copy.
      this.console = undefined
    }
  }

  /**
   * The last lines of the instance's process log, which carries the window's console.
   * @param lines - how many lines to return.
   * @returns the lines, joined.
   */
  logTail(lines: number): string {
    if (!existsSync(this.logPath)) return ''
    return readFileSync(this.logPath, 'utf8').split(/\r?\n/u).filter(line => line.trim() !== '').slice(-lines).join('\n')
  }

  /** Run `work` on one connection to the selected target. */
  private async withTarget<T>(
    selector: string | undefined,
    work: (connection: CdpConnection, target: CdpTarget) => Promise<T>,
  ): Promise<T> {
    const { pid } = this.record()
    if (pid === undefined || !alive(pid)) throw new Error('the Desktop test instance is not running; call it with action "launch" first')
    const target = selectTarget(await listTargets(this.spec.port), selector)
    const connection = await CdpConnection.open(target, this.spec.commandTimeoutMs)
    try {
      return await work(connection, target)
    } finally {
      connection.close()
    }
  }

  /**
   * Evaluate JavaScript in a target and return its value as JSON text.
   * @param expression - the expression; a promise is awaited.
   * @param selector - the target, as {@link selectTarget} reads it.
   * @returns the JSON text of the value, or `undefined` for no value.
   * @throws Error carrying the page's exception text when evaluation throws.
   */
  evaluate(expression: string, selector?: string, timeoutMs = this.spec.commandTimeoutMs): Promise<string> {
    return this.withTarget(selector, async (connection) => {
      const result = await connection.send('Runtime.evaluate', {
        expression, awaitPromise: true, returnByValue: true, userGesture: true,
      }, timeoutMs)
      const details = result.exceptionDetails as { exception?: { description?: string }; text?: string } | undefined
      if (details !== undefined) throw new Error(`the page threw: ${details.exception?.description ?? details.text ?? 'an exception'}`)
      const value = (result.result as { value?: unknown; type?: string } | undefined)
      return value?.value === undefined ? (value?.type ?? 'undefined') : JSON.stringify(value.value, null, 1)
    })
  }

  /**
   * Wait until an expression is truthy in a target.
   * @param expression - the condition.
   * @param timeoutMs - how long to wait.
   * @param selector - the target.
   * @returns the JSON text of the first truthy value.
   */
  async waitFor(expression: string, timeoutMs: number, selector?: string): Promise<string> {
    const deadline = Date.now() + timeoutMs
    let last = ''
    while (Date.now() < deadline) {
      try {
        last = await this.evaluate(`(async () => (${expression}))()`, selector, Math.max(1, Math.min(this.spec.commandTimeoutMs, deadline - Date.now())))
      } catch (error) {
        // A page that reloads or navigates while booting closes the connection or drops the
        // context mid-poll; that is "not yet", and the next poll reaches the new page.
        if (!(error instanceof CdpError)) throw error
        last = `(${error.message})`
      }
      if (last !== 'undefined' && last !== 'false' && last !== 'null' && last !== '0' && last !== '""' && !last.startsWith('(')) return last
      await delay(250)
    }
    throw new Error(`the condition stayed falsy for ${String(timeoutMs)} ms (last value ${last})`)
  }

  /**
   * Capture a target's viewport and save it under the state directory.
   * @param selector - the target; the application window by default.
   * @returns the image bytes and where they were saved.
   */
  screenshot(selector?: string): Promise<InstanceScreenshot> {
    return this.withTarget(selector, async (connection, target) => {
      const result = await connection.send('Page.captureScreenshot', { format: 'png' }, this.spec.commandTimeoutMs)
      const data = Buffer.from(typeof result.data === 'string' ? result.data : '', 'base64')
      const dir = join(this.spec.stateDir, 'screenshots')
      await mkdir(dir, { recursive: true })
      const path = join(dir, `${new Date().toISOString().replace(/[:.]/gu, '-')}.png`)
      await writeFile(path, data)
      return { data: new Uint8Array(data), path, target: `${target.type} ${target.url}` }
    })
  }

  /**
   * Click at a point, as a real pointer would.
   * @param x - CSS pixels from the viewport's left edge.
   * @param y - CSS pixels from the viewport's top edge.
   * @param selector - the target.
   * @returns the element the point hit before the click, for confirmation.
   */
  click(x: number, y: number, selector?: string): Promise<string> {
    return this.withTarget(selector, async (connection) => {
      const probe = await connection.send('Runtime.evaluate', {
        expression: `(() => { const e = document.elementFromPoint(${String(x)}, ${String(y)}); return e ? e.tagName.toLowerCase() + (e.getAttribute('aria-label') ? ' "' + e.getAttribute('aria-label') + '"' : '') + ' ' + (e.textContent || '').trim().slice(0, 60) : 'nothing' })()`,
        returnByValue: true,
      })
      for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
        await connection.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 })
      }
      const hit = (probe.result as { value?: unknown } | undefined)?.value
      return typeof hit === 'string' ? hit : 'nothing'
    })
  }

  /**
   * Insert text into the focused element.
   * @param text - the text.
   * @param selector - the target.
   */
  async type(text: string, selector?: string): Promise<void> {
    await this.withTarget(selector, connection => connection.send('Input.insertText', { text }))
  }

  /**
   * Press one key on the focused element.
   * @param key - a key name such as `Enter`, `Escape`, or `a`.
   * @param selector - the target.
   */
  async key(key: string, selector?: string): Promise<void> {
    await this.withTarget(selector, async (connection) => {
      for (const event of keyPress(key)) await connection.send('Input.dispatchKeyEvent', event)
    })
  }

  /**
   * Reload a target without its cache.
   * @param selector - the target.
   */
  async reload(selector?: string): Promise<void> {
    await this.withTarget(selector, connection => connection.send('Page.reload', { ignoreCache: true }))
  }
}

/**
 * The profile the Desktop application starts on, by its own rule: `DSH_DESKTOP_PROFILE`,
 * then the launcher recorded in `profile-hub.json`, then `desktop`.
 * @param dshHome - the harness home.
 * @param env - the environment to read.
 * @returns the profile name.
 */
export function desktopProfile(dshHome: string, env: NodeJS.ProcessEnv = process.env): string {
  const requested = env.DSH_DESKTOP_PROFILE?.trim()
  if (requested !== undefined && requested !== '') return requested
  const hub = join(dshHome, 'profile-hub.json')
  if (existsSync(hub)) {
    const launcher = (JSON.parse(readFileSync(hub, 'utf8')) as { launcher?: unknown }).launcher
    if (typeof launcher === 'string' && launcher.trim() !== '' && existsSync(join(dshHome, 'profiles', launcher.trim(), 'package.json'))) {
      return launcher.trim()
    }
  }
  return 'desktop'
}

/**
 * The installed Desktop directory and executable when this Host runs inside the Desktop
 * application: the Desktop starts its Host with its own executable in Node mode.
 * @param execPath - the running executable.
 * @returns the directory and file name, or undefined when the Host runs under plain Node.
 */
export function runningDesktop(execPath: string = process.execPath): { dir: string; exe: string } | undefined {
  const exe = basename(execPath)
  if (/^node(\.exe)?$/iu.test(exe)) return undefined
  return { dir: execPath.slice(0, execPath.length - exe.length).replace(/[\\/]$/u, ''), exe }
}
