// The closer a model writes on the WRONG TAG, and the shapes that produces.
//
// The most common malformation a live session emits is neither a missing closer
// nor an extra one: it is the LAST argument's closer spelled with the INVOKE tag
// name, followed by the invoke's own closer. `unfinished()` counts only argument
// closers, so that tag left the last argument open forever, the whole block read
// as cut off mid-write, and a complete, correct call was dumped as prose beside a
// note saying the tool never finished. These cases pin the repair, and pin that it
// stays narrow: a value QUOTING a balanced invoke pair is content, and a body with
// two arguments still open is still refused.

import { describe, expect, it } from 'vitest'
import { DsmlTranslator, toolIndex } from '../src/index.ts'
import type { DsmlEvent } from '../src/index.ts'
import type { ToolSchema } from '@deepseek-ai/dsh-llm'

// Assembled from character codes so this file never carries a literal closing tag
// in its source -- the reader under test is the thing that must survive one.
const LT = String.fromCharCode(60)
const GT = String.fromCharCode(62)
const SL = String.fromCharCode(47)

const OPEN = 'tool_calls'
const INVOKE = 'invoke'
const PARAMETER = 'parameter'

/** A bare opening tag, or a closing one. */
const tag = (name: string, closer = false): string => LT + (closer ? SL : '') + name + GT
/** An opening tag carrying one `name="..."` attribute. */
const named = (name: string, value: string): string => LT + name + ' name="' + value + '"' + GT

const KERNEL: ToolSchema = {
  name: 'kernel',
  description: 'Run Python.',
  parameters: {
    type: 'object',
    properties: { code: { type: 'string' }, timeoutMs: { type: 'number' } },
    required: ['code'],
  },
}
const TOOLS = toolIndex([KERNEL])

const CODE = "\nimport os\nprint('hi')\n"

function events(text: string): DsmlEvent[] {
  const translator = new DsmlTranslator(TOOLS)
  return [...translator.push(text), ...translator.end()]
}

type ToolCall = Extract<DsmlEvent, { kind: 'tool-call' }>

function calls(text: string): ToolCall[] {
  return events(text).filter((event): event is ToolCall => event.kind === 'tool-call')
}

function prose(text: string): string {
  return events(text)
    .filter((event): event is Extract<DsmlEvent, { kind: 'text' }> => event.kind === 'text')
    .map(event => event.text)
    .join('')
}

function args(event: ToolCall): Record<string, unknown> {
  return JSON.parse(event.arguments)
}

/** Both arguments opened; the LAST one deliberately left without its own closer. */
const bodyNeedingBoundary = (): string =>
  named(PARAMETER, 'code') + CODE + tag(PARAMETER, true) +
  named(PARAMETER, 'timeoutMs') + '600000'

/** Both arguments properly closed. */
const bodyWhole = (): string =>
  bodyNeedingBoundary() + tag(PARAMETER, true)

describe('an argument terminated by an invoke closer', () => {
  it('dispatches when the wrapper is closed after it', () => {
    const text =
      tag(OPEN) + named(INVOKE, 'kernel') + bodyNeedingBoundary() +
      tag(INVOKE, true) + tag(INVOKE, true) + tag(OPEN, true)
    const found = calls(text)
    expect(found).toHaveLength(1)
    expect(found[0]?.name).toBe('kernel')
    expect(args(found[0]!)).toEqual({ code: CODE, timeoutMs: 600000 })
    expect(prose(text)).toBe('')
  })

  it('dispatches with no wrapper at all', () => {
    const text =
      named(INVOKE, 'kernel') + bodyNeedingBoundary() +
      tag(INVOKE, true) + tag(INVOKE, true)
    const found = calls(text)
    expect(found).toHaveLength(1)
    expect(args(found[0]!)).toEqual({ code: CODE, timeoutMs: 600000 })
    expect(prose(text)).toBe('')
  })

  it('dispatches however many invoke closers trail the block', () => {
    const text =
      tag(OPEN) + named(INVOKE, 'kernel') + bodyNeedingBoundary() +
      tag(INVOKE, true).repeat(8) + tag(OPEN, true)
    const found = calls(text)
    expect(found).toHaveLength(1)
    expect(args(found[0]!)).toEqual({ code: CODE, timeoutMs: 600000 })
  })

  it('dispatches a whole body, which never needed the repair', () => {
    const text =
      tag(OPEN) + named(INVOKE, 'kernel') + bodyWhole() +
      tag(INVOKE, true) + tag(OPEN, true)
    const found = calls(text)
    expect(found).toHaveLength(1)
    expect(args(found[0]!)).toEqual({ code: CODE, timeoutMs: 600000 })
    expect(prose(text)).toBe('')
  })

  it('reads a second, mis-closed call beside a whole one', () => {
    const text =
      tag(OPEN) +
      named(INVOKE, 'kernel') + bodyWhole() + tag(INVOKE, true) +
      named(INVOKE, 'kernel') + bodyNeedingBoundary() + tag(INVOKE, true) + tag(INVOKE, true) +
      tag(OPEN, true)
    const found = calls(text)
    expect(found).toHaveLength(2)
    expect(args(found[1]!)).toEqual({ code: CODE, timeoutMs: 600000 })
  })
})

describe('the repair stays narrow', () => {
  it('keeps an invoke pair a value legitimately quotes', () => {
    const quoted = 'show ' + named(INVOKE, 'x') + tag(INVOKE, true)
    const text =
      tag(OPEN) + named(INVOKE, 'kernel') +
      named(PARAMETER, 'code') + quoted + tag(PARAMETER, true) +
      tag(INVOKE, true) + tag(OPEN, true)
    const found = calls(text)
    expect(found).toHaveLength(1)
    expect(args(found[0]!)).toEqual({ code: quoted })
  })

  it('refuses a body with two arguments still open', () => {
    const text =
      tag(OPEN) + named(INVOKE, 'kernel') +
      named(PARAMETER, 'code') + CODE +
      named(PARAMETER, 'timeoutMs') + '600000' +
      tag(INVOKE, true) + tag(INVOKE, true) + tag(OPEN, true)
    expect(calls(text)).toHaveLength(0)
    expect(prose(text).length).toBeGreaterThan(0)
  })

  it('never coerces an unknown tool name', () => {
    const text =
      tag(OPEN) + named(INVOKE, 'nope') + bodyNeedingBoundary() +
      tag(INVOKE, true) + tag(INVOKE, true) + tag(OPEN, true)
    expect(calls(text)).toHaveLength(0)
  })
})
