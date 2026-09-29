// What a refused block shows, and what it must never show.
//
// `deFramed` takes the wire protocol off a block the reader refused, so a tag
// never reaches the user. It kept the text BETWEEN the tags, which is right for
// a sentence and wrong for a payload: the argument values are what the call
// would have RUN with, and a refused call that showed them back put the protocol
// one level down into the answer, as bare values with no tag left to explain
// them. A refused block still shows the prose it carried, and the note still
// names the mistake.
//
// Every tag is assembled from character codes. A spec that spells one as a
// single token cannot itself be embedded in a markup document without
// truncating it, which is the failure this reader exists to repair.

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
const KERNEL: ToolSchema = {
  name: 'kernel',
  description: 'Run Python.',
  parameters: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'] },
}
const JOB: ToolSchema = {
  name: 'job_output',
  description: 'Read a job.',
  parameters: {
    type: 'object',
    properties: {
      job_id: { type: 'string' },
      wait: { type: 'boolean' },
      timeout_ms: { type: 'number' },
    },
    required: ['job_id'],
  },
}
const TOOLS = toolIndex([KERNEL, JOB])

function run(text: string, notes = true): { calls: DsmlEvent[]; shown: string } {
  const reader = new DsmlTranslator(TOOLS, { notes })
  const events = [...reader.push(text), ...reader.end()]
  return {
    calls: events.filter(event => event.kind === 'tool-call'),
    shown: events
      .filter((event): event is Extract<DsmlEvent, { kind: 'text' }> => event.kind === 'text')
      .map(event => event.text)
      .join(''),
  }
}

describe('a refused block does not spill its argument values', () => {
  // Every argument opener is here and no argument closer is: the reader cannot
  // tell this from a write cut off mid-argument, so it refuses -- and the
  // values it refuses are exactly the text that used to be shown back.
  const refused = [
    o('tool_calls'),
    o('invoke', 'name="job_output"'),
    o('parameter', 'name="job_id"'),
    'pwsh-20',
    o('parameter', 'name="wait"'),
    'true',
    o('parameter', 'name="timeout_ms"'),
    '600000',
    c('tool_calls'),
    '',
  ].join(NL)

  it('runs nothing', () => {
    expect(run(refused).calls).toEqual([])
  })

  it('shows none of the values the call would have run with', () => {
    const { shown } = run(refused)
    expect(shown).not.toContain('pwsh-20')
    expect(shown).not.toContain('600000')
  })

  it('shows no argument tag either', () => {
    const { shown } = run(refused)
    expect(shown).not.toContain('parameter')
    expect(shown).not.toContain('invoke')
  })

  it('still names the mistake in words', () => {
    expect(run(refused).shown).toContain('unfinished tool call')
  })

  it('drops the value of an element whose closer never arrived', () => {
    const truncated = [
      o('tool_calls'),
      o('invoke', 'name="kernel"'),
      o('parameter', 'name="code"'),
      'rm -rf /tmp/x',
      '',
    ].join(NL)
    const { calls, shown } = run(truncated)
    expect(calls).toEqual([])
    expect(shown).not.toContain('rm -rf /tmp/x')
    expect(shown).toContain('unfinished tool call')
  })

  it('keeps the value out even when the note is switched off', () => {
    expect(run(refused, false).shown).not.toContain('pwsh-20')
  })
})

describe('a refused block still shows the prose it carried', () => {
  it('keeps a sentence written between two argument elements', () => {
    const block = [
      o('tool_calls'),
      o('parameter', 'name="file_path"'),
      'a.py',
      c('invoke'),
      'Edited files and verifying before continuing.',
      o('parameter', 'name="limit"'),
      '40',
      c('tool_calls'),
      '',
    ].join(NL)
    const { calls, shown } = run(block)
    expect(calls).toEqual([])
    expect(shown).toContain('Edited files and verifying before continuing.')
    expect(shown).not.toContain('a.py')
    expect(shown).not.toContain('tool_calls')
  })

  it('leaves a sentence that only mentions the format exactly as written', () => {
    const sentence = 'The harness reads a ' + o('tool_calls') + ' block. Nothing else runs.'
    expect(run(sentence).shown).toBe(sentence + NL)
  })
})
