/**
 * The kernel child process and its wire protocol.
 *
 * `kernel_child.py` speaks newline-delimited base64 frames in both directions:
 * inbound a base64-encoded cell source (or a control request behind
 * {@link CTRL_PREFIX}), outbound a base64-encoded JSON object. The first
 * outbound frame is `{"ready": true, ...}`; every later one is
 * `{"out": string, "error": string | null}`.
 *
 * Base64 is what makes the framing safe: a cell's source and its output both
 * contain newlines, and encoding removes any need to escape or length-prefix.
 * @module @deepseek-ai/dsh-kernel-python/child
 */

import { spawn } from 'node:child_process'
import type { ChildProcessByStdio } from 'node:child_process'
import { Writable } from 'node:stream'
import type { Readable } from 'node:stream'
import { KernelError } from '@deepseek-ai/dsh-kernel'
import { scrubChildEnv } from './env.ts'
import type { SeamRequest, SeamResponse } from './seam.ts'

/**
 * Why a wait for a kernel frame was abandoned.
 *
 * The distinction is load-bearing: a cell that overran its budget and a cell the
 * user stopped restart the kernel for different reasons and are reported to the
 * model with different words. Carrying it on a real Error (rather than as a bare
 * string abort reason) keeps rejection values well-typed all the way out.
 */
export class KernelAbortError extends Error {
  /** Which deadline fired. */
  readonly kind: 'timeout' | 'cancelled'

  constructor(kind: 'timeout' | 'cancelled') {
    super(kind === 'timeout' ? 'the cell exceeded its time budget' : 'the cell was cancelled')
    this.kind = kind
  }
}

/**
 * The reason an abort signal carries, as a {@link KernelAbortError}.
 * @param signal - the aborted signal, if any.
 * @returns the signal's own reason when it is already one of ours, else a
 *   cancellation — an abort from an unknown source is a caller stopping us.
 */
export function abortReason(signal: AbortSignal | undefined): KernelAbortError {
  const reason: unknown = signal?.reason
  return reason instanceof KernelAbortError ? reason : new KernelAbortError('cancelled')
}

/** Control-channel marker; a frame starting with it is never run as code. */
export const CTRL_PREFIX = '\u0000KILN_CTRL\u0000'
/** Prefix for a cell frame carrying optional metadata (like timeoutMs). */
export const CELL_CTRL_PREFIX = '\u0000KILN_CELL\u0000'

/** Marker the child wraps around a control response's JSON payload. */
export const SNAPSHOT_MARKER = '__KILN_KERNEL_STATE__'

/** One decoded outbound frame. */
export interface KernelFrame {
  /** Present only on the startup frame. */
  readonly ready?: boolean
  /** The engine the child selected; startup frame only. */
  readonly engine?: string
  /** Captured stdout + stderr + echoed expression values. */
  readonly out?: string
  /** A formatted traceback, or null when the cell succeeded. */
  readonly error?: string | null
  /**
   * Set when the cell overran its primary budget and was moved to the
   * background rather than finishing. The namespace is intact and the process is
   * healthy, so the provider treats this as a normal (non-restart) result whose
   * `out` is the "still running in the background" notice.
   */
  readonly backgrounded?: boolean
  /** A Python→TS seam request; never a cell result. Routed to the seam handler. */
  readonly seam?: SeamRequest
}

/** How to launch the child. */
export interface KernelChildOptions {
  /** Interpreter to run (`python3`, `py`, an absolute path). */
  readonly python: string
  /** Absolute path to the vendored `kernel_child.py`. */
  readonly script: string
  /** Working directory for the kernel — the agent's workspace. */
  readonly cwd: string
  /** Harness-owned variables applied after secret scrubbing. */
  readonly env: Readonly<Record<string, string>>
}

/**
 * A live `kernel_child.py` process with its frame reader.
 *
 * Instances are single-use: once {@link kill} runs the process is gone, and the
 * owning provider creates a replacement. That is what makes "the namespace was
 * lost" a fact the caller can state rather than infer.
 */
export class KernelChild {
  private readonly proc: ChildProcessByStdio<Writable, Readable, null>
  /** The dedicated fd-3 pipe carrying TS→Python seam responses (null if fd 3 unavailable). */
  private readonly seamOut: Writable | null
  /** Set by the provider to dispatch seam requests against the current agent ctx. */
  seamHandler: ((request: SeamRequest) => void) | undefined = undefined
  /** Frames decoded but not yet claimed by a waiter. */
  private readonly pending: KernelFrame[] = []
  /** Waiters queued ahead of the frames that will satisfy them. */
  private readonly waiters: ((frame: KernelFrame) => void)[] = []
  private buffer = ''
  private exited = false

  constructor(options: KernelChildOptions) {
    try {
      this.proc = spawn(options.python, ['-u', options.script], {
        cwd: options.cwd,
        env: scrubChildEnv(process.env, options.env),
        windowsHide: true,
        // stderr is discarded: the child already folds captured stderr into the
        // cell's `out`, so anything left on the real handle is interpreter
        // noise that would otherwise interleave with nothing at all.
        // The 4th stdio entry (the seam-response pipe) makes the untyped spawn
        // overload return plain ChildProcess; the first three entries still
        // match the ChildProcessByStdio contract exactly, so the assertion only
        // restores that known shape.
        stdio: ['pipe', 'pipe', 'ignore', 'pipe'],
      }) as unknown as ChildProcessByStdio<Writable, Readable, null>
    } catch (cause) {
      throw new KernelError(
        `failed to start the Python kernel with "${options.python}": ${String(cause)}`,
        'KERNEL_START_FAILED',
      )
    }
    this.proc.stdout.setEncoding('ascii')
    this.proc.stdout.on('data', (chunk: string) => { this.onData(chunk) })
    const fd3 = this.proc.stdio[3]
    this.seamOut = fd3 !== null && fd3 !== undefined && 'write' in fd3 ? fd3 : null
    this.seamOut?.setDefaultEncoding('ascii')
    this.seamOut?.on('error', () => {})
    const end = (): void => {
      this.exited = true
      // Release every waiter so a caller blocked on a dead child fails fast
      // instead of running out its whole timeout budget.
      while (this.waiters.length > 0) {
        const waiter = this.waiters.shift()
        waiter?.({ out: '', error: null })
      }
    }
    this.proc.on('exit', end)
    this.proc.on('error', end)
    this.proc.stdin.on('error', () => {})
  }

  /** Whether the process has exited. */
  get dead(): boolean {
    return this.exited
  }

  private onData(chunk: string): void {
    this.buffer += chunk
    let index = this.buffer.indexOf('\n')
    while (index !== -1) {
      const line = this.buffer.slice(0, index).trim()
      this.buffer = this.buffer.slice(index + 1)
      if (line.length > 0) {
        const frame = decodeFrame(line)
        if (frame.seam !== undefined) this.onSeamFrame(frame.seam)
        else this.deliver(frame)
      }
      index = this.buffer.indexOf('\n')
    }
  }

  private deliver(frame: KernelFrame): void {
    const waiter = this.waiters.shift()
    if (waiter !== undefined) waiter(frame)
    else this.pending.push(frame)
  }

  /** Dispatch a decoded seam frame to the provider's handler. */
  private onSeamFrame(request: SeamRequest): void {
    this.seamHandler?.(request)
  }

  /**
   * Write one seam response onto the fd-3 pipe as a base64 JSON line, matching
   * the framing Python's seam reader expects.
   */
  sendSeamResponse(response: SeamResponse): void {
    if (this.seamOut === null) return
    const line = Buffer.from(JSON.stringify(response), 'utf8').toString('base64')
    this.seamOut.write(`${line}\n`)
  }

  /**
   * Await the next frame, ignoring the startup `ready` frame.
   *
   * `ready` is skipped here rather than consumed at startup because a respawn
   * races: the replacement child emits its own `ready` while the caller is
   * already waiting for a cell result, and mistaking one for the other would
   * shift every subsequent response by one.
   * @param signal - optional abort; rejects with the signal's reason.
   * @returns the next result frame.
   */
  async nextFrame(signal?: AbortSignal): Promise<KernelFrame> {
    for (;;) {
      const frame = await this.takeFrame(signal)
      if (frame.ready === true) continue
      return frame
    }
  }

  private takeFrame(signal?: AbortSignal): Promise<KernelFrame> {
    const buffered = this.pending.shift()
    if (buffered !== undefined) return Promise.resolve(buffered)
    if (this.exited) return Promise.resolve({ out: '', error: null })
    return new Promise((resolve, reject) => {
      if (signal?.aborted === true) {
        reject(abortReason(signal))
        return
      }
      const waiter = (frame: KernelFrame): void => {
        signal?.removeEventListener('abort', onAbort)
        resolve(frame)
      }
      const onAbort = (): void => {
        const at = this.waiters.indexOf(waiter)
        if (at !== -1) this.waiters.splice(at, 1)
        reject(abortReason(signal))
      }
      this.waiters.push(waiter)
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }

  /**
   * Send a cell for execution.
   *
   * A bare-code frame is the common case; the envelope form is used only when a
   * cell carries metadata — a per-cell timeout, or the owning chat's `cwd`. The
   * cwd travels per cell because one process serves every chat, so the frame,
   * not the spawn, is where "run this in that chat's directory" is expressed.
   * @param code - the Python source.
   * @param timeoutMs - optional primary budget (background on expiry).
   * @param cwd - optional working directory for this cell (the chat's workspace).
   * @param backgroundTimeoutMs - optional secondary budget (force-stop a backgrounded cell).
   * @param conv - the owning conversation id; scopes durable remember()/recall() storage.
   */
  send(code: string, timeoutMs?: number, cwd?: string, backgroundTimeoutMs?: number, conv?: string): void {
    const hasCwd = cwd !== undefined && cwd.length > 0
    const hasConv = conv !== undefined && conv.length > 0
    const bare = timeoutMs === undefined && backgroundTimeoutMs === undefined && !hasCwd && !hasConv
    const payload = bare
      ? code
      : CELL_CTRL_PREFIX + JSON.stringify({
        code,
        ...timeoutMs === undefined ? {} : { timeoutMs },
        ...backgroundTimeoutMs === undefined ? {} : { backgroundTimeoutMs },
        ...hasCwd ? { cwd } : {},
        ...hasConv ? { conv } : {},
      })
    this.write(Buffer.from(payload, 'utf8').toString('base64'))
  }

  /**
   * Send a control request on the channel that is never executed as code.
   * @param request - the control payload (`{ cmd: 'list_names' }` and friends).
   */
  sendControl(request: unknown): void {
    const payload = CTRL_PREFIX + JSON.stringify(request)
    this.write(Buffer.from(payload, 'utf8').toString('base64'))
  }

  private write(line: string): void {
    if (this.exited) return
    this.proc.stdin.write(`${line}\n`)
  }

  /**
   * Shut the child down: a blank line first, so it reaps its own non-permanent
   * sub-kernels and exits cleanly, then SIGKILL if it does not finish in time.
   * A cell stuck in an uninterruptible call is exactly why the second step
   * exists.
   * @param graceMs - how long to wait for the clean exit.
   */
  async kill(graceMs = 1_500): Promise<void> {
    if (this.exited) return
    const exited = new Promise<void>((resolve) => {
      this.proc.once('exit', () => { resolve() })
    })
    this.write('')
    const timer = new Promise<'timeout'>((resolve) => {
      setTimeout(() => { resolve('timeout') }, graceMs).unref()
    })
    const outcome = await Promise.race([exited.then(() => 'exited' as const), timer])
    if (outcome === 'timeout') {
      this.proc.kill('SIGKILL')
      await exited
    }
    this.exited = true
  }
}

/**
 * Decode one outbound line into a frame. A line the child did not produce as
 * valid base64 JSON is a protocol break, surfaced as an error frame rather than
 * thrown out of the stdout handler where nothing could catch it.
 * @param line - the raw stdout line, already trimmed.
 * @returns the decoded frame, or an error frame describing the break.
 */
export function decodeFrame(line: string): KernelFrame {
  try {
    const json = Buffer.from(line, 'base64').toString('utf8')
    const value: unknown = JSON.parse(json)
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error('frame is not an object')
    }
    return value
  } catch (cause) {
    return { out: '', error: `Bad frame from the Python kernel: ${String(cause)}` }
  }
}

/**
 * Extract a control response's JSON payload from the frame the child wraps it
 * in.
 * @param frame - the frame answering a control request.
 * @returns the parsed payload, or undefined when the frame carried none.
 */
export function parseControlResult(frame: KernelFrame): unknown {
  const out = frame.out ?? ''
  const at = out.lastIndexOf(SNAPSHOT_MARKER)
  if (at === -1) return undefined
  const [line] = out.slice(at + SNAPSHOT_MARKER.length).split('\n')
  try {
    return JSON.parse(line ?? '')
  } catch {
    return undefined
  }
}
