/**
 * Client for the Kiln provider sidecar (`python/kiln/provider_bridge.py`).
 *
 * The registry it fronts — including `ds_direct`, DeepSeek's free web session
 * with its proof-of-work auth, WAF cookie handling, and account rotation —
 * stays Python. Reimplementing that in TypeScript would be a rewrite of the one
 * part of KilnKernel with the least margin for error, so the harness talks to it
 * instead: one JSON object per line each way, correlated by request id.
 *
 * Credentials never cross this wire. The registry resolves API keys from the
 * child's environment at request time and reports only `has_key` booleans.
 * @module @deepseek-ai/dsh-llm-kiln/bridge
 */

import { spawn } from 'node:child_process'
import type { ChildProcessByStdio } from 'node:child_process'
import type { Readable, Writable } from 'node:stream'
import { createInterface } from 'node:readline'
import { LlmError } from '@deepseek-ai/dsh-llm'

/** One model a Kiln provider advertises. */
export interface KilnModel {
  readonly id: string
  readonly name: string
  readonly context_limit?: number
}

/** One provider route as the Kiln registry describes it. */
export interface KilnProvider {
  readonly id: string
  readonly name: string
  readonly enabled: boolean
  readonly builtin: boolean
  readonly schema: string
  readonly base_url: string
  readonly api_key_env: string
  readonly local: boolean
  /** Whether a key is present in the child's environment — never the value. */
  readonly has_key: boolean
  /**
   * Login ids for a provider that pools several accounts (`ds_direct` only).
   *
   * Ids, never credentials — an explicit label, or the email the account was
   * registered with. The harness turns each into its own route so one agent can
   * be pinned to one login.
   */
  readonly accounts?: readonly string[]
  /** Models the provider currently lists. */
  readonly models: readonly KilnModel[]
  /** Models the provider declares, used when `models` is empty (see the sidecar). */
  readonly advertised: readonly KilnModel[]
  readonly default: string
}

/** One normalized stream event from the registry. */
export interface KilnStreamEvent {
  readonly type: 'content' | 'reasoning' | 'refs' | 'notice' | 'title' | 'meta'
  readonly text?: string
  readonly refs?: readonly unknown[]
  readonly finish?: string
  /**
   * Why a `finish: 'error'` stream failed, carried structurally.
   *
   * The sidecar also writes the reason into `content` so the user can read it,
   * but the adapter must not classify a failure by scraping model prose — a
   * model that merely writes the words "rate limit" in an answer would be
   * mistaken for a rate-limited request.
   */
  readonly error?: string
  readonly usage?: { readonly input?: number; readonly output?: number; readonly reasoning?: number; readonly cache_read?: number }
}

/** One conversation turn as the registry expects it. */
export interface KilnMessage {
  readonly role: string
  readonly content: string
  /**
   * A genuine user turn (source 'user'), which the sidecar must never clip to
   * fit its prompt budget. Injected context and older history are dropped first
   * instead, so the user's actual request survives even when it is the oldest
   * message and the context that follows it is large.
   */
  readonly pin?: boolean
}

/** A streaming request. */
export interface KilnStreamRequest {
  readonly provider: string
  readonly model: string
  readonly messages: readonly KilnMessage[]
  readonly opts: Readonly<Record<string, unknown>>
}

/** One caller-supplied file to push into the provider's own file store. */
export interface KilnUploadFile {
  /** Filename the provider stores, extension included. */
  readonly name: string
  /** Exact bytes to upload. */
  readonly data: Uint8Array
}

/** One file the provider accepted. */
export interface KilnUploadedFile {
  readonly name: string
  /** Provider-assigned id, attachable to a later turn as `ref_file_ids`. */
  readonly id: string
  readonly size: number
}

/**
 * The outcome of one upload batch.
 *
 * A single bad file lands in `errors` rather than failing the whole call — the
 * sidecar's own contract, kept here because the caller is the only party that
 * knows whether losing one of five attachments is fatal. `account` is the login
 * that now owns the returned ids: they are scoped to it and are not portable
 * between logins, so the same value must travel with them into the stream call
 * or the chat cannot see the files.
 */
export interface KilnUploadResult {
  /** Login owning the returned ids; omitted only when the sidecar reported none. */
  readonly account?: string
  readonly files: readonly KilnUploadedFile[]
  readonly errors: readonly string[]
}

/** How to launch the sidecar. */
export interface KilnBridgeOptions {
  /** Interpreter to run. */
  readonly python: string
  /** Absolute path to `provider_bridge.py`. */
  readonly script: string
  /** Working directory for the sidecar. */
  readonly cwd: string
  /** Extra environment applied on top of the harness environment. */
  readonly env: Readonly<Record<string, string>>
}

/** The sidecar's process handle: piped stdin/stdout; stderr captured for diagnostics. */
type KilnBridgeProcess = ChildProcessByStdio<Writable, Readable, Readable>

/**
 * Read the sidecar's per-file upload receipts, dropping anything malformed.
 *
 * A file that uploaded is one the provider will accept by id, so an entry
 * missing its id is not a partial success to pass on — it is a file the caller
 * must not believe it can attach. Dropping it keeps the returned list honest
 * rather than handing a later `ref_file_ids` an empty id.
 */
function parseUploadedFiles(value: unknown): KilnUploadedFile[] {
  if (!Array.isArray(value)) return []
  const files: KilnUploadedFile[] = []
  for (const entry of value) {
    if (entry === null || typeof entry !== 'object') continue
    const record = entry as { name?: unknown; id?: unknown; size?: unknown }
    if (typeof record.id !== 'string' || record.id.length === 0) continue
    files.push({
      name: typeof record.name === 'string' ? record.name : 'file',
      id: record.id,
      size: typeof record.size === 'number' && Number.isFinite(record.size) ? record.size : 0,
    })
  }
  return files
}

/** A pending single-response request. */
interface Waiter {
  resolve(value: Record<string, unknown>): void
  reject(reason: unknown): void
}

/** A live stream's delivery hooks. */
interface StreamSink {
  push(event: KilnStreamEvent): void
  end(): void
}

/**
 * The sidecar process and its request multiplexer.
 *
 * One process serves every route and every concurrent stream: the sidecar runs
 * each stream on its own thread, so a slow provider never blocks a catalog read
 * or another route's request.
 */
export class KilnBridge {
  private proc: KilnBridgeProcess | undefined
  private readonly options: KilnBridgeOptions
  private nextId = 1
  private readonly waiters = new Map<number, Waiter>()
  private readonly sinks = new Map<number, StreamSink>()
  private disposed = false
  private stderrTail = ''

  constructor(options: KilnBridgeOptions) {
    this.options = options
  }

  /** Start the sidecar if it is not already running, and return it. */
  private ensure(): KilnBridgeProcess {
    if (this.disposed) throw new LlmError('the Kiln provider bridge is disposed', 'TRANSPORT')
    const running = this.proc
    if (running !== undefined && running.exitCode === null && !running.killed) return running
    const proc = spawn(this.options.python, ['-u', this.options.script], {
      cwd: this.options.cwd,
      env: { ...process.env, ...this.options.env },
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    proc.stdout.setEncoding('utf8')
    proc.stderr.setEncoding('utf8')
    createInterface({ input: proc.stdout }).on('line', (line: string) => { this.onLine(line) })
    proc.stderr.on('data', (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-2000)
    })
    const end = (): void => {
      const detail = this.stderrTail.trim()
      const suffix = detail.length > 0 ? `: ${detail}` : ''
      this.failAll(new LlmError(`the Kiln provider bridge exited${suffix}`, 'TRANSPORT'))
    }
    proc.on('exit', () => { end() })
    proc.on('error', () => { end() })
    proc.stdin.on('error', () => {})
    this.proc = proc
    return proc
  }

  /** Release every outstanding caller when the sidecar goes away. */
  private failAll(reason: LlmError): void {
    for (const waiter of this.waiters.values()) waiter.reject(reason)
    this.waiters.clear()
    for (const sink of this.sinks.values()) {
      // A stream cannot reject mid-iteration without losing the text already
      // delivered, so it is closed with an error event instead — the same
      // shape the registry itself uses for adapter failures.
      sink.push({ type: 'content', text: `\n[provider bridge error] ${reason.message}` })
      sink.push({ type: 'meta', finish: 'error', error: reason.message })
      sink.end()
    }
    this.sinks.clear()
  }

  private onLine(line: string): void {
    if (line.trim().length === 0) return
    let frame: Record<string, unknown>
    try {
      frame = JSON.parse(line) as Record<string, unknown>
    } catch {
      return
    }
    const id = typeof frame['id'] === 'number' ? frame['id'] : undefined
    if (id === undefined) return
    const sink = this.sinks.get(id)
    if (sink !== undefined) {
      if (frame['done'] === true) {
        this.sinks.delete(id)
        sink.end()
        return
      }
      const event = frame['ev']
      if (typeof event === 'object' && event !== null) sink.push(event as KilnStreamEvent)
      return
    }
    const waiter = this.waiters.get(id)
    if (waiter === undefined) return
    this.waiters.delete(id)
    waiter.resolve(frame)
  }

  private write(payload: Record<string, unknown>): void {
    this.ensure().stdin.write(`${JSON.stringify(payload)}\n`)
  }

  /** Send one request and await its single response frame. */
  private request(payload: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason instanceof Error ? signal.reason : new LlmError('the request was aborted', 'TRANSPORT'))
        return
      }
      // Cancelling the caller's signal abandons this frame: the waiter is
      // removed so `onLine` drops the late reply rather than resolving a
      // promise nobody holds. The request itself is already on the wire, so
      // the abort releases the caller without pretending the work was undone.
      const onAbort = (): void => {
        if (!this.waiters.delete(id)) return
        reject(signal?.reason instanceof Error
          ? signal.reason
          : new LlmError('the request was aborted', 'TRANSPORT'))
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      const settle = (): void => signal?.removeEventListener('abort', onAbort)
      this.waiters.set(id, {
        resolve: (value) => { settle(); resolve(value) },
        reject: (reason) => { settle(); reject(reason) },
      })
      try {
        this.write({ ...payload, id })
      } catch (cause) {
        this.waiters.delete(id)
        settle()
        reject(cause instanceof Error ? cause : new LlmError(String(cause), 'TRANSPORT'))
      }
    })
  }

  /**
   * Read the full provider catalog.
   * @returns every route the registry knows, with its models and key status.
   */
  async catalog(): Promise<readonly KilnProvider[]> {
    const frame = await this.request({ cmd: 'catalog' })
    const providers = frame['providers']
    return Array.isArray(providers) ? providers as KilnProvider[] : []
  }

  /**
   * Ask the registry whether a route is usable, without sending a request to it.
   * @param provider - the Kiln provider id.
   * @returns the validity flag and the registry's own explanation, which names
   *   the missing environment variable but never a key value.
   */
  async validate(provider: string): Promise<{ valid: boolean; message: string }> {
    const frame = await this.request({ cmd: 'validate', provider })
    return {
      valid: frame['valid'] === true,
      message: typeof frame['message'] === 'string' ? frame['message'] : '',
    }
  }

  /**
   * Push runtime credentials into the sidecar for one provider.
   *
   * The free DeepSeek web route (`deepseek`) reads `DEEPSEEK_TOKEN` and
   * `DEEPSEEK_COOKIE` from the child's environment, so configuration surfaces
   * can set them here without writing a `ds_config.json` beside the runtime.
   */
  async configure(provider: string, config: Readonly<Record<string, unknown>>): Promise<{ ok: boolean; message?: string }> {
    const frame = await this.request({ cmd: 'configure', provider, config })
    return {
      ok: frame['ok'] === true,
      message: typeof frame['message'] === 'string' ? frame['message'] : '',
    }
  }

  /**
   * Test a DeepSeek login and, on success, add it as a pooled account.
   *
   * Drives the sidecar's real `login()`, so a success here means the harness can
   * serve this account. The password is sent for the login attempt and is never
   * returned or logged; the reply carries only the account id (for the caller to
   * bind a route to) or a plain error string.
   * @param provider - the Kiln provider id; only `deepseek` pools accounts.
   * @param account - the login to test: email or mobile, plus the password.
   * @returns the added account id, or the failure reason.
   */
  async addAccount(
    provider: string,
    account: Readonly<{ email?: string; mobile?: string; area_code?: string; password: string }>,
  ): Promise<{ ok: boolean; account?: string; message?: string }> {
    const frame = await this.request({ cmd: 'add_account', provider, account })
    return {
      ok: frame['ok'] === true,
      ...typeof frame['account'] === 'string' ? { account: frame['account'] } : {},
      ...typeof frame['error'] === 'string' ? { message: frame['error'] } : {},
    }
  }

  /**
   * Push caller-supplied bytes into the provider's own file store.
   *
   * The wire is newline-delimited JSON, so bytes cross base64-encoded; the
   * sidecar decodes them and hands `[(name, blob)]` to the provider's own
   * uploader. The ids that come back are the only way a file reaches a chat on
   * a route with no native attachment channel — they are attached to a later
   * stream as `opts.ref_file_ids`.
   *
   * Ids are scoped to the login that uploaded them, so the returned `account`
   * must travel with them into that stream call; `ref_file_ids` without the
   * matching `account` names files the serving login cannot see.
   * @param provider - the Kiln provider id; only `deepseek` stores files today.
   * @param files - filenames and exact bytes, in the order they should upload.
   * @param account - the login to upload as; omitted lets the ring choose.
   * @param signal - cancellation for this upload batch.
   * @returns the owning account, the accepted files, and any per-file errors.
   */
  async uploadFiles(
    provider: string,
    files: readonly KilnUploadFile[],
    account?: string,
    signal?: AbortSignal,
  ): Promise<KilnUploadResult> {
    if (files.length === 0) return { files: [], errors: [] }
    const frame = await this.request({
      cmd: 'upload_files',
      provider,
      ...account === undefined ? {} : { account },
      files: files.map(file => ({
        name: file.name,
        data: Buffer.from(file.data).toString('base64'),
      })),
    }, signal)
    if (frame['ok'] !== true) {
      const detail = typeof frame['error'] === 'string' ? frame['error'] : 'the upload was refused'
      throw new LlmError(`Kiln file upload failed: ${detail}`, 'TRANSPORT')
    }
    return {
      ...typeof frame['account'] === 'string' ? { account: frame['account'] } : {},
      files: parseUploadedFiles(frame['files']),
      errors: Array.isArray(frame['errors'])
        ? frame['errors'].filter((entry): entry is string => typeof entry === 'string')
        : [],
    }
  }

  /**
   * Start a stream and iterate its events.
   *
   * Aborting `signal` sends a cancel for this exact stream; the sidecar sets the
   * flag its adapters poll, and the stream still terminates with `done`, so the
   * iteration ends cleanly rather than leaking the request id.
   * @param request - the route, model, conversation, and provider options.
   * @param signal - cancellation for this stream.
   * @returns the event stream, ending when the sidecar reports `done`.
   */
  async *stream(request: KilnStreamRequest, signal?: AbortSignal): AsyncIterable<KilnStreamEvent> {
    const id = this.nextId++
    const state = {
      queue: [] as KilnStreamEvent[],
      finished: false,
      wake: undefined as (() => void) | undefined,
    }
    const sink: StreamSink = {
      push: (event) => {
        state.queue.push(event)
        state.wake?.()
      },
      end: () => {
        state.finished = true
        state.wake?.()
      },
    }
    this.sinks.set(id, sink)
    const onAbort = (): void => {
      try {
        this.write({ id: this.nextId++, cmd: 'cancel', target: id })
      } catch {
        // The sidecar is already gone; failAll has closed the stream.
      }
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      this.write({ id, cmd: 'stream', ...request, opts: request.opts })
      for (;;) {
        while (state.queue.length > 0) {
          const event = state.queue.shift()
          if (event !== undefined) yield event
        }
        if (state.finished) return
        // No await separates the drain above from this executor, so a frame
        // delivered in between cannot slip past the wake-up it schedules.
        await new Promise<void>((resolve) => {
          state.wake = resolve
        })
        state.wake = undefined
      }
    } finally {
      this.sinks.delete(id)
      signal?.removeEventListener('abort', onAbort)
    }
  }

  /** Stop the sidecar and fail everything still outstanding. */
  dispose(): void {
    this.disposed = true
    const proc = this.proc
    this.proc = undefined
    this.failAll(new LlmError('the Kiln provider bridge is disposed', 'TRANSPORT'))
    proc?.kill()
  }
}
