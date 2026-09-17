/**
 * DSML for every route: the text-channel tool-call reader, and the one
 * `llm/stream` pass that applies it to whatever adapter answered.
 *
 * A model writes the tool-call markup it was trained on. Which markup that is
 * depends on the model, not on the transport it is speaking through, so a
 * request that filled a provider's native `tools` field correctly can still get
 * a call back as TEXT — `<tool_calls>`, `<function_calls>`, or DeepSeek's
 * pipe-wrapped `<｜｜DSML｜｜ …>` special tokens — from any provider hosting that
 * model. Without this pass, that call reaches the user as markup and reads back
 * to the model as an action that returned nothing: the turn is spent, and
 * neither side is told why.
 *
 * So the reading is unconditional and the TEACHING is not. Only an adapter with
 * no native tool channel states the format ({@link toolProtocolPrompt}, which
 * the Kiln adapter appends to its system slot); every route is read. That
 * asymmetry is the whole design, and it is why this pass is silent: a provider
 * that was handed real tool schemas was never told to write DSML, so a note
 * correcting how it spelled DSML would be the harness inventing a protocol
 * dispute. What it can parse, it converts; everything else passes through
 * exactly as the adapter emitted it.
 *
 * Being silent is also what makes it safe above an adapter that already reads
 * this format for itself. The Kiln adapter parses its own stream; what reaches
 * this pass from it is text that produced no call, which — same tools, same
 * rules — produces no call here either and is forwarded untouched.
 *
 * ```yaml
 * - id: llm-dsml
 *   name: '@deepseek-ai/dsh-llm-dsml'
 * ```
 *
 * @module @deepseek-ai/dsh-llm-dsml
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { readDsmlStream, toolIndex } from './stream.ts'

export { DsmlTranslator, invokeArguments, trailingReasoningCalls } from './dsml.ts'
export type { DsmlEvent, DsmlOptions } from './dsml.ts'
export { mintDsmlCallId, readDsmlStream, toolIndex } from './stream.ts'
export type { DsmlStreamOptions } from './stream.ts'
export {
  coerceParameter,
  DSML_CLOSE,
  DSML_OPEN,
  escapeXml,
  parameterNames,
  renderParameter,
  requiredNames,
  toolProtocolPrompt,
  unescapeXml,
} from './protocol.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'llm-dsml'

/** The service whose streaming waterfall this pass joins. */
export const inject = ['llm']

/** Plugin config. */
export interface Config {
  /**
   * Recover a complete tool call the model left at the end of its reasoning
   * when the turn produced none in its answer. Off, such a call stays in the
   * thought and the turn runs nothing.
   */
  reasoningRecovery?: boolean
  /**
   * Provider routes to leave untouched, by registered route name. Empty — the
   * default — reads every route, which is the point of the pass; name a route
   * here only to rule out this reader while diagnosing one.
   */
  excludeProviders?: string[]
}

export const Config: z<Config> = z.object({
  reasoningRecovery: z.boolean().default(true)
    .description('Run a tool call the model wrote at the end of its thinking, when its answer'
      + ' called nothing. Off, the call stays in the thought and the turn ends having run nothing.'),
  excludeProviders: z.array(z.string()).default([])
    .description('Provider routes to exclude from text tool-call reading, by route name.'
      + ' Empty reads every route.'),
})

/**
 * Install the reader over every model stream.
 *
 * The listener is registered plainly rather than prepended, so it sits as close
 * to the adapter as the composition allows: retry, replay, and checkpoint
 * layers then see the stream a native-tool provider would have produced, and a
 * recovered call is a real call to every one of them.
 * @param ctx - the plugin context.
 * @param config - the composition-layer config.
 */
export function apply(ctx: Context, config: Config): void {
  const excluded = new Set(config.excludeProviders ?? [])
  const reasoningRecovery = config.reasoningRecovery ?? true
  ctx.on('llm/stream', (options: GenerateOptions, next): AsyncIterable<StreamChunk> => {
    if (excluded.has(options.provider)) return next()
    // A request with no tools declared cannot produce a call, so its `<invoke>`
    // is prose about a tool that does not exist here — a title or compaction
    // call quoting a transcript, most often. `readDsmlStream` returns the stream
    // itself in that case, so an auxiliary call pays nothing for this pass.
    return readDsmlStream(next(), toolIndex(options.tools), { reasoningRecovery })
  })
}
