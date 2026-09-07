/**
 * The browser pane: a live, INTERACTIVE mirror of the agent's SHARED browser.
 *
 * It polls `/kiln/browser/state` (written by browser_tools on every action, by
 * the model or by the user) and shows the current viewport screenshot. You can
 * drive the same browser yourself: click the screenshot (mapped to browser
 * coordinates), scroll it, or type after clicking a field — every gesture POSTs
 * to `/kiln/browser/act`, so when the AI is idle it is just a normal browser. A
 * pulse marks activity you did not cause. The address bar, back/forward/reload,
 * and the ref-tree "Elements" view are still here for precise, non-visual acts.
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
  const imgRef = useRef<HTMLImageElement>(null)

  const pull = useCallback(async (): Promise<void> => {
    try {
      const res = await fetch('/kiln/browser/state', { cache: 'no-store' })
      const next = await res.json() as BrowserState
      // The full state (including the screenshot filename) only changes when the
      // shared browser actually acted. Re-applying it on every poll re-renders
      // and re-decodes a large high-res PNG for no reason, which is what made
      // this pane feel laggy at low FPS next to the push-based Terminal. When
      // the timestamp is unchanged there is nothing new to paint, so skip the
      // render work entirely. A state file without `ts` keeps the old always-
      // apply behaviour because we cannot tell whether it changed.
      const changed = next.ts !== undefined && next.ts !== lastTs.current
      if (next.ts === undefined || lastTs.current === 0 || changed) {
        setState(next)
        if (!addressFocused.current) setAddress(next.url)
      }
      if (changed) {
        if (lastTs.current !== 0) { setLive(true); window.setTimeout(() => { setLive(false) }, 1600) }
        lastTs.current = next.ts
      }
    } catch { /* the bridge may not be up yet; the next tick retries */ }
  }, [])

  useEffect(() => {
    if (!active) return
    let alive = true
    const tick = (): void => { if (alive) void pull() }
    tick()
    const id = window.setInterval(tick, 1500)
    return () => { alive = false; window.clearInterval(id) }
  }, [active, pull])

  // A user gesture: send it, then refresh the view right away (and once more
  // shortly after, to catch a navigation or late paint) instead of waiting for
  // the 1.5s poll. No `busy` gate — interaction must stay snappy.
  const actLive = useCallback(async (action: string, args: Record<string, unknown> = {}): Promise<void> => {
    await act(action, args)
    void pull()
    window.setTimeout(() => { void pull() }, 450)
  }, [pull])

  const go = useCallback(async (raw: string): Promise<void> => {
    const target = raw.trim()
    if (target === '') return
    const url = /^[a-z][a-z0-9+.-]*:\/\//i.test(target) ? target : `https://${target}`
    setBusy(true)
    try { await act('navigate', { url }) } finally { setBusy(false); void pull() }
  }, [pull])

  const nav = useCallback(async (action: string): Promise<void> => {
    setBusy(true)
    try { await act(action) } finally { setBusy(false); void pull() }
  }, [pull])

  const toggleTree = useCallback(async (): Promise<void> => {
    if (tree !== null) { setTree(null); return }
    setBusy(true)
    try { setTree(await act('read_page')) } finally { setBusy(false) }
  }, [tree])

  const clickRef = useCallback(async (ref: string): Promise<void> => {
    setBusy(true)
    try { await act('click', { ref }); setTree(await act('read_page')) } finally { setBusy(false); void pull() }
  }, [pull])

  const onAddressKey = useCallback((event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter') void go(address)
  }, [address, go])

  // Map a click on the screenshot to browser viewport coordinates and click there.
  const onStageClick = useCallback((event: ReactMouseEvent<HTMLImageElement>): void => {
    const img = event.currentTarget
    const rect = img.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return
    const vw = state.vw ?? 1440
    const vh = state.vh ?? 900
    const x = Math.round(((event.clientX - rect.left) / rect.width) * vw)
    const y = Math.round(((event.clientY - rect.top) / rect.height) * vh)
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

  const shot = state.screenshot === '' ? '' : `/kiln/browser/shot/${encodeURIComponent(state.screenshot)}`

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
                ref={imgRef}
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
