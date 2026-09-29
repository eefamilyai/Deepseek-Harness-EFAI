/**
 * A wrapped block that carries whole parameters and never named a tool.
 *
 * This is the shape that reached the operator as raw markup: the model wrote
 * the taught `<tool_calls>` envelope, then the arguments, and never wrote an
 * invoke opener at all. Both of the reader's invoke-keyed passes stand down on
 * a block with no opener, so without a block-scope reading the whole thing fell
 * through to prose, ran nothing, and drew no note either — the note rules match
 * tool names and only an argument name was present.
 *
 * The reading is decidable exactly when one declared tool owns every argument
 * written, so the tests below pin both ends: the single-candidate block that
 * dispatches, and the two-candidate block that must refuse rather than pick.
 *
 * Every closing tag is assembled from parts. A spec that spells one as a single
 * token cannot itself be embedded in a markup document without truncating it —
 * the failure the reader exists to repair — so this file does not.
 */

import { describe, expect, it } from 'vitest'
import type { ToolSchema } from '@deepseek-ai/dsh-llm'
import { DsmlTranslator, toolIndex } from '../src/index.ts'
import type { DsmlEvent } from '../src/index.ts'

const WORD = 'parameter'
const P_OPEN = '<' + WORD + ' '
const P_CLOSE = '<' + '/' + WORD + '>'
const I_CLOSE = '<' + '/invoke>'
const C_OPEN = '<tool_calls>'
const C_CLOSE = '<' + '/tool_calls>'

const KERNEL: ToolSchema = {
  name: 'kernel',
  description: 'Run Python.',
  parameters: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'] },
}

const KERNEL_TOOLS = toolIndex([KERNEL])

/** One wrapped block: the envelope, then arguments, and no invoke opener. */
function wrapped(...arguments_: string[]): string {
  return [C_OPEN, ...arguments_, C_CLOSE].join('\n')
}

/** One whole argument element. */
function argument(name: string, value: string): string {
  return P_OPEN + 'name="' + name + '">' + value + P_CLOSE
}

function run(text: string, tools = KERNEL_TOOLS): { events: DsmlEvent[]; reader: DsmlTranslator } {
  const reader = new DsmlTranslator(tools)
  return { events: [...reader.push(text), ...reader.end()], reader }
}

/** The tool calls one reply produced, as name plus parsed arguments. */
function calls(text: string, tools = KERNEL_TOOLS): { name: string; arguments: Record<string, unknown> }[] {
  return run(text, tools)
    .events.filter((event): event is Extract<DsmlEvent, { kind: 'tool-call' }> => event.kind === 'tool-call')
    .map(event => ({ name: event.name, arguments: JSON.parse(event.arguments) as Record<string, unknown> }))
}

describe('a wrapped block with no invoke opener', () => {
  it('infers the one tool that owns the argument and runs it', () => {
    const produced = calls(wrapped(argument('code', 'print(1)')))
    expect(produced).toHaveLength(1)
    expect(produced[0]?.name).toBe('kernel')
    expect(String(produced[0]?.arguments.code).trim()).toBe('print(1)')
  })

  it('reports the shape it repaired', () => {
    expect(run(wrapped(argument('code', 'print(1)'))).reader.repairedShapes()).toContain('orphan-parameter')
  })

  it('leaves no raw markup in the visible text', () => {
    const visible = run(wrapped(argument('code', 'print(1)'))).events
      .filter((event): event is Extract<DsmlEvent, { kind: 'text' }> => event.kind === 'text')
      .map(event => event.text)
      .join('')
    expect(visible).not.toContain(P_OPEN)
    expect(visible).not.toContain(P_CLOSE)
  })

  it('carries a payload that itself quotes the format', () => {
    const payload = 'print(' + JSON.stringify(P_OPEN + 'name="code">x' + P_CLOSE) + ')'
    const produced = calls(wrapped(argument('code', payload)))
    expect(produced).toHaveLength(1)
    expect(String(produced[0]?.arguments.code).trim()).toBe(payload)
  })

  it('reads two arguments of one tool', () => {
    const SEARCH: ToolSchema = {
      name: 'search_files',
      description: 'Search files.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string' }, limit: { type: 'integer' } },
        required: ['query'],
      },
    }
    const produced = calls(
      wrapped(argument('query', 'pool'), argument('limit', '5')),
      toolIndex([SEARCH]),
    )
    expect(produced).toHaveLength(1)
    expect(produced[0]?.arguments).toMatchObject({ query: 'pool' })
  })
})

describe('a wrapped block that must not be read', () => {
  it('refuses when two declared tools own the argument name', () => {
    const TWIN: ToolSchema = {
      name: 'other',
      description: 'Also takes code.',
      parameters: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'] },
    }
    const text = wrapped(argument('code', 'print(1)'))
    expect(calls(text, toolIndex([KERNEL, TWIN]))).toEqual([])
    expect(run(text, toolIndex([KERNEL, TWIN])).reader.repairedShapes()).not.toContain('orphan-parameter')
  })

  it('refuses an argument whose own closer never arrived', () => {
    const open = wrapped(P_OPEN + 'name="code">print(1)')
    expect(calls(open)).toEqual([])
  })

  it('refuses a block with prose between two arguments', () => {
    const text = wrapped(argument('code', 'print(1)'), 'and then', argument('code', 'print(2)'))
    expect(calls(text)).toEqual([])
  })

  it('refuses an argument no declared tool owns', () => {
    expect(calls(wrapped(argument('nope', 'x')))).toEqual([])
  })

  it('refuses a duplicated argument name', () => {
    expect(calls(wrapped(argument('code', 'a'), argument('code', 'b')))).toEqual([])
  })

  it('leaves a well-formed invoke block alone', () => {
    const wellFormed = [C_OPEN, '<invoke name="kernel">', argument('code', 'print(1)'), I_CLOSE, C_CLOSE].join('\n')
    expect(run(wellFormed).reader.repairedShapes()).not.toContain('orphan-parameter')
    expect(calls(wellFormed)).toHaveLength(1)
  })

  it('does not fire on a single unwrapped argument line', () => {
    // The per-line reader owns that shape; the block reader must not double-report it.
    const line = argument('code', 'print(1)')
    const { events, reader } = run(line)
    expect(events.filter(event => event.kind === 'tool-call')).toHaveLength(1)
    expect(reader.repairedShapes()).toContain('orphan-parameter')
  })
})
