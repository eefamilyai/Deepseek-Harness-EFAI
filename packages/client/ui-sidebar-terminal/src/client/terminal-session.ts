/**
 * One piped-shell connection per Session, held outside React.
 *
 * A tab body unmounts when its tab is switched away or the panel collapses, but
 * the shell behind it must not: closing the socket kills the process, and a user
 * who flips to a file and back would lose their scrollback and their shell. So
 * the connection lives in this module, keyed by session id, and bodies attach to
 * it as views. `useSyncExternalStore` reads the cached snapshot, so a body that
 * remounts re-attaches to the same live shell with its buffer intact.
 *
 * The cwd is captured when the connection is made and never changed afterwards:
 * reconnecting to a new cwd would tear down a working shell, so a session's
 * terminal stays where it opened.
 * @module @deepseek-ai/dsh-client-ui-sidebar-terminal/client/terminal-session
 */

/** Cap on retained output; the buffer is re-parsed each render, so bound it. */
const MAX_BUFFER = 200_000

/** Connection state of one session's shell. */
export type TerminalStatus = 'connecting' | 'open' | 'closed'

/** What a body renders from. A new object only when something actually changed. */
export interface TerminalSnapshot {
  readonly buffer: string
  readonly status: TerminalStatus
}

/** One session's live shell and everyone watching it. */
export interface TerminalSession {
  /** Read the current snapshot; stable identity between changes. */
  getSnapshot(): TerminalSnapshot
  /** Subscribe to snapshot changes. */
  subscribe(listener: () => void): () => void
  /** Send raw bytes to the shell; false when the socket is not open. */
  send(data: string): boolean
  /** Kill the shell and open a fresh one, dropping the scrollback. */
  reset(): void
  /** Drop every listener; the connection itself is kept alive. */
  release(): void
}

interface Entry {
  readonly cwd: string
  ws: WebSocket | null
  buffer: string
  status: TerminalStatus
  snapshot: TerminalSnapshot
  readonly listeners: Set<() => void>
  /** Bumped per reset so a stale socket's close cannot mark the new one closed. */
  generation: number
}

const sessions = new Map<string, Entry>()

/** Publish a new snapshot when the buffer or status actually changed. */
function emit(entry: Entry): void {
  entry.snapshot = { buffer: entry.buffer, status: entry.status }
  for (const listener of entry.listeners) listener()
}

/** Append output, keeping the tail within the cap. */
function append(entry: Entry, text: string): void {
  const next = entry.buffer + text
  entry.buffer = next.length > MAX_BUFFER ? next.slice(next.length - MAX_BUFFER) : next
  emit(entry)
}

/** Open a fresh socket for one session's shell, replacing any previous one. */
function connect(entry: Entry): void {
  const generation = ++entry.generation
  entry.status = 'connecting'
  emit(entry)
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
  const query = entry.cwd === '' ? '' : `?cwd=${encodeURIComponent(entry.cwd)}`
  const ws = new WebSocket(`${proto}://${window.location.host}/kiln/terminal${query}`)
  entry.ws = ws
  ws.onopen = () => { if (entry.generation === generation) { entry.status = 'open'; emit(entry) } }
  // A stale socket closing must not mark the replacement disconnected.
  ws.onclose = () => { if (entry.generation === generation) { entry.status = 'closed'; emit(entry) } }
  ws.onerror = () => { if (entry.generation === generation) { entry.status = 'closed'; emit(entry) } }
  ws.onmessage = (event) => {
    if (entry.generation !== generation) return
    const text = typeof event.data === 'string' ? event.data : ''
    if (text !== '') append(entry, text)
  }
}

/**
 * Attach to a session's shell, opening it on first use.
 *
 * The first caller's cwd wins and is never revised: a later render with a
 * different cwd re-attaches to the shell already running for that session.
 * @param sessionId - the Session the shell belongs to.
 * @param cwd - the session workspace root, used only when the shell is created.
 * @returns the shared connection.
 */
export function acquireTerminal(sessionId: string, cwd: string): TerminalSession {
  let entry = sessions.get(sessionId)
  if (entry === undefined) {
    entry = {
      cwd,
      ws: null,
      buffer: '',
      status: 'connecting',
      snapshot: { buffer: '', status: 'connecting' },
      listeners: new Set(),
      generation: 0,
    }
    sessions.set(sessionId, entry)
    connect(entry)
  }
  const held = entry
  return {
    getSnapshot: () => held.snapshot,
    subscribe: (listener) => {
      held.listeners.add(listener)
      return () => { held.listeners.delete(listener) }
    },
    send: (data) => {
      if (held.ws !== null && held.ws.readyState === WebSocket.OPEN) { held.ws.send(data); return true }
      return false
    },
    reset: () => {
      held.buffer = ''
      held.ws?.close()
      connect(held)
    },
    release: () => { held.listeners.clear() },
  }
}

/**
 * Close every shell this module opened.
 *
 * Called when the plugin unloads: the sessions map is module state, so without
 * this the sockets would outlive the plugin that owns them.
 * @returns nothing; the map is empty afterwards.
 */
export function disposeAllTerminals(): void {
  for (const entry of sessions.values()) {
    entry.generation += 1
    entry.ws?.close()
    entry.listeners.clear()
  }
  sessions.clear()
}
