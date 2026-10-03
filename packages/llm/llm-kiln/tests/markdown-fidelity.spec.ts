/**
 * A table's delimiter row when the session glued it to the header.
 *
 * Markdown needs `| a | b |` and `| --- | --- |` on separate lines, and a DeepSeek web
 * session has produced the pair as one line — which renders as a paragraph of pipes, so the
 * table the answer asked for never appears. The repair belongs to this adapter because it is
 * the last place that holds the whole visible block.
 */

import { describe, expect, it } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { KilnAdapter, repairGluedTableDelimiter } from '@deepseek-ai/dsh-llm-kiln'
import type { KilnBridge, KilnStreamEvent } from '@deepseek-ai/dsh-llm-kiln'

/**
 * The shape one session produced verbatim: the header lost its outer pipe and the delimiter
 * row followed it on the same line.
 */
const GLUED = '## Shapes\n\n| Route title | Choice|---|---|\n| `DeepSeek (free web)` | `Auto` |\n| `hunt@…` | `hunt` |\n'

/** The same answer with the delimiter row where markdown wants it. */
const HEALTHY = '## Shapes\n\n| Route title | Choice\n|---|---|\n| `DeepSeek (free web)` | `Auto` |\n| `hunt@…` | `hunt` |\n'

/** A bridge that replays one scripted answer. */
function bridgeOf(answer: string): KilnBridge {
  return bridgeOfPieces([answer])
}

/** A bridge that replays an answer in the pieces a stream would deliver it in. */
function bridgeOfPieces(pieces: readonly string[]): KilnBridge {
  return {
    async *stream(): AsyncIterable<KilnStreamEvent> {
      for (const text of pieces) yield { type: 'content', text }
      yield { type: 'meta', finish: 'stop' }
    },
  } as unknown as KilnBridge
}

/** The visible text block the adapter committed for one answer. */
async function committed(answer: string): Promise<string> {
  return committedFrom(bridgeOf(answer))
}

/** The visible text block the adapter committed for one bridge. */
async function committedFrom(bridge: KilnBridge): Promise<string> {
  const adapter = new KilnAdapter({ bridge, routes: () => new Map(), kilnId: route => route })
  let block = ''
  for await (const chunk of adapter.stream({
    provider: 'kiln-deepseek',
    model: 'deepseek-expert',
    messages: [createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } })],
  })) {
    if (chunk.type === 'block-end' && chunk.block.type === 'text') block = chunk.block.text
  }
  return block
}

describe('repairGluedTableDelimiter', () => {
  it('puts the delimiter row back on its own line', () => {
    expect(repairGluedTableDelimiter(GLUED)).toBe(HEALTHY)
  })

  it('reads a delimiter whose cells carry alignment', () => {
    expect(repairGluedTableDelimiter('| a | b |:--|--:|\n| 1 | 2 |\n')).toBe('| a | b\n|:--|--:|\n| 1 | 2 |\n')
  })

  it('reads a delimiter joined by a space', () => {
    expect(repairGluedTableDelimiter('| a | b | ---|---|\n| 1 | 2 |\n')).toBe('| a | b\n| ---|---|\n| 1 | 2 |\n')
  })

  it('keeps a list item\u2019s indentation on both rows', () => {
    expect(repairGluedTableDelimiter('- step\n  | a | b |---|---|\n  | 1 | 2 |\n'))
      .toBe('- step\n  | a | b\n  |---|---|\n  | 1 | 2 |\n')
  })

  it('reads a table of more than two columns', () => {
    expect(repairGluedTableDelimiter('| a | b | c |---|---|---|\n| 1 | 2 | 3 |\n'))
      .toBe('| a | b | c\n|---|---|---|\n| 1 | 2 | 3 |\n')
  })

  it('leaves a table that arrived correctly alone', () => {
    const healthy = '| a | b |\n|:--|--:|\n| 1 | 2 |\n| 3 | 4 |\n'
    expect(repairGluedTableDelimiter(healthy)).toBe(healthy)
  })

  it('is idempotent', () => {
    expect(repairGluedTableDelimiter(HEALTHY)).toBe(HEALTHY)
    expect(repairGluedTableDelimiter(repairGluedTableDelimiter(GLUED))).toBe(HEALTHY)
  })

  it('leaves prose that merely carries pipes and dashes', () => {
    // Neither line starts as a table row, so there is no table here to put back together.
    const prose = 'Write `| a | b |` then `|---|---|` below it.\nPipe | a | b |---|---| here.\n'
    expect(repairGluedTableDelimiter(prose)).toBe(prose)
  })

  it('leaves a glued pair whose columns disagree', () => {
    const wrong = '| a | b |---|---|--:|\n| 1 | 2 |\n'
    expect(repairGluedTableDelimiter(wrong)).toBe(wrong)
  })

  it('leaves a header and delimiter with no row to render', () => {
    const lonely = '| a | b |---|---|\n'
    expect(repairGluedTableDelimiter(lonely)).toBe(lonely)
  })

  it('leaves a fenced block exactly as it was written', () => {
    const fenced = '```\n| a | b |---|---|\n| 1 | 2 |\n```\n'
    expect(repairGluedTableDelimiter(fenced)).toBe(fenced)
  })

  it('does not touch text without a pipe', () => {
    expect(repairGluedTableDelimiter('plain answer\n')).toBe('plain answer\n')
  })
})

describe('the Kiln adapter', () => {
  it('commits a glued table as the table it was written to be', async () => {
    expect(await committed(GLUED)).toBe(HEALTHY)
  })

  it('commits a healthy table unchanged', async () => {
    const healthy = '| a | b |\n|---|---|\n| 1 | 2 |\n'
    expect(await committed(healthy)).toBe(healthy)
  })

  it('repairs a glued table however the stream split it', async () => {
    // The glue is a property of the text, not of one chunk: the block is what gets repaired.
    const pieces = ['## Shapes\n\n| Route title | Choice', '|---|---|', '\n| `a` | `b` |\n']
    expect(await committedFrom(bridgeOfPieces(pieces)))
      .toBe('## Shapes\n\n| Route title | Choice\n|---|---|\n| `a` | `b` |\n')
  })
})
