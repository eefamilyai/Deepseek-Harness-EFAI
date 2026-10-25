/**
 * Kiln-backed persistent Python kernel for the `ctx.kernel` seam.
 *
 * The kernel itself is the Kiln runtime vendored under `python/kiln/runtime`,
 * spawned as a child process and driven over its base64 frame protocol. Nothing
 * about the engine is reimplemented here: the namespace semantics, the
 * preloaded helpers (`remember`/`recall`, `sh`, `read_file`, `browser_use`, …),
 * and the top-level-expression echo all belong to that runtime.
 *
 * ```yaml
 * - id: kernel-python
 *   name: '@deepseek-ai/dsh-kernel-python'
 *   config:
 *     python: python3        # omitted = probe the platform defaults
 *     cwd: /path/to/project  # omitted = the harness working directory
 *     runtimeDir: /path/to/runtime  # omitted = the packed copy, else the repository's
 * ```
 *
 * @module @deepseek-ai/dsh-kernel-python
 */

import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import type { Context, Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-kernel'
import { KernelError } from '@deepseek-ai/dsh-kernel'
import { KilnKernelProvider } from './provider.ts'

export { KernelChild, decodeFrame, parseControlResult, CTRL_PREFIX, SNAPSHOT_MARKER } from './child.ts'
export type { KernelChildOptions, KernelFrame } from './child.ts'
export { isSecretEnvVar, scrubChildEnv } from './env.ts'
export { KilnKernelProvider, joinCellOutput } from './provider.ts'
export type { KilnKernelProviderOptions } from './provider.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'kernel-python'

/** Services required before the backend can register. */
export const inject = ['kernel']

/** The id this backend registers under on `ctx.kernel`. */
export const PROVIDER_ID = 'kiln-python'

/**
 * Interpreters probed when config names none, in preference order. `py` leads
 * on Windows because the launcher is what a stock python.org install puts on
 * PATH, while the bare `python` there is often the Microsoft Store shim that
 * exits with an install prompt rather than running anything.
 */
const PYTHON_CANDIDATES: Readonly<Record<'win32' | 'other', readonly string[]>> = {
  win32: ['py', 'python', 'python3'],
  other: ['python3', 'python'],
}

/** Plugin config: interpreter, workspace, and where mutable kernel state lands. */
export interface Config {
  /** Interpreter to run. Omitted = `$DSH_KERNEL_PYTHON`, then the platform probe. */
  python?: string
  /** Kernel working directory. Omitted = the harness working directory. */
  cwd?: string
  /** Directory for `subkernels.json` and other durable kernel state. Omitted = `<cwd>/.kiln_kernel_state`. */
  stateDir?: string
  /** Vendored Kiln runtime directory. Omitted = the copy shipped with this repo. */
  runtimeDir?: string
  /**
   * Kernels kept alive at once, one per conversation. The least recently idle is
   * reaped first, and a conversation running a cell never is. Defaults to 4.
   */
  maxKernels?: number
  /** Reap a conversation's kernel after this many idle minutes. Defaults to 30; 0 keeps every kernel. */
  idleKernelMinutes?: number
  /**
   * Whether the agent's browser may open a real Chromium window. Default: no
   * window, which is what an agent working on your behalf should do unless you
   * asked to watch. Editable from Settings; takes effect on restart.
   */
  browserWindow: Volatile<boolean>
}

export const Config = z.object({
  python: z.string(),
  cwd: z.string(),
  stateDir: z.string(),
  runtimeDir: z.string(),
  maxKernels: z.natural().min(1).default(4)
    .description('Python kernels kept alive at once, one per conversation, so one chat\'s slow cell'
      + ' cannot block another. The least recently used is reaped first; a running cell never is.'),
  idleKernelMinutes: z.natural().default(30)
    .description('Reap a conversation\'s kernel after this many idle minutes. Its remember() entries'
      + ' survive; its namespace does not. 0 keeps every kernel until the harness exits.'),
  browserWindow: z.boolean().default(false)
    .description('Let the agent open a real Chromium window on your desktop. Off, it browses'
      + ' windowless and nothing appears while it works; screenshots still work.'
      + ' Restart the harness to apply.')
    .volatile(),
})

/** Probe timeout for one interpreter candidate. */
const PROBE_TIMEOUT_MS = 10_000


/**
 * The archive-external path for a location inside an asar archive.
 *
 * Electron reads files inside `app.asar` through its patched `fs`, but a spawned
 * interpreter is an ordinary process: the same path is `ENOENT` for it. That
 * asymmetry is why an installed Desktop reported every cell as a crash while the
 * provider's own `existsSync` guard passed — the runtime resolved to a path
 * Electron could list and Python could not open. An unpacking build places the
 * same files under the archive's `.unpacked` sibling, so that is the copy to
 * reach for; nothing here proves the sibling exists.
 * @param path - a candidate path, possibly inside an asar archive.
 * @returns the `.unpacked` sibling when `path` names an archive, else `path`.
 */
export function outsideAsar(path: string): string {
  const segments = path.split(/[\\/]/)
  const index = segments.findIndex(segment => segment.toLowerCase().endsWith('.asar'))
  if (index === -1) return path
  return [...segments.slice(0, index), `${segments[index]}.unpacked`, ...segments.slice(index + 1)].join(sep)
}

/**
 * The Kiln runtime: the copy packed into this package (`kiln/` beside `lib/`,
 * which is what an installed Desktop has), else the repository's
 * `python/kiln/runtime`, four levels above this module's directory in a source
 * checkout.
 *
 * A packaged runtime inside an asar archive is only reached when its `.unpacked`
 * sibling is absent, because a spawned interpreter cannot open the archived
 * copy; {@link apply} refuses that launch rather than starting a child that dies.
 * @returns the runtime directory's absolute path.
 */
export function defaultRuntimeDir(): string {
  const packed = resolve(import.meta.dirname, '..', 'kiln')
  const unpacked = outsideAsar(packed)
  if (unpacked !== packed) {
    if (existsSync(join(unpacked, 'kernel_child.py'))) return unpacked
  } else if (existsSync(join(packed, 'kernel_child.py'))) return packed
  return resolve(import.meta.dirname, '..', '..', '..', '..', 'python', 'kiln', 'runtime')
}

/**
 * The interpreter inside the uv-managed bundle, once provisioned.
 *
 * `start.cmd`/`start.sh` run `uv sync` against `python/kiln/runtime/pyproject.toml`,
 * which downloads a standalone CPython and the runtime's dependencies into this
 * `.venv`. Preferring it means even a direct `dsh web` — no launcher, so
 * `$DSH_KERNEL_PYTHON` is unset — finds the bundled Python (with `curl_cffi`,
 * `playwright`, …) instead of a bare system interpreter that lacks them.
 * @param runtimeDir - the runtime whose bundle to inspect; defaults to {@link defaultRuntimeDir}.
 * @returns the bundled interpreter's path, or undefined when the bundle has not been provisioned.
 */
export function bundledVenvPython(runtimeDir: string = defaultRuntimeDir()): string | undefined {
  const venv = process.platform === 'win32'
    ? join(runtimeDir, '.venv', 'Scripts', 'python.exe')
    : join(runtimeDir, '.venv', 'bin', 'python')
  return existsSync(venv) ? venv : undefined
}

/**
 * Find an interpreter that actually runs. A name on PATH is not enough — the
 * Windows Store shim is on PATH and answers `--version` with an advertisement —
 * so each candidate is executed and only a clean exit counts.
 * @param configured - an explicitly configured interpreter, tried alone.
 * @param runtimeDir - the runtime whose bundled venv is preferred; defaults to {@link defaultRuntimeDir}.
 * @returns the first working interpreter, or undefined when none is.
 */
export async function resolvePython(
  configured?: string,
  runtimeDir: string = defaultRuntimeDir(),
): Promise<string | undefined> {
  const { execFileSync } = await import('node:child_process')
  const explicit = configured ?? process.env.DSH_KERNEL_PYTHON
  const candidates = explicit !== undefined && explicit.length > 0
    ? [explicit]
    : [bundledVenvPython(runtimeDir), ...PYTHON_CANDIDATES[process.platform === 'win32' ? 'win32' : 'other']]
      .filter((candidate): candidate is string => candidate !== undefined)
  for (const candidate of candidates) {
    try {
      const stdout = execFileSync(candidate, ['-c', 'print("ok")'], {
        encoding: 'utf8',
        timeout: PROBE_TIMEOUT_MS,
        windowsHide: true,
      })
      if (stdout.includes('ok')) return candidate
    } catch {
      // Next candidate. A probe failure is the normal case for every
      // interpreter name a given machine does not have.
    }
  }
  return undefined
}

/**
 * Resolve the launch facts, start no process, and register the backend.
 *
 * The kernel process itself is lazy: it starts on the first cell, so a
 * composition that mounts this row but never calls the tool pays nothing. What
 * is *not* lazy is interpreter resolution — a missing Python must be an
 * unavailable provider at selection time, not a surprise in the middle of the
 * model's first cell.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const runtimeDir = config.runtimeDir ?? defaultRuntimeDir()
  const script = join(runtimeDir, 'kernel_child.py')
  // Before the existence check, not after: inside Electron `existsSync` answers
  // for the archive's own index, so a runtime the child cannot open passes it.
  if (outsideAsar(script) !== script) {
    throw new KernelError(
      `the Kiln kernel runtime at "${script}" is inside an asar archive, which the kernel's Python`
      + ' process cannot open: set `runtimeDir` on the kernel-python row to a runtime directory on disk',
      'KERNEL_START_FAILED',
    )
  }
  if (!existsSync(script)) {
    throw new KernelError(
      `the Kiln kernel runtime is missing: no kernel_child.py under "${runtimeDir}"`,
      'KERNEL_START_FAILED',
    )
  }
  const python = await resolvePython(config.python, runtimeDir)
  if (python === undefined) {
    throw new KernelError(
      'no working Python interpreter was found; set `python` on the kernel-python row or $DSH_KERNEL_PYTHON',
      'KERNEL_START_FAILED',
    )
  }
  const cwd = config.cwd ?? process.cwd()
  const stateDir = config.stateDir ?? join(cwd, '.kiln_kernel_state')
  // Whoever NAMES the directory creates it. The Python side writes its state
  // files through helpers that swallow their own errors, so a directory that
  // does not exist is not an error there — it is a silent no-op, and the state
  // simply never persists.
  mkdirSync(stateDir, { recursive: true })
  const provider = new KilnKernelProvider({
    id: PROVIDER_ID,
    python,
    script,
    cwd,
    // One kernel per conversation is the isolation unit: a wedged cell in one
    // chat must not queue behind — or be visible to — any other.
    ...config.maxKernels === undefined ? {} : { maxKernels: config.maxKernels },
    idleKernelMs: (config.idleKernelMinutes ?? 30) * 60_000,
    env: {
      // Keeps `subkernels.json` and the ds_direct session pin out of the
      // vendored (read-only, reinstallable) runtime tree.
      KILN_STATE_DIR: stateDir,
      // Root for the durable `remember()`/`recall()` tier. One SHARED root is
      // safe: kiln_memory keys each conversation by KILN_CONV_ID, which now
      // arrives per cell from the owning agent. Keeping it outside the readonly
      // runtime tree makes it survive a reinstall/upgrade and lets every session
      // in this process share one durable store without leaking entries across
      // conversations.
      KILN_MEMORY_DIR: process.env.KILN_MEMORY_DIR ?? join(stateDir, 'memory'),
      // Where browser_tools writes its live state.json + screenshots. A global
      // default (not the per-cwd state dir) matches the browser being one
      // process-wide singleton; an explicit KILN_BROWSER_DIR still wins.
      KILN_BROWSER_DIR: process.env.KILN_BROWSER_DIR ?? join(homedir(), '.dsh', 'browser'),
      // Whether the browser may put a window on the desktop. The runtime reads
      // this once per process, so it is resolved here rather than per action,
      // and an explicit environment value still wins for a one-off run.
      KILN_BROWSER_HEADED: process.env.KILN_BROWSER_HEADED
        ?? (config.browserWindow.get() ? '1' : '0'),
      // The runtime's own modules resolve relative to the script, but a cell
      // that imports one of them needs the directory on the path too.
      PYTHONPATH: [dirname(script), process.env.PYTHONPATH].filter(part => part !== undefined && part.length > 0).join(process.platform === 'win32' ? ';' : ':'),
    },
  })
  ctx.kernel.registerProvider(provider)
  // The seam's own registration disposer only unregisters; the kernel PROCESS
  // outlives that unless something stops it, so its shutdown is a separate
  // fiber-scoped effect.
  ctx.effect(function* () {
    yield async () => { await provider.dispose() }
  }, 'kernel-python process')
}
