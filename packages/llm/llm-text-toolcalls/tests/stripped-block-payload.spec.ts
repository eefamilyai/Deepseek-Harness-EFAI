// A refused block whose closers the TRANSPORT removed must not spill its values.
//
// The reported leak: a session emits a complete call, the transport strips every
// argument closer, `unfinished()` reads the block as cut off mid-write, and the
// refusal path flushed the argument VALUES to the user as bare prose -- no tag
// left to explain them. `closeBlock` gated the payload strip on the envelope
// closer surviving; when it did not, the block fell back to the truncation rule
// and showed everything it carried.
//
// The discriminator is structural, not spelling: an element never nests, so a
// second argument opener PROVES the first argument closed. Two or more openers
// with no argument closer anywhere is a block written whole and damaged in
// flight -- a finished block, whose values are what the call would have run with.
// One argument cannot be told from a write that stopped, so it stays on the
// truncation path and its text is kept, which is the long-standing rule.
//
// Every tag is assembled from character codes. A spec that spells one as a single
// token cannot itself be embedded in a markup document without truncating it,
// which is the failure this reader exists to repair.

import { describe, expect, it } from 'vitest'
import type { ToolSchema } from '@deepseek-ai/dsh-llm'
import { DsmlTranslator, toolIndex } from '../src/index.ts'
import type { DsmlEvent } from '../src/index.ts'

const LT = String.fromCharCode(60)
const GT = String.fromCharCode(62)
const SL = String.fromCharCode(47)
const NL = String.fromCharCode(10)

const o = (name: string, attrs = ''): string => LT + name + (attrs ? ' ' + attrs : '') + GT
const c = (name: string): string => LT + SL + name + GT

const READ: ToolSchema = {
  name: 'read',
  description: 'Read a file.',
  parameters: {
    type: 'object',
    properties: {
      file_path: { type: 'string' },
      offset: { type: 'number' },
      limit: { type: 'number' },
    },
    required: ['file_path'],
  },
}
const KERNEL: ToolSchema = {
  name: 'kernel',
  description: 'Run Python.',
  parameters: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'] },
}
const TOOLS = toolIndex([READ, KERNEL])

const PATH = 'D:' + SL + 'x' + SL + 'ds_direct.py'

function run(text: string): { calls: DsmlEvent[]; shown: string } {
  const reader = new DsmlTranslator(TOOLS, { notes: true })
  const events = [...reader.push(text + NL), ...reader.end()]
  return {
    calls: events.filter(event => event.kind === 'tool-call'),
    shown: events
      .filter(event => event.kind === 'text')
      .map(event => (event as { text: string }).text)
      .join(''),
  }
}

describe('a stripped block drops its values instead of spilling them', () => {
  // Three arguments, every closer gone. The transport removed them; the block
  // itself was written whole, and the argument count proves it.
  const stripped = [
    o('tool_calls'),
    o('invoke', 'name="read"'),
    o('parameter', 'name="file_path"'),
    PATH,
    o('parameter', 'name="offset"'),
    '3338',
    o('parameter', 'name="limit"'),
    '40',
  ].join(NL)

  it('shows none of the values the call would have run with', () => {
    const { shown } = run(stripped)
    expect(shown).not.toContain(PATH)
    expect(shown).not.toContain('3338')
  })

  it('still names the mistake in words', () => {
    expect(run(stripped).shown).toContain('unfinished tool call')
  })

  it('shows no tag either', () => {
    const { shown } = run(stripped)
    expect(shown).not.toContain('parameter')
    expect(shown).not.toContain('invoke')
  })
})

describe('the rule stays on the truncation path for one argument', () => {
  it('keeps the text of a write that stopped mid-value', () => {
    // One argument, no closer. Nothing says whether the model finished or the
    // stream stopped, so the text is the only record of what was written and it
    // is kept. llm-kiln's suite pins this independently.
    const truncated = [
      o('tool_calls'),
      o('invoke', 'name="kernel"'),
      o('parameter', 'name="code"'),
      'rm -rf /tmp/x',
    ].join(NL)
    const { calls, shown } = run(truncated)
    expect(calls).toEqual([])
    expect(shown).toContain('rm -rf /tmp/x')
  })

  it('keeps the text of a single stripped argument', () => {
    const one = [
      o('tool_calls'),
      o('invoke', 'name="read"'),
      o('parameter', 'name="file_path"'),
      PATH,
    ].join(NL)
    const { shown } = run(one)
    expect(shown).toContain(PATH)
  })

  it('keeps a value that is a lone opener-shaped string', () => {
    // Pinned by value-markup.spec.ts: an opener the value never closes leaves
    // the block unbalanced, and refusing is the only reading that cannot invent.
    const code = 'show = ' + o('parameter', 'name="x"')
    const { calls } = run([
      o('tool_calls'),
      o('invoke', 'name="kernel"'),
      o('parameter', 'name="code"'),
      code,
      c('parameter'),
      c('invoke'),
      c('tool_calls'),
    ].join(NL))
    expect(calls).toEqual([])
  })
})

describe('a healthy call is untouched by the rule', () => {
  it('dispatches and shows nothing', () => {
    const whole = [
      o('tool_calls'),
      o('invoke', 'name="read"'),
      o('parameter', 'name="file_path"'),
      PATH,
      c('parameter'),
      o('parameter', 'name="offset"'),
      '3338',
      c('parameter'),
      c('invoke'),
      c('tool_calls'),
    ].join(NL)
    const { calls, shown } = run(whole)
    expect(calls).toHaveLength(1)
    expect(shown).toBe('')
  })
})
