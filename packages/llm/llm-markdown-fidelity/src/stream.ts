/**
 * The stream pass: repair while the text is still arriving.
 *
 * A glue can be split across deltas (`"...| Choice"` then `"|---|---|"`), so the pass cannot
 * wait for a whole block and it cannot emit as it receives either: a delimiter run that is
 * still growing must not be sent before it is known, and the text before it must not be held
 * longer than the run itself. It therefore withholds only the tail that could still turn out
 * to be a delimiter row — from the first pipe whose remainder is nothing but delimiter
 * characters — and settles it the moment a character arrives that no run can contain.
 *
 * The block a text delta belongs to is tracked as well: when a block ends, the text this pass
 * assembled *is* the block, provided the source assembled it from the same deltas. That keeps
 * the deltas and the block from disagreeing, which is what a downstream reader rebuilds from.
 */

import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { FENCE, cellsOf, couldExtendRun, delimiterRun, isHeaderSegment } from './repair.ts'

/** A completed glued pair inside the withheld text. */
interface Glued {
  /** Where the delimiter run starts in the withheld text. */
  readonly offset: number
  /** Where it ends. */
  readonly end: number
}

/** Text a stream withholds while it waits to see whether a delimiter row is glued to a header. */
export class GluedTableRepair {
  /** The line as it has arrived, which the header test reads. */
  private line = ''
  /** The tail of that line withheld from the stream. */
  private held = ''
  /** Whether the answer is inside a fenced block, where pipes are text and not markdown. */
  private fenced = false

  /**
   * Feed one delta.
   * @param text - the delta's text.
   * @returns the text to emit now, with any completed glue repaired.
   */
  push(text: string): string {
    let out = ''
    let rest = text
    while (rest !== '') {
      const end = rest.indexOf('\n')
      const segment = end < 0 ? rest : rest.slice(0, end + 1)
      rest = end < 0 ? '' : rest.slice(end + 1)
      this.line += segment
      this.held += segment
      // A finished line settles completely: nothing arriving later can change what it was.
      out += this.settle(segment.endsWith('\n'))
      if (segment.endsWith('\n')) {
        if (FENCE.test(segment)) this.fenced = !this.fenced
        this.line = ''
        this.held = ''
      }
    }
    return out
  }

  /**
   * Settle whatever is still withheld at the end of a block.
   * @returns the text to emit, repaired where it is a glued pair.
   */
  flush(): string {
    const out = this.settle(true)
    this.line = ''
    this.held = ''
    return out
  }

  /**
   * Emit what this pass can vouch for.
   * @param complete - whether the line the text belongs to has ended.
   * @returns the text to emit.
   */
  private settle(complete: boolean): string {
    let out = ''
    for (;;) {
      const glued = this.glued()
      if (glued !== null) {
        out += `${this.held.slice(0, glued.offset).trimEnd()}\n${this.held.slice(glued.offset, glued.end)}`
        this.held = this.held.slice(glued.end)
        // The inserted newline starts a line: what follows it is analysed as its own.
        this.line = this.held
        continue
      }
      if (complete) {
        out += this.held
        this.held = ''
        return out
      }
      const hold = this.holdPoint()
      if (hold < 0) {
        out += this.held
        this.held = ''
        return out
      }
      out += this.held.slice(0, hold)
      this.held = this.held.slice(hold)
      return out
    }
  }

  /** The first completed, glued delimiter run in the withheld text. */
  private glued(): Glued | null {
    // Inside a fence every pipe is text the reader asked to see verbatim.
    if (this.fenced) return null
    for (let index = this.held.indexOf('|'); index >= 0; index = this.held.indexOf('|', index + 1)) {
      const run = delimiterRun(this.held.slice(index))
      if (run === null) continue
      const header = this.line.slice(0, this.line.length - this.held.length + index)
      if (!isHeaderSegment(header)) continue
      if (cellsOf(header).length === cellsOf(run).length) return { offset: index, end: index + run.length }
    }
    return null
  }

  /** Where the withheld text stops being settled: the first pipe that could still grow into a row. */
  private holdPoint(): number {
    for (let index = this.held.indexOf('|'); index >= 0; index = this.held.indexOf('|', index + 1)) {
      if (couldExtendRun(this.held.slice(index))) return index
    }
    return -1
  }
}

/**
 * Repair the markdown of one model stream.
 * @param source - the stream the adapter produced.
 * @returns the same chunks, with a text block's glued delimiter rows separated.
 */
export async function* readMarkdownFidelity(source: AsyncIterable<StreamChunk>): AsyncGenerator<StreamChunk> {
  const repair = new GluedTableRepair()
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
