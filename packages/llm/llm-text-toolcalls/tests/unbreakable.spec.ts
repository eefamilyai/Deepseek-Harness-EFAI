// What a damaged call must do: dispatch when the repair is provable, refuse
// when it is not.
//
// The reader's contract has two sides. Markup the model WROTE is a call and has
// to run; markup the model SHOWED is prose and must not. This file tests the
// first side by taking one well-formed call and damaging it in every way a
// transport or a model has been seen to damage one.
//
// The damages split into two kinds, and the split is the point:
//
//   * A repair the GRAMMAR proves. When the invoke itself closed, or when a
//     second opener proves the first one did, the structure is decidable and
//     the call must dispatch.
//   * A repair that would be INVENTED. A single invoke whose parameter closer
//     is missing is indistinguishable from a command cut off mid-write, so its
//     end must not be guessed at. Those cases are asserted to refuse, and are
//     covered in detail by catalog.spec.ts.
//
// The illustrative side lives in illustration.spec.ts.

import { describe, expect, it } from 'vitest'
import { DsmlTranslator, toolIndex } from '../src/index.ts'
import type { DsmlEvent } from '../src/index.ts'
import type { ToolSchema } from '@deepseek-ai/dsh-llm'

const LT = String.fromCharCode(60)
const GT = String.fromCharCode(62)
const SL = String.fromCharCode(47)
const OI = LT + 'invoke'
const OP = LT + 'parameter'
const TCO = LT + 'tool_calls' + GT
const IC = LT + SL + 'invoke' + GT
const PC = LT + SL + 'parameter' + GT
const TCC = LT + SL + 'tool_calls' + GT

const READ: ToolSchema = {
  name: 'read',
  description: 'Read a file.',
  parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
}
const TOOLS = toolIndex([READ])

const run = (text: string): DsmlEvent[] => {
  const translator = new DsmlTranslator(TOOLS)
  return [...translator.push(text.endsWith('\n') ? text : text + '\n'), ...translator.end()]
}

interface Call {
  readonly name: string
  readonly arguments: Record<string, unknown>
}

const callsOf = (events: readonly DsmlEvent[]): Call[] =>
  events
    .filter((event): event is Extract<DsmlEvent, { kind: 'tool-call' }> => event.kind === 'tool-call')
    .map(event => ({ name: event.name, arguments: JSON.parse(event.arguments) as Record<string, unknown> }))

// Every taught closer, for the damages that strip them all at once.
const ANY_CLOSE = new RegExp(LT + SL + '(?:tool_calls|invoke|parameter)' + GT, 'g')

const OPEN_INVOKE = OI + ' name="read"' + GT
const OPEN_PARAM = OP + ' name="path"' + GT
const INVOKE = OPEN_INVOKE + '\n' + OPEN_PARAM + 'a.txt' + PC + '\n' + IC
const BLOCK = TCO + '\n' + INVOKE + '\n' + TCC + '\n'

const WANT: Call[] = [{ name: 'read', arguments: { path: 'a.txt' } }]

// Each damage below leaves the call's meaning intact in a way the grammar can
// still read, so each must keep its dispatch.
const REPAIRABLE: readonly (readonly [string, (text: string) => string])[] = [
  ['intact', text => text],
  ['a bare invoke, no wrapper', () => INVOKE + '\n'],
  ['the wrapper closer lost', text => text.replace(TCC, '')],
  ['the invoke closer lost', text => text.replace(IC, '')],
  ['a surplus parameter closer', text => text.replace(IC, PC + IC)],
  ['a surplus invoke closer', text => text.replace(TCC, IC + TCC)],
  ['every newline gone', text => text.replace(/\n/g, '')],
  ['an unquoted attribute value', text => text.replace('name="path"', 'name=path')],
  ['a spaced attribute run', text => text.replace(OPEN_INVOKE, OI + '   name = "read" ' + GT)],
  ['prose before the block', text => 'Sure - reading that now.\n' + text],
  ['prose after the block', text => text + 'Let me know what you think.\n'],
  ['prose around the block', text => 'Reading it.\n' + text + 'Done.\n'],
  ['the block indented', text => text.split('\n').map(line => '  ' + line).join('\n')],
  ['carriage returns', text => text.replace(/\n/g, '\r\n')],
  ['a stray closer in the prose before', text => 'That tag is structure' + PC + '\n' + text],
]

describe('a damaged call still runs when the repair is provable', () => {
  for (const [label, damage] of REPAIRABLE) {
    it(label, () => {
      expect(callsOf(run(damage(BLOCK)))).toEqual(WANT)
    })
  }
})

// These three damages all remove the parameter's closer while leaving a single
// invoke. Nothing in the structure says whether the value ended or the stream
// did, so completing it would invent an argument the model never finished
// writing. Refusing is the correct reading, and it is the property
// catalog.spec.ts pins by name.
describe('an ambiguous truncation is refused rather than invented', () => {
  const AMBIGUOUS: readonly (readonly [string, (text: string) => string])[] = [
    ['the parameter closer lost', text => text.replace(PC, '')],
    ['every closer lost', text => text.replace(ANY_CLOSE, '')],
    ['newlines and closers gone', text => text.replace(/\n/g, '').replace(ANY_CLOSE, '')],
  ]

  for (const [label, damage] of AMBIGUOUS) {
    it(label, () => {
      expect(callsOf(run(damage(BLOCK)))).toEqual([])
    })
  }
})

// The decidable version of "every closer lost": a second invoke opener proves
// the first one closed, which is what makes a fully-stripped block readable
// rather than guesswork. This is the shape a transport flattening a multi-call
// turn produces, and it is the one restoreStrippedClosers exists for.
describe('a multi-invoke block stripped of every closer is recoverable', () => {
  const SECOND = OPEN_INVOKE + '\n' + OP + ' name="path"' + GT + 'b.txt' + PC + '\n' + IC
  const TWO = TCO + '\n' + INVOKE + '\n' + SECOND + '\n' + TCC + '\n'

  it('dispatches both calls when the closers are all gone', () => {
    const damaged = TWO.replace(/\n/g, '').replace(ANY_CLOSE, '')
    expect(callsOf(run(damaged))).toEqual([
      { name: 'read', arguments: { path: 'a.txt' } },
      { name: 'read', arguments: { path: 'b.txt' } },
    ])
  })

  it('names the shape it repaired', () => {
    const translator = new DsmlTranslator(TOOLS)
    translator.push(TWO.replace(/\n/g, '').replace(ANY_CLOSE, '') + '\n')
    translator.end()
    expect(translator.repairedShapes()).toContain('closer-stripped')
  })
})

describe('an intact call is left alone', () => {
  it('dispatches exactly once', () => {
    expect(callsOf(run(BLOCK))).toEqual(WANT)
  })

  it('reports no repair for a well-formed block', () => {
    const translator = new DsmlTranslator(TOOLS)
    translator.push(BLOCK)
    translator.end()
    expect(translator.repairedShapes()).toEqual([])
  })
})
