/**
 * Window custom events bridging the dock overlay to the conversation header
 * slot buttons (the dock's private React root and the slot tree share no
 * React parent, so a tiny same-origin event bus carries the open intent).
 * @module @deepseek-ai/dsh-client-ui-dock/client/dock-events
 */

/** Toggle the dock drawer open/closed. */
export const DOCK_TOGGLE_EVENT = 'dsh:dock-toggle'

/** Open the dock drawer, without toggling it closed when already open. */
export const DOCK_OPEN_EVENT = 'dsh:dock-open'

/** Ask the dock to toggle. */
export function toggleDock(): void {
  window.dispatchEvent(new CustomEvent(DOCK_TOGGLE_EVENT))
}

/** Ask the dock to open. */
export function openDock(): void {
  window.dispatchEvent(new CustomEvent(DOCK_OPEN_EVENT))
}
