// Markup the model SHOWS is prose; markup the model WRITES is a call.
//
// The format statement this transport teaches promises that fenced code blocks
// never run, and an explanation of the format quotes its own tags. Both are
// illustrations, and neither may dispatch — nor may either swallow the prose
// around it, which is what an unclosed block opened by a mention used to do.

import { describe, expect, it } from 'vitest'
import { DsmlTranslator, toolIndex } from '../src/index.ts'
import type { DsmlEvent } from '../src/index.ts'
import type { ToolSchema } from '@deepseek-ai/dsh-llm'

// Every tag below is built from char codes so this file never carries a literal
// closing tag in its source — the reader under test is the thing that has to
// survive those, and a fixture that trips it would be testing the wrong layer.
const LT = String.fromCharCode(60), GT = String.fromCharCode(62), SL = String.fromCharCode(47)
const TICK = String.fromCharCode(96)
const OI = LT + 'invoke'
const OP = LT + 'parameter'
const TCO = LT + 'tool_calls' + GT
const TCC = LT + SL + 'tool_calls' + GT
const IC = LT + SL + 'invoke' + GT
const PC = LT + SL + 'parameter' + GT
const FENCE = TICK.repeat(3)

const READ: ToolSchema = {
  name: 'read',
  description: 'Read a file.',
  parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
}
const WRITE: ToolSchema = {
  name: 'write',
  description: 'Write a file.',
  parameters: { type: 'object', properties: { content: { type: 'string' } }, required: ['content'] },
}
const TOOLS = toolIndex([READ, WRITE])

const run = (text: string): DsmlEvent[] => {
  const translator = new DsmlTranslator(TOOLS)
  return [...translator.push(text.endsWith('\n') ? text : `${text}\n`), ...translator.end()]
}
const callsOf = (events: readonly DsmlEvent[]): { name: string; arguments: Record<string, unknown> }[] =>
  events
    .filter((event): event is Extract<DsmlEvent, { kind: 'tool-call' }> => event.kind === 'tool-call')
    .map(event => ({ name: event.name, arguments: JSON.parse(event.arguments) as Record<string, unknown> }))
const textOf = (events: readonly DsmlEvent[]): string =>
  events.filter(event => event.kind === 'text').map(event => event.text).join('')

const CALL = OI + ' name="read"' + GT + OP + ' name="path"' + GT + 'a.txt' + PC + IC

describe('a fenced block is an illustration', () => {
  it('does not dispatch a call written inside a fence', () => {
    const events = run(`${FENCE}\n${CALL}\n${FENCE}\n`)
    expect(callsOf(events)).toEqual([])
  })

  it('shows the fenced block to the user exactly as written', () => {
    const events = run(`${FENCE}\n${CALL}\n${FENCE}\n`)
    const shown = textOf(events)
    expect(shown).toContain(CALL)
    expect(shown).toContain(FENCE)
  })

  it('reads a fence with an info word', () => {
    const events = run(`${FENCE}xml\n${CALL}\n${FENCE}\n`)
    expect(callsOf(events)).toEqual([])
  })

  it('still reads a real call after the fence closes', () => {
    const events = run(`${FENCE}\n${CALL}\n${FENCE}\n${CALL}\n`)
    expect(callsOf(events)).toEqual([{ name: 'read', arguments: { path: 'a.txt' } }])
  })

  it('sends no format reminder, because nothing was malformed', () => {
    const events = run(`${FENCE}\n${CALL}\n${FENCE}\n`)
    expect(textOf(events)).not.toContain('format reminder')
  })

  it('reads a fence inside an open call as that call argument', () => {
    const events = run(
      TCO + '\n'
      + OI + ' name="write"' + GT + OP + ' name="content"' + GT + FENCE + 'py\nx = 1\n' + FENCE + PC + IC + '\n'
      + TCC + '\n',
    )
    expect(callsOf(events)).toEqual([{ name: 'write', arguments: { content: `${FENCE}py\nx = 1\n${FENCE}` } }])
  })
})

describe('a code span is an illustration', () => {
  it('does not open a block on a mention of an invoke', () => {
    const events = run(`The ${TICK}${OI}${TICK} tag carries the tool name.\n`)
    expect(callsOf(events)).toEqual([])
  })

  it('shows the mention with its backticks and its closer intact', () => {
    const mention = `${TICK}${IC}${TICK}`
    const events = run(`A stray ${mention} is structure.\n`)
    expect(textOf(events)).toContain(mention)
  })

  it('keeps the prose after a mention instead of swallowing it', () => {
    const events = run(`Write ${TICK}${OI} name="read"${TICK} and the call runs.\n`)
    const shown = textOf(events)
    expect(shown).toContain('and the call runs.')
    expect(callsOf(events)).toEqual([])
  })

  it('does not infer a call from a quoted line-leading parameter', () => {
    const events = run(`${TICK}${OP} name="path"${GT}a.txt${PC}${TICK}\n`)
    expect(callsOf(events)).toEqual([])
  })

  it('still reads a real call on a later line', () => {
    const events = run(`See ${TICK}${OI}${TICK} for the format.\n${CALL}\n`)
    expect(callsOf(events)).toEqual([{ name: 'read', arguments: { path: 'a.txt' } }])
  })

  it('does not count a mention as a repaired shape', () => {
    const translator = new DsmlTranslator(TOOLS)
    translator.push(`${TICK}${OI} name="read"${TICK} and ${TICK}${OI} name="read"${TICK}\n`)
    translator.end()
    expect(translator.repairedShapes()).toEqual([])
  })
})

describe('span-free input is read exactly as before', () => {
  it('dispatches a well-formed call with no backticks anywhere', () => {
    const events = run(TCO + '\n' + CALL + '\n' + TCC + '\n')
    expect(callsOf(events)).toEqual([{ name: 'read', arguments: { path: 'a.txt' } }])
  })

  it('leaves a parameter value containing a backtick alone', () => {
    const events = run(
      TCO + '\n'
      + OI + ' name="write"' + GT + OP + ' name="content"' + GT + 'a' + TICK + 'b' + PC + IC + '\n'
      + TCC + '\n',
    )
    expect(callsOf(events)).toEqual([{ name: 'write', arguments: { content: `a${TICK}b` } }])
  })
})
