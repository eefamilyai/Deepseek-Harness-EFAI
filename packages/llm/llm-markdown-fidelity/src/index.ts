/**
 * Markdown fidelity for a model's text stream.
 *
 * A GFM table needs its header and its delimiter row on separate lines, and a model
 * occasionally writes the pair as one — `| Route title | Choice|---|---|`. Nothing below
 * repairs that: a renderer reads the whole answer as a paragraph of pipes, so the table the
 * model asked for never appears, and the session keeps the malformed text for every reader
 * after it. This pass sits on `llm/stream`, so it covers every route rather than the one
 * adapter a session happened to use.
 *
 * ```yaml
 * - id: llm-markdown-fidelity
 *   name: '@deepseek-ai/dsh-llm-markdown-fidelity'
 * ```
 *
 * @module @deepseek-ai/dsh-llm-markdown-fidelity
 */

import type { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { readMarkdownFidelity } from './stream.ts'

export { GluedTableRepair, readMarkdownFidelity } from './stream.ts'
export { cellsOf, delimiterRun, gluedDelimiterAt, isHeaderSegment, repairGluedTableDelimiter } from './repair.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'llm-markdown-fidelity'

/** The service whose streaming waterfall this pass joins. */
export const inject = ['llm']

/**
 * Repair the markdown of every model stream.
 *
 * Registered plainly, like the text-toolcall reader beside it: a stream transform that a
 * later pass, the session, and every replay all see is a repair of the answer itself, and
 * one that only touched the rendered page would leave the recorded text malformed.
 * @param ctx - the plugin context.
 */
export function apply(ctx: Context): void {
  ctx.on('llm/stream', (_options: GenerateOptions, next: () => AsyncIterable<StreamChunk>) =>
    readMarkdownFidelity(next()))
}
