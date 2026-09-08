/**
 * Browser half of the dock: mounts the right-side dock into a PRIVATE React
 * root appended to the document body — the same self-contained overlay pattern
 * ui-effects uses — so the drawer needs no slot wiring. It also contributes two
 * conversation-header utilities through the slot system: a sidebar toggle and a
 * three-dot overflow menu that re-hosts the Session-log download.
 * @module @deepseek-ai/dsh-client-ui-dock/client
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the session plugin's Context merge (ctx.sessions) and the
// SessionStandardProps seat that gives header slots their sessionId.
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
// Type-only: makes ctx.slots legal for our header registrations.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: makes ctx.locale legal for our header dictionary.
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: declares the conversation header slot key + its SlotMap entry.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { Dock } from './Dock.tsx'
import type { ActiveChat } from './Dock.tsx'
import { DockMenuHeaderAction, DockToggleHeaderAction } from './header-actions.tsx'
import { en, zh } from './header-locales.ts'

/** Fixed dock mount id, stable across re-activations. */
const ROOT_ID = 'dsh-ui-dock-root'

/**
 * Services the dock reads. `sessions` gates access to `ctx.sessions` (the
 * current chat + its cwd for the terminal); `slots` and `locale` gate the two
 * conversation-header contributions. Cordis throws on an un-injected property,
 * so this list is what makes those reads legal.
 */
export const inject = ['sessions', 'slots', 'locale']

/**
 * Adapt the sessions list into a stable `{id, cwd}` source for the dock's
 * terminal. The same object reference is returned until the current chat or its
 * cwd actually changes, which keeps `useSyncExternalStore` from looping.
 * @param ctx - client context carrying the sessions service.
 */
function activeChatStore(ctx: ClientContext): ActiveChat {
  const sessions = ctx.sessions
  let cache = { id: '', cwd: '' }
  return {
    get: () => {
      const snap = sessions.list.getSnapshot()
      const id = snap.current ?? ''
      const cwd = id === '' ? '' : (snap.byId[id]?.cwd ?? '')
      if (id !== cache.id || cwd !== cache.cwd) cache = { id, cwd }
      return cache
    },
    subscribe: fn => sessions.list.subscribe(fn),
  }
}

/**
 * Mount the dock overlay root and the two header slots for this activation's
 * lifetime.
 * @param ctx - client context (its effect lifetime, sessions, slots, and locale).
 */
export function apply(ctx: ClientContext): void {
  const activeChat = activeChatStore(ctx)

  // Locale dictionary for the header buttons (the slot renderer binds it).
  ctx.effect(() => ctx.locale.register('dsh-client-ui-dock-header', { zh, en }), 'ui-dock: header dictionaries')

  // Sidebar toggle capsule, first in the header utilities list.
  ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
    name: 'conversation.session.header.utilities',
    id: 'dock-toggle',
    order: 0,
    locale: 'dsh-client-ui-dock-header',
  }, DockToggleHeaderAction))

  // Three-dot overflow menu. Same list cell id as upstream's session-log
  // capsule at a LOWER priority (lower renders), so our menu wins that cell
  // and hosts the download through the shared `/api/session.export` route.
  ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
    name: 'conversation.session.header.utilities',
    id: 'session-log-download',
    priority: -10,
    order: 10,
    locale: 'dsh-client-ui-dock-header',
  }, DockMenuHeaderAction))

  // The drawer overlay itself remains a private root with no slot wiring.
  ctx.effect(() => {
    let host = document.getElementById(ROOT_ID)
    if (host === null) {
      host = document.createElement('div')
      host.id = ROOT_ID
      document.body.append(host)
    }
    const root = createRoot(host)
    root.render(createElement(Dock, { activeChat }))
    const mounted = host
    return () => {
      root.unmount()
      mounted.remove()
    }
  }, 'ui-dock: dock root')
}
