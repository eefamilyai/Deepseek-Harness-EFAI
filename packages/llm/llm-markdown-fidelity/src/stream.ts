/**
 * The stream pass: repair while the text is still arriving.
 *
 * Whether a line holds one table row or several is a property of the *finished* line - a lost
 * newline leaves no trace in the middle of one - so the pass cannot emit a table row as it
 * arrives and then correct itself. It therefore buffers a line only while that line looks like
 * a table row, and every other line flows through untouched, so prose streams exactly as it
 * always did.
 *
 * The block a text delta belongs to is tracked as well: when a block ends, the text this pass
 * assembled *is* the block, provided the source assembled it from the same deltas. That keeps
 * the deltas and the block from disagreeing, which is what a downstream reader rebuilds from.
 */

import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { FENCE, cells, columnsOf, isHeaderSegment, lastColumnsOf, repairTableLine } from './repair.ts'

/** Text a stream buffers while it waits to see the whole of a table line. */
export class TableLineRepair {
  /** The current line's text, buffered while it may be a table row. */
  private line = ''
  /** Whether the current line began as a table row, so only its end can settle it. */
  private buffered = false
  /** The column count of the table this line belongs to, or null when none is open. */
  private columns: number | null = null
  /** Whether the answer is inside a fenced block, where pipes are text and not markdown. */
  private fenced = false
  /** A blank line held back, while the header above it may still claim it. */
  private blank = ''
  /** The column count of a header line that began its block, or null. */
  private header: number | null = null
  /** Whether the line being settled begins its block. */
  private blockStart = true

  /**
   * Feed one delta.
   * @param text - the delta's text.
   * @returns the text to emit now, with any table line repaired.
   */
  push(text: string): string {
    let out = ''
    let rest = text
    while (rest !== '') {
      const end = rest.indexOf('\n')
      const segment = end < 0 ? rest : rest.slice(0, end + 1)
      rest = end < 0 ? '' : rest.slice(end + 1)
      this.line += segment
      // A line that is only whitespace and has ended holds nothing to decide: a blank line or
      // a paragraph break belongs to the reader now, and holding it back would delay prose.
      if (/^\s*$/.test(this.line)) {
        if (!this.line.includes('\n')) continue
        out += this.settle()
        continue
      }
      // A line starting as a table row or as a fence is settled whole: only its end says
      // whether it holds one row or several, and a fence decides whether rows exist at all.
      if (!this.buffered) this.buffered = /^\s*[|`~]/.test(this.line)
      if (!this.buffered) {
        out += this.line
        this.line = ''
        continue
      }
      if (!segment.endsWith('\n')) continue
      out += this.settle()
    }
    return out
  }

  /**
   * Settle whatever is still buffered at the end of a block.
   * @returns the text to emit, repaired where it is a table line.
   */
  flush(): string {
    const out = (this.buffered || this.line !== '' ? this.settle() : '') + this.blank
    this.line = ''
    this.buffered = false
    this.blank = ''
    return out
  }

  /** Repair the buffered line and hand it over. */
  private settle(): string {
    const line = this.line
    this.line = ''
    this.buffered = false
    // A line that is only whitespace and has ended is a blank line or a paragraph break.
    if (line.trim() === '') {
      this.blockStart = true
      // A header above it may still be claimed by a delimiter row: markdown requires the pair
      // adjacent, so a blank line between them is a table that never became one.
      if (this.header !== null) {
        this.blank = line
        return ''
      }
      return line
    }
    const count = columnsOf(line)
    const repaired = this.fenced ? [line] : repairTableLine(line, this.columns)
    let out = this.blank
    if (out !== '' && count !== null && this.header === count) out = ''
    this.blank = ''
    out += repaired.join('\n')
    if (FENCE.test(line)) this.fenced = !this.fenced
    // A separated pair states the count the rows below it split by; reading only the arriving
    // line would leave the first row after it merged.
    const columns = count ?? lastColumnsOf(repaired)
    this.header = !this.fenced && this.blockStart && columns === null && line.trimStart().startsWith('|') && isHeaderSegment(line)
      ? cells(line).length
      : null
    this.columns = columns ?? (line.trimStart().startsWith('|') ? this.columns : null)
    this.blockStart = false
    return out
  }
}

/**
 * Repair the markdown of one model stream.
 * @param source - the stream the adapter produced.
 * @returns the same chunks, with a text block's merged table lines separated.
 */
export async function* readMarkdownFidelity(source: AsyncIterable<StreamChunk>): AsyncGenerator<StreamChunk> {
  const repair = new TableLineRepair()
  let index = 0
  let open = false
  let raw = ''
  let emitted = ''
  for await (const chunk of source) {
    if (chunk.type === 'text-delta') {
      index = chunk.index
      open = true
      raw += chunk.text
      const text = repair.push(chunk.text)
      emitted += text
      if (text !== '') yield { ...chunk, text }
      continue
    }
    if (open && (chunk.type === 'block-end' || chunk.type === 'finish')) {
      const tail = repair.flush()
      if (tail !== '') {
        emitted += tail
        yield { type: 'text-delta', index, text: tail }
      }
    }
    if (chunk.type === 'block-end' && open) {
      // The source assembled this block from the deltas this pass saw, so the block it hands
      // over is the one to correct; a block whose text the source built another way is left
      // exactly as it came.
      if (chunk.block.type === 'text' && chunk.block.text === raw) {
        yield { ...chunk, block: { type: 'text', text: emitted } }
      } else {
        yield chunk
      }
      open = false
      raw = ''
      emitted = ''
      continue
    }
    yield chunk
  }
}
