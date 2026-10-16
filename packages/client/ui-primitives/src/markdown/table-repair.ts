/**
 * Source repair for pipe tables that model output damages, applied to the
 * markdown text before either grammar parses it.
 *
 * The DeepSeek service re-serializes table lines before streaming them, and
 * the re-serialization loses characters at row ends: the `|` and line break
 * between two rows collapse into one `|` (rows fuse onto one line, or the
 * delimiter row fuses with the header and the first row), blank lines appear
 * between header, delimiter, and body, and the blank line after the table
 * disappears. GFM accepts none of that, so the table renders as text with
 * pipes in it, or the sentence after it renders as one more row.
 *
 * Every damage is recoverable from what remains. A fused line holds a whole
 * number of rows, because the join removed exactly one boundary per pair; the
 * delimiter's dash cells give the column count. The repair passes, in order:
 *
 * 1. Remove blank lines between a delimiter row and the pipe rows beside it.
 * 2. Rebuild a pipe block whose header and delimiter fused, or whose rows
 *    fused, into one header line, one delimiter line, and one line per row.
 * 3. Regenerate a delimiter row whose cell count differs from its header's.
 * 4. End a table at the first following line that has no pipe.
 *
 * A table GFM already reads is never rewritten, fenced code is never touched,
 * and each line keeps its container prefix (list indentation, blockquote
 * markers). Appending text to a document only appends to its repair, except
 * where a line arriving later changes how an earlier line reads; the
 * incremental parser treats that as non-append input.
 */

/** A fenced code opener: up to three spaces, then three or more backticks or tildes. */
const FENCE = /^ {0,3}(`{3,}|~{3,})/

/** Blockquote markers and indentation that prefix a line's content; matches every line, possibly empty. */
const CONTAINER = /^[ \t]*(?:>[ \t]?)*/

/** A GFM delimiter row's content: dash cells with optional alignment colons, separated by pipes. */
const DELIMITER = /^\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?$/

/** A GFM delimiter cell. */
const DELIMITER_CELL = /^[ \t]*:?-+:?[ \t]*$/

/** A delimiter cell as a fused line carries it: three or more dashes, so a `-` placeholder cell never matches. */
const FUSED_DELIMITER_CELL = /^[ \t]*:?-{3,}:?[ \t]*$/

/** One source line, split from its terminator and its container prefix. */
interface Line {
  /** Indentation and blockquote markers. */
  readonly prefix: string
  /** The line after its prefix. */
  readonly content: string
  /** The terminator; empty on the last line. */
  readonly end: string
  /** Inside fenced code, the fences included. */
  readonly code: boolean
}

/** A pipe row and its cells. */
interface Row {
  readonly line: Line
  readonly cells: readonly string[]
}

/**
 * Split text into lines and mark fenced code.
 * @param text - Markdown source.
 * @returns lines that rejoin to the source verbatim.
 */
function readLines(text: string): Line[] {
  const lines: Line[] = []
  let fence = ''
  const push = (raw: string, end: string): void => {
    const content = raw.replace(CONTAINER, '')
    const prefix = raw.slice(0, raw.length - content.length)
    const run = FENCE.exec(content)?.[1] ?? ''
    const code = fence !== '' || run !== ''
    if (fence === '') {
      fence = run
    } else if (run !== '' && run[0] === fence[0] && run.length >= fence.length
      && content.slice(content.indexOf(run) + run.length).trim() === '') {
      fence = ''
    }
    lines.push({ prefix, content, end, code })
  }
  const pattern = /\r\n|\r|\n/g
  let start = 0
  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
    push(text.slice(start, match.index), match[0])
    start = match.index + match[0].length
  }
  push(text.slice(start), '')
  return lines
}

/**
 * The cells of a pipe-table line, split on unescaped pipes with the outer pipes removed.
 * @param content - the line's content after its container prefix.
 * @returns the cell texts, untrimmed.
 */
export function tableCells(content: string): string[] {
  let body = content.trim()
  if (body.startsWith('|')) body = body.slice(1)
  if (body.endsWith('|') && !body.endsWith('\\|')) body = body.slice(0, -1)
  return body.split(/(?<!\\)\|/)
}

/**
 * Whether a line's content is a GFM delimiter row.
 * @param content - the line's content after its container prefix.
 * @returns true for a pipe-bearing row of dash cells.
 */
function isDelimiterRow(content: string): boolean {
  const trimmed = content.trim()
  return trimmed.includes('|') && DELIMITER.test(trimmed)
}

/**
 * Whether a line belongs to a pipe block: outside code, starting with a pipe.
 * @param line - one line, or undefined past either end of the document.
 * @returns true for a pipe row.
 */
function isPipeRow(line: Line | undefined): line is Line {
  return line !== undefined && !line.code && line.content.trimStart().startsWith('|')
}

/**
 * Whether a line is blank outside code.
 * @param line - one line, or undefined past either end of the document.
 * @returns true for an empty or whitespace-only line.
 */
function isBlank(line: Line | undefined): boolean {
  return line !== undefined && !line.code && line.content.trim() === ''
}

/**
 * Whether a line is a delimiter row outside code.
 * @param line - one line, or undefined past either end of the document.
 * @returns true for a delimiter row.
 */
function isDelimiterLine(line: Line | undefined): boolean {
  return line !== undefined && !line.code && isDelimiterRow(line.content)
}

/**
 * The line terminator a line inserted after `line` takes.
 * @param line - the source line.
 * @returns its terminator, or a line feed on the unterminated last line.
 */
function terminatorOf(line: Line): string {
  return line.end === '' ? '\n' : line.end
}

/**
 * Pass 1: remove blank lines between a delimiter row and the pipe rows on either side of it.
 * A pipe row directly above its own delimiter heads the next table, so the gap before it stays.
 * @param lines - the document's lines.
 * @returns the lines without those gaps.
 */
function closeDelimiterGaps(lines: readonly Line[]): Line[] {
  const drop = new Set<number>()
  lines.forEach((line, index) => {
    if (!isDelimiterLine(line)) return
    for (const step of [-1, 1]) {
      let cursor = index + step
      while (isBlank(lines[cursor])) cursor += step
      const neighbour = lines[cursor]
      const headsNextTable = step === 1 && isDelimiterLine(lines[cursor + 1])
      if (cursor === index + step || !isPipeRow(neighbour) || isDelimiterRow(neighbour.content) || headsNextTable) continue
      for (let blank = index + step; blank !== cursor; blank += step) drop.add(blank)
    }
  })
  return lines.filter((_, index) => !drop.has(index))
}

/**
 * Format cells as one pipe row.
 * @param prefix - the container prefix to keep.
 * @param cells - cell texts.
 * @param end - the terminator.
 * @returns the row line.
 */
function formatRow(prefix: string, cells: readonly string[], end: string): Line {
  return { prefix, content: `| ${cells.map(cell => cell.trim()).join(' | ')} |`, end, code: false }
}

/**
 * Delimiter cells for `width` columns, keeping the alignment of the source's cells where they exist.
 * @param width - the column count.
 * @param source - the delimiter cells the source carried.
 * @returns the delimiter cells.
 */
function delimiterCells(width: number, source: readonly string[] = []): string[] {
  return Array.from({ length: width }, (_, index) => {
    const cell = source[index]?.trim() ?? ''
    return DELIMITER_CELL.test(cell) ? cell : '---'
  })
}

/**
 * Split cells into rows of `width`, when they hold a whole number of rows.
 * @param cells - a fused line's cells.
 * @param width - the column count.
 * @returns the rows, or undefined when the cells are not a whole number of rows.
 */
function chunk(cells: readonly string[], width: number): string[][] | undefined {
  if (width === 0 || cells.length === 0 || cells.length % width !== 0) return undefined
  const rows: string[][] = []
  for (let start = 0; start < cells.length; start += width) rows.push(cells.slice(start, start + width))
  return rows
}

/**
 * Format rows split from one source line; the last takes the source line's own terminator.
 * @param line - the source line.
 * @param rows - the rows it held.
 * @returns one line per row.
 */
function formatRows(line: Line, rows: readonly (readonly string[])[]): Line[] {
  return rows.map((cells, index) => formatRow(line.prefix, cells, index === rows.length - 1 ? line.end : terminatorOf(line)))
}

/**
 * Split the fused rows of a table body; a row that is not a whole multiple of the width stays verbatim.
 * @param body - body rows.
 * @param width - the column count.
 * @returns the body with each fused line expanded.
 */
function splitRows(body: readonly Row[], width: number): Line[] {
  return body.flatMap(({ line, cells }) => {
    const rows = chunk(cells, width)
    return rows === undefined || rows.length < 2 ? [line] : formatRows(line, rows)
  })
}

/**
 * The run of fused delimiter cells in one row, if it has one.
 * @param cells - the row's cells.
 * @returns the run's start and end cell indexes.
 */
function fusedDelimiterRun(cells: readonly string[]): { start: number; end: number } | undefined {
  const start = cells.findIndex(cell => FUSED_DELIMITER_CELL.test(cell))
  if (start < 0) return undefined
  let end = start
  while (FUSED_DELIMITER_CELL.test(cells[end] ?? '')) end++
  return { start, end }
}

/**
 * Rebuild a block whose delimiter fused into a row: with the header before it, with the first rows after it, or both.
 * @param rows - the block's rows.
 * @returns the rebuilt lines, undefined when no row carries a fused delimiter, or null when the damage is undecidable.
 */
function rebuildFusedDelimiter(rows: readonly Row[]): Line[] | undefined | null {
  for (const [index, { line, cells }] of rows.entries()) {
    if (isDelimiterRow(line.content)) return undefined
    const run = fusedDelimiterRun(cells)
    if (run === undefined) continue
    const width = run.end - run.start
    const header = cells.slice(0, run.start)
    const headerAbove = header.length === 0 && rows[index - 1]?.cells.length === width
    if (header.length !== width && !headerAbove) return null
    const body = run.end === cells.length ? [] : chunk(cells.slice(run.end), width)
    if (body === undefined) return null
    const fused = [
      ...(headerAbove ? [] : [header]),
      delimiterCells(width, cells.slice(run.start, run.end)),
      ...body,
    ]
    return [
      ...rows.slice(0, index).map(row => row.line),
      ...formatRows(line, fused),
      ...splitRows(rows.slice(index + 1), width),
    ]
  }
  return undefined
}

/**
 * Rebuild a block with a delimiter on its second line: a delimiter whose cell count differs from the header's, or fused body rows.
 * @param rows - the block's rows.
 * @returns the rebuilt lines, or undefined when the table already reads as written.
 */
function rebuildBody([header, delimiter, ...body]: readonly Row[]): Line[] | undefined {
  if (header === undefined || delimiter === undefined || !isDelimiterRow(delimiter.line.content)) return undefined
  const width = header.cells.length
  const splitBody = splitRows(body, width)
  const delimiterMatches = delimiter.cells.length === width
  if (delimiterMatches && splitBody.length === body.length) return undefined
  const delimiterLine = delimiterMatches
    ? delimiter.line
    : formatRow(delimiter.line.prefix, delimiterCells(width, delimiter.cells), delimiter.line.end)
  return [header.line, delimiterLine, ...splitBody]
}

/**
 * Rebuild a block that lost its delimiter under a header reduced to empty cells: the second row gives the width.
 * @param rows - the block's rows.
 * @returns the rebuilt lines, or undefined when the block does not have that shape.
 */
function rebuildLostDelimiter([first, second, ...rest]: readonly Row[]): Line[] | undefined {
  // A pipe row's first cell is empty exactly when its next non-space character is another pipe.
  if (first === undefined || second === undefined || !/^\|[ \t]*\|/.test(first.line.content.trim())) return undefined
  const width = second.cells.length
  if (width < 2 || !rest.every(row => row.cells.length % width === 0)) return undefined
  for (let lead = first.cells.length % width || width; lead < first.cells.length; lead += width) {
    if (!first.cells.slice(0, lead).every(cell => cell.trim() === '')) return undefined
    const rows = chunk(first.cells.slice(lead), width)
    if (rows === undefined || !rows.every(cells => cells.some(cell => cell.trim() !== ''))) continue
    const empty = Array.from({ length: width }, () => '')
    return [
      ...formatRows({ ...first.line, end: terminatorOf(first.line) }, [empty, delimiterCells(width), ...rows]),
      ...splitRows([second, ...rest], width),
    ]
  }
  return undefined
}

/**
 * Pass 2 and 3: rebuild each damaged block of consecutive pipe rows; a block that reads as written stays verbatim.
 * @param lines - the document's lines.
 * @returns the lines with every damaged block rebuilt.
 */
function rebuildBlocks(lines: readonly Line[]): Line[] {
  const out: Line[] = []
  let block: Row[] = []
  const flush = (): void => {
    const fused = rebuildFusedDelimiter(block)
    const rebuilt = fused === null ? undefined : fused ?? rebuildBody(block) ?? rebuildLostDelimiter(block)
    out.push(...(rebuilt ?? block.map(row => row.line)))
    block = []
  }
  for (const line of lines) {
    if (isPipeRow(line)) {
      block.push({ line, cells: tableCells(line.content) })
      continue
    }
    flush()
    out.push(line)
  }
  flush()
  return out
}

/**
 * Pass 4: end every table at the first following line that has no pipe.
 * @param lines - the document's lines.
 * @returns the lines with a separator before each such line.
 */
function endTablesAtProse(lines: readonly Line[]): Line[] {
  const out: Line[] = []
  let inTable = false
  let previous: string | null = null
  for (const line of lines) {
    const blank = line.content.trim() === ''
    if (line.code || blank) {
      inTable = false
    } else if (inTable && !line.content.includes('|')) {
      out.push({ prefix: line.prefix.trimEnd(), content: '', end: terminatorOf(line), code: false })
      inTable = false
    } else if (!inTable && previous !== null && isDelimiterRow(line.content)
      && tableCells(previous).length === tableCells(line.content).length) {
      inTable = true
    }
    out.push(line)
    previous = line.code || blank || !line.content.includes('|') ? null : line.content
  }
  return out
}

/**
 * Repair the pipe tables in a markdown document.
 * @param text - Markdown source as the model wrote it.
 * @returns the source with every damaged table repaired; text without a pipe returns unchanged.
 */
export function repairMarkdownTables(text: string): string {
  if (!text.includes('|')) return text
  const lines = endTablesAtProse(rebuildBlocks(closeDelimiterGaps(readLines(text))))
  return lines.map(line => line.prefix + line.content + line.end).join('')
}
