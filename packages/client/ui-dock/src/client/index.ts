/**
 * Browser half of the dock: mounts the right-side dock into a PRIVATE React
 * root appended to the document body — the same self-contained overlay pattern
 * ui-effects uses — so it needs no slot wiring and rides no other package's
 * layout. It talks straight to the sidebar-bridge endpoints over same-origin
 * HTTP + WebSocket.
 * @module @deepseek-ai/dsh-client-ui-dock/client
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the session plugin's Context merge (ctx.sessions).
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { Dock } from './Dock.tsx'
import type { ActiveChat } from './Dock.tsx'

/** Fixed dock mount id, stable across re-activations. */
const ROOT_ID = 'dsh-ui-dock-root'

/**
 * Services the dock reads. `sessions` gates access to `ctx.sessions` (the
 * current chat + its cwd for the terminal); cordis throws on an un-injected
 * property, so this list is what makes that read legal.
 */
export const inject = ['sessions']

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
 * Mount the dock overlay root for this activation's lifetime.
 * @param ctx - client context (its effect lifetime and sessions service).
 */
export function apply(ctx: ClientContext): void {
  const activeChat = activeChatStore(ctx)
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
