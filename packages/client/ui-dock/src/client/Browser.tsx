/**
 * The browser pane: a LIVE, native render of the agent's shared browser URL.
 *
 * It no longer streams bitmap frames. Instead it subscribes to
 * `/kiln/browser/stream` only for the current URL/title, and renders that URL
 * in a real `<iframe>` so the page's own HTML, CSS, and JavaScript run in the
 * user's browser — crisp at any size and smooth because there is no image
 * round-trip. URL-level driving (address bar, back/forward/reload) and the
 * ref-tree "Elements" view still POST to `/kiln/browser/act`, so the AI's
 * browser follows; the next pushed URL simply re-points the iframe.
 *
 * Trade-off: because the iframe runs in the user's browser, it uses the user's
 * own cookies/session rather than the agent's, and a site that sends
 * `X-Frame-Options: DENY`/`SAMEORIGIN` (or a restrictive CSP) will refuse to
 * embed — use the "Open" button for those.
 * @module @deepseek-ai/dsh-client-ui-dock/client/Browser
 */

import { useCallback, useEffect, useRef, useState, type JSX } from 'react'
import type { KeyboardEvent } from 'react'
import css from './dock.module.css'

interface BrowserState {
  url: string
  title: string
  text_preview: string
  links: string[]
  ts?: number
}

type BrowserEvent =
  | { type: 'frame'; ts: number; url: string; title: string; text_preview: string; vw: number; vh: number; screenshot: string | null }
  | { type: 'state'; ts?: number; url: string; title: string; text_preview: string; vw: number; vh: number }

const EMPTY: BrowserState = { url: '', title: '', text_preview: '', links: [] }

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
      ...(typeof ts === 'number' ? { ts } : {}),
    }))
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
          if (parsed.type === 'frame' || parsed.type === 'state') applyEvent(parsed)
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

      <div className={css.browserView}>
        {current === ''
          ? <div className={css.browserEmpty}>{state.text_preview === '' ? 'No page yet — type an address above to browse.' : state.text_preview}</div>
          : <iframe className={css.frame} src={current} title={state.title || 'page'} />}
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
