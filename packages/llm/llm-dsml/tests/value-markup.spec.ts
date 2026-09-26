// A parameter VALUE is raw text, and the text may be markup.
//
// The reader's oldest failure in this area was structural: the first closing tag
// inside a value was read as the end of the element, so a command that itself
// quoted the format was cut off mid-write and ran truncated. Two rules settle it
// from structure alone — an opener only bounds an element at depth zero, and the
// element's terminator is the last closer before the next depth-zero opener.
//
// These cases pin both directions: a value that CONTAINS markup keeps every
// character of it, and a closer the model wrote one time too many is still
// dropped as structure rather than swept into the value.

import { describe, expect, it } from 'vitest'
import { DsmlTranslator, toolIndex } from '../src/index.ts'
import type { DsmlEvent } from '../src/index.ts'
import type { ToolSchema } from '@deepseek-ai/dsh-llm'

// Every tag below is assembled from character codes so this file never carries a
// literal closing tag in its source — the reader under test is the thing that has
// to survive one, and a fixture that tripped it would test the wrong layer.
const LT = String.fromCharCode(60)
const GT = String.fromCharCode(62)
const SL = String.fromCharCode(47)
const OI = LT + 'invoke'
const OP = LT + 'parameter'
const CO = LT + 'tool_calls' + GT
const CC = LT + SL + 'tool_calls' + GT
const IC = LT + SL + 'invoke' + GT
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

const callsOf = (text: string): { calls: Call[]; shapes: string[] } => {
  const translator = new DsmlTranslator(TOOLS)
  const events: DsmlEvent[] = [...translator.push(text.endsWith('\n') ? text : text + '\n'), ...translator.end()]
  return {
    calls: events
      .filter((event): event is Extract<DsmlEvent, { kind: 'tool-call' }> => event.kind === 'tool-call')
      .map(event => ({ name: event.name, arguments: JSON.parse(event.arguments) as Record<string, unknown> })),
    shapes: [...translator.repairedShapes()],
  }
}

/** One kernel call whose `code` argument is exactly `code`, wrapped in a block. */
const kernelCall = (code: string): string =>
  CO + '\n' + OI + ' name="kernel"' + GT + '\n' + OP + ' name="code"' + GT + code + '\n' + PC + '\n' + IC + '\n' + CC + '\n'

const codeOf = (text: string): unknown => callsOf(text).calls[0]?.arguments.code

describe('a value that contains markup keeps every character of it', () => {
  it('a closing tag quoted inside the value does not end the element', () => {
    const code = 'payload = "' + PC + '"'
    expect(codeOf(kernelCall(code))).toBe(code + '\n')
  })

  it('a whole call nested inside the value is data, not a second call', () => {
    const code = 'template = ' + OI + ' name="read"' + GT + OP + ' name="path"' + GT + 'a.txt' + PC + IC
    const { calls } = callsOf(kernelCall(code))
    expect(calls).toHaveLength(1)
    expect(calls[0]?.arguments.code).toBe(code + '\n')
  })

  it('a lone unmatched opener inside the value is refused, not guessed at', () => {
    // An opener the value never closes leaves the block unbalanced, and nothing
    // in the structure says whether that opener is content or the element was
    // cut off mid-write. Refusing is the only reading that cannot invent.
    const code = 'show = ' + OP + ' name="x"' + GT
    expect(callsOf(kernelCall(code)).calls).toEqual([])
  })

  it('a balanced pair inside the value stays in the value', () => {
    const code = 'ex: ' + OP + ' name="x"' + GT + 'v' + PC
    expect(codeOf(kernelCall(code))).toBe(code + '\n')
  })
})

describe('a closer written one time too many is structure, not value', () => {
  const surplus = (tail: string): string =>
    CO + '\n' + OI + ' name="kernel"' + GT + '\n' + OP + ' name="code"' + GT + 'x = 1\n' + PC + tail + '\n' + IC + '\n' + CC + '\n'

  it('drops the surplus tag from a value that carried no markup', () => {
    expect(codeOf(surplus(PC))).toBe('x = 1\n')
  })

  it('drops the surplus tag even with a space before it', () => {
    expect(codeOf(surplus(' ' + PC))).toBe('x = 1\n')
  })

  it('names the surplus shape it repaired', () => {
    expect(callsOf(surplus(PC)).shapes).toContain('surplus-closer')
  })

  it('leaves a well-formed value reporting nothing', () => {
    expect(callsOf(kernelCall('x = 1')).shapes).toEqual([])
  })
})
