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
import { FENCE, columnsOf, repairTableLine } from './repair.ts'

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
      // Leading whitespace cannot decide yet: a table row inside a list item is indented.
      if (!this.buffered && /^\s*$/.test(this.line)) continue
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
    const out = this.buffered ? this.settle() : this.line
    this.line = ''
    this.buffered = false
    return out
  }

  /** Repair the buffered line and hand it over. */
  private settle(): string {
    const line = this.line
    this.line = ''
    this.buffered = false
    const repaired = this.fenced ? [line] : repairTableLine(line, this.columns)
    if (FENCE.test(line)) this.fenced = !this.fenced
    this.columns = columnsOf(line) ?? (line.trimStart().startsWith('|') ? this.columns : null)
    return repaired.join('\n')
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
