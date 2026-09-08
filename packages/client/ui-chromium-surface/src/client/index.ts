/**
 * Browser half of the chromium-surface plugin: mounts a self-contained
 * Chromium-style pane into a private React root appended to the document body.
 *
 * The pane talks straight to the host's `/chromium` endpoints — it never goes
 * through the agent's browser tool or the dock's shared browser, so this
 * surface has its own session, tabs, and per-tab history.
 * @module @deepseek-ai/dsh-client-ui-chromium-surface/client
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { ChromiumSurface } from './ChromiumSurface.tsx'

/** Fixed mount id, stable across re-activations. */
const ROOT_ID = 'dsh-ui-chromium-surface-root'

/** The surface reads no Cordis services: the endpoints are plain HTTP/WS. */
export const inject: string[] = []

/**
 * Mount the private overlay root for this activation's lifetime.
 * @param ctx - client context (its effect lifetime is the teardown boundary).
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => {
    let host = document.getElementById(ROOT_ID)
    if (host === null) {
      host = document.createElement('div')
      host.id = ROOT_ID
      document.body.append(host)
    }
    const root = createRoot(host)
    root.render(createElement(ChromiumSurface))
    const mounted = host
    return () => {
      root.unmount()
      mounted.remove()
    }
  }, 'ui-chromium-surface: surface root')
}
