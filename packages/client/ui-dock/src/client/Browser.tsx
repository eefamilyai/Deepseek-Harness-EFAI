/**
 * The browser pane: a LIVE, native render of the shared browser URL, with a
 * screenshot "Mirror" fallback for sites that refuse to be embedded.
 *
 * Default mode points a real <iframe> at the shared browser's current URL, so
 * the page's own HTML/CSS/JS run natively in the user's browser — crisp and
 * smooth. Some sites (google.com among them) send `X-Frame-Options` or a CSP
 * frame-ancestors rule that browsers enforce at the security layer; no client
 * code can embed those. The Mirror toggle renders the agent's own screenshot
 * stream instead, so even blocking sites remain visible (as the AI sees them).
 *
 * The stream also keeps URL/title sync and the "Elements" ref-tree; the address
 * bar, back/forward/reload, Open, and Elements actions still drive the shared
 * browser through `/kiln/browser/act`.
 * @module @deepseek-ai/dsh-client-ui-dock/client/Browser
 */

import { useCallback, useEffect, useRef, useState, type JSX } from 'react'
import type { KeyboardEvent } from 'react'
import css from './dock.module.css'

type RenderMode = 'live' | 'mirror'

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
}

type BrowserEvent =
  | { type: 'frame'; ts: number; url: string; title: string; text_preview: string; vw: number; vh: number; screenshot: string | null; tabs?: TabInfo[]; active?: number; history?: HistoryInfo }
  | { type: 'state'; ts?: number; url: string; title: string; text_preview: string; vw: number; vh: number; tabs?: TabInfo[]; active?: number; history?: HistoryInfo }

const EMPTY: BrowserState = { url: '', title: '', text_preview: '', links: [], screenshot: '', vw: 1440, vh: 900, tabs: [], active: -1 }

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

/** The browser pane. `active` gates the stream so a hidden tab does no work. */
export function Browser({ active }: { active: boolean }): JSX.Element {
  const [state, setState] = useState<BrowserState>(EMPTY)
  const [mode, setMode] = useState<RenderMode>('mirror')
  const [address, setAddress] = useState('')
  const [busy, setBusy] = useState(false)
  const [tree, setTree] = useState<string | null>(null)
  const [live, setLive] = useState(false)
  const [showHistory, setShowHistory] = useState(false)
  const lastTs = useRef(0)
  const historyRef = useRef<HistoryInfo | null>(null)
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
      tabs: event.tabs ?? prev.tabs,
      active: event.active ?? prev.active,
      // A frame carries the PNG inline; a state tick must not clobber the last
      // good frame with an empty string while the bridge re-reads state.
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

  const tabAction = useCallback(async (action: string, args: Record<string, unknown> = {}): Promise<void> => {
    setBusy(true)
    try { suppressLive.current = true; await act(action, args) } finally { setBusy(false) }
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

  const current = state.url
  const hist = historyRef.current
  const emptyHistory = hist === null
    || (hist.back.length === 0 && hist.current === null && hist.forward.length === 0)

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
          title={mode === 'live' ? 'This site may block embedding — show the agent\'s screenshot instead' : 'Show the native live page when it allows embedding'}
          onClick={() => { setMode(mode === 'live' ? 'mirror' : 'live') }}
          disabled={busy}
        >
          {mode === 'live' ? 'Shared frame' : 'Live iframe'}
        </button>
        <button className={css.textBtn} title="Interactive element tree" onClick={() => void toggleTree()} disabled={busy}>
          {tree === null ? 'Elements' : 'Hide'}
        </button>
        <a
          className={css.textBtn}
          href={current === '' ? undefined : current}
          target="_blank"
          rel="noopener noreferrer"
          title="Open in a new tab"
          aria-disabled={current === ''}
          onClick={(event) => { if (current === '') event.preventDefault() }}
        >
          Open
        </a>
      </div>

      <div className={css.tabStrip} role="tablist" aria-label="Browser tabs">
        {state.tabs.map(tab => (
          <div key={tab.index} className={`${css.tabChip} ${tab.active ? css.tabChipActive : ''}`}>
            <button type="button" className={css.tabChipLabel} title={tab.url || 'New tab'} onClick={() => void tabAction('switch_tab', { index: tab.index })} disabled={busy}>
              {tab.title || tab.url || `Tab ${tab.index + 1}`}
            </button>
            <button type="button" className={css.tabChipClose} title="Close tab" onClick={() => void tabAction('close_tab', { index: tab.index })} disabled={busy}>×</button>
          </div>
        ))}
        <button type="button" className={css.tabAdd} title="New tab" onClick={() => void tabAction('new_tab')} disabled={busy}>+</button>
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
          : mode === 'live'
            ? <iframe className={css.frame} src={current} title={state.title || 'page'} />
            : state.screenshot === ''
              ? <div className={css.browserEmpty}>No snapshot yet — the shared browser is still loading this page.</div>
              : (
                <div className={css.stage}>
                  <img className={css.shot} src={state.screenshot} alt={state.title || 'page'} draggable={false} />
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
        <span className={css.pageTitle}>{state.title === '' ? (current === '' ? 'DeepSeek Browser' : current) : state.title}</span>
      </div>
    </div>
  )
}
