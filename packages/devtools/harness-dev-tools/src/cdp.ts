/**
 * A minimal Chrome DevTools Protocol client over the runtime's global `fetch` and
 * `WebSocket`, enough to inspect and drive one Electron window.
 *
 * Each command opens one connection to one target and closes it afterwards, so no
 * connection outlives the tool call that needed it.
 *
 * @module @deepseek-ai/dsh-harness-dev-tools/cdp
 */

/** One debuggable target as `/json/list` reports it. */
export interface CdpTarget {
  /** Target identity. */
  readonly id: string
  /** `page` for a window document, `webview` for an embedded guest, and others. */
  readonly type: string
  /** The document address. */
  readonly url: string
  /** The document title. */
  readonly title: string
  /** The WebSocket address commands for this target are sent to. */
  readonly webSocketDebuggerUrl: string
}

/** Thrown when a protocol command fails or the endpoint cannot be reached. */
export class CdpError extends Error {
  override readonly name = 'CdpError'
}

/**
 * List the targets one debugging port exposes.
 * @param port - the `--remote-debugging-port` the window was started with.
 * @param signal - abandons the request.
 * @returns every target, or a rejection when nothing listens on the port.
 */
export async function listTargets(port: number, signal?: AbortSignal): Promise<CdpTarget[]> {
  let response: Response
  try {
    response = await fetch(`http://127.0.0.1:${String(port)}/json/list`, signal === undefined ? {} : { signal })
  } catch (error) {
    throw new CdpError(`nothing answers on debugging port ${String(port)}`, { cause: error })
  }
  if (!response.ok) throw new CdpError(`debugging port ${String(port)} answered HTTP ${String(response.status)}`)
  const body: unknown = await response.json()
  if (!Array.isArray(body)) throw new CdpError('the debugging endpoint returned no target list')
  return body.filter((entry): entry is CdpTarget =>
    typeof entry === 'object' && entry !== null
    && typeof (entry as Record<string, unknown>).webSocketDebuggerUrl === 'string'
    && typeof (entry as Record<string, unknown>).type === 'string')
}

/**
 * Choose the target a command addresses.
 * @param targets - every target the port exposes.
 * @param selector - empty for the application window, `webview` for the first embedded guest,
 *   or a substring of a target's address or title.
 * @returns the chosen target.
 * @throws {CdpError} when no target matches.
 */
export function selectTarget(targets: readonly CdpTarget[], selector = ''): CdpTarget {
  const wanted = selector.trim()
  const pages = targets.filter(target => target.type === 'page' && !target.url.startsWith('devtools://'))
  const match = wanted === ''
    ? pages.find(target => !target.url.startsWith('about:')) ?? pages[0]
    : wanted === 'webview'
      ? targets.find(target => target.type === 'webview')
      : targets.find(target => target.url.includes(wanted) || target.title.includes(wanted))
  if (match === undefined) {
    const known = targets.map(target => `${target.type} ${target.url}`).join('; ') || 'none'
    throw new CdpError(`no target matches "${wanted || 'the application window'}"; targets: ${known}`)
  }
  return match
}

/** One open protocol connection. */
export class CdpConnection {
  private next = 0
  private readonly pending = new Map<number, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }>()

  private constructor(private readonly socket: WebSocket) {
    socket.addEventListener('message', (event) => { this.receive(event.data) })
    socket.addEventListener('close', () => {
      for (const waiter of this.pending.values()) waiter.reject(new CdpError('the target closed the connection'))
      this.pending.clear()
    })
  }

  /**
   * Connect to one target.
   * @param target - the target to drive.
   * @param timeoutMs - upper bound on the connection handshake.
   * @returns the open connection.
   */
  static open(target: CdpTarget, timeoutMs: number): Promise<CdpConnection> {
    const socket = new WebSocket(target.webSocketDebuggerUrl)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.close()
        reject(new CdpError(`connecting to ${target.url} timed out`))
      }, timeoutMs)
      socket.addEventListener('open', () => { clearTimeout(timer); resolve(new CdpConnection(socket)) }, { once: true })
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new CdpError(`cannot connect to ${target.url}`)) }, { once: true })
    })
  }

  /**
   * Send one command and wait for its result.
   * @param method - the protocol method, for example `Runtime.evaluate`.
   * @param params - the method's parameters.
   * @param timeoutMs - upper bound on the wait.
   * @returns the command's `result` object.
   */
  send(method: string, params: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<Record<string, unknown>> {
    const id = ++this.next
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new CdpError(`${method} timed out after ${String(timeoutMs)} ms`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value) },
        reject: (error) => { clearTimeout(timer); reject(error) },
      })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }

  /** Close the connection. */
  close(): void {
    this.socket.close()
  }

  /**
   * Listen to the target's protocol events (`Runtime.consoleAPICalled` and the like).
   * @param listener - receives each event's method and params.
   * @returns the function that stops listening.
   */
  onEvent(listener: (method: string, params: Record<string, unknown>) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private readonly listeners = new Set<(method: string, params: Record<string, unknown>) => void>()

  private receive(data: unknown): void {
    if (typeof data !== 'string') return
    const message = JSON.parse(data) as {
      id?: number
      method?: string
      params?: Record<string, unknown>
      result?: Record<string, unknown>
      error?: { message?: string }
    }
    if (message.id === undefined) {
      if (message.method !== undefined) for (const listener of this.listeners) listener(message.method, message.params ?? {})
      return
    }
    const waiter = this.pending.get(message.id)
    if (waiter === undefined) return
    this.pending.delete(message.id)
    if (message.error !== undefined) waiter.reject(new CdpError(message.error.message ?? 'protocol error'))
    else waiter.resolve(message.result ?? {})
  }
}

/** Windows virtual key codes for the named keys `Input.dispatchKeyEvent` needs one for. */
const VIRTUAL_KEYS: Readonly<Record<string, number>> = {
  Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46, Space: 32,
  ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Home: 36, End: 35, PageUp: 33, PageDown: 34,
}

/**
 * The `Input.dispatchKeyEvent` pair that presses one key.
 * @param key - a `KeyboardEvent.key` name such as `Enter`, `Escape`, or `a`.
 * @returns the keyDown and keyUp parameters.
 */
export function keyPress(key: string): [Record<string, unknown>, Record<string, unknown>] {
  const code = VIRTUAL_KEYS[key] ?? (key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0)
  const text = key === 'Enter' ? '\r' : key.length === 1 ? key : undefined
  const base = { key, code: key.length === 1 ? `Key${key.toUpperCase()}` : key, windowsVirtualKeyCode: code }
  return [{ type: 'keyDown', ...base, ...text === undefined ? {} : { text } }, { type: 'keyUp', ...base }]
}
