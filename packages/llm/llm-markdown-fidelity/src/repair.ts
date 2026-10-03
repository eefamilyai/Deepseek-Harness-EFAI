/**
 * The repair itself: the lines a table needs, put back where a lost newline merged them.
 *
 * Markdown wants a table's header, its delimiter row, and each of its rows on lines of their
 * own. A stream that drops a newline after a row's closing pipe writes `| a | b |---|---|`
 * or `| a | b | c | d |`, and every renderer then does the same thing: the first is a
 * paragraph of pipes, and the second keeps the first row's cells and *discards the rest*, so
 * the reader loses rows without being told.
 *
 * The repair inserts the newlines and changes nothing else — no words of its own, no touching
 * of a table that arrived correctly. What makes it safe is the table's own column count: a
 * delimiter row states it, a cell holding a pipe has to escape it, so a line whose cells
 * divide by that count was two or more rows.
 */

/** A delimiter cell: `---`, `:--`, `--:`, or `:-:`. */
const DELIMITER_CELL = ':?-{1,}:?'

/** A whole delimiter row at the start of the text. */
const DELIMITER_RUN = new RegExp(`^\\|(?:\\s*${DELIMITER_CELL}\\s*\\|)+`)

/** The cells of one table row, outer pipes removed. */
function cellsOf(row: string): string[] {
  return row
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split(/(?<!\\)\|/)
}

/** One row written back with its outer pipes and one space between cells. */
function rowOf(cells: readonly string[]): string {
  return `| ${cells.map(cell => cell.trim()).join(' | ')} |`
}

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
export function cells(row: string): string[] {
  return cellsOf(row)
}

/**
 * The column count of a table, when this line is that table's delimiter row.
 *
 * Only a delimiter row states the count, which is what keeps row splitting honest: a table
 * whose delimiter is not in the text is never reshaped.
 * @param line - one line of a text block.
 * @returns the column count, or null when the line is not a delimiter row.
 */
export function columnsOf(line: string): number | null {
  const trimmed = line.trim()
  const run = delimiterRun(trimmed)
  if (run === null || run.length !== trimmed.length) return null
  return cellsOf(run).length
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
  const parts = cellsOf(segment)
  return parts.length >= 2 && parts.some(cell => /[^\s:-]/.test(cell))
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

/**
 * The rows one line holds, when a lost newline merged two or more of them.
 * @param line - one line of a table body.
 * @param columns - the table's column count, or null when the table is not open.
 * @returns the rows, or null when the line already holds exactly one.
 */
export function rowsOf(line: string, columns: number | null): string[] | null {
  if (columns === null || columns < 2) return null
  const parts = cellsOf(line)
  if (parts.length <= columns || parts.length % columns !== 0) return null
  const rows: string[] = []
  for (let start = 0; start < parts.length; start += columns) {
    rows.push(rowOf(parts.slice(start, start + columns)))
  }
  return rows
}

/**
 * The lines one finished line stands for.
 *
 * The two glues are checked in the order they can nest: a delimiter row merged into its
 * header may itself carry a row merged after it, and splitting the rows without separating
 * the delimiter first would count its dashes as cells.
 * @param line - one line of a text block.
 * @param columns - the column count of the table this line belongs to, or null when none is open.
 * @param rowsFollow - whether a row is known to follow this line, which a glued pair needs
 * before it is worth separating: a header and its delimiter alone render as a table with no
 * rows, so there is nothing there to put back.
 * @returns the lines to write in place of this one.
 */
export function repairTableLine(line: string, columns: number | null, rowsFollow = true): string[] {
  // A stream hands over a finished line with its newline; the line's own end belongs to the
  // last line this returns, or the next line would run into it.
  const newline = line.endsWith('\n') ? '\n' : ''
  const parts = repairBody(newline === '' ? line : line.slice(0, -1), columns, rowsFollow)
  if (newline !== '') parts[parts.length - 1] = `${parts[parts.length - 1] ?? ''}${newline}`
  return parts
}

/**
 * The lines one finished line body stands for, with no newline of its own.
 * @param line - one line of a text block, without its newline.
 * @param columns - the column count of the table this line belongs to, or null when none is open.
 * @param rowsFollow - whether a row is known to follow.
 * @returns the lines to write in place of this one.
 */
function repairBody(line: string, columns: number | null, rowsFollow: boolean): string[] {
  const trimmed = line.trimStart()
  const indent = line.slice(0, line.length - trimmed.length)
  const split = gluedDelimiterAt(line)
  if (split !== null) {
    const header = line.slice(0, split).trimEnd()
    const rest = line.slice(split).trim()
    const run = delimiterRun(rest)
    if (run === null) return [line]
    // Anything after the run on the same line is a row, and a row is reason enough to
    // separate the delimiter. A bare pair with nothing after it and no row below renders as
    // a table with no rows, so it is left as the model wrote it.
    const follows = rest.length > run.length
    if (!follows && !rowsFollow) return [line]
    const remainder = rest.slice(run.length).trim()
    const parts = cellsOf(remainder)
    // The run's closing pipe is also the next row's opening one, so a row that followed it on
    // the same line arrives without its own leading pipe and is written back as a whole row.
    const tail = remainder === ''
      ? []
      : (rowsOf(remainder, cellsOf(run).length) ?? (parts.length === cellsOf(run).length ? [rowOf(parts)] : [remainder]))
    return [header, `${indent}${run}`, ...tail.map(row => `${indent}${row}`)]
  }
  return rowsOf(line, columns) ?? [line]
}

/** A line that opens or closes a fenced code block, whose contents are text, not markdown. */
export const FENCE = /^\s*(?:```|~~~)/

/**
 * Repair every table line in one text block.
 * @param text - one whole visible text block.
 * @returns the same text with a merged delimiter row separated, merged rows split, and a blank
 * line between a header and its delimiter row removed — and nothing else changed.
 */
export function repairTableLines(text: string): string {
  if (!text.includes('|')) return text
  const lines = text.split('\n')
  const out: string[] = []
  let columns: number | null = null
  let fenced = false
  let header: number | null = null
  let blockStart = true
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    if (FENCE.test(line)) fenced = !fenced
    if (line.trim() === '') {
      // A blank line between a header and its delimiter row is a table that never became one:
      // markdown requires the pair adjacent, and the header's own column count says the
      // delimiter row below was meant for it.
      const standoff = header !== null && columnsOf(lines[index + 1] ?? '') === header
        && (lines[index + 2] ?? '').trimStart().startsWith('|')
      if (!fenced && standoff) continue
      out.push(line)
      columns = null
      header = null
      blockStart = true
      continue
    }
    const rowsFollow = (lines[index + 1] ?? '').trimStart().startsWith('|')
    out.push(...(fenced ? [line] : repairTableLine(line, columns, rowsFollow)))
    const count = columnsOf(line)
    header = !fenced && blockStart && count === null && line.trimStart().startsWith('|') && isHeaderSegment(line)
      ? cells(line).length
      : null
    columns = count ?? (line.trimStart().startsWith('|') ? columns : null)
    blockStart = false
  }
  return out.join('\n')
}
