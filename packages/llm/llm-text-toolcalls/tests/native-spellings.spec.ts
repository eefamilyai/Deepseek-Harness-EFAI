
// The native dialects a live DeepSeek session actually emits, valid and malformed.
//
// The pipe-wrapped DSML token is the provider's own tool-call head, not the
// format we teach. It arrives in a FAMILY: one pipe or two, the DSML word on
// either side of the run, with or without a space before the payload word.
// Each spelling used to need its own pattern, so each new one was a silent
// failure. These cases pin the whole family, and pin that the rewrite is
// token-level -- it is the same one pass whether the surrounding call is
// well-formed or damaged, because the token rewrite never consults the block.

import { describe, expect, it } from 'vitest'
import { DsmlTranslator, toolIndex } from '../src/index.ts'
import type { DsmlEvent } from '../src/index.ts'
import type { ToolSchema } from '@deepseek-ai/dsh-llm'

// Assembled from character codes so this file never carries a literal closing
// tag in its source -- the reader under test is the thing that must survive one.
const LT = String.fromCharCode(60)
const GT = String.fromCharCode(62)
const SL = String.fromCharCode(47)
const FW = String.fromCharCode(0xFF5C)
const P1 = FW
const P2 = FW + FW

/** One native token: leading pipe run, optional slash, DSML, trailing run, payload. */
const T = (lead: string, closer: boolean, after: string, payload: string): string =>
  LT + lead + (closer ? SL : '') + 'DSML' + after + payload + GT

const READ: ToolSchema = {
  name: 'read',
  description: 'Read a file.',
  parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
}
const GLOB: ToolSchema = {
  name: 'glob',
  description: 'Match paths.',
  parameters: { type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'] },
}
const KERNEL: ToolSchema = {
  name: 'kernel',
  description: 'Run Python.',
  parameters: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'] },
}
const TOOLS = toolIndex([READ, GLOB, KERNEL])

interface Call {
  readonly name: string
  readonly arguments: Record<string, unknown>
}

const read = (lines: readonly string[]): { calls: Call[]; prose: string } => {
  const translator = new DsmlTranslator(TOOLS)
  const events: DsmlEvent[] = [...translator.push(lines.join('\n') + '\n'), ...translator.end()]
  return {
    calls: events
      .filter((event): event is Extract<DsmlEvent, { kind: 'tool-call' }> => event.kind === 'tool-call')
      .map(event => ({ name: event.name, arguments: JSON.parse(event.arguments) as Record<string, unknown> })),
    prose: events.filter(event => event.kind === 'text').map(event => event.text).join(''),
  }
}

/** A whole well-formed native call, spelled with the given pipe runs. */
const native = (lead: string, after: string, space: boolean, tool: string, arg: string, value: string): string[] => {
  const gap = space ? ' ' : ''
  return [
    T(lead, false, after, gap + 'calls'),
    T(lead, false, after, gap + `invoke name="${tool}"`),
    T(lead, false, after, gap + `parameter name="${arg}" string="true"`) + value + T('', true, after, 'parameter'),
    T('', true, after, gap + 'invoke'),
    T('', true, after, gap + 'calls'),
  ]
}

describe('every spelling of the native DSML token', () => {
  it('reads one pipe each side, with a space before the word', () => {
    expect(read(native(P1, P1, true, 'read', 'path', 'src/index.ts')).calls)
      .toEqual([{ name: 'read', arguments: { path: 'src/index.ts' } }])
  })

  it('reads two pipes each side, with a space', () => {
    expect(read(native(P2, P2, true, 'glob', 'pattern', '*/config.toml')).calls)
      .toEqual([{ name: 'glob', arguments: { pattern: '*/config.toml' } }])
  })

  it('reads the spelling with no space before the word', () => {
    expect(read(native(P2, P2, false, 'glob', 'pattern', '**/*.ts')).calls)
      .toEqual([{ name: 'glob', arguments: { pattern: '**/*.ts' } }])
  })

  it('reads pipes on the LEFT of the word only', () => {
    expect(read(native(P2, '', true, 'read', 'path', 'a.txt')).calls)
      .toEqual([{ name: 'read', arguments: { path: 'a.txt' } }])
  })

  it('reads pipes on the RIGHT of the word only', () => {
    expect(read(native('', P2, true, 'read', 'path', 'b.txt')).calls)
      .toEqual([{ name: 'read', arguments: { path: 'b.txt' } }])
  })

  it('reads an over-piped run of four', () => {
    expect(read(native(P2 + P2, P2 + P2, true, 'read', 'path', 'c.txt')).calls)
      .toEqual([{ name: 'read', arguments: { path: 'c.txt' } }])
  })

  it('leaves no prose behind for any well-formed spelling', () => {
    expect(read(native(P2, P2, true, 'read', 'path', 'x.txt')).prose.trim()).toBe('')
  })
})

describe('the token rewrite is the same pass when the call is damaged', () => {
  it('dispatches a closer-spammed native block, and books the surplus', () => {
    // One argument closer too many. Structure says the surplus tag is framing,
    // not value: the rewrite already produced a complete call, so it runs.
    const translator = new DsmlTranslator(TOOLS)
    const lines = [
      T(P2, false, P2, ' calls'),
      T(P2, false, P2, ' invoke name="read"'),
      T(P2, false, P2, ' parameter name="path" string="true"') + 'd.txt',
      T('', true, P2, 'parameter'),
      T('', true, P2, 'parameter'),
      T('', true, P2, ' invoke'),
      T('', true, P2, ' calls'),
    ]
    const events: DsmlEvent[] = [...translator.push(lines.join('\n') + '\n'), ...translator.end()]
    const calls = events
      .filter((event): event is Extract<DsmlEvent, { kind: 'tool-call' }> => event.kind === 'tool-call')
      .map(event => ({ name: event.name, arguments: JSON.parse(event.arguments) as Record<string, unknown> }))
    expect(calls).toEqual([{ name: 'read', arguments: { path: 'd.txt\n' } }])
    expect([...translator.repairedShapes()]).toContain('surplus-closer')
  })

  it('dispatches a native block that lost its invoke opener entirely', () => {
    const lines = [
      T(P2, false, P2, ' calls'),
      T(P2, false, P2, ' parameter name="code" string="true"') + 'print(1)' + T('', true, P2, 'parameter'),
      T('', true, P2, ' calls'),
    ]
    expect(read(lines).calls).toEqual([{ name: 'kernel', arguments: { code: 'print(1)' } }])
  })

  it('dispatches a native block whose second parameter lost its name attribute', () => {
    const lines = [
      T(P2, false, P2, ' invoke name="read"'),
      T(P2, false, P2, ' parameter name="path" string="true"') + 'e.txt' + T('', true, P2, 'parameter'),
      T('', true, P2, ' path2" string="false"') + 'f.txt' + T('', true, P2, 'parameter'),
      T('', true, P2, ' invoke'),
    ]
    expect(read(lines).calls).toEqual([{ name: 'read', arguments: { path: 'e.txt', path2: 'f.txt' } }])
  })

  it('still refuses a native block cut off mid-argument, and says so', () => {
    // The one malformed shape that must NOT run: no closer ever arrived, so
    // nothing proves the argument ended. It stays visible with a note.
    const lines = [
      T(P2, false, P2, ' calls'),
      T(P2, false, P2, ' invoke name="kernel"'),
      T(P2, false, P2, ' parameter name="code" string="true"') + '1+1',
    ]
    const { calls, prose } = read(lines)
    expect(calls).toEqual([])
    expect(prose).toContain('unfinished tool call')
  })
})
