/**
 * Browser half: register `terminal` as a right-Sidebar tab type.
 *
 * The public two-stage path, unmodified: the type into `ctx.sidebarRightTabs`,
 * the body into the keyed `sidebar.right.pane.tab` seat and the chip label into
 * the keyed `sidebar.right.pane.tab.title` seat, both under the type's `id`.
 *
 * It also carries the conversation header's more-actions menu over from the
 * retired dock: the Session-log download and a Terminal entry that opens this
 * tab. The dock's drawer toggle is deliberately not re-homed — the right
 * Sidebar is the one panel.
 *
 * This module also owns the run-in-terminal bridge. `ui-primitives` is
 * cordis-free and must not import a tab package, so a chat code block's Run
 * button announces itself on a window CustomEvent; this plugin is the listener,
 * and it turns that announcement into a navigation — opening the terminal tab
 * with the code block as its `params`. The shell's own connection is keyed by
 * session inside `terminal-session.ts`, so it is deliberately not an effect here:
 * a tab switch must not tear down a working shell.
 * @module @deepseek-ai/dsh-client-ui-sidebar-terminal/client
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the session plugin's Context merge and the SessionStandardProps
// seat that gives the tab body its sessionId and session list.
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
// Type-only: makes ctx.slots legal for this registration.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: makes ctx.locale legal for this dictionary.
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: declares ctx.sidebarRightTabs / ctx.sidebarRight and their seats.
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
// Type-only: declares the conversation header utilities slot key + its SlotMap entry.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { RUN_IN_TERMINAL_EVENT } from '@deepseek-ai/dsh-client-ui-primitives'
import { TERMINAL_ID, TERMINAL_KIND, terminalDefinition } from './definition.tsx'
import { TerminalBody } from './TerminalBody.tsx'
import { TerminalTitle } from './TerminalTitle.tsx'
import { TerminalMenuHeaderAction, type TerminalMenuInjected } from './header-actions.tsx'
import { en, zh } from './locales.ts'
import { disposeAllTerminals } from './terminal-session.ts'
import './params.ts'

export type { SidebarTerminalKey } from './locales.ts'
export type { TerminalBodyProps } from './TerminalBody.tsx'
export type { TerminalSession, TerminalSnapshot, TerminalStatus } from './terminal-session.ts'
export { acquireTerminal, disposeAllTerminals } from './terminal-session.ts'

/** This package's copy namespace. */
const NS = 'sidebarTerminal'

/**
 * Required browser services: the tab registry, the keyed seats, and copy.
 * `sessions` is not listed because the slot framework resolves the session
 * itself for a session-scoped seat; the body reads it from its own props.
 */
export const inject = ['slots', 'locale', 'sidebarRightTabs', 'sidebarRight']

/**
 * Client plugin body: register the type, its dictionaries, its body and chip
 * label, and the run-in-terminal bridge.
 * @param ctx - client root context carrying the registry, the seats, and copy.
 */
export function apply(ctx: ClientContext): void {
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.sidebarRightTabs.register(terminalDefinition(t)), 'ui-sidebar-terminal: terminal type')
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-sidebar-terminal: dictionaries')

  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(
    { name: 'sidebar.right.pane.tab', key: TERMINAL_ID, locale: NS },
    TerminalBody,
  )), 'ui-sidebar-terminal: terminal tab body')
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register(
    { name: 'sidebar.right.pane.tab.title', key: TERMINAL_ID },
    TerminalTitle,
  )), 'ui-sidebar-terminal: terminal tab title')

  // The conversation header's more-actions menu, carried over from the dock.
  // Same list cell id as upstream's session-log capsule at a LOWER priority
  // (lower renders), so this menu wins that cell and hosts the download.
  ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
    name: 'conversation.session.header.utilities',
    id: 'session-log-download',
    priority: -10,
    order: 10,
    locale: NS,
    inject: (): TerminalMenuInjected => ({
      openTerminal: () => { ctx.sidebarRight.openTab(TERMINAL_KIND) },
    }),
  }, TerminalMenuHeaderAction))

  // The chat code fence's Run button. It carries no session: the tab opens in
  // whichever session is current, which is the chat the block was run from.
  // `nonce` is what makes running the same block twice two navigations, so the
  // body's submit effect fires on each one.
  let nonce = 0
  ctx.effect(() => {
    const onRun = (event: Event): void => {
      const code = (event as CustomEvent<string>).detail
      if (typeof code !== 'string' || code.trim() === '') return
      nonce += 1
      ctx.sidebarRight.openTab(TERMINAL_KIND, { params: { code, nonce } })
    }
    window.addEventListener(RUN_IN_TERMINAL_EVENT, onRun)
    return () => { window.removeEventListener(RUN_IN_TERMINAL_EVENT, onRun) }
  }, 'ui-sidebar-terminal: run-in-terminal bridge')

  // The per-session shells are module state; close them with the plugin so the
  // sockets do not outlive the package that opened them.
  ctx.effect(() => () => { disposeAllTerminals() }, 'ui-sidebar-terminal: shells')
}
