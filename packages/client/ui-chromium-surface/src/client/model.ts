/**
 * Pure presentation helpers for the surface, kept separate so they test without
 * React or a live browser.
 * @module @deepseek-ai/dsh-client-ui-chromium-surface/client/model
 */

import { type ChromiumState, activeTab } from './types.ts'

export { EMPTY_STATE, activeTab, tabLabel, tabUrl } from './types.ts'
export type {
  ChromiumActResult, ChromiumAction, ChromiumState, ChromiumTab, HistoryEntry, TabHistory,
} from './types.ts'

/**
 * The ordered set of tab ids in the strip, active tab first so the visible one
 * always leads the list without changing the underlying host order.
 */
export function orderedTabIds(state: ChromiumState): number[] {
  const active = state.activeTabId
  const ids = state.tabs.map(tab => tab.id)
  if (active === null) return ids
  return [active, ...ids.filter(id => id !== active)]
}

/** Whether the active tab has any backward history to step into. */
export function canGoBack(state: ChromiumState): boolean {
  const tab = activeTab(state)
  return tab !== null && tab.history.back.length > 0
}

/** Whether the active tab has any forward history to step into. */
export function canGoForward(state: ChromiumState): boolean {
  const tab = activeTab(state)
  return tab !== null && tab.history.forward.length > 0
}
