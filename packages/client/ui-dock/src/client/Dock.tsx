/**
 * The dock shell: a fixed right-edge handle that opens a slide-in drawer with a
 * live Terminal pane. The pane stays mounted while the drawer is open (only
 * visibility toggles) so the live terminal session survives a collapse. Open
 * state and drawer width persist in localStorage.
 * @module @deepseek-ai/dsh-client-ui-dock/client/Dock
 */

import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import type { MouseEvent as ReactMouseEvent } from 'react'
import { DOCK_OPEN_EVENT, DOCK_TOGGLE_EVENT } from './dock-events.ts'
import { Terminal } from './Terminal.tsx'
import type { TerminalInject } from './Terminal.tsx'
import css from './dock.module.css'

/** The active chat's identity + workspace, as a useSyncExternalStore source. */
export interface ActiveChat {
  /** Stable {id, cwd} of the current chat (same reference until either changes). */
  get(): { id: string; cwd: string }
  /** Subscribe to chat switches; returns an unsubscriber. */
  subscribe(fn: () => void): () => void
}

const OPEN_KEY = 'dsh.dock.open'
const WIDTH_KEY = 'dsh.dock.width'

/** Drawer width bounds. The max is computed per-drag against the viewport. */
const MIN_WIDTH = 380
const DEFAULT_WIDTH = 760

/** Read the persisted open flag (closed by default on a fresh profile). */
function initialOpen(): boolean {
  try { return window.localStorage.getItem(OPEN_KEY) === '1' } catch { return false }
}

/** Read the persisted drawer width, falling back to a comfortable default. */
function initialWidth(): number {
  try {
    const raw = Number(window.localStorage.getItem(WIDTH_KEY))
    if (Number.isFinite(raw) && raw >= MIN_WIDTH) return raw
  } catch { /* private mode */ }
  return DEFAULT_WIDTH
}

/** The right-side dock. */
export function Dock({ activeChat }: { activeChat: ActiveChat }): JSX.Element {
  const chat = useSyncExternalStore(activeChat.subscribe, activeChat.get)
  const [open, setOpen] = useState(initialOpen)
  const [mounted, setMounted] = useState(initialOpen)
  const [width, setWidth] = useState(initialWidth)
  const [resizing, setResizing] = useState(false)
  // A code block the user asked to run in this chat's terminal. Held here
  // (not in Terminal) so the dock can open and mount the pane first.
  const [pendingInject, setPendingInject] = useState<TerminalInject | null>(null)
  // Re-run signal: bump per injection so running the SAME block twice works.
  const [injectNonce, setInjectNonce] = useState(0)
  // One terminal per chat we have opened, id -> its captured cwd. Each stays
  // mounted (socket + shell alive) so switching chats preserves every chat's
  // own terminal; a chat's Reset button restarts only that shell.
  const [terminals, setTerminals] = useState<Record<string, string>>({})

  useEffect(() => { try { window.localStorage.setItem(OPEN_KEY, open ? '1' : '0') } catch { /* private mode */ } }, [open])
  useEffect(() => { try { window.localStorage.setItem(WIDTH_KEY, String(Math.round(width))) } catch { /* private mode */ } }, [width])

  // Mount the (heavy) pane on first open and keep it mounted thereafter, so
  // the terminal socket is not torn down every time the drawer is collapsed.
  useEffect(() => { if (open) setMounted(true) }, [open])

  // A chat code block's Run button asks this dock to execute it: open the
  // drawer, ensure the current chat's shell is mounted, and hand the block to
  // that terminal (it waits for the socket).
  useEffect(() => {
    const onRun = (event: Event): void => {
      if (chat.id === '') return // no active chat — nowhere to run
      const code = (event as CustomEvent<string>).detail
      if (typeof code !== 'string' || code.trim() === '') return
      setOpen(true)
      // The mount effect below creates the terminal on the next render; the
      // injection then submits once its socket opens.
      setInjectNonce(n => n + 1)
      setPendingInject({ code, nonce: injectNonce + 1 })
    }
    window.addEventListener('dsh:run-in-terminal', onRun)
    return () => { window.removeEventListener('dsh:run-in-terminal', onRun) }
  }, [chat.id, injectNonce])

  // Open a terminal for the current chat the first time the drawer shows, and
  // capture its cwd ONCE. A blank id is the "no chat / still loading" state —
  // never spawn a shell for it. The cwd is never changed after mount: a live
  // reconnect to a new cwd would tear down the working shell, so the terminal
  // is only created once the chat (and normally its cwd) is on screen.
  useEffect(() => {
    if (!open || chat.id === '') return
    setTerminals(prev => (prev[chat.id] !== undefined ? prev : { ...prev, [chat.id]: chat.cwd }))
  }, [open, chat.id, chat.cwd])

  const close = useCallback(() => setOpen(false), [])
  // Header buttons are mounted in the slot tree (no shared React parent
  // with this private overlay root), so they reach the drawer through tiny
  // window custom events instead of props.
  useEffect(() => {
    const onToggle = (): void => { setOpen(value => !value) }
    const onOpen = (): void => { setOpen(true) }
    window.addEventListener(DOCK_TOGGLE_EVENT, onToggle)
    window.addEventListener(DOCK_OPEN_EVENT, onOpen)
    return () => {
      window.removeEventListener(DOCK_TOGGLE_EVENT, onToggle)
      window.removeEventListener(DOCK_OPEN_EVENT, onOpen)
    }
  }, [])

  // The terminal has consumed the injection; clear it so the same block can
  // be run again later (nonce already makes each injection distinct).
  const onInjected = useCallback(() => { setPendingInject(null) }, [])

  // Drag the left edge to resize. The drawer is right-anchored, so the width is
  // the distance from the pointer to the right edge; window listeners keep the
  // drag alive even when the pointer outruns the thin handle.
  const startResize = useCallback((event: ReactMouseEvent<HTMLDivElement>): void => {
    event.preventDefault()
    setResizing(true)
    const onMove = (ev: MouseEvent): void => {
      const max = Math.max(MIN_WIDTH, window.innerWidth - 40)
      setWidth(Math.min(max, Math.max(MIN_WIDTH, window.innerWidth - ev.clientX)))
    }
    const onUp = (): void => {
      setResizing(false)
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [])

  return (
    <>
      <aside
        className={css.drawer}
        data-open={open || undefined}
        data-resizing={resizing || undefined}
        style={{ width }}
        aria-hidden={!open}
      >
        <div
          className={css.resizer}
          onMouseDown={startResize}
          role="separator"
          aria-orientation="vertical"
          title="Drag to resize"
        />
        <header className={css.head}>
          <button className={css.close} onClick={close} title="Close" aria-label="Close the dock">×</button>
        </header>
        <div className={css.body}>
          {mounted && (
            <div className={css.pane} data-active>
              {Object.entries(terminals).map(([id, cwd]) => (
                <div key={id} className={css.termHost} data-active={id === chat.id || undefined}>
                  <Terminal active={open && id === chat.id} cwd={cwd} inject={pendingInject ?? undefined} onInjected={onInjected} />
                </div>
              ))}
              {terminals[chat.id] === undefined && (
                <div className={css.termEmpty}>Open a chat to use its terminal.</div>
              )}
            </div>
          )}
        </div>
      </aside>
    </>
  )
}
