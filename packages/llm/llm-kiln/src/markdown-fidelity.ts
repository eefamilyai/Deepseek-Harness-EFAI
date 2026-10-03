/**
 * Markdown fidelity for a text-channel answer.
 *
 * A provider with no tool channel hands its answer over as text, and the client renders it
 * as markdown. One construct is fragile on that wire: a GFM table needs its delimiter row
 * (`| --- | --- |`) on a line of its own, and a DeepSeek web session has produced the pair
 * glued into one line — `| Route title | Choice |---|---|` — which markdown reads as a
 * single paragraph of pipes, so the table never appears.
 *
 * Nothing in the path drops that newline: the DSML translator emits text character by
 * character, the sidecar concatenates its fragments as they arrive, and this adapter passes
 * deltas through verbatim. The glue is in what the model wrote, and the repair therefore
 * belongs here, where the whole block is known: one newline goes back before the delimiter
 * row, and nothing else about the answer changes.
 */

/** A delimiter cell: `---`, `:--`, `--:`, or `:-:`. */
const DELIMITER_CELL = ':?-{1,}:?'

/** A whole delimiter row: cells between pipes, the outer pipes optional. */
const DELIMITER_ROW = new RegExp(`^\\|(?:\\s*${DELIMITER_CELL}\\s*\\|)+$`)

/** A line that opens or closes a fenced code block, whose contents are text, not markdown. */
const FENCE = /^\s*(?:```|~~~)/

/**
 * The cells of one table row, outer pipes removed.
 * @param row - one line of a table, with or without its outer pipes.
 * @returns the cell texts, untrimmed.
 */
function cells(row: string): string[] {
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
function isHeader(segment: string): boolean {
  const parts = cells(segment)
  return parts.length >= 2 && parts.some(part => /[^\s:-]/.test(part))
}

/**
 * Where a delimiter row takes over a line that should have been a header alone.
 *
 * Every pipe in the line is tried as the start of the delimiter run, and the first that
 * parses as one wins: a header's own pipes cannot, because the cells between them hold
 * text. The run must also describe the header's column count — that agreement is what
 * separates a table the model wrote from prose that happens to mention pipes and dashes —
 * and the header may or may not end with the outer pipe markdown makes optional.
 * @param line - one line of a text block.
 * @returns the index of the delimiter run's first pipe, or null when the line is not a glued pair.
 */
function gluedDelimiterAt(line: string): number | null {
  const first = line.indexOf('|')
  // A table row starts with a pipe; leading whitespace is a list item's indentation.
  if (first < 0 || line.slice(0, first).trim() !== '') return null
  for (let index = line.indexOf('|', first + 1); index > 0; index = line.indexOf('|', index + 1)) {
    const run = line.slice(index)
    if (!DELIMITER_ROW.test(run)) continue
    const header = line.slice(0, index)
    if (!isHeader(header)) continue
    if (cells(header).length === cells(run).length) return index
  }
  return null
}

/**
 * Put a table's delimiter row back on its own line.
 * @param text - one whole visible text block of an answer.
 * @returns the same text with every glued delimiter row separated, and nothing else changed.
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
    // The pair renders as a table only when a row follows it: a header and its delimiter
    // alone stay where they are, because there is nothing to render them for.
    if (split === null || !(lines[index + 1] ?? '').trimStart().startsWith('|')) {
      out.push(line)
      continue
    }
    const indent = line.slice(0, line.length - line.trimStart().length)
    out.push(line.slice(0, split).trimEnd(), `${indent}${line.slice(split).trim()}`)
  }
  return out.join('\n')
}
