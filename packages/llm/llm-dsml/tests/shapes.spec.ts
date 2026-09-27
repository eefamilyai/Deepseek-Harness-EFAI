// Two duties, and they are separate.
//
// 1. A CALL IS A CALL. A model writing the same name-plus-values in a notation
//    the spelling rules never learned gets its call read: JSON, YAML, a colon
//    pair, an element per key, a shell flag, a C-like call. The reader reads
//    structure, not spelling, so a notation it has never seen costs it nothing.
//
// 2. AN EXPLANATION IS AN EXPLANATION. The same reader must never dispatch a
//    call it is only being shown. A fenced example, a backtick-quoted snippet,
//    a sentence that names a tool and its arguments — each is documentation,
//    and running one is as wrong as dropping a real call.
//
// The discriminator is structural: a real call carries a name the roster
// declares AND a complete set of bindings with nothing left over, while an
// explanation keeps the words that describe it.

import { describe, expect, it } from 'vitest'
import { extractShape } from '../src/shapes.ts'
import type { ToolSchema } from '@deepseek-ai/dsh-llm'

const NL = String.fromCharCode(10)
const LT = String.fromCharCode(60)
const GT = String.fromCharCode(62)
const SL = String.fromCharCode(47)
const BT = String.fromCharCode(96)

const schema = (name: string, properties: Record<string, unknown>, required: string[]): ToolSchema =>
  ({ name, description: name, parameters: { type: 'object', properties, required } })

const TOOLS = new Map<string, ToolSchema>([
  ['kernel', schema('kernel', { code: { type: 'string' } }, ['code'])],
  ['read', schema('read', { file_path: { type: 'string' } }, ['file_path'])],
])
const ONE_SLOT = new Map<string, ToolSchema>([
  ['kernel', schema('kernel', { code: { type: 'string' } }, ['code'])],
])

const codeOf = (text: string, tools = TOOLS): unknown => extractShape(text, tools)?.args.get('code')

describe('a call is a call, whatever notation carries it', () => {
  const calls: readonly (readonly [string, string])[] = [
    ['a JSON envelope', '{"tool": "kernel", "arguments": {"code": "print(1)"}}'],
    ['a YAML block', `tool: kernel${NL}code: print(1)`],
    ['a foreign element dialect', `${LT}call tool="kernel"${GT}${LT}arg name="code"${GT}print(1)${LT}${SL}arg${GT}${LT}${SL}call${GT}`],
    ['a Python call', 'kernel(code="print(1)")'],
    ['a call taking a JSON object', 'kernel({code: "print(1)"})'],
    ['attrs on the invoke itself', `${LT}invoke name="kernel" code="print(1)"${SL}${GT}`],
    ['a tool_name child element', `${LT}invoke${GT}${LT}tool_name${GT}kernel${LT}${SL}tool_name${GT}${LT}parameters${GT}${LT}code${GT}print(1)${LT}${SL}code${GT}${LT}${SL}parameters${GT}${LT}${SL}invoke${GT}`],
    ['shell flags', 'kernel --code "print(1)"'],
    ['a markdown bullet', `**kernel**${NL}- code: print(1)`],
    ['key = value lines', `tool = kernel${NL}code = print(1)`],
    ['the tool worn as its own element', `${LT}kernel code="print(1)"${SL}${GT}`],
    ['a TypeScript object', 'kernel({ code: "print(1)" })'],
    ['an OpenAI-style envelope', '{"name": "kernel", "parameters": {"code": "print(1)"}}'],
    ['arguments written before the tool', `code: print(1)${NL}tool: kernel`],
    ['a tool element around a code element', `${LT}kernel${GT}${LT}code${GT}print(1)${LT}${SL}code${GT}${LT}${SL}kernel${GT}`],
    ['a bracket call', 'kernel[code="print(1)"]'],
    ['a colon block', `kernel:${NL}  code: print(1)`],
    ['an at-label', `@kernel${NL}code: print(1)`],
    ['equals with no spaces', `tool=kernel${NL}code=print(1)`],
    ['single quotes', "kernel(code='print(1)')"],
    ['a function label', '{"function": "kernel", "arguments": {"code": "print(1)"}}'],
    ['an attribute naming the slot', `${LT}tool function="kernel"${GT}${LT}code${GT}print(1)${LT}${SL}code${GT}${LT}${SL}tool${GT}`],
  ]

  for (const [label, text] of calls) {
    it(`reads ${label}`, () => {
      expect(codeOf(text)).toBe('print(1)')
    })
  }

  it('reads a lone positional argument for a tool that declares one slot', () => {
    // 'kernel("print(1)")' never says which slot the value belongs to. With
    // exactly one declared slot there is nothing to choose, so it is a reading
    // rather than a guess.
    expect(codeOf('kernel("print(1)")', ONE_SLOT)).toBe('print(1)')
    expect(codeOf('kernel(print(1))', ONE_SLOT)).toBe('print(1)')
  })

  it('refuses a positional argument when the tool declares more than one slot', () => {
    const two = new Map<string, ToolSchema>([
      ['kernel', schema('kernel', { code: { type: 'string' }, timeoutMs: { type: 'number' } }, ['code'])],
    ])
    expect(extractShape('kernel("print(1)")', two)).toBeUndefined()
  })

  it('refuses a call that names a tool the request never declared', () => {
    expect(extractShape('nonexistent(code="1")', TOOLS)).toBeUndefined()
  })

  it('refuses a call whose required argument is missing', () => {
    expect(extractShape('kernel(timeoutMs=30)', ONE_SLOT)).toBeUndefined()
  })

  it('refuses a slot bound to two different values', () => {
    // Two readings of one slot is a coin flip, and a coin flip that runs
    // something is not a reading.
    expect(extractShape('kernel code="a" code="b"', ONE_SLOT)).toBeUndefined()
  })
})

describe('an explanation is an explanation, however it is written', () => {
  const prose: readonly (readonly [string, string])[] = [
    ['a sentence naming the tool', 'You can call the kernel tool with the code parameter.'],
    ['a how-to', 'To run Python, use kernel and pass code as a string.'],
    ['a question about a call', 'Did the kernel call actually run? I set code to print(1) earlier.'],
    ['a fenced example', `For example:${NL}kernel(code="print(1)")${NL}that is how it works.`],
    ['a sentence about read', 'The read tool takes a file_path argument, like a.txt.'],
    ['a backtick mention', `Use ${BT}kernel(code="...")${BT} when you want to run Python inline.`],
    ['a bulleted list of tools', `Options:${NL}- kernel: runs Python${NL}- read: reads a file`],
    ['prose around a real value', 'The kernel call used code = print(1) and returned nothing.'],
    ['a bare fence marker', BT + BT + BT + 'json'],
    ['a documented example in a fence', `Here is the format:${NL}${BT}${BT}${BT}${NL}kernel(code="print(1)")${NL}${BT}${BT}${BT}`],
  ]

  for (const [label, text] of prose) {
    it(`refuses ${label}`, () => {
      expect(extractShape(text, TOOLS)).toBeUndefined()
    })
  }
})

describe('a bare value never swallows the frame around it', () => {
  // An unquoted value runs to its terminator, so a call written without quotes
  // hands the slot the closing bracket that belongs to the CALL. The bracket is
  // frame, not content, and a value may not end with a closer nothing inside it
  // opened - so it is cut, and the call reads the way the model wrote it.
  it('reads an unquoted value in a bracket call', () => {
    expect(codeOf('kernel(code=print(1))')).toBe('print(1)')
  })

  it('reads an unquoted value in a colon pair', () => {
    expect(codeOf('kernel(code: print(1))')).toBe('print(1)')
  })

  it('reads an unquoted path in a bracket call', () => {
    expect(extractShape('read(file_path=/a/b.txt)', TOOLS)?.args.get('file_path')).toBe('/a/b.txt')
  })

  it('keeps a closer the value opened itself', () => {
    // 'print(1)' is balanced, so its own bracket is content. Only the
    // unpartnered one - the frame's - is cut.
    expect(codeOf('kernel(code=print(1)())')).toBe('print(1)()')
  })

  it('keeps a bracketed value the notation delimited', () => {
    // The quotes already said where the value stopped, so a trailing bracket
    // inside them is what the model wrote.
    expect(codeOf('kernel(code="print(1)")')).toBe('print(1)')
    expect(codeOf('kernel(code="print(1))")')).toBe('print(1))')
  })
})

describe('the two duties do not bleed into each other', () => {
  // The reader decides per LINE, so that is the unit each duty is stated over:
  // the line that makes the call is read, and the line that talks about it is
  // not. A block reader above this one is what separates them in a transcript.
  it('reads the line that makes the call', () => {
    expect(codeOf('kernel(code="print(1)")')).toBe('print(1)')
  })

  it('refuses the line that only mentions the call', () => {
    expect(extractShape(`See ${BT}kernel${BT} for details.`, TOOLS)).toBeUndefined()
  })

  it('refuses a call quoted inside a fence', () => {
    expect(extractShape(`${BT}${BT}${BT}${NL}kernel(code="print(1)")${NL}${BT}${BT}${BT}`, TOOLS)).toBeUndefined()
  })

  it('refuses a parenthesised list that names its own arguments', () => {
    // 'kernel(timeoutMs=30)' names a slot this tool does not declare. Reading
    // it as one positional value would run the text `timeoutMs=30` as the
    // argument, which is a call the model never made.
    expect(extractShape('kernel(timeoutMs=30)', ONE_SLOT)).toBeUndefined()
  })
})
