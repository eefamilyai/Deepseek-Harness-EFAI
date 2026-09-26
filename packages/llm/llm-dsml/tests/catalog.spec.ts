/**
 * The repair catalogue: what the reader knows how to repair, and what it
 * remembers repairing.
 *
 * {@link DsmlTranslator} repairs malformed tool-call markup every turn, and it
 * does so silently, because a repaired call runs. `KNOWN_SHAPES` is the set it
 * can repair; `recordShape` and `bumpShapes` are the memory of a shape being
 * live in the wild, so the next investigation starts from a written-down
 * example instead of a transcript.
 *
 * Every tag below is assembled from parts. A test that spells a closing tag as
 * one literal token cannot itself be embedded in a markup document without
 * truncating it — the exact failure the reader exists to repair — so this file
 * does not.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolSchema } from '@deepseek-ai/dsh-llm'
import {
  bumpShapes,
  catalogPath,
  DsmlTranslator,
  KNOWN_SHAPES,
  loadCatalog,
  recordShape,
  toolIndex,
} from '../src/index.ts'
import type { DsmlEvent } from '../src/index.ts'

/** The tag word under test, kept apart so no closing tag appears as one token. */
const WORD = 'parameter'
const P_OPEN = '<' + WORD + ' '
const P_CLOSE = '<' + '/' + WORD + '>'
const I_OPEN = '<invoke name="'
const I_CLOSE = '<' + '/invoke>'
const C_OPEN = '<tool_calls>'
const C_CLOSE = '<' + '/tool_calls>'

const SKILL: ToolSchema = {
  name: 'skill',
  description: 'Load a skill.',
  parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
}

const READ: ToolSchema = {
  name: 'read',
  description: 'Read a file.',
  parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
}

const TOOLS = toolIndex([SKILL, READ])

/** One invoke for `tool` whose single argument closes, then closes again. */
function surplusInvoke(tool: string, argument: string, value: string): string {
  return [
    I_OPEN + tool + '">',
    P_OPEN + 'name="' + argument + '">' + value,
    P_CLOSE,
    P_CLOSE,
    I_CLOSE,
  ].join('\n')
}

/** One invoke for `tool`, written the way the format asks for. */
function wellFormedInvoke(tool: string, argument: string, value: string): string {
  return [I_OPEN + tool + '">', P_OPEN + 'name="' + argument + '">' + value, P_CLOSE, I_CLOSE].join('\n')
}

/** Wrap a body in the taught envelope. */
function envelope(...body: string[]): string {
  return [C_OPEN, ...body, C_CLOSE].join('\n')
}

/** Feed one whole reply through a reader and hand back both halves. */
function run(text: string): { events: DsmlEvent[]; reader: DsmlTranslator } {
  const reader = new DsmlTranslator(TOOLS)
  return { events: [...reader.push(text), ...reader.end()], reader }
}

/** The names of the calls one reply produced. */
function callNames(text: string): string[] {
  return run(text).events.filter(event => event.kind === 'tool-call').map(event => event.name)
}

let dir: string | undefined

afterEach(() => {
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
  dir = undefined
})

/** A path in a fresh temp directory, with no catalogue written yet. */
function freshPath(): string {
  dir = mkdtempSync(join(tmpdir(), 'dsml-catalog-'))
  return join(dir, 'catalog.json')
}

/** The whole shape list a path resolves to, by id. */
function idsAt(path: string): string[] {
  return loadCatalog(path).map(shape => shape.id)
}

describe('surplus closer', () => {
  it('dispatches every call of a block where each one closed twice', () => {
    const text = envelope(
      surplusInvoke('skill', 'name', 'a'),
      surplusInvoke('skill', 'name', 'b'),
      surplusInvoke('skill', 'name', 'c'),
    )
    const { events, reader } = run(text)
    expect(events.filter(event => event.kind === 'tool-call')).toHaveLength(3)
    expect(reader.repairedShapes()).toContain('surplus-closer')
  })

  it('leaves a well-formed block unrepaired', () => {
    const { events, reader } = run(envelope(wellFormedInvoke('read', 'path', 'a.txt')))
    expect(events.filter(event => event.kind === 'tool-call')).toHaveLength(1)
    expect(reader.repairedShapes()).toEqual([])
  })

  it('refuses a call whose last argument never closed', () => {
    const truncated = [I_OPEN + 'read">', P_OPEN + 'name="path">a.txt', I_CLOSE].join('\n')
    const { events, reader } = run(envelope(truncated))
    expect(events.filter(event => event.kind === 'tool-call')).toHaveLength(0)
    expect(reader.repairedShapes()).toEqual([])
  })

  it('reads a wrapper-closed call that also closed twice', () => {
    const text = [C_OPEN, I_OPEN + 'read">', P_OPEN + 'name="path">a.txt', P_CLOSE, P_CLOSE, C_CLOSE].join('\n')
    expect(callNames(text)).toEqual(['read'])
  })
})

describe('the repair catalogue', () => {
  it('ships every known shape with nothing on disk', () => {
    expect(idsAt(freshPath())).toEqual(KNOWN_SHAPES.map(shape => shape.id))
  })

  it('appends a shape the seed has never seen exactly once', () => {
    const path = freshPath()
    const shape = { id: 'two-openers-one-close', saw: 'x', fix: 'y', example: 'z' }
    expect(recordShape(shape, path)).toBe(true)
    expect(recordShape(shape, path)).toBe(false)
    const shapes = loadCatalog(path)
    expect(shapes.filter(entry => entry.id === shape.id)).toHaveLength(1)
    expect(shapes).toHaveLength(KNOWN_SHAPES.length + 1)
  })

  it('ignores a file it did not write', () => {
    const path = freshPath()
    writeFileSync(path, 'not json at all', 'utf8')
    expect(idsAt(path)).toEqual(KNOWN_SHAPES.map(shape => shape.id))
  })

  it('discards a partial entry whole', () => {
    const path = freshPath()
    writeFileSync(path, JSON.stringify({ version: 1, shapes: [{ id: 'half-a-shape' }] }), 'utf8')
    expect(idsAt(path)).not.toContain('half-a-shape')
  })

  it('lets the seed win on a shared id', () => {
    const path = freshPath()
    writeFileSync(path, JSON.stringify({
      version: 1,
      shapes: [{ id: 'surplus-closer', saw: 'stale', fix: 'stale', example: 'stale' }],
    }), 'utf8')
    expect(loadCatalog(path).find(shape => shape.id === 'surplus-closer')?.fix).not.toBe('stale')
  })

  it('resolves the path by fixed lookup, never by search', () => {
    expect(catalogPath('/explicit.json')).toBe('/explicit.json')
    expect(catalogPath(undefined, { DSML_CATALOG: '/from-env.json' })).toBe('/from-env.json')
    expect(catalogPath(undefined, {})).toMatch(/dsml-catalog\.json$/)
  })
})

describe('hit counts', () => {
  it('adds one hit per repair, in one write', () => {
    const path = freshPath()
    expect(bumpShapes(['surplus-closer', 'surplus-closer'], path)).toBe(true)
    expect(loadCatalog(path).find(shape => shape.id === 'surplus-closer')?.hits).toBe(2)
    expect(bumpShapes(['surplus-closer'], path)).toBe(true)
    expect(loadCatalog(path).find(shape => shape.id === 'surplus-closer')?.hits).toBe(3)
  })

  it('ignores an id no rule stands behind', () => {
    expect(bumpShapes(['never-seen'], freshPath())).toBe(false)
  })

  it('does nothing for an empty turn', () => {
    expect(bumpShapes([], freshPath())).toBe(false)
  })
})
