import { describe, expect, it } from 'vitest'
import { parseRlmDump, renderRlmContext, type ResolvedConfig } from '../src/index.ts'

const cfg: ResolvedConfig = { disabled: false, ownerAgentId: undefined, maxAnswerChars: 4000, maxBindChars: 2000 }

describe('parseRlmDump', () => {
  it('parses a marker line and ignores surrounding output', () => {
    const out = 'foo\n__KILN_RLM_STATE__ {"answer":{"content":"hi","ready":true},"binds":{"x":42}}\nbar'
    expect(parseRlmDump(out)).toEqual({ answer: { content: 'hi', ready: true }, binds: { x: 42 } })
  })

  it('returns undefined when no marker is present', () => {
    expect(parseRlmDump('no marker here')).toBeUndefined()
  })

  it('coerces a non-string answer content to empty', () => {
    expect(parseRlmDump('__KILN_RLM_STATE__ {"answer":{"content":123,"ready":false},"binds":{}}'))
      .toEqual({ answer: { content: '', ready: false }, binds: {} })
  })
})

describe('renderRlmContext', () => {
  it('renders binds and answer', () => {
    const snapshot = { answer: { content: 'final', ready: true }, binds: { x: 42, name: 'n' } }
    const text = renderRlmContext(snapshot, cfg)
    expect(text).toContain('x = 42')
    expect(text).toContain('answer (ready): final')
  })

  it('returns empty string when nothing to contribute', () => {
    expect(renderRlmContext({ answer: { content: '', ready: false }, binds: {} }, cfg)).toBe('')
  })
})
