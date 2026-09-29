// The adversarial corpus: the two duties, pitted against each other.
//
// `shapes.spec.ts` pins the reading and `structural.spec.ts` pins the wiring.
// This is the corpus that tries to BREAK the pair, and it is organized around
// the two duties the reader has to keep apart:
//
//   * A CALL IS A CALL. Every notation — seen or unseen, whole or malformed,
//     streamed in any chunking — must dispatch with exactly the arguments
//     written, and must never be dropped, truncated, or run with invented
//     arguments.
//   * AN EXPLANATION IS AN EXPLANATION. Prose that names a tool, a fenced
//     example, a backtick-quoted snippet, a documented shape, and a transcript
//     quoted in an answer must all pass through as text, unchanged.
//
// A notation that reads is checked at FOUR chunkings, because "reads it" is
// only half the property: a reader that needs the whole line in one piece is a
// reader that fails on a real stream, where the split lands wherever the
// provider feels like it.

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

const READ: ToolSchema = {
  name: 'read',
  description: 'Read a file.',
  parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
}
const KERNEL: ToolSchema = {
  name: 'kernel',
  description: 'Run Python.',
  parameters: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'] },
}
const WRITE: ToolSchema = {
  name: 'write',
  description: 'Write a file.',
  parameters: {
    type: 'object',
    properties: { path: { type: 'string' }, content: { type: 'string' } },
    required: ['path'],
  },
}
const TOOLS = toolIndex([READ, KERNEL, WRITE])

interface Read {
  readonly calls: readonly { readonly name: string; readonly arguments: Record<string, unknown> }[]
  readonly text: string
}

/** Feed one whole reply through a reader. */
function whole(input: string): Read {
  const translator = new DsmlTranslator(TOOLS)
  return collect([...translator.push(input.endsWith(NL) ? input : input + NL), ...translator.end()])
}

/** Feed the same reply in fixed-size chunks — the split lands where it lands. */
function chunked(input: string, size: number): Read {
  const translator = new DsmlTranslator(TOOLS)
  const events: DsmlEvent[] = []
  for (let at = 0; at < input.length; at += size) events.push(...translator.push(input.slice(at, at + size)))
  events.push(...translator.end())
  return collect(events)
}

function collect(events: readonly DsmlEvent[]): Read {
  return {
    calls: events
      .filter((event): event is Extract<DsmlEvent, { kind: 'tool-call' }> => event.kind === 'tool-call')
      .map(event => ({ name: event.name, arguments: JSON.parse(event.arguments) as Record<string, unknown> })),
    text: events.filter(event => event.kind === 'text').map(event => (event as { text: string }).text).join(''),
  }
}

/**
 * A call written in `text` reads the same way however the stream is cut.
 *
 * The chunkings are not decoration. `binding` holds an unfinished line while it
 * could still become a call, and the boundary cases — a name split from its own
 * arguments, an argument split from its own quote — are exactly where a reader
 * that streams eagerly leaks the front of a call to the user and loses the call.
 * @param label - the notation being described, for the failure message.
 * @param text - one call, written in that notation.
 * @param name - the tool it should name.
 * @param args - the arguments it should carry, exactly.
 */
function reads(label: string, text: string, name: string, args: Record<string, unknown>): void {
  it(`reads ${label}`, () => {
    for (const [how, read] of [
      ['whole', whole(text)],
      ['1-char chunks', chunked(text, 1)],
      ['2-char chunks', chunked(text, 2)],
      ['3-char chunks', chunked(text, 3)],
    ] as const) {
      expect(read.calls, `${label} (${how})`).toEqual([{ name, arguments: args }])
      // A call is never shown to the user as markup.
      expect(read.text, `${label} (${how}) showed raw markup`).not.toContain('kernel')
    }
  })
}

/** An explanation passes through as text, however it is chunked. */
function refuses(label: string, text: string): void {
  it(`refuses ${label}`, () => {
    for (const [how, read] of [
      ['whole', whole(text)],
      ['1-char chunks', chunked(text, 1)],
      ['3-char chunks', chunked(text, 3)],
    ] as const) {
      expect(read.calls, `${label} (${how})`).toEqual([])
      // It is not merely refused: the user is shown what the model wrote.
      expect(read.text, `${label} (${how})`).toContain('kernel')
    }
  })
}

describe('a call is a call, in whatever notation it is written', () => {
  const ONE = { code: 'print(1)' }

  reads('a JSON envelope', '{"tool": "kernel", "arguments": {"code": "print(1)"}}', 'kernel', ONE)
  reads('a pretty-printed JSON envelope', '{' + NL + '  "tool": "kernel",' + NL + '  "arguments": {"code": "print(1)"}' + NL + '}', 'kernel', ONE)
  reads('a Python call', 'kernel(code="print(1)")', 'kernel', ONE)
  reads('a YAML block', 'tool: kernel' + NL + 'code: print(1)', 'kernel', ONE)
  reads('an equals pair', 'tool=kernel' + NL + 'code=print(1)', 'kernel', ONE)
  reads('a colon pair', 'kernel: code: print(1)', 'kernel', ONE)
  reads('a colon pair with no space', 'kernel:' + NL + 'code:print(1)', 'kernel', ONE)
  reads('a shell flag, quoted', 'kernel --code "print(1)"', 'kernel', ONE)
  reads('a shell flag with equals', 'kernel --code=print(1)', 'kernel', ONE)
  reads('a bare shell flag', 'kernel -code print(1)', 'kernel', ONE)
  reads('a bracketed call', 'kernel[code="print(1)"]', 'kernel', ONE)
  reads('a lone positional value', 'kernel("print(1)")', 'kernel', ONE)
  reads('an at-label', '@kernel code="print(1)"', 'kernel', ONE)
  reads('an arrow', 'kernel => code: print(1)', 'kernel', ONE)
  reads(
    'an element per key',
    LT + 'kernel' + GT + LT + 'code' + GT + 'print(1)' + LT + SL + 'code' + GT + LT + SL + 'kernel' + GT,
    'kernel',
    ONE,
  )
  reads(
    'a named envelope of elements',
    LT + 'tool_call' + GT +
      LT + 'tool' + GT + 'kernel' + LT + SL + 'tool' + GT +
      LT + 'code' + GT + 'print(1)' + LT + SL + 'code' + GT +
      LT + SL + 'tool_call' + GT,
    'kernel',
    ONE,
  )
  // The taught wrapper is where the reader was taught; a call written in it
  // still has to read, since that is the notation the prompt asks for. The
  // value sits on the parameter's own line, which is the shape the format
  // statement shows — `<parameter name="PARAMETER_NAME">value</parameter>`.
  reads(
    'the taught envelope',
    CO + NL + OI + ' name="kernel"' + GT + NL + OP + ' name="code"' + GT + 'print(1)' + PC + NL + IC + NL + CC,
    'kernel',
    ONE,
  )
  // The same envelope with the closer on its own line: the value is still every
  // character between the tags, so the newline before `</parameter>` stays. That
  // newline is what makes a `content` argument a POSIX text file, so dropping it
  // would change the call the model wrote.
  reads(
    'the taught envelope with its closer on the next line',
    CO + NL + OI + ' name="kernel"' + GT + NL + OP + ' name="code"' + GT + 'print(1)' + NL + PC + NL + IC + NL + CC,
    'kernel',
    { code: 'print(1)' + NL },
  )
  reads('a tool with two slots', 'write(path="a.txt", content="hi")', 'write', { path: 'a.txt', content: 'hi' })
  reads('a one-slot tool', 'read(path="a.txt")', 'read', { path: 'a.txt' })
})

describe('a hostile value survives the reading', () => {
  // A value is raw text. Every one of these carries the notation's own
  // punctuation inside it, and a reader that stopped at the first `,` or `=`
  // would hand the tool a truncated string or invent an argument from it.
  const HOSTILE: readonly (readonly [string, string])[] = [
    ['an equals sign', 'x = 1'],
    ['a comma', 'a, b'],
    ['braces', 'd = {}'],
    ['parentheses', 'f(x)'],
    ['a nested single quote', "print('hi')"],
    ['angle brackets', 'a < b > c'],
    ['brackets', 'a[0] = 1'],
    ['a colon', 'd: 1'],
    ['an escaped quote inside', 'say "hi" twice'],
  ]

  for (const [label, value] of HOSTILE) {
    reads(
      `a value carrying ${label}`,
      `kernel(code="${value}")`,
      'kernel',
      { code: value },
    )
  }
})

describe('an explanation is an explanation', () => {
  refuses('a sentence naming the tool', 'You can call kernel with the code parameter.')
  refuses('a how-to', 'To run Python, use kernel and pass code as a string.')
  refuses('a documented shape', 'The call looks like kernel(code="...") in every dialect.')
  refuses('a transcript quoted in an answer', 'The model wrote kernel(code="print(1)") and the tool ran.')
  refuses('a mention beside real prose', 'First I will check the file, then I call kernel with code.')
  refuses(
    'a fenced example',
    BT + BT + BT + 'python' + NL + 'kernel(code="print(1)")' + NL + BT + BT + BT,
  )
  refuses('a quoted snippet', 'Use ' + BT + 'kernel(code="print(1)")' + BT + ' for that.')
  refuses('a system prompt recited back', 'Your tools are:' + NL + 'kernel(code="print(1)")' + NL + 'read(path="a.txt")')
  refuses('a heading with no arguments', '## Available tools: kernel, read, write')
})

describe('an ambiguity is refused rather than guessed at', () => {
  // One slot bound to two different values is a guess, not a reading. Running
  // either one of them would be the reader inventing an argument.
  it('refuses a slot bound twice', () => {
    expect(whole('kernel(code="one")' + NL + 'code="two"').calls).toEqual([])
  })

  it('refuses a call missing a required slot', () => {
    expect(whole('read()').calls).toEqual([])
  })

  it('refuses a tool the request never declared', () => {
    expect(whole('execute(command="rm -rf /")').calls).toEqual([])
  })

  it('refuses a positional value for a two-slot tool', () => {
    // With two slots the text never says which one the value belongs to.
    expect(whole('write("a.txt")').calls).toEqual([])
  })
})
