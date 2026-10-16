/**
 * The Desktop window's half of the agent browser: it carries the agent's pages and
 * shows them in the right sidebar.
 *
 * In the Desktop renderer this plugin subscribes to the Host's `agentBrowser` command
 * stream, performs every operation on the agent page it keeps for that Session, and
 * registers the **AI Browser** sidebar tab that lays the page over its viewport. The
 * tab opens itself when the operator expands the sidebar of a conversation whose agent
 * has used the browser since the operator last looked, and while the sidebar is already
 * open whenever the agent opens a page. Outside the Desktop renderer there is no
 * webview to drive, so the plugin stays out of the way and the Host keeps its headless
 * browser.
 *
 * @module @deepseek-ai/dsh-web-browser-sidebar/client
 */

import type { Context } from '@deepseek-ai/cordis'
// Type-only: the Client `remote` service and this package's generated namespace.
import type {} from '@deepseek-ai/dsh-api-gateway/client'
import type {} from '@deepseek-ai/dsh-api-workspace-controller/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import contribution from '@deepseek-ai/dsh-web-browser-sidebar/remote'
import { GuideArtworkBrowser } from '@deepseek-ai/dsh-client-ui-primitives'
import type { AgentBrowserRequest } from '../types.ts'
import { AgentBrowserBody, AgentBrowserTitle, type AgentBrowserInjected } from './AgentBrowserBody.tsx'
import { en, zh } from './locales.ts'
import { AgentPages, type GuestBridge } from './pages.ts'

export type {} from '@deepseek-ai/dsh-web-browser-sidebar/remote'
export type { AgentBrowserBodyProps, AgentBrowserInjected, AgentBrowserTitleProps } from './AgentBrowserBody.tsx'
export type { AgentTabState } from './pages.ts'
export type { AgentBrowserKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-sidebar-right/client' {
  interface SidebarRightTabParamsMap {
    /** The AI Browser page takes no parameters: it shows its conversation's agent page. */
    'agent-browser': Record<string, never>
  }
}

/** The tab kind `openTab` names. */
const KIND = 'agent-browser'

/** The tab implementation's identity, and the key its body and title register under. */
const TAB_ID = '@deepseek-ai/dsh-web-browser-sidebar'

/** The locale namespace this tab registers its copy under. */
const NAMESPACE = 'agentBrowser'

/** Milliseconds between two checks of whether the operator expanded the sidebar. */
const EXPANSION_POLL_MS = 400

/** Services this plugin reads. */
export const inject = ['remote', 'slots', 'locale', 'sidebarRight', 'sidebarRightTabs']

/** The Desktop preload's browser bridge, when this renderer has one. */
function desktopBridge(): GuestBridge | undefined {
  const carrier = (globalThis as typeof globalThis & {
    dshDesktop?: { readonly protocolVersion: number; readonly browser?: GuestBridge }
  }).dshDesktop
  return carrier?.protocolVersion === 1 ? carrier.browser : undefined
}

/**
 * Mount the namespace and, in the Desktop renderer, carry and show the agent's pages.
 * @param ctx - Client plugin context.
 */
export async function apply(ctx: Context): Promise<void> {
  await ctx.remote.$mount(contribution)
  const bridge = desktopBridge()
  if (bridge === undefined) return
  // The namespace mounted above is a service of its own; this scope waits for it.
  ctx.inject(['remote.agentBrowser'], (scope) => { carryPages(scope, bridge) })
}

/**
 * Carry the agent's pages in this window and show them in the sidebar.
 * @param ctx - a scope holding the mounted `remote.agentBrowser` namespace.
 * @param bridge - the Desktop preload's guest operations.
 */
function carryPages(ctx: Context, bridge: GuestBridge): void {
  ctx.effect(() => ctx.locale.register(NAMESPACE, { zh, en }), 'web-browser-sidebar: dictionaries')
  const t = ctx.locale.bind(NAMESPACE)

  /** Conversations whose agent used the browser since the operator last saw their tab. */
  const unseen = new Set<string>()
  const reveal = (sessionId: string): void => {
    if (ctx.sidebarRight.mounted.getSnapshot() !== sessionId || !ctx.sidebarRight.isExpanded()) return
    unseen.delete(sessionId)
    ctx.sidebarRight.openTab(KIND)
  }

  const pages = new AgentPages({
    bridge,
    document,
    workspace: (sessionId) => {
      const snapshot = ctx.get('workspaces')?.list.getSnapshot()
      const owner = snapshot?.phase === 'ready' ? snapshot.items.find(item => item.sessionIds.some(id => id === sessionId)) : undefined
      // The key the sidebar Browser uses, so the agent's pages share its cookies and logins.
      return owner === undefined ? `session:${sessionId}` : `cwd:${owner.path}`
    },
    activity: (sessionId, op) => {
      unseen.add(sessionId)
      if (op === 'navigate') reveal(sessionId)
    },
  })
  ctx.effect(() => () => pages.dispose(), 'web-browser-sidebar: pages')

  // The column cannot be observed for expansion, so a short poll notices the moment the
  // operator opens the sidebar of a conversation with unseen agent activity.
  ctx.effect(() => {
    const timer = setInterval(() => {
      const sessionId = ctx.sidebarRight.mounted.getSnapshot()
      if (sessionId !== undefined && unseen.has(sessionId)) reveal(sessionId)
    }, EXPANSION_POLL_MS)
    return () => { clearInterval(timer) }
  }, 'web-browser-sidebar: reveal')

  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: TAB_ID,
    kind: KIND,
    keepMounted: true,
    title: () => t('type.label'),
    guide: [{ id: 'open', order: 31, title: () => t('guide.title'), description: () => t('guide.description'), icon: GuideArtworkBrowser }],
  }), 'web-browser-sidebar: type')

  const injected = (sessionId: string): AgentBrowserInjected => ({
    hooks: { agentPage: pages.tabState(sessionId) },
    attach: (viewportId) => {
      const viewport = document.getElementById(viewportId)
      if (viewport === null) return () => {}
      unseen.delete(sessionId)
      return pages.attach(sessionId, viewport)
    },
    load: (url) => { pages.load(sessionId, url) },
    command: (command) => { pages.command(sessionId, command) },
  })
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab', key: TAB_ID, locale: NAMESPACE, inject: injected,
  }, AgentBrowserBody)), 'web-browser-sidebar: body')
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab.title', key: TAB_ID, locale: NAMESPACE, inject: injected,
  }, AgentBrowserTitle)), 'web-browser-sidebar: title')

  const stream = ctx.remote.$stream<AgentBrowserRequest>({
    name: 'agentBrowser',
    open: signal => ctx.remote.agentBrowser.commands(signal),
    ended: () => new Error('agent browser command stream ended'),
  })
  let disposed = false
  ctx.effect(() => () => { disposed = true; return stream.dispose() }, 'web-browser-sidebar: command stream')
  void (async () => {
    for await (const frame of stream) {
      frame.accept()
      const request = frame.value
      if (request.op === 'hello') continue
      void pages.perform(request).then(reply => ctx.remote.agentBrowser.respond(reply)).catch((error: unknown) => {
        // The reply could not be delivered; the Host fails the operation at its deadline.
        console.error('agent browser reply failed', error)
      })
    }
  })().catch((error: unknown) => {
    if (!disposed) console.error('agent browser command stream failed', error)
  })
}
