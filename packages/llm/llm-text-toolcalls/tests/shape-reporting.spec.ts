/**
 * Every shape the catalogue names is a shape the reader reports.
 *
 * The catalogue in `src/catalog.ts` is the written-down list of malformations
 * this reader repairs, and `DsmlTranslator.repairedShapes()` is how a turn says
 * which of them it met. The two have to agree: an id the reader can repair but
 * never reports is a shape the hit counter can never see, and the next
 * investigation starts from nothing — which is the exact failure the catalogue
 * exists to end.
 *
 * So each case below feeds one shape and asserts its id comes back. A shape
 * whose repair is silent fails here rather than going unnoticed.
 *
 * Every closing tag is assembled from parts. A spec that spells one as a single
 * token cannot itself be embedded in a markup document without truncating it —
 * the failure the reader exists to repair — so this file does not.
 */

import { describe, expect, it } from 'vitest'
import type { ToolSchema } from '@deepseek-ai/dsh-llm'
import { DsmlTranslator, KNOWN_SHAPES, toolIndex } from '../src/index.ts'
import type { DsmlEvent } from '../src/index.ts'

const WORD = 'parameter'
const P_OPEN = '<' + WORD + ' '
const P_CLOSE = '<' + '/' + WORD + '>'
const I_OPEN = '<invoke name="'
const I_CLOSE = '<' + '/invoke>'
const EQ_INVOKE = '<' + 'invoke="read"' + '>'
const C_OPEN = '<tool_calls>'
const C_CLOSE = '<' + '/tool_calls>'

const READ: ToolSchema = {
  name: 'read',
  description: 'Read a file.',
  parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
}

const SEARCH: ToolSchema = {
  name: 'search_files',
  description: 'Search files.',
  parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
}

const KERNEL: ToolSchema = {
  name: 'kernel',
  description: 'Run Python.',
  parameters: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'] },
}

const TOOLS = toolIndex([READ, SEARCH, KERNEL])

/** Feed one reply through a reader and hand back its events and the reader. */
function run(text: string): { events: DsmlEvent[]; reader: DsmlTranslator } {
  const reader = new DsmlTranslator(TOOLS)
  return { events: [...reader.push(text), ...reader.end()], reader }
}

/** The shape ids one reply reported. */
function shapesOf(text: string): readonly string[] {
  return run(text).reader.repairedShapes()
}

/** One invoke for `tool` with a single parameter, written the taught way. */
function invoke(tool: string, argument: string, value: string): string {
  return [I_OPEN + tool + '">', P_OPEN + 'name="' + argument + '">' + value, P_CLOSE, I_CLOSE].join('\n')
}

describe('a repaired shape is reported', () => {
  it('reports closer-stripped', () => {
    const stripped = C_OPEN + '\n' + I_OPEN + 'read">\n' + P_OPEN + 'name="path">a.txt\n' + I_OPEN + 'read">\n' + P_OPEN + 'name="path">b.txt\n' + C_CLOSE
    expect(shapesOf(stripped)).toContain('closer-stripped')
  })

  it('reports surplus-closer', () => {
    const doubled = [I_OPEN + 'read">', P_OPEN + 'name="path">a.txt', P_CLOSE, P_CLOSE, I_CLOSE].join('\n')
    expect(shapesOf(C_OPEN + '\n' + doubled + '\n' + C_CLOSE)).toContain('surplus-closer')
  })

  it('reports missing-invoke-close', () => {
    const wrapperClosed = [C_OPEN, I_OPEN + 'read">', P_OPEN + 'name="path">a.txt', P_CLOSE, C_CLOSE].join('\n')
    expect(shapesOf(wrapperClosed)).toContain('missing-invoke-close')
  })

  it('reports json-body', () => {
    const object = C_OPEN + '\n' + I_OPEN + 'search_files">' + '{ "query": "pool" }' + I_CLOSE + '\n' + C_CLOSE
    expect(shapesOf(object)).toContain('json-body')
  })

  it('reports orphan-closer', () => {
    expect(shapesOf('The call ran.' + P_CLOSE + '\n')).toContain('orphan-closer')
  })

  it('reports system-reminder-echo', () => {
    const recited = '<system_reminder>' + '\n' + 'You have tools.' + '\n' + '<' + '/system_reminder>' + '\n'
    expect(shapesOf(recited)).toContain('system-reminder-echo')
  })

  it('reports orphan-parameter', () => {
    expect(shapesOf(P_OPEN + 'name="path">a.txt' + P_CLOSE + '\n')).toContain('orphan-parameter')
  })

  it('reports tool-named-tag', () => {
    expect(shapesOf('<' + 'read path="a.txt"/>' + '\n')).toContain('tool-named-tag')
  })

  it('reports equals-tag', () => {
    const equals = [C_OPEN, EQ_INVOKE, P_OPEN + 'name="path">a.txt', P_CLOSE, I_CLOSE, C_CLOSE].join('\n')
    const { events, reader } = run(equals)
    expect(reader.repairedShapes()).toContain('equals-tag')
    const call = events.find(
      (event): event is Extract<DsmlEvent, { kind: 'tool-call' }> => event.kind === 'tool-call',
    )
    expect(call && JSON.parse(call.arguments)).toEqual({ path: 'a.txt\n' })
  })
})

describe('an unrepaired turn reports nothing', () => {
  it('reports nothing for a well-formed call', () => {
    expect(shapesOf(C_OPEN + '\n' + invoke('read', 'path', 'a.txt') + '\n' + C_CLOSE)).toEqual([])
  })

  it('reports nothing for plain prose', () => {
    expect(shapesOf('Let me read that file for you.' + '\n')).toEqual([])
  })

  it('reports nothing for a mention inside a code span', () => {
    expect(shapesOf('Write `' + I_OPEN + 'read">` to call it.' + '\n')).toEqual([])
  })
})

describe('the catalogue and the reader agree', () => {
  it('names every id with a kebab-case key', () => {
    for (const shape of KNOWN_SHAPES) {
      expect(shape.id).toMatch(/^[a-z][a-z0-9-]*$/)
    }
  })

  it('ships no duplicate id', () => {
    const ids = KNOWN_SHAPES.map(shape => shape.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('the argument repair', () => {
  const SAVE: ToolSchema = {
    name: 'save',
    description: 'Save a file.',
    parameters: {
      type: 'object',
      properties: { file_path: { type: 'string' }, timeoutMs: { type: 'number' } },
      required: ['file_path'],
    },
  }
  const SAVE_TOOLS = toolIndex([SAVE])

  /** The arguments one reply produced, and the reader that produced them. */
  function argsOf(
    text: string,
    tools = SAVE_TOOLS,
  ): { args: Record<string, unknown>; reader: DsmlTranslator } {
    const reader = new DsmlTranslator(tools)
    const events = [...reader.push(text), ...reader.end()]
    const call = events.find(
      (event): event is Extract<DsmlEvent, { kind: 'tool-call' }> => event.kind === 'tool-call',
    )
    return { args: call === undefined ? {} : (JSON.parse(call.arguments) as Record<string, unknown>), reader }
  }

  it('reports near-miss-argument', () => {
    const text = C_OPEN + '\n' + invoke('save', 'filePath', 'a.txt') + '\n' + C_CLOSE
    const { args, reader } = argsOf(text)
    expect(reader.repairedShapes()).toContain('near-miss-argument')
    expect(Object.keys(args)).toEqual(['file_path'])
  })

  it('reports quoted-scalar', () => {
    const text = C_OPEN + '\n' + invoke('save', 'timeoutMs', '"30"') + '\n' + C_CLOSE
    const { args, reader } = argsOf(text)
    expect(reader.repairedShapes()).toContain('quoted-scalar')
    expect(args.timeoutMs).toBe(30)
  })

  it('refuses a name two declared slots could mean', () => {
    const AMBIG: ToolSchema = {
      name: 'fetch_url',
      description: 'Fetch a URL.',
      parameters: {
        type: 'object',
        properties: { timeoutMs: { type: 'number' }, timeoutSec: { type: 'number' } },
      },
    }
    const text = C_OPEN + '\n' + invoke('fetch_url', 'timeout', '30') + '\n' + C_CLOSE
    const { args, reader } = argsOf(text, toolIndex([AMBIG]))
    expect(reader.repairedShapes()).not.toContain('near-miss-argument')
    expect(Object.keys(args)).toEqual(['timeout'])
  })

  it('leaves a quoted argument of a string parameter alone', () => {
    const text = C_OPEN + '\n' + invoke('read', 'path', '"a.txt"') + '\n' + C_CLOSE
    const { args, reader } = argsOf(text, toolIndex([READ]))
    expect(reader.repairedShapes()).not.toContain('quoted-scalar')
    expect(String(args.path).trim()).toBe('"a.txt"')
  })

  it('leaves a spelled-out argument alone', () => {
    const text = C_OPEN + '\n' + invoke('save', 'file_path', 'a.txt') + '\n' + C_CLOSE
    const { args, reader } = argsOf(text)
    expect(reader.repairedShapes()).toEqual([])
    expect(Object.keys(args)).toEqual(['file_path'])
  })
})
