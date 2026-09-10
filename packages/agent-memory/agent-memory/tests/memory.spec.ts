import { describe, expect, it } from 'vitest'
import { agentKey, agentPrefix, nodeKey, refOf, summarize, truncate, renderNode, renderMemoryIndex } from '../src/memory.ts'
import { memoryDomain } from '../src/spec.ts'
import { UNIT_NAME_RE } from '@deepseek-ai/dsh-storage'
import type { MemoryNode } from '../src/spec.ts'

describe('summarize', () => {
  it('flattens whitespace', () => {
    expect(summarize('a\n  b\tc', 100)).toBe('a b c')
  })
  it('keeps short text verbatim', () => {
    expect(summarize('short note', 20)).toBe('short note')
  })
  it('head/tail truncates long text with a marker', () => {
    const out = summarize('x'.repeat(100), 20)
    expect(out.length).toBeLessThanOrEqual(22)
    expect(out).toContain('…')
    expect(out.startsWith('x')).toBe(true)
  })
})

describe('truncate', () => {
  it('passes through short text', () => {
    expect(truncate('abc', 10)).toBe('abc')
  })
  it('hard-cuts long text (no marker)', () => {
    expect(truncate('abcdef', 3)).toBe('abc')
  })
})

describe('refOf', () => {
  it('is deterministic', () => {
    expect(refOf('note', 'src', 'hello')).toBe(refOf('note', 'src', 'hello'))
  })
  it('is 16 chars', () => {
    expect(refOf('note', 'src', 'hello')).toHaveLength(16)
  })
  it('differs by kind/source/full', () => {
    const base = refOf('note', 'src', 'hello')
    expect(refOf('tool-result', 'src', 'hello')).not.toBe(base)
    expect(refOf('note', 'other', 'hello')).not.toBe(base)
    expect(refOf('note', 'src', 'world')).not.toBe(base)
  })
})

describe('agent memory domain', () => {
  it('names the domain with a valid backend unit name', () => {
    // The domain name doubles as the backend unit name, so a name outside
    // UNIT_NAME_RE rejects at `defineDomain` — i.e. at plugin mount, which is
    // boot. `agent-memory` (hyphen) failed exactly here.
    expect(memoryDomain.name).toMatch(UNIT_NAME_RE)
    expect(memoryDomain.name).toBe('agent_memory')
  })

  it('declares every table name within UNIT_NAME_RE', () => {
    for (const table of Object.keys(memoryDomain.tables)) expect(table).toMatch(UNIT_NAME_RE)
  })
})

describe('agentKey / agentPrefix / nodeKey', () => {
  // The `per-record` layout turns a record key into a file name; this is the
  // backend's own path-safe key alphabet.
  const PATH_SAFE_KEY = /^[a-zA-Z0-9_-]+$/

  it('keys are stable and scoped per agent', () => {
    const a = nodeKey('agent-a', 7)
    const b = nodeKey('agent-a', 8)
    const c = nodeKey('agent-b', 7)
    expect(a).not.toBe(b)
    expect(a).not.toBe(c)
    expect(a.startsWith(agentPrefix('agent-a'))).toBe(true)
    expect(c.startsWith(agentPrefix('agent-b'))).toBe(true)
  })

  it('folds an id carrying path-unsafe characters into a path-safe key', () => {
    // A real agent id can be a dotted / slashed identifier; the raw form is not
    // a path segment and would reject the write.
    const raw = 'session.7f3a/agent:0'
    expect(raw).not.toMatch(PATH_SAFE_KEY)
    expect(agentKey(raw)).toMatch(PATH_SAFE_KEY)
    expect(nodeKey(raw, 1)).toMatch(PATH_SAFE_KEY)
  })

  it('keeps ids that fold alike distinct', () => {
    expect(agentKey('a.b')).not.toBe(agentKey('a/b'))
    expect(agentKey('a-b')).not.toBe(agentKey('a_b'))
  })

  it('never lets one agent prefix overlap another', () => {
    // A separator inside the folded alphabet would let `x` swallow `x_y`.
    for (const [left, right] of [['x', 'x_y'], ['a-b', 'a_b']] as const) {
      expect(nodeKey(right, 1).startsWith(agentPrefix(left))).toBe(false)
      expect(nodeKey(left, 1).startsWith(agentPrefix(right))).toBe(false)
    }
  })

  it('is deterministic', () => {
    expect(agentKey('agent-a')).toBe(agentKey('agent-a'))
  })
})

describe('renderNode / renderMemoryIndex', () => {
  const node: MemoryNode = {
    kind: 'note',
    text: 'summary text',
    full: 'the full evidence',
    ref: 'abcd1234abcd1234',
    source: 'memory_add',
    seq: 1,
    ts: 123,
  }
  it('renders a compact one-line node with ref', () => {
    expect(renderNode(node)).toBe('[note:abcd1234abcd1234] memory_add: summary text')
  })
  it('empty index renders empty string', () => {
    expect(renderMemoryIndex([])).toBe('')
  })
  it('index renders header + newest-first lines', () => {
    const text = renderMemoryIndex([node])
    expect(text).toContain('memory index')
    expect(text).toContain(renderNode(node))
  })
})
