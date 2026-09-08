/**
 * Pure client tests: presentation helpers over the host's wire shapes.
 * No React and no live browser — these are the tab/history ordering rules the
 * surface renders from.
 */
import { describe, expect, it } from 'vitest'
import { EMPTY_STATE, activeTab, canGoBack, canGoForward, orderedTabIds, tabLabel, tabUrl } from '../src/client/model.ts'
import type { ChromiumState } from '../src/client/model.ts'

function state(over: Partial<ChromiumState>): ChromiumState {
  return { tabs: [], activeTabId: null, ...over }
}

describe('chromium surface model', () => {
  it('returns null active tab when nothing is open', () => {
    expect(activeTab(EMPTY_STATE)).toBeNull()
    expect(orderedTabIds(EMPTY_STATE)).toEqual([])
  })

  it('orders the active tab first in the strip without reordering the host list', () => {
    const s = state({
      tabs: [
        { id: 1, active: false, title: 'A', url: 'https://a/', history: { back: [], current: null, forward: [] } },
        { id: 2, active: true, title: 'B', url: 'https://b/', history: { back: [], current: null, forward: [] } },
        { id: 3, active: false, title: 'C', url: 'https://c/', history: { back: [], current: null, forward: [] } },
      ],
      activeTabId: 2,
    })
    expect(orderedTabIds(s)).toEqual([2, 1, 3])
  })

  it('derives back/forward affordances from the active tab history', () => {
    const s = state({
      tabs: [{
        id: 1, active: true, title: 'X', url: 'https://x/',
        history: {
          back: [{ url: 'https://a/', title: 'A' }],
          current: { url: 'https://b/', title: 'B' },
          forward: [],
        },
      }],
      activeTabId: 1,
    })
    expect(canGoBack(s)).toBe(true)
    expect(canGoForward(s)).toBe(false)
  })

  it('labels a tab by title, then url, then id', () => {
    const withTitle = { id: 1, active: true, title: 'Welcome', url: 'https://w/', history: { back: [], current: null, forward: [] } }
    const withUrl = { id: 2, active: false, title: '', url: 'https://u/', history: { back: [], current: null, forward: [] } }
    const bare = { id: 3, active: false, title: '', url: '', history: { back: [], current: null, forward: [] } }
    expect(tabLabel(withTitle)).toBe('Welcome')
    expect(tabLabel(withUrl)).toBe('https://u/')
    expect(tabLabel(bare)).toBe('Tab 3')
    expect(tabUrl(activeTab(state({ tabs: [withTitle], activeTabId: 1 })))).toBe('https://w/')
  })
})
