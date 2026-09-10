/**
 * The browser pane: a live, interactive view of the REAL Chromium the agent
 * drives, plus a button that raises its window.
 *
 * There is no <iframe> here, and there cannot be one. An iframe makes the
 * user's own browser load the URL as a SEPARATE session — different cookies,
 * different logins, different scroll position — so it was never the agent's
 * browser, and sites that send X-Frame-Options refused to render in it at all.
 * A web page also cannot host a native Chromium window. So the pane shows the
 * agent's own live frames (the CDP screencast of its real window) and forwards
 * every mouse and key event back to that same browser: what you do here happens
 * in the real window, and "Show browser" raises it on the desktop.
 *
 * The stream keeps URL/title sync and the ref-tree; the address bar,
 * back/forward/reload, tabs, and Elements actions drive the shared browser
 * through `/kiln/browser/act`.
 * @module @deepseek-ai/dsh-client-ui-dock/client/Browser
 */

import { useCallback, useEffect, useRef, useState, type JSX } from 'react'
import type { KeyboardEvent, MouseEvent } from 'react'
import css from './dock.module.css'

interface HistoryInfo {
  back: { url: string; title: string }[]
  current: { url: string; title: string } | null
  forward: { url: string; title: string }[]
}

interface TabInfo {
  index: number
  url: string
  title: string
  active: boolean
  history: HistoryInfo
}

interface BrowserState {
  url: string
  title: string
  text_preview: string
  links: string[]
  screenshot: string
  vw: number
  vh: number
  ts?: number
  tabs: TabInfo[]
  active: number
  headed: boolean
}

type BrowserEvent =
  | { type: 'frame'; ts: number; url: string; title: string; text_preview: string; vw: number; vh: number; screenshot: string | null; tabs?: TabInfo[]; active?: number; history?: HistoryInfo; headed?: boolean }
  | { type: 'state'; ts?: number; url: string; title: string; text_preview: string; vw: number; vh: number; tabs?: TabInfo[]; active?: number; history?: HistoryInfo; headed?: boolean }

const EMPTY: BrowserState = { url: '', title: '', text_preview: '', links: [], screenshot: '', vw: 1440, vh: 900, tabs: [], active: -1, headed: false }

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

/** Translate a key event into the page's key name, or null to send it as text. */
function keyCombo(event: KeyboardEvent<HTMLDivElement>): string | null {
  const k = event.key
  const mods: string[] = []
  if (event.ctrlKey) mods.push('Control')
  if (event.altKey) mods.push('Alt')
  if (event.shiftKey && k.length > 1) mods.push('Shift')
  if (event.metaKey) mods.push('Meta')
  const named = k.length > 1
  if (!named && mods.length === 0) return null
  const base = named ? k : k.toUpperCase()
  return mods.length > 0 ? [...mods, base].join('+') : base
}

/** The browser pane. `active` gates the stream so a hidden tab does no work. */
export function Browser({ active }: { active: boolean }): JSX.Element {
  const [state, setState] = useState<BrowserState>(EMPTY)
  const [address, setAddress] = useState('')
  const [busy, setBusy] = useState(false)
  const [tree, setTree] = useState<string | null>(null)
  const [live, setLive] = useState(false)
  const [showHistory, setShowHistory] = useState(false)
  const [notice, setNotice] = useState('')
  const lastTs = useRef(0)
  const historyRef = useRef<HistoryInfo | null>(null)
  const addressFocused = useRef(false)
  const suppressLive = useRef(false)
  const wsRef = useRef<WebSocket | null>(null)
  const imgRef = useRef<HTMLImageElement | null>(null)
  const stageRef = useRef<HTMLDivElement | null>(null)
  const dragging = useRef(false)
  // Read inside listeners that must not be re-bound on every viewport change.
  const vp = useRef({ vw: 1440, vh: 900 })
  vp.current = { vw: state.vw, vh: state.vh }

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
      headed: event.headed ?? prev.headed ?? false,
      tabs: event.tabs ?? prev.tabs,
      active: event.active ?? prev.active,
      // A frame carries the image inline; a state tick must not clobber the
      // last good frame with an empty string while the bridge re-reads state.
      screenshot: event.type === 'frame' ? (event.screenshot ?? prev.screenshot) : prev.screenshot,
      ...(typeof ts === 'number' ? { ts } : {}),
    }))
    if (event.history !== undefined) {
      // The bridge may send a bare {} for an empty/incomplete state; normalize
      // to the full {back,current,forward} shape so the History panel can never
      // call .map on an undefined list and crash the dock.
      const h = event.history ?? {}
      historyRef.current = {
        back: Array.isArray(h.back) ? h.back : [],
        current: h.current ?? null,
        forward: Array.isArray(h.forward) ? h.forward : [],
      }
    }
    if (!addressFocused.current) setAddress(event.url)
    if (changed) {
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
          switch (parsed.type) {
            case 'frame':
            case 'state':
              applyEvent(parsed)
              break
            default:
              break
          }
        } catch { /* ignore malformed frames */ }
      }
      ws.onclose = () => {
        if (closed) return
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

  const go = useCallback(async (raw: string): Promise<void> => {
    const target = raw.trim()
    if (target === '') return
    const url = /^[a-z][a-z0-9+.-]*:\/\//i.test(target) ? target : `https://${target}`
    setBusy(true)
    try { suppressLive.current = true; await act('navigate', { url }) } finally { setBusy(false) }
  }, [])

  const tabAction = useCallback((action: string, args: Record<string, unknown> = {}): void => {
    // Tab-strip actions are fire-and-forget: the /kiln/browser/stream feed
    // already pushes the new tabs/active/url as soon as the kernel rewrites
    // state.json, so blocking the whole strip on the kernel round-trip (and
    // its heavy _state() DOM walk) is what made new/close tab feel frozen.
    suppressLive.current = true
    void act(action, args)
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

  const showWindow = useCallback(async (): Promise<void> => {
    const out = await act('show_window')
    setNotice(out)
    window.setTimeout(() => { setNotice('') }, 4000)
  }, [])

  /** Map a click on the pane to page coordinates through the letterboxed image. */
  const toPage = useCallback((clientX: number, clientY: number): { x: number; y: number } | null => {
    const img = imgRef.current
    if (img === null) return null
    const rect = img.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return null
    const { vw, vh } = vp.current
    // The image is object-fit: contain, so it is scaled uniformly and centred;
    // undo that letterboxing before scaling into page space.
    const scale = Math.min(rect.width / vw, rect.height / vh)
    const offX = (rect.width - vw * scale) / 2
    const offY = (rect.height - vh * scale) / 2
    const x = (clientX - rect.left - offX) / scale
    const y = (clientY - rect.top - offY) / scale
    if (x < 0 || y < 0 || x > vw || y > vh) return null
    return { x: Math.round(x), y: Math.round(y) }
  }, [])

  const onStageMouseDown = useCallback((event: MouseEvent<HTMLDivElement>): void => {
    const pt = toPage(event.clientX, event.clientY)
    if (pt === null) return
    event.preventDefault()
    stageRef.current?.focus()
    dragging.current = true
    void act('ui_mouse', { kind: 'down', x: pt.x, y: pt.y, button: event.button === 2 ? 'right' : 'left' })
  }, [toPage])

  const onStageMouseUp = useCallback((event: MouseEvent<HTMLDivElement>): void => {
    if (!dragging.current) return
    dragging.current = false
    // Release exactly what mousedown pressed. Sending `click` here would add a
    // second down+up on top of the pending press and double-fire buttons.
    void act('ui_mouse', { kind: 'up', button: event.button === 2 ? 'right' : 'left' })
  }, [toPage])

  const onStageMouseMove = useCallback((event: MouseEvent<HTMLDivElement>): void => {
    if (!dragging.current) return
    const pt = toPage(event.clientX, event.clientY)
    if (pt === null) return
    void act('ui_mouse', { kind: 'move', x: pt.x, y: pt.y })
  }, [toPage])

  const onStageKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>): void => {
    const combo = keyCombo(event)
    event.preventDefault()
    if (combo === null) {
      void act('ui_key', { text: event.key })
      return
    }
    void act('ui_key', { key: combo })
  }, [])

  // Wheel must be non-passive to stop the dock's own scroll from also moving.
  useEffect(() => {
    const node = stageRef.current
    if (node === null) return
    const onWheel = (event: globalThis.WheelEvent): void => {
      event.preventDefault()
      void act('ui_mouse', { kind: 'wheel', dx: event.deltaX, dy: event.deltaY })
    }
    node.addEventListener('wheel', onWheel, { passive: false })
    return () => { node.removeEventListener('wheel', onWheel) }
  }, [active, state.url])

  const onAddressKey = useCallback((event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter') void go(address)
  }, [address, go])

  const current = state.url
  const hist = historyRef.current
  const emptyHistory = hist === null
    || (hist.back.length === 0 && hist.current === null && hist.forward.length === 0)
  const headed = state.headed === true

  return (
    <div className={css.browser}>
      <div className={css.browserBar}>
        <button className={css.iconBtn} title="Back" onClick={() => void nav('back')} disabled={busy}>‹</button>
        <button className={css.iconBtn} title="Forward" onClick={() => void nav('forward')} disabled={busy}>›</button>
        <button className={css.iconBtn} title="Reload" onClick={() => void go(current === '' ? address : current)} disabled={busy}>⟳</button>
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
        <button
          className={css.textBtn}
          title={headed
            ? 'Raise the real Chromium window on your desktop'
            : 'The browser is headless; set KILN_BROWSER_HEADED=1 and restart to get a real window'}
          onClick={() => void showWindow()}
          disabled={busy}
        >
          {headed ? 'Show browser' : 'Headless'}
        </button>
        <button className={css.textBtn} title="Interactive element tree" onClick={() => void toggleTree()} disabled={busy}>
          {tree === null ? 'Elements' : 'Hide'}
        </button>
      </div>

      {notice !== '' && <div className={css.browserNotice}>{notice}</div>}

      <div className={css.tabStrip} role="tablist" aria-label="Browser tabs">
        {state.tabs.map(tab => (
          <div key={tab.index} className={`${css.tabChip} ${tab.active ? css.tabChipActive : ''}`}>
            <button type="button" className={css.tabChipLabel} title={tab.url || 'New tab'} onClick={() => { tabAction('switch_tab', { index: tab.index }) }} disabled={busy}>
              {tab.title || tab.url || `Tab ${tab.index + 1}`}
            </button>
            <button type="button" className={css.tabChipClose} title="Close tab" onClick={() => { tabAction('close_tab', { index: tab.index }) }} disabled={busy}>×</button>
          </div>
        ))}
        <button type="button" className={css.tabAdd} title="New tab" onClick={() => { tabAction('new_tab') }} disabled={busy}>+</button>
        <button type="button" className={css.textBtn} title="Navigation history" onClick={() => { setShowHistory(v => !v) }} disabled={busy}>
          {showHistory ? 'Hide history' : 'History'}
        </button>
      </div>
      {showHistory && (
        <div className={css.historyPanel}>
          {emptyHistory
            ? <div className={css.treeLine}>No navigation history yet.</div>
            : (
              <>
                {hist.back.map((e, i) => (
                  <div key={`b${i}`} className={css.treeLine}>‹ {e.title || e.url}</div>
                ))}
                {hist.current !== null && (
                  <div className={css.treeItem}>
                    {hist.current.title || hist.current.url}
                  </div>
                )}
                {hist.forward.map((e, i) => (
                  <div key={`f${i}`} className={css.treeLine}>› {e.title || e.url}</div>
                ))}
              </>
            )}
        </div>
      )}
      <div className={css.browserView}>
        {current === ''
          ? <div className={css.browserEmpty}>{state.text_preview === '' ? 'No page yet — type an address above to browse.' : state.text_preview}</div>
          : state.screenshot === ''
            ? <div className={css.browserEmpty}>No frame yet — the shared browser is still loading this page.</div>
            : (
              <div
                ref={stageRef}
                className={css.stage}
                tabIndex={0}
                role="application"
                aria-label="Live browser — click to interact"
                onMouseDown={onStageMouseDown}
                onMouseUp={onStageMouseUp}
                onMouseMove={onStageMouseMove}
                onKeyDown={onStageKeyDown}
                onContextMenu={(event) => { event.preventDefault() }}
              >
                <img
                  ref={imgRef}
                  className={css.shot}
                  src={state.screenshot}
                  alt={state.title || 'page'}
                  draggable={false}
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

      <div className={css.browserFoot} title={current}>
        <span className={css.pageTitle}>
          {state.title === '' ? (current === '' ? 'DeepSeek Browser' : current) : state.title}
          {headed ? ' — real window (click here or press Show browser)' : ' — headless'}
        </span>
      </div>
    </div>
  )
}
