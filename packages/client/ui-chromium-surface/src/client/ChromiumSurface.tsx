/**
 * The Chromium-style surface: a tab strip, an address/navigation bar, and a
 * text snapshot of the active tab. It drives the host's dedicated `/chromium`
 * endpoints directly, so its session, tabs, and history are entirely its own —
 * never the agent's browser.
 * @module @deepseek-ai/dsh-client-ui-chromium-surface/client/ChromiumSurface
 */

import { useCallback, useEffect, useRef, useState, type JSX, type KeyboardEvent } from 'react'
import { type ChromiumAction, type ChromiumState, EMPTY_STATE, activeTab, orderedTabIds, tabLabel, tabUrl } from './model.ts'

/** POST one action to the host; returns the updated session snapshot. */
async function act(action: ChromiumAction, args: Record<string, unknown> = {}): Promise<ChromiumState> {
  const res = await fetch('/chromium/act', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action, ...args }),
  })
  const json = await res.json() as { ok?: boolean; state?: ChromiumState; error?: string }
  if (json.ok !== true) {
    throw new Error(json.error ?? `chromium action "${action}" failed`)
  }
  return json.state ?? EMPTY_STATE
}

/** Read the current session snapshot. */
async function readState(): Promise<ChromiumState> {
  const res = await fetch('/chromium/state')
  if (!res.ok) return EMPTY_STATE
  return await res.json() as ChromiumState
}

/** The browser surface component. */
export function ChromiumSurface(): JSX.Element {
  const [state, setState] = useState<ChromiumState>(EMPTY_STATE)
  const [address, setAddress] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const addressFocused = useRef(false)

  const applyState = useCallback((next: ChromiumState): void => {
    setState(next)
    const tab = activeTab(next)
    if (!addressFocused.current) setAddress(tab?.url ?? '')
  }, [])

  // Boot: read the persisted session, then subscribe to change pushes.
  useEffect(() => {
    let closed = false
    void readState().then((s) => { if (!closed) applyState(s) })
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const url = `${proto}//${window.location.host}/chromium/stream`
    let ws: WebSocket
    let retry: number | null = null
    const connect = (): void => {
      if (closed) return
      ws = new WebSocket(url)
      ws.onmessage = (ev) => {
        try {
          const parsed = JSON.parse(String(ev.data)) as { type?: string; state?: ChromiumState }
          if (parsed.type === 'state' && parsed.state !== undefined) applyState(parsed.state)
        } catch { /* ignore malformed frames */ }
      }
      ws.onclose = () => { if (!closed) retry = window.setTimeout(connect, 750) }
      ws.onerror = () => { ws.close() }
    }
    connect()
    return () => {
      closed = true
      if (retry !== null) window.clearTimeout(retry)
      ws?.close()
    }
  }, [applyState])

  const run = useCallback(async (action: ChromiumAction, args: Record<string, unknown> = {}): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      applyState(await act(action, args))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }, [applyState])

  const go = useCallback((raw: string): void => {
    const target = raw.trim()
    if (target === '') return
    const url = /^[a-z][a-z0-9+.-]*:\/\//i.test(target) ? target : `https://${target}`
    void run('navigate', { url })
  }, [run])

  const onAddressKey = useCallback((event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter') go(address)
  }, [address, go])

  const tab = activeTab(state)

  return (
    <div style={{ fontFamily: 'system-ui, sans-serif' }}>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', padding: 6, borderBottom: '1px solid #333' }}>
        <button type="button" onClick={() => void run('back')} disabled={busy || tab === null || tab.history.back.length === 0} title="Back">‹</button>
        <button type="button" onClick={() => void run('forward')} disabled={busy || tab === null || tab.history.forward.length === 0} title="Forward">›</button>
        <button type="button" onClick={() => void run('reload')} disabled={busy || tab === null} title="Reload">⟳</button>
        <input
          style={{ flex: 1, padding: '4px 8px' }}
          value={address}
          placeholder="Search or type a URL"
          spellCheck={false}
          onFocus={() => { addressFocused.current = true }}
          onBlur={() => { addressFocused.current = false }}
          onChange={(event) => { setAddress(event.target.value) }}
          onKeyDown={onAddressKey}
        />
        <button type="button" onClick={() => void run('open')} disabled={busy} title="New tab">+</button>
      </div>
      <div style={{ display: 'flex', gap: 2, padding: '4px 6px', borderBottom: '1px solid #333', overflowX: 'auto' }}>
        {orderedTabIds(state).map((id) => {
          const t = state.tabs.find(candidate => candidate.id === id)
          if (t === undefined) return null
          return (
            <span key={id} style={{ display: 'inline-flex', gap: 4, alignItems: 'center', padding: '2px 8px', borderRadius: 4, background: t.active ? '#1f6feb' : '#222', color: '#fff', whiteSpace: 'nowrap' }}>
              <button type="button" onClick={() => void run('activate', { tabId: t.id })} style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer' }} title={t.url}>
                {tabLabel(t)}
              </button>
              <button type="button" onClick={() => void run('close', { tabId: t.id })} style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer' }} title="Close tab">×</button>
            </span>
          )
        })}
        {state.tabs.length === 0 && <span style={{ color: '#888' }}>No tabs — type a URL above.</span>}
      </div>
      <div style={{ padding: 8, minHeight: 120 }}>
        {error !== null && <div style={{ color: '#f87171', marginBottom: 6 }}>{error}</div>}
        {tab === null
          ? <div style={{ color: '#888' }}>No page yet — type an address above to browse.</div>
          : (
            <div>
              <strong>{tab.title === '' ? (tab.url === '' ? 'Blank tab' : tab.url) : tab.title}</strong>
              <div style={{ color: '#888', margin: '4px 0' }}>{tabUrl(tab)}</div>
              <pre style={{ whiteSpace: 'pre-wrap', fontSize: 13 }}>{tab.history.current?.title ?? ''}</pre>
            </div>
          )}
      </div>
    </div>
  )
}
