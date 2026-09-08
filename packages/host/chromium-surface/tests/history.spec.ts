/**
 * Pure host tests: navigation-history semantics and snapshot formatting.
 * No Chromium launch — the reducer and the string formatter are what carry the
 * "persistent tabs + per-tab history" contract.
 */
import { describe, expect, it } from 'vitest'
import { EMPTY_HISTORY, goBack, goForward, pushNavigation } from '../src/history.ts'
import { formatSnapshot, type RawSnapshot } from '../src/page-script.ts'

describe('tab history', () => {
  it('records forward navigation and truncates any forward tail', () => {
    let h = EMPTY_HISTORY
    h = pushNavigation(h, { url: 'https://a.example/', title: 'A' })
    h = pushNavigation(h, { url: 'https://b.example/', title: 'B' })
    expect(h.back.map(e => e.url)).toEqual(['https://a.example/'])
    expect(h.current?.url).toBe('https://b.example/')

    h = goBack(h)
    expect(h.current?.url).toBe('https://a.example/')
    expect(h.forward.map(e => e.url)).toEqual(['https://b.example/'])

    // A fresh navigation from the back position drops the forward tail.
    h = pushNavigation(h, { url: 'https://c.example/', title: 'C' })
    expect(h.forward).toEqual([])
    expect(h.current?.url).toBe('https://c.example/')
  })

  it('back and forward are no-ops at the stack edges', () => {
    const one = pushNavigation(EMPTY_HISTORY, { url: 'https://only.example/', title: 'Only' })
    expect(goBack(one)).toBe(one)
    expect(goForward(one)).toBe(one)
    expect(goBack(EMPTY_HISTORY)).toBe(EMPTY_HISTORY)
  })

  it('keeps every entry title, not just the url', () => {
    const h = pushNavigation(EMPTY_HISTORY, { url: 'https://x.example/', title: 'Landing page' })
    expect(h.current?.title).toBe('Landing page')
    expect(h.current?.url).toBe('https://x.example/')
  })
})

describe('snapshot formatting', () => {
  it('renders title, url, text, and numbered interactive refs', () => {
    const snap: RawSnapshot = {
      title: 'Example',
      url: 'https://example.test/',
      text: 'Hello page',
      elements: [
        { ref: 1, tag: 'a', role: 'link', name: 'Home' },
        { ref: 2, tag: 'input', role: 'textbox', name: 'q', type: 'text', value: 'prefill' },
      ],
    }
    const out = formatSnapshot(snap)
    expect(out).toContain('# Example')
    expect(out).toContain('URL: https://example.test/')
    expect(out).toContain('Hello page')
    expect(out).toContain('[1] link: Home')
    expect(out).toContain('[2] textbox text: q = "prefill"')
  })

  it('reports an empty page without inventing refs', () => {
    const out = formatSnapshot({ title: '', url: 'https://e.test/', text: '', elements: [] })
    expect(out).toContain('(no interactive elements found on this page)')
  })
})
