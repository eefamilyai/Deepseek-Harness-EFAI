/**
 * The repair itself: a table's delimiter row back on its own line.
 *
 * Markdown wants `| a | b |` and `| --- | --- |` on separate lines. A model that writes them
 * as one line has written a paragraph of pipes: the table is gone, and no renderer can guess
 * it back. The repair puts the newline where markdown asks for it and changes nothing else —
 * it inserts no text of its own and never touches a table that arrived correctly.
 *
 * The match is deliberately narrow. A candidate is a delimiter run that follows *cells with
 * text in them* and describes the same number of columns as that header — the difference
 * between a table the model wrote and prose that happens to mention pipes and dashes.
 */

/** A delimiter cell: `---`, `:--`, `--:`, or `:-:`. */
const DELIMITER_CELL = ':?-{1,}:?'

/** A whole delimiter row at the start of the text. */
const DELIMITER_RUN = new RegExp(`^\\|(?:\\s*${DELIMITER_CELL}\\s*\\|)+`)

/** Characters a delimiter row is written with, all of which may still extend one. */
const RUN_MATERIAL = /^[|\-:\s]*$/

/**
 * The delimiter run that opens this text, if one does.
 * @param text - text to read from its start.
 * @returns the run, or null when the text does not start with one.
 */
export function delimiterRun(text: string): string | null {
  return DELIMITER_RUN.exec(text)?.[0] ?? null
}

/**
 * The cells of one table row, outer pipes removed.
 * @param row - one line of a table, with or without its outer pipes.
 * @returns the cell texts, untrimmed.
 */
export function cellsOf(row: string): string[] {
  return row
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
}

/**
 * Whether a segment is a table header: two columns or more, with text in one of them.
 *
 * A delimiter row read as a header of its own has neither, which is what keeps a table that
 * arrived correctly from being pulled apart: its delimiter line matches the run pattern
 * exactly, and only this test says there is no header above the run to separate it from.
 * @param segment - the part of a line before a candidate delimiter run.
 * @returns true when the segment reads as a header.
 */
export function isHeaderSegment(segment: string): boolean {
  const cells = cellsOf(segment)
  return cells.length >= 2 && cells.some(cell => /[^\s:-]/.test(cell))
}

/**
 * Where a delimiter row takes over a line that should have been a header alone.
 *
 * Every pipe in the line is tried as the start of the delimiter run, and the first that
 * parses as one wins: a header's own pipes cannot, because the cells between them hold text.
 * The run must also describe the header's column count, and the header may or may not end
 * with the outer pipe markdown makes optional.
 * @param line - one line of a text block.
 * @returns the index of the delimiter run's first pipe, or null when the line is not a glued pair.
 */
export function gluedDelimiterAt(line: string): number | null {
  const first = line.indexOf('|')
  // A table row starts with a pipe; leading whitespace is a list item's indentation.
  if (first < 0 || line.slice(0, first).trim() !== '') return null
  for (let index = line.indexOf('|', first + 1); index > 0; index = line.indexOf('|', index + 1)) {
    const run = delimiterRun(line.slice(index))
    if (run === null) continue
    const header = line.slice(0, index)
    if (!isHeaderSegment(header)) continue
    if (cellsOf(header).length === cellsOf(run).length) return index
  }
  return null
}

/** A line that opens or closes a fenced code block, whose contents are text, not markdown. */
export const FENCE = /^\s*(?:```|~~~)/

/**
 * Put a table's delimiter row back on its own line.
 *
 * The pair renders as a table only when a row follows it: a header and its delimiter alone
 * stay where they are, and a fenced block that quotes one stays byte for byte.
 * @param text - one whole visible text block.
 * @returns the text with each glued delimiter row separated, and nothing else changed.
 */
export function repairGluedTableDelimiter(text: string): string {
  if (!text.includes('|')) return text
  const lines = text.split('\n')
  const out: string[] = []
  let fenced = false
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    if (FENCE.test(line)) fenced = !fenced
    const split = fenced ? null : gluedDelimiterAt(line)
    if (split === null || !(lines[index + 1] ?? '').trimStart().startsWith('|')) {
      out.push(line)
      continue
    }
    const indent = line.slice(0, line.length - line.trimStart().length)
    out.push(line.slice(0, split).trimEnd(), `${indent}${line.slice(split).trim()}`)
  }
  return out.join('\n')
}

/** Whether every character from here on could still be part of a delimiter row. */
export function couldExtendRun(text: string): boolean {
  return RUN_MATERIAL.test(text)
}
