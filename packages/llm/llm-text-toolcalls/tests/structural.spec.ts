// The structural reader, through the REAL translator.
//
// `shapes.spec.ts` pins the reading itself. This pins the WIRING: that a call
// written in a notation the spelling rules never learned actually dispatches
// from `DsmlTranslator`, and that a sentence, a fenced example, or a quoted
// snippet still does not — the two duties, end to end, through the class every
// provider route runs.

import { describe, expect, it } from 'vitest'
import { DsmlTranslator, toolIndex } from '../src/index.ts'
import type { DsmlEvent } from '../src/index.ts'
import type { ToolSchema } from '@deepseek-ai/dsh-llm'

// Tag literals are assembled from character codes so this file never carries a
// literal closing tag: the reader under test is what has to survive one.
const NL = String.fromCharCode(10)
const LT = String.fromCharCode(60)
const GT = String.fromCharCode(62)
const SL = String.fromCharCode(47)
const BT = String.fromCharCode(96)
const CO = LT + 'tool_calls' + GT
const CC = LT + SL + 'tool_calls' + GT
const OI = LT + 'invoke'
const IC = LT + SL + 'invoke' + GT
const OP = LT + 'parameter'
const PC = LT + SL + 'parameter' + GT

const KERNEL: ToolSchema = {
  name: 'kernel',
  description: 'Run Python.',
  parameters: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'] },
}
const TOOLS = toolIndex([KERNEL])

interface Call {
  readonly name: string
  readonly arguments: Record<string, unknown>
}

const translate = (text: string): { calls: Call[]; text: string; shapes: string[] } => {
  const translator = new DsmlTranslator(TOOLS)
  const events: DsmlEvent[] = [...translator.push(text.endsWith(NL) ? text : text + NL), ...translator.end()]
  return {
    calls: events
      .filter((event): event is Extract<DsmlEvent, { kind: 'tool-call' }> => event.kind === 'tool-call')
      .map(event => ({ name: event.name, arguments: JSON.parse(event.arguments) as Record<string, unknown> })),
    text: events.filter(event => event.kind === 'text').map(event => (event as { text: string }).text).join(''),
    shapes: [...translator.repairedShapes()],
  }
}

/** The value of the one argument these calls carry, or undefined. */
const codeOf = (text: string): unknown => translate(text).calls[0]?.arguments.code

describe('a call in an untaught notation dispatches', () => {
  const notations: readonly (readonly [string, string])[] = [
    ['a JSON envelope', '{"tool": "kernel", "arguments": {"code": "print(1)"}}'],
    ['a Python call', 'kernel(code="print(1)")'],
    ['a YAML block', 'tool: kernel' + NL + 'code: print(1)'],
    ['shell flags', 'kernel --code "print(1)"'],
    ['a colon pair', 'kernel: code: print(1)'],
    ['a bracketed call', 'kernel[code="print(1)"]'],
    ['an equals pair', 'tool=kernel' + NL + 'code=print(1)'],
    ['a lone positional value', 'kernel("print(1)")'],
  ]

  for (const [label, text] of notations) {
    it(`reads ${label}`, () => {
      const { calls, shapes } = translate(text)
      expect(calls).toHaveLength(1)
      expect(calls[0]?.name).toBe('kernel')
      expect(codeOf(text)).toBe('print(1)')
      // The reader could not read the notation the model chose, so the repair
      // is counted and the taught dialect is named back to the model.
      expect(shapes).toContain('structural-notation')
    })
  }

  it('reads an untaught call that sits inside the taught wrapper', () => {
    // A model that wrapped a JSON body in the taught envelope is still making
    // that call; the body is where the arguments are.
    const { calls } = translate(CO + NL + '{"name": "kernel", "arguments": {"code": "print(1)"}}' + NL + CC)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.arguments.code).toBe('print(1)')
  })
})

describe('an explanation still passes through as text', () => {
  const explanations: readonly (readonly [string, string])[] = [
    ['a sentence naming the tool', 'You can call kernel with the code parameter.'],
    ['a how-to', 'To run Python, use kernel and pass code as a string.'],
    ['a fenced example', BT + BT + BT + NL + 'kernel(code="print(1)")' + NL + BT + BT + BT],
    ['a quoted snippet', 'Use ' + BT + 'kernel(code="print(1)")' + BT + ' for that.'],
    ['a documented shape', 'The call looks like kernel(code="...") in every dialect.'],
  ]

  for (const [label, text] of explanations) {
    it(`refuses ${label}`, () => {
      const { calls, text: shown } = translate(text)
      expect(calls).toEqual([])
      // It is not merely refused: it is shown to the user, unchanged.
      expect(shown).toContain('kernel')
    })
  }

  it('does not read a truncated taught block structurally', () => {
    // The block carried the reader's own vocabulary and the spelling rules
    // refused it — the parameter never closed. Reading its fragments as a name
    // plus bindings would dispatch the very call that was just declined, so the
    // structural reader must stay out of taught markup's way.
    const { calls } = translate(CO + NL + OI + ' name="kernel"' + GT + NL + OP + ' name="code"' + GT + 'x = 1' + NL + IC + NL + CC)
    expect(calls).toEqual([])
  })

  it('does not read a taught call whose value carries a lone opener', () => {
    const code = 'show = ' + OP + ' name="x"' + GT
    const { calls } = translate(CO + NL + OI + ' name="kernel"' + GT + NL + OP + ' name="code"' + GT + code + NL + PC + NL + IC + NL + CC)
    expect(calls).toEqual([])
  })
})

describe('the reading does not depend on how the stream is chunked', () => {
  const CALL = '{"tool": "kernel", "arguments": {"code": "print(1)"}}' + NL

  it('reads it whole', () => {
    expect(codeOf(CALL)).toBe('print(1)')
  })

  it('reads it one character at a time', () => {
    const translator = new DsmlTranslator(TOOLS)
    const events: DsmlEvent[] = []
    for (const char of CALL) events.push(...translator.push(char))
    events.push(...translator.end())
    const calls = events.filter((event): event is Extract<DsmlEvent, { kind: 'tool-call' }> => event.kind === 'tool-call')
    expect(calls).toHaveLength(1)
    expect((JSON.parse(calls[0]?.arguments ?? '{}') as { code?: unknown }).code).toBe('print(1)')
  })

  it('reads it split at every boundary', () => {
    // Every place the stream could break is a place a reader that buffers
    // wrongly will miss the call.
    for (let at = 1; at < CALL.length; at++) {
      const translator = new DsmlTranslator(TOOLS)
      const events: DsmlEvent[] = [
        ...translator.push(CALL.slice(0, at)),
        ...translator.push(CALL.slice(at)),
        ...translator.end(),
      ]
      const calls = events.filter((event): event is Extract<DsmlEvent, { kind: 'tool-call' }> => event.kind === 'tool-call')
      expect(calls, `split at ${String(at)}`).toHaveLength(1)
      expect((JSON.parse(calls[0]?.arguments ?? '{}') as { code?: unknown }).code).toBe('print(1)')
    }
  })
})
