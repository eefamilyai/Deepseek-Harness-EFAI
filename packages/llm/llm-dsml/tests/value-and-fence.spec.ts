// The reader's two halves of one rule: a parameter's VALUE is raw text.
//
// A call is written across lines and its arguments may quote the format, so
// neither end of a value can be read off the first tag that looks like one.
// These pin the two places that got it wrong and the streaming path that
// made one of them reachable only in chunks.
//
// Tags are assembled from character codes: the reader is the thing under
// test, and a fixture carrying a literal closer would trip the wrong layer.
import { describe, expect, it } from 'vitest'
import { DsmlTranslator, toolIndex } from '../src/index.ts'
import type { DsmlEvent } from '../src/index.ts'
import type { ToolSchema } from '@deepseek-ai/dsh-llm'

const LT = String.fromCharCode(60)
const GT = String.fromCharCode(62)
const SL = String.fromCharCode(47)
const BT = String.fromCharCode(96)
const NL = String.fromCharCode(10)
const o = (n: string, a = '') => LT + n + (a ? ' ' + a : '') + GT
const c = (n: string) => LT + SL + n + GT
const A = (n: string, v: string) => n + '="' + v + '"'
const P = (n: string, v: string) => o('parameter', A('name', n)) + v + c('parameter')
const I = (n: string, b: string) => o('invoke', A('name', n)) + b + c('invoke')
const W = (b: string) => o('tool_calls') + b + c('tool_calls')

const WRITE: ToolSchema = {
  name: 'write',
  description: 'Write a file.',
  parameters: {
    type: 'object',
    properties: { file_path: { type: 'string' }, content: { type: 'string' } },
    required: ['file_path', 'content'],
  },
}
const KERNEL: ToolSchema = {
  name: 'kernel',
  description: 'Run Python.',
  parameters: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'] },
}
const TOOLS = toolIndex([WRITE, KERNEL])

interface Call { readonly name: string; readonly arguments: Record<string, unknown> }

const callsOf = (text: string): Call[] => {
  const translator = new DsmlTranslator(TOOLS)
  const events: DsmlEvent[] = [...translator.push(text.endsWith(NL) ? text : text + NL), ...translator.end()]
  return events
    .filter((e): e is Extract<DsmlEvent, { kind: 'tool-call' }> => e.kind === 'tool-call')
    .map(e => ({ name: e.name, arguments: JSON.parse(e.arguments) as Record<string, unknown> }))
}

const proseOf = (text: string): string => {
  const translator = new DsmlTranslator(TOOLS)
  const events: DsmlEvent[] = [...translator.push(text.endsWith(NL) ? text : text + NL), ...translator.end()]
  return events.filter(e => e.kind === 'text').map(e => e.text).join('')
}

/** The prose and the calls, which is what a stream MEANS regardless of split. */
const meaning = (text: string, chunk: number): string => {
  const translator = new DsmlTranslator(TOOLS)
  const events: DsmlEvent[] = []
  for (let at = 0; at < text.length; at += chunk) events.push(...translator.push(text.slice(at, at + chunk)))
  events.push(...translator.end())
  return JSON.stringify([
    events.filter(e => e.kind === 'text').map(e => e.text).join(''),
    events.filter(e => e.kind === 'tool-call').map(e => [e.name, e.arguments]),
  ])
}

describe('a value that quotes the format', () => {
  const cases: readonly (readonly [string, string])[] = [
    ['a lone invoke closer', 'head' + NL + c('invoke') + NL + 'tail'],
    ['a lone block closer', 'head' + NL + c('tool_calls') + NL + 'tail'],
    ['a complete call', 'code' + NL + I('kernel', P('code', 'x')) + NL + 'more'],
    ['a balanced parameter pair', 'a' + o('parameter', A('name', 'x')) + 'm' + c('parameter') + 'b'],
    ['two lone closers', 'a' + c('parameter') + c('parameter') + 'b'],
  ]

  for (const [label, value] of cases) {
    it('keeps every character of ' + label, () => {
      const calls = callsOf(W(I('write', P('file_path', 'a.txt') + P('content', value))))
      expect(calls).toHaveLength(1)
      expect(calls[0]?.arguments.content).toBe(value)
    })
  }
})

describe('a fenced example is an illustration, not an action', () => {
  const example = 'Shape:' + NL + NL + BT + BT + BT + 'xml' + NL
    + W(I('kernel', P('code', 'print(1)'))) + NL + BT + BT + BT + NL + NL + 'Done.' + NL

  it('never dispatches when the whole block arrives at once', () => {
    expect(callsOf(example)).toHaveLength(0)
    expect(proseOf(example)).toContain('Done.')
  })

  it('never dispatches however the block is chunked', () => {
    for (const size of [1, 2, 3, 7, 64]) {
      const at = new DsmlTranslator(TOOLS)
      const events: DsmlEvent[] = []
      for (let i = 0; i < example.length; i += size) events.push(...at.push(example.slice(i, i + size)))
      events.push(...at.end())
      expect(events.filter(e => e.kind === 'tool-call'), `chunk ${String(size)}`).toHaveLength(0)
    }
  })

  it('still dispatches the same text when it is NOT fenced', () => {
    const bare = W(I('kernel', P('code', 'print(1)'))) + NL
    expect(callsOf(bare)).toHaveLength(1)
    for (const size of [1, 2, 3]) expect(meaning(bare, size)).toBe(meaning(bare, 4096))
  })
})

describe('a call reads the same however the stream is split', () => {
  const streamed: readonly string[] = [
    W(I('kernel', P('code', 'x' + NL + 'y'))) + NL,
    W(I('write', P('file_path', 'a.txt') + P('content', 'head' + NL + c('invoke') + NL + 'tail'))) + NL,
    'Prose before.' + NL + W(I('kernel', P('code', 'x'))) + NL + 'Prose after.' + NL,
  ]

  streamed.forEach((text, index) => {
    it(`is chunk-invariant for case ${String(index)}`, () => {
      const whole = meaning(text, text.length)
      for (const size of [1, 2, 3, 7]) expect(meaning(text, size), `chunk ${String(size)}`).toBe(whole)
    })
  })
})
