/**
 * The repair in one text: a table's delimiter row glued to its header.
 *
 * The shape that reached the harness verbatim is
 * `| Route title | Choice|---|---|` — the header lost its outer pipe and the delimiter row
 * followed it on the same line — which markdown reads as a paragraph of pipes.
 */

import { describe, expect, it } from 'vitest'
import { repairGluedTableDelimiter } from '@deepseek-ai/dsh-llm-markdown-fidelity'

/** The shape one session produced verbatim. */
const GLUED = '## Shapes\n\n| Route title | Choice|---|---|\n| `DeepSeek (free web)` | `Auto` |\n| `hunt@…` | `hunt` |\n'

/** The same answer with the delimiter row where markdown wants it. */
const HEALTHY = '## Shapes\n\n| Route title | Choice\n|---|---|\n| `DeepSeek (free web)` | `Auto` |\n| `hunt@…` | `hunt` |\n'

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
