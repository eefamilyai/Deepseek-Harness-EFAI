/**
 * The terminal pane: a live WebSocket to the sidebar-bridge's `/kiln/terminal`
 * piped shell. There is no PTY (Windows has none), so the shell is line-based:
 * you type on the visible input line — echoed locally as you type — and the
 * whole line is sent on Enter. The shell prints its own prompt, the command,
 * and the output, which are ANSI-rendered into the scrollback above. Up/Down
 * walk a local history; Ctrl-C sends an interrupt. Full-screen TUIs (vim/htop)
 * are out of scope for a piped shell.
 * @module @deepseek-ai/dsh-client-ui-dock/client/Terminal
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { KeyboardEvent, MouseEvent as ReactMouseEvent } from 'react'
import { renderAnsi } from './ansi.ts'
import css from './dock.module.css'

/** Cap on retained output; the buffer is re-parsed each render, so bound it. */
const MAX_BUFFER = 200_000

/**
 * The terminal pane for one chat. `active` focuses the input when shown; `cwd`
 * is the chat's workspace, so each chat's terminal opens where its files are.
 */
export interface TerminalInject {
  /** The exact multi-line command block to run, line by line. */
  code: string
  /** Bumped by the dock per injection so the same code can be re-run. */
  nonce: number
}

export function Terminal({ active, cwd, inject, onInjected }: {
  active: boolean
  cwd: string
  /** A pending run-in-terminal injection; submitted once the socket is open. */
  inject?: TerminalInject | undefined
  /** Called after the injection has been submitted (dock clears its pending state). */
  onInjected?: () => void
}): JSX.Element {
  const [buffer, setBuffer] = useState('')
  const [status, setStatus] = useState<'connecting' | 'open' | 'closed'>('connecting')
  const [input, setInput] = useState('')
  const [gen, setGen] = useState(0)
  const wsRef = useRef<WebSocket | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const history = useRef<string[]>([])
  // Cursor into history for Up/Down; === length means "the new, unsent line".
  const histAt = useRef(0)

  useEffect(() => {
    setStatus('connecting')
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
    const query = cwd === '' ? '' : `?cwd=${encodeURIComponent(cwd)}`
    const ws = new WebSocket(`${proto}://${window.location.host}/kiln/terminal${query}`)
    wsRef.current = ws
    ws.onopen = () => setStatus('open')
    ws.onclose = () => setStatus('closed')
    ws.onerror = () => setStatus('closed')
    ws.onmessage = (event) => {
      const text = typeof event.data === 'string' ? event.data : ''
      if (text === '') return
      setBuffer((prev) => {
        const next = prev + text
        return next.length > MAX_BUFFER ? next.slice(next.length - MAX_BUFFER) : next
      })
    }
    return () => { ws.close() }
  }, [gen, cwd])

  // Reset: drop the scrollback and reconnect, which spawns a fresh shell (the
  // old one dies when its socket closes). Per chat — other chats keep theirs.
  const reset = useCallback((): void => { setBuffer(''); setGen(g => g + 1) }, [])

  // Keep the newest output in view unless the user has scrolled up to read back.
  useEffect(() => {
    const el = scrollRef.current
    if (el === null) return
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    if (nearBottom) el.scrollTop = el.scrollHeight
  }, [buffer, input])

  useEffect(() => { if (active && status === 'open') inputRef.current?.focus() }, [active, status])

  // Run a code block injected from a chat fence: line-by-line into the piped
  // shell once the socket is open. Heredocs/TUIs are outside the line-based
  // shell's scope (same limitation as typing), and empty lines are skipped.
  useEffect(() => {
    if (inject === undefined || status !== 'open') return
    const ws = wsRef.current
    if (ws === null || ws.readyState !== WebSocket.OPEN) return
    for (const line of inject.code.split(/\r?\n/)) {
      if (line.trim() === '') continue
      ws.send(`${line}\r\n`)
    }
    onInjected?.()
    // `nonce` is the re-run signal; `status` gates the retry after a reconnect.
  }, [inject?.nonce, status, inject, onInjected])

  const send = useCallback((data: string): boolean => {
    const ws = wsRef.current
    if (ws !== null && ws.readyState === WebSocket.OPEN) { ws.send(data); return true }
    return false
  }, [])

  const submit = useCallback((line: string): void => {
    // CRLF: cmd.exe (and bash) both accept it as a line terminator; the shell
    // echoes the committed command into the scrollback, so we do not echo here.
    if (!send(`${line}\r\n`)) return
    if (line.trim() !== '') history.current.push(line)
    histAt.current = history.current.length
    setInput('')
  }, [send])

  const onKeyDown = useCallback((event: KeyboardEvent<HTMLInputElement>): void => {
    // Read the live DOM value, never the React state — a fast Enter can outrun
    // the onChange re-render, which would submit a stale (empty) line.
    if (event.key === 'Enter') { event.preventDefault(); submit(event.currentTarget.value); return }
    if (event.ctrlKey && (event.key === 'c' || event.key === 'C')) {
      event.preventDefault()
      send(String.fromCharCode(3))
      setInput('')
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      if (history.current.length === 0) return
      histAt.current = Math.max(0, histAt.current - 1)
      setInput(history.current[histAt.current] ?? '')
      return
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      if (history.current.length === 0) return
      histAt.current = Math.min(history.current.length, histAt.current + 1)
      setInput(histAt.current === history.current.length ? '' : (history.current[histAt.current] ?? ''))
    }
  }, [submit, send])

  const focusInput = useCallback((event: ReactMouseEvent<HTMLDivElement>): void => {
    // Let clicks on the input (and text selection) through; a click on the
    // empty scrollback focuses the prompt.
    if ((event.target as HTMLElement).tagName !== 'INPUT') inputRef.current?.focus()
  }, [])

  return (
    <div className={css.terminal}>
      <div className={css.terminalBar}>
        <span className={css.terminalCwd} title={cwd === '' ? 'default directory' : cwd}>
          {cwd === '' ? '~ (default)' : cwd}
        </span>
        <button className={css.terminalReset} onClick={reset} title="Kill this shell and start a fresh one">↻ Reset</button>
      </div>
      <div ref={scrollRef} className={css.terminalScroll} onMouseDown={focusInput}>
        <pre className={css.terminalPre}>{renderAnsi(buffer)}</pre>
        <div className={css.terminalInputRow}>
          <span className={css.terminalPrompt} aria-hidden>❯</span>
          <input
            ref={inputRef}
            className={css.terminalLine}
            value={input}
            onChange={event => setInput(event.target.value)}
            onKeyDown={onKeyDown}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            autoComplete="off"
            aria-label="terminal input"
            disabled={status !== 'open'}
          />
        </div>
      </div>
      {status !== 'open' && (
        <div className={css.terminalStatus}>
          {status === 'connecting'
            ? 'connecting…'
            : (
              <>
                disconnected{' '}
                <button className={css.termReconnect} onClick={() => setGen(g => g + 1)}>reconnect</button>
              </>
            )}
        </div>
      )}
    </div>
  )
}
