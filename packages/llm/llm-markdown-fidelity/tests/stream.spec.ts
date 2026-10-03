/**
 * The repair while the text is still arriving.
 *
 * A glue can be split across deltas, so the pass withholds only the tail that could still
 * turn out to be a delimiter row. These specs cut the same answer at every position and
 * require the same repaired stream, which is the property a stream pass has to hold.
 */

import { describe, expect, it } from 'vitest'
import type { ContentBlock, StreamChunk } from '@deepseek-ai/dsh-llm'
import { readMarkdownFidelity } from '@deepseek-ai/dsh-llm-markdown-fidelity'

/** The shape one session produced verbatim. */
const GLUED = '| Route title | Choice|---|---|\n| `a` | `b` |\n| `c` | `d` |\n'

/** The same answer with the delimiter row where markdown wants it. */
const HEALTHY = '| Route title | Choice\n|---|---|\n| `a` | `b` |\n| `c` | `d` |\n'

/** A source that delivers one answer in the given pieces and then finishes. */
async function* source(pieces: readonly string[], block = true): AsyncGenerator<StreamChunk> {
  for (const text of pieces) yield { type: 'text-delta', index: 0, text }
  if (block) yield { type: 'block-end', index: 0, block: { type: 'text', text: pieces.join('') } }
  yield { type: 'finish', reason: { kind: 'stop' } }
}

/** The text and final block one repaired stream produced. */
async function run(pieces: readonly string[]): Promise<{ text: string; block: ContentBlock | null }> {
  let text = ''
  let block: ContentBlock | null = null
  for await (const chunk of readMarkdownFidelity(source(pieces))) {
    if (chunk.type === 'text-delta') text += chunk.text
    if (chunk.type === 'block-end') block = chunk.block
  }
  return { text, block }
}

/** The text one repaired stream emitted. */
async function textOf(pieces: readonly string[]): Promise<string> {
  return (await run(pieces)).text
}

describe('readMarkdownFidelity', () => {
  it('repairs a glue however the stream split it', async () => {
    for (let cut = 0; cut <= GLUED.length; cut += 1) {
      expect(await textOf([GLUED.slice(0, cut), GLUED.slice(cut)]), `cut at ${cut}`).toBe(HEALTHY)
    }
  })

  it('repairs a glue delivered one character at a time', async () => {
    expect(await textOf(GLUED.split(''))).toBe(HEALTHY)
  })

  it('leaves a table that arrived correctly, split anywhere', async () => {
    for (let cut = 0; cut <= HEALTHY.length; cut += 1) {
      expect(await textOf([HEALTHY.slice(0, cut), HEALTHY.slice(cut)]), `cut at ${cut}`).toBe(HEALTHY)
    }
  })

  it('hands over the block it assembled, not the glued one', async () => {
    const { text, block } = await run([GLUED.slice(0, 20), GLUED.slice(20)])
    expect(block).toEqual({ type: 'text', text: HEALTHY })
    expect(text).toBe(HEALTHY)
  })

  it('leaves a block the source did not assemble from these deltas alone', async () => {
    // A source that trims its block is making its own choice about the text; the pass hands
    // that block on untouched rather than replacing it with the delta text.
    const chunks: StreamChunk[] = [
      { type: 'text-delta', index: 0, text: GLUED },
      { type: 'block-end', index: 0, block: { type: 'text', text: GLUED.trim() } },
    ]
    const seen: StreamChunk[] = []
    for await (const chunk of readMarkdownFidelity((async function* () { yield* chunks })())) seen.push(chunk)
    expect(seen.filter(chunk => chunk.type === 'block-end')).toEqual([
      { type: 'block-end', index: 0, block: { type: 'text', text: GLUED.trim() } },
    ])
  })

  it('passes every other chunk through', async () => {
    const chunks: StreamChunk[] = [
      { type: 'block-start', index: 0, blockType: 'reasoning' },
      { type: 'reasoning-delta', index: 0, text: '| a | b |---|---|\n' },
      { type: 'block-end', index: 0, block: { type: 'reasoning', text: '| a | b |---|---|\n' } },
      { type: 'usage', usage: { inputTokens: 1, outputTokens: 2 } },
    ]
    const seen: StreamChunk[] = []
    for await (const chunk of readMarkdownFidelity((async function* () { yield* chunks })())) seen.push(chunk)
    expect(seen).toEqual(chunks)
  })

  it('leaves a fenced quote of a glued table alone', async () => {
    const fenced = '```\n| a | b |---|---|\n| 1 | 2 |\n```\n'
    expect(await textOf([fenced])).toBe(fenced)
  })

  it('withholds a run that has not finished arriving, and leaves an unfinished one alone', async () => {
    // `|` alone could still become a delimiter row, so it waits for the next delta; a run
    // with no closing pipe is not a delimiter row, so nothing is inserted before it.
    const out: string[] = []
    for await (const chunk of readMarkdownFidelity(source(['| a | b |', '|---']))) {
      if (chunk.type === 'text-delta') out.push(chunk.text)
    }
    expect(out.join('')).toBe('| a | b ||---')
  })
})
