/**
 * The browser pane: a live, INTERACTIVE mirror of the agent's SHARED browser.
 *
 * It subscribes to `/kiln/browser/stream`, a WebSocket the host bridge pushes
 * to: the bridge watches the kernel-written `state.json` and emits a new frame
 * only when the shared browser's `ts` stamp changes, so the dock renders the
 * AI's current page the moment it navigates and otherwise draws nothing. You can
 * drive the same browser yourself: click the screenshot (mapped to browser
 * coordinates), scroll it, or type after clicking a field — every gesture POSTs
 * to `/kiln/browser/act`, and the next pushed frame reflects it. A pulse marks
 * activity you did not cause. The address bar, back/forward/reload, and the
 * ref-tree "Elements" view are still here for precise, non-visual acts.
 * @module @deepseek-ai/dsh-client-ui-dock/client/Browser
 */

import { useCallback, useEffect, useRef, useState, type JSX } from 'react'
import type { KeyboardEvent, MouseEvent as ReactMouseEvent, WheelEvent } from 'react'
import css from './dock.module.css'

interface BrowserState {
  url: string
  title: string
  screenshot: string
  text_preview: string
  links: string[]
  ts?: number
  vw?: number
  vh?: number
}

type BrowserEvent =
  | { type: 'frame'; ts: number; url: string; title: string; text_preview: string; vw: number; vh: number; screenshot: string | null }
  | { type: 'state'; ts?: number; url: string; title: string; text_preview: string; vw: number; vh: number }

const EMPTY: BrowserState = { url: '', title: '', screenshot: '', text_preview: '', links: [], vw: 1440, vh: 900 }

/** POST one browser_use action to the shared browser; returns its text output. */
async function act(action: string, args: Record<string, unknown> = {}): Promise<string> {
  try {
    const res = await fetch('/kiln/browser/act', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action, ...args }),
    })
    const json = await res.json() as { output?: string; error?: string }
    return json.output ?? json.error ?? ''
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

/** Named keys the browser understands as key presses; everything else is text. */
const SPECIAL_KEYS = new Set([
  'Enter', 'Backspace', 'Tab', 'Escape', 'Delete', 'ArrowUp', 'ArrowDown',
  'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown',
])

/** The browser pane. `active` gates polling so a hidden tab does no work. */
export function Browser({ active }: { active: boolean }): JSX.Element {
  const [state, setState] = useState<BrowserState>(EMPTY)
  const [address, setAddress] = useState('')
  const [busy, setBusy] = useState(false)
  const [tree, setTree] = useState<string | null>(null)
  const [live, setLive] = useState(false)
  const lastTs = useRef(0)
  const addressFocused = useRef(false)
  const suppressLive = useRef(false)
  const wsRef = useRef<WebSocket | null>(null)

  const applyEvent = useCallback((event: BrowserEvent): void => {
    const ts = event.ts
    const changed = typeof ts === 'number' && ts !== lastTs.current
    setState(prev => ({
      ...prev,
      url: event.url,
      title: event.title,
      text_preview: event.text_preview,
      vw: event.vw,
      vh: event.vh,
      // A frame carries the full PNG inline; a state tick must not clobber the
      // last good frame with an empty string while the bridge re-reads state.
      screenshot: event.type === 'frame' ? (event.screenshot ?? prev.screenshot) : prev.screenshot,
      // `ts` is optional with exactOptionalPropertyTypes, so keep it out of the
      // object entirely rather than assigning an explicit undefined.
      ...(typeof ts === 'number' ? { ts } : {}),
    }))
    if (!addressFocused.current) setAddress(event.url)
    if (changed) {
      // Our own POST bumps the same ts; don't flash the "AI is using this" pulse
      // for a gesture the user just made.
      if (!suppressLive.current && lastTs.current !== 0) {
        setLive(true)
        window.setTimeout(() => { setLive(false) }, 1600)
      }
      suppressLive.current = false
      if (typeof ts === 'number') lastTs.current = ts
    }
  }, [])

  useEffect(() => {
    if (!active) return
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const url = `${proto}//${window.location.host}/kiln/browser/stream`
    let ws: WebSocket
    let closed = false
    let retry: number | null = null
    const connect = (): void => {
      if (closed) return
      ws = new WebSocket(url)
      wsRef.current = ws
      ws.onmessage = (ev) => {
        try {
          const parsed = JSON.parse(String(ev.data)) as BrowserEvent
          if (parsed.type === 'frame' || parsed.type === 'state') applyEvent(parsed)
        } catch { /* ignore malformed frames */ }
      }
      ws.onclose = () => {
        if (closed) return
        // The bridge may be restarting; reconnect with a short backoff so a
        // transient drop does not leave the pane frozen on the last frame.
        retry = window.setTimeout(connect, 750)
      }
      ws.onerror = () => { ws.close() }
    }
    connect()
    return () => {
      closed = true
      if (retry !== null) window.clearTimeout(retry)
      wsRef.current = null
      ws.close()
    }
  }, [active, applyEvent])

  // A user gesture: send it, then refresh the view right away (and once more
  // shortly after, to catch a navigation or late paint) instead of waiting for
  // the 1.5s poll. No `busy` gate — interaction must stay snappy.
  const actLive = useCallback(async (action: string, args: Record<string, unknown> = {}): Promise<void> => {
    suppressLive.current = true
    await act(action, args)
  }, [])

  const go = useCallback(async (raw: string): Promise<void> => {
    const target = raw.trim()
    if (target === '') return
    const url = /^[a-z][a-z0-9+.-]*:\/\//i.test(target) ? target : `https://${target}`
    setBusy(true)
    try { suppressLive.current = true; await act('navigate', { url }) } finally { setBusy(false) }
  }, [])

  const nav = useCallback(async (action: string): Promise<void> => {
    setBusy(true)
    try { suppressLive.current = true; await act(action) } finally { setBusy(false) }
  }, [])

  const toggleTree = useCallback(async (): Promise<void> => {
    if (tree !== null) { setTree(null); return }
    setBusy(true)
    try { setTree(await act('read_page')) } finally { setBusy(false) }
  }, [tree])

  const clickRef = useCallback(async (ref: string): Promise<void> => {
    setBusy(true)
    try { suppressLive.current = true; await act('click', { ref }); setTree(await act('read_page')) } finally { setBusy(false) }
  }, [])

  const onAddressKey = useCallback((event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter') void go(address)
  }, [address, go])

  // Map a click on the screenshot to browser viewport coordinates and click there.
  const onStageClick = useCallback((event: ReactMouseEvent<HTMLImageElement>): void => {
    const img = event.currentTarget
    const rect = img.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return
    // The CSS uses object-fit: contain, so the rendered page is a centered
    // sub-rectangle inside the <img> box whenever the pane's aspect ratio does
    // not match the viewport's. Map the click against that content rectangle;
    // a click in the letterbox band has no page content under it.
    const naturalW = img.naturalWidth || (state.vw ?? 1440)
    const naturalH = img.naturalHeight || (state.vh ?? 900)
    if (naturalW === 0 || naturalH === 0) return
    const scale = Math.min(rect.width / naturalW, rect.height / naturalH)
    const contentW = naturalW * scale
    const contentH = naturalH * scale
    const left = rect.left + (rect.width - contentW) / 2
    const top = rect.top + (rect.height - contentH) / 2
    const vw = state.vw ?? naturalW
    const vh = state.vh ?? naturalH
    const x = Math.round(((event.clientX - left) / contentW) * vw)
    const y = Math.round(((event.clientY - top) / contentH) * vh)
    if (x < 0 || y < 0 || x > vw || y > vh) return
    img.parentElement?.focus()
    void actLive('click', { target: `${x},${y}` })
  }, [actLive, state.vw, state.vh])

  const onStageWheel = useCallback((event: WheelEvent<HTMLDivElement>): void => {
    // The image is the viewport; wheeling scrolls the real page, not this div.
    event.preventDefault()
    void actLive('scroll', { dy: Math.round(event.deltaY), dx: Math.round(event.deltaX) })
  }, [actLive])

  const onStageKey = useCallback((event: KeyboardEvent<HTMLDivElement>): void => {
    const key = event.key
    if (event.altKey && !event.ctrlKey && !event.metaKey) return
    if ((event.ctrlKey || event.metaKey) && key.length === 1) {
      event.preventDefault()
      void actLive('key', { key: `Control+${key.toUpperCase()}` })
      return
    }
    if (SPECIAL_KEYS.has(key)) {
      event.preventDefault()
      void actLive('key', { key })
      return
    }
    if (key.length === 1 && !event.ctrlKey && !event.metaKey) {
      event.preventDefault()
      void actLive('type_text', { text: key })
    }
  }, [actLive])

  // The bridge pushes the PNG inline as a data URI, so no /shot round-trip.
  const shot = state.screenshot

  return (
    <div className={css.browser}>
      <div className={css.browserBar}>
        <button className={css.iconBtn} title="Back" onClick={() => void nav('back')} disabled={busy}>‹</button>
        <button className={css.iconBtn} title="Forward" onClick={() => void nav('forward')} disabled={busy}>›</button>
        <button className={css.iconBtn} title="Reload" onClick={() => void go(state.url === '' ? address : state.url)} disabled={busy}>⟳</button>
        <div className={css.addressWrap}>
          <span className={`${css.liveDot} ${live ? css.liveDotOn : ''}`} title={live ? 'The AI is using this browser' : 'Idle'} />
          <input
            className={css.address}
            value={address}
            placeholder="Search or type a URL"
            spellCheck={false}
            onFocus={() => { addressFocused.current = true }}
            onBlur={() => { addressFocused.current = false }}
            onChange={(event) => { setAddress(event.target.value) }}
            onKeyDown={onAddressKey}
          />
        </div>
        <button className={css.textBtn} title="Interactive element tree" onClick={() => void toggleTree()} disabled={busy}>
          {tree === null ? 'Elements' : 'Hide'}
        </button>
      </div>

      <div className={css.browserView}>
        {shot === ''
          ? <div className={css.browserEmpty}>{state.text_preview === '' ? 'No page yet — type an address above to browse.' : state.text_preview}</div>
          : (
            <div className={css.stage} tabIndex={0} onWheel={onStageWheel} onKeyDown={onStageKey} title="Click, scroll, or type to interact">
              <img
                className={css.shot}
                src={shot}
                alt={state.title === '' ? 'page' : state.title}
                draggable={false}
                onClick={onStageClick}
              />
            </div>
          )}
        {tree !== null && (
          <div className={css.tree}>
            <div className={css.treeHead}>Elements — click one to act on it</div>
            <div className={css.treeBody}>
              {tree.split('\n').map((line, index) => {
                const match = /\[ref_(\d+)\]/.exec(line)
                return match === null
                  ? <div key={index} className={css.treeLine}>{line}</div>
                  : <button key={index} className={css.treeItem} onClick={() => void clickRef(`ref_${match[1]}`)}>{line}</button>
              })}
            </div>
          </div>
        )}
      </div>

      <div className={css.browserFoot} title={state.url}>
        <span className={css.pageTitle}>{state.title === '' ? (state.url === '' ? 'DeepSeek Browser' : state.url) : state.title}</span>
      </div>
    </div>
  )
}
