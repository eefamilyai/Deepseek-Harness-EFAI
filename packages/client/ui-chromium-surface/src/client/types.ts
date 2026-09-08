/**
 * Client-local mirror of the host's `/chromium` wire shapes. The host is the
 * source of truth; this module exists so the surface component can be typed
 * without importing the host package into the browser bundle.
 * @module @deepseek-ai/dsh-client-ui-chromium-surface/client/types
 */

/** One history entry as the host serializes it. */
export interface HistoryEntry {
  url: string
  title: string
}

/** A tab's history stack as the host serializes it. */
export interface TabHistory {
  back: HistoryEntry[]
  current: HistoryEntry | null
  forward: HistoryEntry[]
}

/** One tab as the host serializes it. */
export interface ChromiumTab {
  id: number
  active: boolean
  title: string
  url: string
  history: TabHistory
}

/** The whole session snapshot from GET /chromium/state. */
export interface ChromiumState {
  tabs: ChromiumTab[]
  activeTabId: number | null
}

/** What one POST /chromium/act can do. */
export type ChromiumAction =
  | 'navigate' | 'open' | 'close' | 'activate' | 'back' | 'forward'
  | 'reload' | 'read' | 'click' | 'type' | 'press' | 'scroll'

/** The success envelope from POST /chromium/act. */
export interface ChromiumActResult {
  ok: boolean
  state: ChromiumState
  text: string
  error?: string
}

/** The empty snapshot before the host has been asked for anything. */
export const EMPTY_STATE: ChromiumState = { tabs: [], activeTabId: null }

/** The single tab the surface should show, or null when nothing is open. */
export function activeTab(state: ChromiumState): ChromiumTab | null {
  if (state.activeTabId === null) return null
  return state.tabs.find(tab => tab.id === state.activeTabId) ?? null
}

/** A short, stable label for a tab strip entry. */
export function tabLabel(tab: ChromiumTab): string {
  if (tab.title.trim() !== '') return tab.title.trim()
  if (tab.url.trim() !== '') return tab.url.trim()
  return `Tab ${tab.id}`
}

/** The title shown in the address area for the current tab. */
export function tabUrl(tab: ChromiumTab | null): string {
  return tab === null ? '' : tab.url
}
