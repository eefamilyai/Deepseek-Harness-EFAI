/**
 * The repair in one text: table lines a lost newline merged.
 *
 * Both shapes here are ones this fork actually produced. The first is the delimiter row glued
 * to its header (`| Route title | Choice|---|---|`), which every renderer reads as a paragraph
 * of pipes. The second is what a later message showed: the newline after a row's closing pipe
 * was lost, so two rows became one line of four cells - and a renderer keeps the first row and
 * discards the rest, which is how a reader loses rows without being told.
 */

import { describe, expect, it } from 'vitest'
import { repairTableLines } from '@deepseek-ai/dsh-llm-markdown-fidelity'

/** The shape one session produced verbatim. */
const GLUED = '## Shapes\n\n| Route title | Choice|---|---|\n| `DeepSeek (free web)` | `Auto` |\n| `hunt@…` | `hunt` |\n'

/** The same answer with the delimiter row where markdown wants it. */
const HEALTHY = '## Shapes\n\n| Route title | Choice\n|---|---|\n| `DeepSeek (free web)` | `Auto` |\n| `hunt@…` | `hunt` |\n'

/** The second shape, verbatim from this fork's own message: two rows merged on each of two lines. */
const MERGED = '| a | b |\n|---|---|\n| r1 | s1 | r2 | s2 |\n| r3 | s3 | r4 | s4 |\n'

/** What that message meant to say. */
const SEPARATE = '| a | b |\n|---|---|\n| r1 | s1 |\n| r2 | s2 |\n| r3 | s3 |\n| r4 | s4 |\n'

describe('repairTableLines', () => {
  it('puts the delimiter row back on its own line', () => {
    expect(repairTableLines(GLUED)).toBe(HEALTHY)
  })

  it('splits rows that a lost newline merged', () => {
    expect(repairTableLines(MERGED)).toBe(SEPARATE)
  })

  it('splits a row merged onto the delimiter row', () => {
    // The pipe the pair shared belongs to the delimiter row, which needs both of its own:
    // markdown makes the header's outer pipe optional, and counting one column would not be
    // a table.
    expect(repairTableLines('| a | b |---|---| r1 | s1 |\n'))
      .toBe('| a | b\n|---|---|\n| r1 | s1 |\n')
  })

  it('reads a delimiter whose cells carry alignment', () => {
    expect(repairTableLines('| a | b |:--|--:|\n| 1 | 2 |\n')).toBe('| a | b\n|:--|--:|\n| 1 | 2 |\n')
  })

  it('reads a delimiter joined by a space', () => {
    expect(repairTableLines('| a | b | ---|---|\n| 1 | 2 |\n')).toBe('| a | b\n| ---|---|\n| 1 | 2 |\n')
  })

  it('keeps a list item\u2019s indentation on both rows', () => {
    expect(repairTableLines('- step\n  | a | b |---|---|\n  | 1 | 2 |\n'))
      .toBe('- step\n  | a | b\n  |---|---|\n  | 1 | 2 |\n')
  })

  it('reads a table of more than two columns', () => {
    expect(repairTableLines('| a | b | c |---|---|---|\n| 1 | 2 | 3 |\n'))
      .toBe('| a | b | c\n|---|---|---|\n| 1 | 2 | 3 |\n')
  })

  it('keeps a cell whose own pipe is escaped', () => {
    const table = '| a | b |\n|---|---|\n| x \\| y | z |\n'
    expect(repairTableLines(table)).toBe(table)
  })

  it('leaves a table that arrived correctly alone', () => {
    const healthy = '| a | b |\n|:--|--:|\n| 1 | 2 |\n| 3 | 4 |\n'
    expect(repairTableLines(healthy)).toBe(healthy)
  })

  it('leaves a short row alone', () => {
    // A row with fewer cells than the header is how markdown pads a table, not a lost newline.
    const short = '| a | b | c |\n|---|---|---|\n| 1 | 2 |\n'
    expect(repairTableLines(short)).toBe(short)
  })

  it('leaves a row whose cells do not divide by the column count alone', () => {
    const odd = '| a | b |\n|---|---|\n| 1 | 2 | 3 |\n'
    expect(repairTableLines(odd)).toBe(odd)
  })

  it('does not reshape a table whose delimiter row is not in the text', () => {
    const partial = '| a | b | c | d |\n'
    expect(repairTableLines(partial)).toBe(partial)
  })

  it('is idempotent', () => {
    expect(repairTableLines(HEALTHY)).toBe(HEALTHY)
    expect(repairTableLines(repairTableLines(GLUED))).toBe(HEALTHY)
    expect(repairTableLines(repairTableLines(MERGED))).toBe(SEPARATE)
  })

  it('leaves prose that merely carries pipes and dashes', () => {
    // Neither line starts as a table row, so there is no table here to put back together.
    const prose = 'Write `| a | b |` then `|---|---|` below it.\nPipe | a | b |---|---| here.\n'
    expect(repairTableLines(prose)).toBe(prose)
  })

  it('leaves a glued pair whose columns disagree', () => {
    const wrong = '| a | b |---|---|--:|\n| 1 | 2 |\n'
    expect(repairTableLines(wrong)).toBe(wrong)
  })

  it('leaves a header and delimiter with no row to render', () => {
    const lonely = '| a | b |---|---|\n'
    expect(repairTableLines(lonely)).toBe(lonely)
  })

  it('leaves a fenced block exactly as it was written', () => {
    const fenced = '```\n| a | b |---|---|\n| 1 | 2 |\n```\n'
    expect(repairTableLines(fenced)).toBe(fenced)
  })

  it('does not touch text without a pipe', () => {
    expect(repairTableLines('plain answer\n')).toBe('plain answer\n')
  })
})
