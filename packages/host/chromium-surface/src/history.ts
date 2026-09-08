/**
 * Per-tab navigation history: a small reducer over a back/forward stack.
 *
 * Purely functional — no browser types — so the navigation semantics are
 * unit-testable without launching Chromium. The live surface applies each
 * transition to a Playwright Page after updating the model, so the model
 * always mirrors the page the user asked to visit.
 *
 * @module @deepseek-ai/dsh-host-chromium-surface/history
 */

/** One entry in a tab's navigation stack. */
export interface HistoryEntry {
  /** Absolute URL after the navigation resolved. */
  readonly url: string
  /** Document title at the time the entry was recorded. */
  readonly title: string
}

/** The reduction state a single tab keeps. */
export interface TabHistory {
  /** Entries strictly before the current one (most recent last). */
  readonly back: readonly HistoryEntry[]
  /** The entry the tab is showing right now. */
  readonly current: HistoryEntry | null
  /** Entries strictly after the current one (nearest first). */
  readonly forward: readonly HistoryEntry[]
}

/** An empty tab that has not navigated anywhere. */
export const EMPTY_HISTORY: TabHistory = { back: [], current: null, forward: [] }

/** Record a fresh navigation: append it, truncating any forward entries. */
export function pushNavigation(history: TabHistory, entry: HistoryEntry): TabHistory {
  return { back: [...history.back, ...(history.current === null ? [] : [history.current])], current: entry, forward: [] }
}

/** Navigate backward one entry, or return the history unchanged at the oldest entry. */
export function goBack(history: TabHistory): TabHistory {
  const previous = history.back.at(-1)
  if (previous === undefined) return history
  return {
    back: history.back.slice(0, -1),
    current: previous,
    forward: [...(history.current === null ? [] : [history.current]), ...history.forward],
  }
}

/** Navigate forward one entry, or return the history unchanged at the newest entry. */
export function goForward(history: TabHistory): TabHistory {
  const next = history.forward[0]
  if (next === undefined) return history
  return {
    back: [...history.back, ...(history.current === null ? [] : [history.current])],
    current: next,
    forward: history.forward.slice(1),
  }
}
