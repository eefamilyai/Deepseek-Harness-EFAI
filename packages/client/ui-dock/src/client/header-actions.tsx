/**
 * Conversation-header slots contributed by the dock: a persistent sidebar
 * toggle plus a three-dot overflow menu that re-hosts the Session-log download
 * (shadowing the upstream standalone capsule at a lower list-cell priority)
 * alongside a few dock-centric actions so the overflow is warranted.
 * @module @deepseek-ai/dsh-client-ui-dock/client/header-actions
 */

import { useState } from 'react'
import type { ReactNode } from 'react'
import {
  IconBrowseOutline16,
  IconCopyOutline16,
  IconDownloadOutline16,
  IconEllipsisOutline16,
  IconPanelLeftOutline16,
  IconCodeOutline16,
  Menu,
  writeClipboard,
  type MenuEntry,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime, SessionIdOf } from '@deepseek-ai/dsh-client-ui-slots'
import { openDockTab, toggleDock } from './dock-events.ts'
import { NS } from './header-locales.ts'
import css from './header.module.css'

/** Shared header runtime + locale share for both slot components. */
type HeaderProps = PropsRuntime<'conversation.session.header.utilities'> & PropsLocale<typeof NS>

/** Start the Host-owned Session-log ZIP download in the browser download manager. */
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
 * The sidebar toggle: opens/closes the dock drawer without leaving the chat.
 * @returns a header capsule button.
 */
export function DockToggleHeaderAction({ t }: HeaderProps): ReactNode {
  return (
    <button
      type="button"
      className={css.toggleButton}
      onClick={toggleDock}
      title={t('toggle.title')}
      aria-label={t('toggle.title')}
    >
      <IconPanelLeftOutline16 />
    </button>
  )
}

/**
 * The three-dot overflow menu for the Session header utilities area. It shadows
 * the upstream Session-log capsule (same list cell id, lower priority) so the
 * download appears here instead of as a standalone button, alongside a few
 * dock-oriented actions.
 * @returns a portaled anchored menu and its trigger button.
 */
export function DockMenuHeaderAction({ sessionId, t }: HeaderProps): ReactNode {
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
      id: 'open-browser',
      label: t('menu.openBrowser'),
      icon: <IconBrowseOutline16 size={16} />,
    },
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
    } else if (id === 'open-browser') {
      openDockTab('browser')
    } else if (id === 'open-terminal') {
      openDockTab('terminal')
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
