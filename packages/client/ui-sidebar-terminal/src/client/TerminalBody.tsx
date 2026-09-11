/**
 * The terminal tab's body: a live view of this Session's piped shell.
 *
 * The shell itself lives in `terminal-session.ts`, keyed by session, so
 * switching tabs or collapsing the panel does not kill it. This component is a
 * view: it reads the shared snapshot through `useSyncExternalStore`, keeps the
 * newest output in view, and turns keystrokes into bytes on the socket.
 *
 * There is no PTY (Windows has none), so the shell is line-based: you type on
 * the visible input line — echoed locally as you type — and the whole line is
 * sent on Enter. The shell prints its own prompt, the command, and the output,
 * which are ANSI-rendered into the scrollback above. Up/Down walk a local
 * history; Ctrl-C sends an interrupt. Full-screen TUIs (vim/htop) are out of
 * scope for a piped shell.
 *
 * A code block run from a chat fence arrives as a navigation: the tab is opened
 * with `params: { code, nonce }`, and this body submits each line once the socket
 * is open. `nonce` is what makes running the same block twice two navigations.
 * @module @deepseek-ai/dsh-client-ui-sidebar-terminal/client/TerminalBody
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { KeyboardEvent, MouseEvent as ReactMouseEvent } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { renderAnsi } from './ansi.ts'
import { acquireTerminal, type TerminalSession } from './terminal-session.ts'
import css from './terminal.module.css'

/** The body's composed props: the tab it draws, the session it belongs to, and its copy. */
export type TerminalBodyProps =
  & PropsRuntime<'sidebar.right.pane.tab'>
  & PropsLocale<'sidebarTerminal'>

/**
 * The terminal pane for one Session.
 * @param props - framework props carrying the tab (with its navigation) and copy.
 * @returns the terminal view.
 */
export function TerminalBody({ sessionId, useSessions, useTabInfo, t }: TerminalBodyProps): JSX.Element {
  const { tab } = useTabInfo()
  const cwd = useSessions(sessions => sessions.byId[sessionId]?.cwd) ?? ''

  const [input, setInput] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const history = useRef<string[]>([])
  // Cursor into history for Up/Down; === length means "the new, unsent line".
  const histAt = useRef(0)
  // The connection is acquired once per session; `cwd` only seeds a new shell.
  const sessionRef = useRef<TerminalSession | null>(null)
  if (sessionRef.current === null) sessionRef.current = acquireTerminal(sessionId, cwd)
  const session = sessionRef.current

  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot)
  const { buffer, status } = snapshot

  // Drop this view's listener on unmount; the shell itself stays alive for the
  // session, so a tab switch or a panel collapse keeps the process and its
  // scrollback.
  useEffect(() => () => { sessionRef.current?.release() }, [])

  // Keep the newest output in view unless the user has scrolled up to read back.
  useEffect(() => {
    const el = scrollRef.current
    if (el === null) return
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    if (nearBottom) el.scrollTop = el.scrollHeight
  }, [buffer, input])

  // Only the visible body takes focus; a hidden tab must not steal keystrokes.
  useEffect(() => { if (tab.visible && status === 'open') inputRef.current?.focus() }, [tab.visible, status])

  // A code block injected from a chat fence: line by line into the piped shell
  // once the socket is open. Heredocs and TUIs are outside the line-based
  // shell's scope (the same limitation as typing); empty lines are skipped.
  const request = tab.navigation.params
  const nonce = request !== undefined && 'code' in request ? request.nonce : undefined
  useEffect(() => {
    if (request === undefined || !('code' in request) || status !== 'open') return
    for (const line of request.code.split(/\r?\n/)) {
      if (line.trim() === '') continue
      session.send(`${line}\r\n`)
    }
    // `nonce` is the re-run signal; `status` retries after a reconnect.
  }, [nonce, status, session, request])

  const submit = useCallback((line: string): void => {
    // CRLF: cmd.exe (and bash) both accept it as a line terminator; the shell
    // echoes the committed command into the scrollback, so we do not echo here.
    if (!session.send(`${line}\r\n`)) return
    if (line.trim() !== '') history.current.push(line)
    histAt.current = history.current.length
    setInput('')
  }, [session])

  const onKeyDown = useCallback((event: KeyboardEvent<HTMLInputElement>): void => {
    // Read the live DOM value, never the React state — a fast Enter can outrun
    // the onChange re-render, which would submit a stale (empty) line.
    if (event.key === 'Enter') { event.preventDefault(); submit(event.currentTarget.value); return }
    if (event.ctrlKey && (event.key === 'c' || event.key === 'C')) {
      event.preventDefault()
      session.send(String.fromCharCode(3))
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
  }, [submit, session])

  const focusInput = useCallback((event: ReactMouseEvent<HTMLDivElement>): void => {
    // Let clicks on the input (and text selection) through; a click on the
    // empty scrollback focuses the prompt.
    if ((event.target as HTMLElement).tagName !== 'INPUT') inputRef.current?.focus()
  }, [])

  return (
    <div className={css.terminal}>
      <div className={css.terminalBar}>
        <span className={css.terminalCwd} title={cwd === '' ? t('cwdDefault') : cwd}>
          {cwd === '' ? t('cwdDefault') : cwd}
        </span>
        <button className={css.terminalReset} onClick={session.reset} title={t('reset')}>↻</button>
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
            aria-label={t('input')}
            disabled={status !== 'open'}
          />
        </div>
      </div>
      {status !== 'open' && (
        <div className={css.terminalStatus}>
          {status === 'connecting' ? t('connecting') : `${t('disconnected')} `}
          {status === 'closed' && (
            <button className={css.termReconnect} onClick={session.reset}>{t('reconnect')}</button>
          )}
        </div>
      )}
    </div>
  )
}
