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

/** One account the runtime can serve, as the Accounts tab renders it. */
export interface KilnAccountRow {
  /** The account id a route is pinned by; empty for a profile with no config entry. */
  readonly id: string
  /** The Chrome user-data directory name this account owns. */
  readonly slug: string
  /** Whether a configured login currently names this account. */
  readonly configured: boolean
  readonly email: string
  readonly mobile: string
  readonly area_code: string
  /** Credential PRESENCE only. No token, cookie, or password value crosses here. */
  readonly has_token: boolean
  readonly has_cookie: boolean
  readonly has_password: boolean
  /** This account's Chrome user-data directory. */
  readonly profile: string
  readonly profile_exists: boolean
  /** Where this account's captured identity is recorded. */
  readonly record_path: string
  /** The Shumei fingerprint this account presents, or '' when it has none yet. */
  readonly device_id: string
  readonly device_id_len: number
  readonly device_id_valid: boolean
  /**
   * Why a stored `device_id` was refused, or '' when none was.
   *
   * A record whose device failed the shape gate is repaired by PURGING the
   * value, which would otherwise be indistinguishable from "never captured".
   * This carries the refused value's shape so the row can say a capture was
   * attempted and rejected, rather than silently looking empty.
   */
  readonly device_id_rejected: string
  /** 'account' when the account minted it, 'machine' when it inherits the machine value. */
  readonly device_id_source: string
  /** The per-profile header UUID, a different value from `device_id`. */
  readonly x_device_id: string
  /** The `/client/settings` query-string UUID, different again from both. */
  readonly did: string
  /** How the identity was captured, or '' when none was. */
  readonly origin: string
  /** Capture time, or null when this account was never captured. */
  readonly captured_at: number | null
}

/** One operator-visible event from the sidecar's log ring. */
export interface KilnLogEntry {
  readonly seq: number
  readonly at: number
  readonly account: string
  readonly event: string
  readonly level: string
  readonly detail: string
}

/** The outcome of a re-login or a re-profile. A refusal is a value, not a throw. */
export interface KilnAccountOpResult {
  readonly ok: boolean
  readonly account?: string
  /** Why the repair was refused, when it was. */
  readonly message?: string
  /** Whether the browser identity was refreshed as part of the repair. */
  readonly captured?: boolean
  /** Whether re-profiling removed the previous profile before minting. */
  readonly removed?: boolean
}

/** Read one string field, defaulting to '' rather than inventing a value. */
function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/**
 * Read the sidecar's account rows, dropping anything malformed.
 *
 * Every field is read defensively because this crosses a process boundary: a
 * row missing its `device_id` is a real state (a profile that has not minted one
 * yet), so it must arrive as '' rather than as a crash or a fabricated value.
 */
function parseAccountRows(value: unknown): KilnAccountRow[] {
  if (!Array.isArray(value)) return []
  const rows: KilnAccountRow[] = []
  for (const entry of value) {
    if (entry === null || typeof entry !== 'object') continue
    const record = entry as Record<string, unknown>
    const captured = record['captured_at']
    rows.push({
      id: text(record['id']),
      slug: text(record['slug']),
      configured: record['configured'] === true,
      email: text(record['email']),
      mobile: text(record['mobile']),
      area_code: text(record['area_code']),
      has_token: record['has_token'] === true,
      has_cookie: record['has_cookie'] === true,
      has_password: record['has_password'] === true,
      profile: text(record['profile']),
      profile_exists: record['profile_exists'] === true,
      record_path: text(record['record_path']),
      device_id: text(record['device_id']),
      device_id_len: typeof record['device_id_len'] === 'number' ? record['device_id_len'] : 0,
      device_id_valid: record['device_id_valid'] === true,
      device_id_rejected: text(record['device_id_rejected']),
      device_id_source: text(record['device_id_source']),
      x_device_id: text(record['x_device_id']),
      did: text(record['did']),
      origin: text(record['origin']),
      captured_at: typeof captured === 'number' ? captured : null,
    })
  }
  return rows
}

/** Read the sidecar's log entries, keeping only ones a sequence number can order. */
function parseLogEntries(value: unknown): KilnLogEntry[] {
  if (!Array.isArray(value)) return []
  const entries: KilnLogEntry[] = []
  for (const entry of value) {
    if (entry === null || typeof entry !== 'object') continue
    const record = entry as Record<string, unknown>
    const seq = record['seq']
    if (typeof seq !== 'number') continue
    const at = record['at']
    entries.push({
      seq,
      at: typeof at === 'number' ? at : 0,
      account: text(record['account']),
      event: text(record['event']),
      level: text(record['level']) || 'info',
      detail: text(record['detail']),
    })
  }
  return entries
}

/** Unwrap one repair result; the sidecar answers `ok: true` for the envelope itself. */
function parseAccountOp(frame: Record<string, unknown>): KilnAccountOpResult {
  if (frame['ok'] !== true) {
    return { ok: false, message: text(frame['error']) || 'the request was refused' }
  }
  const result = frame['result']
  if (result === null || typeof result !== 'object') {
    return { ok: false, message: 'the sidecar sent no result' }
  }
  const record = result as Record<string, unknown>
  return {
    ok: record['ok'] === true,
    ...typeof record['account'] === 'string' ? { account: record['account'] } : {},
    ...typeof record['error'] === 'string' ? { message: record['error'] } : {},
    ...record['captured'] === true ? { captured: true } : {},
    ...record['removed'] === true ? { removed: true } : {},
  }
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
      // The bridge speaks newline-delimited JSON on stdout, and the reader
      // below decodes it as UTF-8. Left to the host, a Windows child on a
      // legacy ANSI codepage encodes non-ASCII in that codepage instead,
      // and every such character reaches the UI as U+FFFD (a diamond with
      // a question mark). Pinning the child to UTF-8 makes the encode side
      // match the decode side on every host, whatever the console default.
      env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', ...this.options.env },
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
    account: Readonly<{ email?: string; mobile?: string; area_code?: string; password: string; device_id?: string }>,
  ): Promise<{ ok: boolean; account?: string; message?: string }> {
    const frame = await this.request({ cmd: 'add_account', provider, account })
    return {
      ok: frame['ok'] === true,
      ...typeof frame['account'] === 'string' ? { account: frame['account'] } : {},
      ...typeof frame['error'] === 'string' ? { message: frame['error'] } : {},
    }
  }

  /**
   * Read every account the runtime can serve, with the identity each one owns.
   *
   * An operator cannot tell "adding an account worked" from "it silently did
   * nothing" without this. The reply carries what each account is configured
   * with, where its Chrome profile lives, and the `device_id` / `x-device-id` /
   * `did` that profile actually minted — but only the PRESENCE of the
   * credentials: a device id identifies a device, a bearer token authorizes a
   * session, and only one of those belongs on the wire.
   * @returns the account rows, in the sidecar's order.
   */
  async listAccounts(): Promise<readonly KilnAccountRow[]> {
    const frame = await this.request({ cmd: 'accounts' })
    if (frame['ok'] !== true) {
      const detail = typeof frame['error'] === 'string' ? frame['error'] : 'the read was refused'
      throw new LlmError(`Kiln account read failed: ${detail}`, 'TRANSPORT')
    }
    return parseAccountRows(frame['accounts'])
  }

  /**
   * Mint a fresh bearer token for one account from its stored credentials.
   *
   * The repair for a token that went stale. The sidecar replays the login the
   * account was added with and persists the new token into that account's own
   * slot; the password is used and never returned.
   * @param account - the account id to re-login.
   * @param capture - also refresh this account's browser identity. Default true.
   * @returns the repair's outcome; a refusal is a value, not a throw.
   */
  async reloginAccount(account: string, capture = true): Promise<KilnAccountOpResult> {
    const frame = await this.request({ cmd: 'relogin', account, capture })
    return parseAccountOp(frame)
  }

  /**
   * Rebuild one account's Chrome profile and mint a fresh browser identity.
   *
   * `fresh` removes the existing user-data directory first, which is the point:
   * a profile that reuses its old state replays its old `device_id`, and the
   * repair for a flagged identity is a new one rather than the same one again.
   * @param account - the account id to re-profile.
   * @param fresh - remove the existing profile before minting. Default true.
   * @returns the repair's outcome; a refusal is a value, not a throw.
   */
  async reprofileAccount(account: string, fresh = true): Promise<KilnAccountOpResult> {
    const frame = await this.request({ cmd: 'reprofile', account, fresh })
    return parseAccountOp(frame)
  }

  /**
   * Drain the sidecar's operator log from a sequence number.
   *
   * Drained rather than paged: the ring is bounded and the caller keeps its own
   * cursor, so a poll returns only what it has not seen. That is what makes two
   * accounts running at once legible — every entry names the account it belongs
   * to, so interleaved requests stay attributable.
   * @param since - the last sequence number the caller already has.
   * @returns the new entries, oldest first.
   */
  async accountLog(since = 0): Promise<readonly KilnLogEntry[]> {
    const frame = await this.request({ cmd: 'account_log', since })
    if (frame['ok'] !== true) {
      const detail = typeof frame['error'] === 'string' ? frame['error'] : 'the read was refused'
      throw new LlmError(`Kiln log read failed: ${detail}`, 'TRANSPORT')
    }
    return parseLogEntries(frame['entries'])
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
