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
  /**
   * The id of the request this frame answers, echoed by the child.
   *
   * Frames are matched to waiters by this id rather than by arrival order.
   * Order alone is not a correlation: one line of raw output on the channel
   * (an `os.system` call, a subprocess inheriting stdio, a print from a
   * non-cell thread) used to be handed to the waiting cell as its result,
   * after which every later cell received the previous cell's frame — with
   * nothing to detect it and nothing to recover from it. Absent on the
   * startup and seam frames, which answer no request.
   */
  readonly id?: number
  /**
   * Set on the synthetic frame that releases a waiter when the child exits.
   *
   * A real cell that printed nothing produces `{ out: '', error: null }`, so
   * without its own marker the death of the kernel is indistinguishable from
   * a quiet success and gets reported to the model as "the cell produced no
   * output".
   */
  readonly dead?: boolean
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
  /**
   * Images the cell returned with `show()`, already base64-encoded by the
   * child. Untrusted until a consumer decodes and validates them: this layer
   * only checks the shape a frame can carry, and a frame is whatever the child
   * wrote on the channel.
   */
  readonly images?: readonly KernelCellImage[]
}

/**
 * One frame image: base64 bytes plus the type the child detected.
 *
 * Declared here rather than imported from `@deepseek-ai/dsh-kernel` because
 * this package deliberately mirrors the kernel seam's wire shapes instead of
 * depending on it at run time — the same reason `SeamRequest` is local.
 */
export interface KernelCellImage {
  readonly data: string
  readonly mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
  readonly bytes: number
  readonly name?: string
  readonly note?: string
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
  /** Frames that arrived before their waiter registered, keyed by request id. */
  private readonly pending = new Map<number, KernelFrame>()
  /** Waiters, keyed by the request id whose frame will satisfy them. */
  private readonly waiters = new Map<number, (frame: KernelFrame) => void>()
  /** Source of request ids; monotonic for the life of this child. */
  private nextId = 1
  /**
   * Ids whose waiter was abandoned (aborted) while the cell was still running.
   * The child will still answer them, and that answer belongs to nobody.
   */
  private readonly retired = new Set<number>()
  /**
   * Frames the channel produced that answer nothing: undecodable lines, and
   * late frames for cells whose waiter was already abandoned. Counted rather
   * than delivered — misdelivering one is the bug this class exists to avoid.
   */
  private discarded = 0
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
      // instead of running out its whole timeout budget. `dead` is what marks
      // this as a death rather than a cell that printed nothing.
      for (const waiter of this.waiters.values()) waiter({ dead: true })
      this.waiters.clear()
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
        if (frame === undefined) this.discarded += 1
        else if (frame.seam !== undefined) this.onSeamFrame(frame.seam)
        else this.deliver(withFrameImages(frame))
      }
      index = this.buffer.indexOf('\n')
    }
  }

  /**
   * Route one decoded frame to the request it names.
   *
   * A frame naming no request (the startup `ready`) or naming one nobody is
   * waiting for (a cell whose caller aborted, a duplicate) is dropped. The old
   * positional queue had no way to tell those from a result, so it handed them
   * to whichever cell happened to be waiting and shifted the channel by one
   * for the rest of the process's life.
   */
  private deliver(frame: KernelFrame): void {
    const { id } = frame
    if (id === undefined) {
      if (frame.ready !== true) this.discarded += 1
      return
    }
    const waiter = this.waiters.get(id)
    if (waiter === undefined) {
      // No waiter yet is legitimate only as a race we do not rely on; a frame
      // for a retired id is not, so keep it out of anyone else's way.
      if (this.retired.has(id)) this.discarded += 1
      else this.pending.set(id, frame)
      return
    }
    this.waiters.delete(id)
    waiter(frame)
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
   * Await the frame answering one request.
   *
   * Nothing is skipped and nothing is taken on trust: the frame either names
   * `id` or it is not this request's answer. That is what makes a `ready` from
   * a racing respawn, a late frame from an abandoned cell, and a raw line from
   * a subprocess all harmless instead of each shifting the channel by one.
   * @param id - the id returned by {@link send} or {@link sendControl}.
   * @param signal - optional abort; rejects with the signal's reason.
   * @returns the frame answering `id`, or a `dead` frame if the child exits first.
   */
  nextFrame(id: number, signal?: AbortSignal): Promise<KernelFrame> {
    const buffered = this.pending.get(id)
    if (buffered !== undefined) {
      this.pending.delete(id)
      return Promise.resolve(buffered)
    }
    if (this.exited) return Promise.resolve({ dead: true })
    return new Promise((resolve, reject) => {
      if (signal?.aborted === true) {
        this.retired.add(id)
        reject(abortReason(signal))
        return
      }
      const waiter = (frame: KernelFrame): void => {
        signal?.removeEventListener('abort', onAbort)
        resolve(frame)
      }
      const onAbort = (): void => {
        this.waiters.delete(id)
        // The cell is still running in the child and will still answer; mark
        // the id so that answer is dropped rather than handed to a later cell.
        this.retired.add(id)
        reject(abortReason(signal))
      }
      this.waiters.set(id, waiter)
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }

  /** How many frames answered no live request. Non-zero means a fault worth reporting. */
  get discardedFrames(): number {
    return this.discarded
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
   * @returns the request id to pass to {@link nextFrame}.
   */
  send(code: string, timeoutMs?: number, cwd?: string, backgroundTimeoutMs?: number, conv?: string): number {
    const hasCwd = cwd !== undefined && cwd.length > 0
    const hasConv = conv !== undefined && conv.length > 0
    const id = this.nextId++
    // Always the envelope form, never bare code: the envelope is what carries
    // the correlation id, and a cell without one cannot have its answer told
    // apart from anything else on the channel.
    const payload = CELL_CTRL_PREFIX + JSON.stringify({
      id,
      code,
      ...timeoutMs === undefined ? {} : { timeoutMs },
      ...backgroundTimeoutMs === undefined ? {} : { backgroundTimeoutMs },
      ...hasCwd ? { cwd } : {},
      ...hasConv ? { conv } : {},
    })
    this.write(Buffer.from(payload, 'utf8').toString('base64'))
    return id
  }

  /**
   * Send a control request on the channel that is never executed as code.
   * @param request - the control payload (`{ cmd: 'list_names' }` and friends).
   * @returns the request id to pass to {@link nextFrame}.
   */
  sendControl(request: object): number {
    const id = this.nextId++
    const payload = CTRL_PREFIX + JSON.stringify({ ...request, id })
    this.write(Buffer.from(payload, 'utf8').toString('base64'))
    return id
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
 * Decode one outbound line into a frame.
 *
 * A line that is not valid base64 JSON did not come from `send_frame`, so it is
 * not an answer to anything and must not be treated as one. It used to be
 * turned into an error frame and handed to the waiting cell, which consumed
 * that cell's waiter and left its real frame to be collected by the NEXT cell —
 * a one-line contamination that shifted every result for the rest of the
 * session. Returning undefined lets the reader drop it and lets the waiter go
 * on waiting for the frame that actually names it.
 *
 * `Buffer.from(line, 'base64')` also ignores characters outside the base64
 * alphabet rather than failing, so plain text often decodes to plausible
 * binary; the JSON parse is the only real check and has to be able to say no.
 * @param line - the raw stdout line, already trimmed.
 * @returns the decoded frame, or undefined when the line is not a frame.
 */
export function decodeFrame(line: string): KernelFrame | undefined {
  try {
    const json = Buffer.from(line, 'base64').toString('utf8')
    const value: unknown = JSON.parse(json)
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
    return value
  } catch {
    return undefined
  }
}

const IMAGE_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const

/**
 * Keep only the well-formed images a frame claims to carry.
 *
 * A frame is whatever the child wrote on the channel, so its `images` is
 * untrusted input like any other: the entries are filtered to ones a consumer
 * can actually use (a supported media type, a non-empty base64 payload, a
 * consistent byte count) rather than rejected wholesale. One malformed entry
 * costs its own image and nothing else — losing a whole cell's output because
 * one picture was described badly would be the worse failure.
 * @param frame - a decoded frame, with whatever `images` the child sent.
 * @returns the same frame with a validated `images` array, or without the field
 *   when it carried none.
 */
export function withFrameImages(frame: KernelFrame): KernelFrame {
  const raw = (frame as { images?: unknown }).images
  if (!Array.isArray(raw)) {
    // Absent and malformed are the same answer to a consumer: no images.
    const { images: _dropped, ...rest } = frame as { images?: unknown }
    return rest as unknown as KernelFrame
  }
  const images: KernelCellImage[] = []
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue
    const { data, mediaType, bytes, name, note } = entry as Record<string, unknown>
    if (typeof data !== 'string' || data.length === 0) continue
    if (typeof mediaType !== 'string') continue
    if (!(IMAGE_MEDIA_TYPES as readonly string[]).includes(mediaType)) continue
    if (typeof bytes !== 'number' || !Number.isSafeInteger(bytes) || bytes < 0) continue
    images.push({
      data,
      mediaType: mediaType as KernelCellImage['mediaType'],
      bytes,
      ...typeof name === 'string' && name.length > 0 ? { name } : {},
      ...typeof note === 'string' && note.length > 0 ? { note } : {},
    })
  }
  if (images.length === 0) {
    const { images: _dropped, ...rest } = frame as { images?: unknown }
    return rest as unknown as KernelFrame
  }
  return { ...frame, images }
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
