// A block whose closers a transport stripped must still dispatch every call.

import { describe, expect, it } from 'vitest'
import { restoreStrippedClosers } from '../src/dsml.ts'
import { DsmlTranslator, toolIndex } from '../src/index.ts'
import type { DsmlEvent } from '../src/index.ts'
import type { ToolSchema } from '@deepseek-ai/dsh-llm'
import { existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const LT = String.fromCharCode(60), GT = String.fromCharCode(62), SL = String.fromCharCode(47)
const PC = LT + SL + 'parameter' + GT
const IC = LT + SL + 'invoke' + GT
const OP = LT + 'parameter'
const OI = LT + 'invoke'
const counts = (s: string) => ({
  po: (s.match(new RegExp(OP + '\\b', 'gi')) ?? []).length,
  pc: (s.match(new RegExp(PC, 'gi')) ?? []).length,
  io: (s.match(new RegExp(OI + '\\b', 'gi')) ?? []).length,
  ic: (s.match(new RegExp(IC, 'gi')) ?? []).length,
})

describe('restoreStrippedClosers', () => {
  it('restores a stripped two-call block', () => {
    const stripped = OI + ' name="grep"' + GT + ' ' + OP + ' name="pattern"' + GT + 'A '
      + OP + ' name="path"' + GT + 'B '
      + OI + ' name="grep"' + GT + ' ' + OP + ' name="pattern"' + GT + 'C '
      + OP + ' name="path"' + GT + 'D'
    const fixed = restoreStrippedClosers(stripped)
    expect(counts(fixed)).toEqual({ po: 4, pc: 4, io: 2, ic: 2 })
  })

  it('is idempotent', () => {
    const stripped = OI + ' name="a"' + GT + ' ' + OI + ' name="b"' + GT + ' x'
    const once = restoreStrippedClosers(stripped)
    expect(restoreStrippedClosers(once)).toBe(once)
  })

  it('leaves a single truncated invoke alone', () => {
    const cut = OI + ' name="read"' + GT + ' ' + OP + ' name="path"' + GT + 'a'
    expect(restoreStrippedClosers(cut)).toBe(cut)
  })

  it('leaves a block that kept a closer alone', () => {
    const half = OI + ' name="a"' + GT + PC + ' ' + OI + ' name="b"' + GT + ' x'
    expect(restoreStrippedClosers(half)).toBe(half)
  })

  it('ignores prose with no openers', () => {
    expect(restoreStrippedClosers('nothing here')).toBe('nothing here')
  })
})

describe('the learned-literal layer stays inert', () => {
  it('replays nothing when no catalogue is established', async () => {
    const m = await import('../src/catalog.ts')
    const prior = process.env.DSML_CATALOG
    delete process.env.DSML_CATALOG
    try {
      expect(m.learnedLiterals()).toEqual([])
    } finally {
      if (prior === undefined) delete process.env.DSML_CATALOG
      else process.env.DSML_CATALOG = prior
    }
  })

  it('writes nothing when no catalogue is established', async () => {
    const m = await import('../src/catalog.ts')
    const prior = process.env.DSML_CATALOG
    delete process.env.DSML_CATALOG
    try {
      expect(m.recordLiteral('x-broken', 'x-fixed')).toBe(false)
    } finally {
      if (prior === undefined) delete process.env.DSML_CATALOG
      else process.env.DSML_CATALOG = prior
    }
  })

  it('refuses to store a structural closer as a rewrite', async () => {
    const m = await import('../src/catalog.ts')
    const tmp = join(tmpdir(), 'dsml-guard-' + Math.random().toString(36).slice(2) + '.json')
    const LT = String.fromCharCode(60), SL = String.fromCharCode(47), GT = String.fromCharCode(62)
    const closer = LT + SL + 'invoke' + GT
    try {
      expect(m.recordLiteral(closer, '', tmp)).toBe(false)
      expect(m.learnedLiterals(tmp)).toEqual([])
    } finally {
      if (existsSync(tmp)) rmSync(tmp, { force: true })
    }
  })
})

describe('a closer-stripped block, end to end', () => {
  const READ: ToolSchema = {
    name: 'read',
    description: 'Read a file.',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  }
  const TOOLS = toolIndex([READ])
  const oneLine = OI + ' name="read"' + GT + ' ' + OP + ' name="path"' + GT + 'a.txt '
    + OI + ' name="read"' + GT + ' ' + OP + ' name="path"' + GT + 'b.txt'
  const acrossLines = LT + 'tool_calls' + GT + '\n'
    + OI + ' name="read"' + GT + '\n'
    + OP + ' name="path"' + GT + 'a.txt\n'
    + OI + ' name="read"' + GT + '\n'
    + OP + ' name="path"' + GT + 'b.txt\n'

  // `arguments` is a JSON string on the event, not an object, so the value the
  // tool would actually receive is only visible once it is parsed here.
  const pairsOf = (events: readonly DsmlEvent[]): [string, Record<string, unknown>][] => {
    const pairs: [string, Record<string, unknown>][] = []
    for (const event of events) {
      if (event.kind !== 'tool-call') continue
      pairs.push([event.name, JSON.parse(event.arguments) as Record<string, unknown>])
    }
    return pairs
  }
  const run = (text: string): DsmlEvent[] => {
    const translator = new DsmlTranslator(TOOLS)
    return [...translator.push(text), ...translator.end()]
  }

  it('dispatches every call of a stripped block on one line', () => {
    expect(pairsOf(run(oneLine + '\n'))).toEqual([
      ['read', { path: 'a.txt' }],
      ['read', { path: 'b.txt' }],
    ])
  })

  it('dispatches every call of a stripped block across lines', () => {
    expect(pairsOf(run(acrossLines))).toEqual([
      ['read', { path: 'a.txt' }],
      ['read', { path: 'b.txt' }],
    ])
  })

  it('names the shape it repaired', () => {
    const translator = new DsmlTranslator(TOOLS)
    translator.push(oneLine + '\n')
    translator.end()
    expect(translator.repairedShapes()).toContain('closer-stripped')
  })
})
