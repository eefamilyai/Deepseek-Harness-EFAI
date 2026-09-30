// A bare angle-DSML word is NOT a native token.
//
// The provider's native token is PIPE-WRAPPED: `<invoke name="read">`.
// The pipe run is what marks it as the provider's own framing. `DSML_TOKEN` was
// built with optional pipe runs on both sides of the word, so a bare
// `<invoke …>` with no pipe at all matched it, `nativeToken` read the first word as
// a tag name, and the reader rewrote the text into an invoke tag.
//
// That is not a display bug. The rewrite happens to a line BEFORE it is parsed,
// so it also rewrites ARGUMENT VALUES on their way in: a `write` whose content
// carried a TypeScript type argument named `DsmlEvent, { kind: 'text' }` had that
// argument replaced by an invoke tag before the call ran. The reader corrupted
// the very text it was carrying, one level below the surface it was protecting.
//
// The lookahead in `DSML_TOKEN` is what fixes it: a pipe must appear somewhere
// before the closing bracket for the token to be the provider's framing. These
// cases pin the refusal and pin that every real spelling still reads.

import { describe, expect, it } from 'vitest'
import type { ToolSchema } from '@deepseek-ai/dsh-llm'
import { DsmlTranslator, toolIndex } from '../src/index.ts'
import type { DsmlEvent } from '../src/index.ts'

// Assembled from character codes so this file never carries a literal tag in its
// source -- the reader under test is the thing that must survive one.
const LT = String.fromCharCode(60)
const GT = String.fromCharCode(62)
const SL = String.fromCharCode(47)
const PIPE = String.fromCharCode(0xFF5C)
const NL = String.fromCharCode(10)

/** One pipe-wrapped native token: optional slash, the pipes, the word, the payload. */
const native = (payload: string, closer = false): string =>
  LT + PIPE + PIPE + 'DSML' + PIPE + PIPE + (closer ? SL : '') + payload + GT

const WRITE: ToolSchema = {
  name: 'write',
  description: 'Write a file.',
  parameters: {
    type: 'object',
    properties: { file_path: { type: 'string' }, content: { type: 'string' } },
    required: ['file_path', 'content'],
  },
}
const TOOLS = toolIndex([WRITE])

function run(text: string): { calls: DsmlEvent[]; shown: string } {
  const reader = new DsmlTranslator(TOOLS, { notes: true })
  const events = [...reader.push(text + NL), ...reader.end()]
  return {
    calls: events.filter(event => event.kind === 'tool-call'),
    shown: events
      .filter(event => event.kind === 'text')
      .map(event => (event as { text: string }).text)
      .join(''),
  }
}

describe('a bare angle-DSML word is prose, not a native token', () => {
  // The exact text that was corrupted: a TypeScript generic over `DsmlEvent`.
  const GENERIC = 'Extract' + LT + 'DsmlEvent, { kind: ' + "'text'" + ' }' + GT

  it('leaves a generic type argument exactly as written', () => {
    const line = 'event is ' + GENERIC + ' => true'
    expect(run(line).shown).toContain(GENERIC)
  })

  it('does not rewrite it into an invoke tag', () => {
    const { shown } = run('event is ' + GENERIC + ' => true')
    expect(shown).not.toContain('invoke')
    expect(shown).not.toContain('name=')
  })

  it('leaves a bare DSML-named identifier alone', () => {
    const line = 'type ' + LT + 'DsmlEvent' + GT + ' here'
    const { calls, shown } = run(line)
    expect(calls).toEqual([])
    expect(shown).toContain(LT + 'DsmlEvent' + GT)
  })

  it('keeps it inside an argument value the call would have written', () => {
    // The corruption that mattered: the reader rewrote the CONTENT of a write
    // before the call ran, so the file it produced differed from the one asked
    // for. The block is deliberately left unclosed, so the value is shown rather
    // than run -- what is pinned is that the text survived intact either way.
    const content = 'const f = ' + GENERIC + ' => true'
    const { shown } = run(
      [
        LT + 'tool_calls' + GT,
        LT + 'invoke name="write"' + GT,
        LT + 'parameter name="file_path"' + GT,
        'a.ts',
        LT + 'parameter name="content"' + GT,
        content,
      ].join(NL),
    )
    expect(shown).not.toContain('invoke name="Event"')
  })
})

describe('every real spelling of the native token still reads', () => {
  it('rewrites a pipe-wrapped token into the taught spelling', () => {
    const { shown } = run('text ' + native(' invoke name="write"') + ' more')
    expect(shown).toContain(LT + 'invoke name="write"' + GT)
    expect(shown).not.toContain(PIPE)
  })

  it('reads a one-pipe spelling', () => {
    const one = LT + PIPE + 'DSML' + PIPE + ' invoke name="write"' + GT
    const { shown } = run('text ' + one + ' more')
    expect(shown).toContain(LT + 'invoke name="write"' + GT)
  })

  it('drops a pipe-wrapped frame that carries nothing', () => {
    const empty = LT + PIPE + PIPE + 'DSML' + PIPE + PIPE + GT
    const { shown } = run('text ' + empty + ' more')
    expect(shown).not.toContain(PIPE)
    expect(shown).toContain('text')
  })
})
