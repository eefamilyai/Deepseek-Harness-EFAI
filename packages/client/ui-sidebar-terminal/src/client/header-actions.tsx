/**
 * The conversation header's more-actions menu, carried over from the retired
 * dock's header contribution.
 *
 * The dock owned this cell (`session-log-download`, shadowing the shipped
 * standalone capsule at a lower list-cell priority) so the Session-log download
 * and a dock-centric Terminal entry shared one overflow. The dock itself is
 * gone; the menu stays, and its Terminal entry is now a navigation: it opens
 * this package's own `terminal` tab in the right Sidebar instead of opening a
 * drawer that no longer exists.
 *
 * The toggle button that used to sit beside it was the dock's way into its
 * drawer. There is no drawer any more — the right Sidebar is the one panel —
 * so the button is deliberately not re-homed.
 * @module @deepseek-ai/dsh-client-ui-sidebar-terminal/client/header-actions
 */

import { useState } from 'react'
import type { ReactNode } from 'react'
import {
  IconCodeOutline16,
  IconCopyOutline16,
  IconDownloadOutline16,
  IconEllipsisOutline16,
  Menu,
  writeClipboard,
  type MenuEntry,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime, SessionIdOf } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import css from './header.module.css'

/** Business face the plugin hands the menu: opening this package's tab. */
export interface TerminalMenuInjected {
  /** Open (or reveal) the `terminal` tab in the right Sidebar. */
  openTerminal: () => void
}

/** The menu's composed props: session runtime, its copy, and its actions. */
export type TerminalMenuProps =
  & PropsRuntime<'conversation.session.header.utilities'>
  & PropsLocale<'sidebarTerminal'>
  & InjectFace<TerminalMenuInjected>

/**
 * Start the Session-log ZIP download in the browser download manager.
 *
 * The Host endpoint is the one the shipped download command streams from; the
 * anchor is handed the same URL, so the browser owns the transfer and its
 * progress UI.
 * @param sessionId - the Session whose tree is exported.
 */
function downloadSessionLog(sessionId: SessionIdOf): void {
  const origin = (globalThis as { location?: { origin?: string } }).location?.origin
  const base = origin !== undefined && origin !== 'null' ? origin : 'http://dsh.internal'
  const url = new URL('/api/session.export', base)
  url.searchParams.set('sessionId', String(sessionId))
  url.searchParams.set('includeDescendants', 'true')
  const anchor = document.createElement('a')
  anchor.href = url.toString()
  anchor.download = `dsh-session-${String(sessionId).replace(/[^A-Za-z0-9_-]/g, '_')}.zip`
  anchor.click()
}

/**
 * The three-dot overflow menu for the Session header utilities area.
 * @param props - the session, its copy, and the injected tab opener.
 * @returns a portaled anchored menu and its trigger button.
 */
export function TerminalMenuHeaderAction({ sessionId, openTerminal, t }: TerminalMenuProps): ReactNode {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const items: readonly MenuEntry[] = [
    {
      id: 'session-log',
      label: t('menu.sessionLog'),
      icon: <IconDownloadOutline16 size={16} />,
      disabled: busy,
    },
    {
      id: 'copy-session-id',
      label: t('menu.copySessionId'),
      icon: <IconCopyOutline16 size={16} />,
    },
    { type: 'separator', id: 'sep' },
    {
      id: 'open-terminal',
      label: t('menu.openTerminal'),
      icon: <IconCodeOutline16 size={16} />,
    },
  ]

  const handle = (id: string): void => {
    setOpen(false)
    if (id === 'session-log') {
      setBusy(true)
      setError(null)
      try {
        downloadSessionLog(sessionId)
      } catch (cause: unknown) {
        setError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        setBusy(false)
      }
    } else if (id === 'copy-session-id') {
      void writeClipboard(String(sessionId))
    } else if (id === 'open-terminal') {
      openTerminal()
    }
  }

  return (
    <Menu
      open={open}
      portal
      align="end"
      side="bottom"
      onClose={() => { setOpen(false) }}
      onSelect={handle}
      items={items}
      anchor={
        <button
          type="button"
          className={css.menuButton}
          onClick={() => { setOpen(value => !value) }}
          aria-label={t('menu.title')}
          aria-haspopup="menu"
          aria-expanded={open}
          title={error ?? t('menu.title')}
        >
          <IconEllipsisOutline16 />
        </button>
      }
    />
  )
}
