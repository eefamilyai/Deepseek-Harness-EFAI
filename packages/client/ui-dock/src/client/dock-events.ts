/**
 * Window custom events bridging the dock overlay to the conversation header
 * slot buttons (the dock's private React root and the slot tree share no
 * React parent, so a tiny same-origin event bus carries the open/tab intent).
 * @module @deepseek-ai/dsh-client-ui-dock/client/dock-events
 */

/** Dock drawer tabs, kept in one type so header buttons and the drawer agree. */
export type DockTab = 'browser' | 'terminal'

/** Toggle the dock drawer open/closed. */
export const DOCK_TOGGLE_EVENT = 'dsh:dock-toggle'

/** Open the dock drawer on a specific tab. */
export const DOCK_OPEN_TAB_EVENT = 'dsh:dock-open-tab'

/** Ask the dock to toggle. */
export function toggleDock(): void {
  window.dispatchEvent(new CustomEvent(DOCK_TOGGLE_EVENT))
}

/** Ask the dock to open on the given tab. */
export function openDockTab(tab: DockTab): void {
  window.dispatchEvent(new CustomEvent<DockTab>(DOCK_OPEN_TAB_EVENT, { detail: tab }))
}
