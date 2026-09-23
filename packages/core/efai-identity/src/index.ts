/**
 * The fork's identity opener: the first thing the model reads, replacing the
 * harness's shipped one.
 *
 * The opener states what kind of machine the agent is on and what "done" means
 * here, so it has to arrive before the deployment persona and before any tool
 * guidance — the harness reserves order −1000 for exactly that, and registers
 * its own text there.
 *
 * This plugin rewrites the assembled section rather than registering a second
 * one. Registering another section cannot work: `harness:identity` is a unique
 * name, a second section at the same order would render beside the first
 * rather than instead of it, and the shipped opener can be switched off by a
 * config field that any later patch layer may restate. Rewriting the assembly
 * is the one place where the answer is the same in all three cases — the
 * opener present, absent, or replaced by someone else.
 *
 * ```yaml
 * - id: efai-identity
 *   name: '@deepseek-ai/dsh-efai-identity'
 *   config:
 *     text: 'You are an AI agent ...'
 * ```
 *
 * @module @deepseek-ai/dsh-efai-identity
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { AssembleContext, AssembledSection, PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-system-prompt'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'efai-identity'

/** The opener rides the assembly, so the prompt service must be present. */
export const inject = ['systemPrompt']

/** The section name the harness reserves for the opener. */
export const IDENTITY_SECTION = 'harness:identity'

/** The opener this fork ships when the composition states none. */
export const DEFAULT_IDENTITY = 'You are an AI agent in a fully enclosed sandbox for windows related testing'
  + ' and software development. Put in maximum effort no matter how long the task takes, even if it takes'
  + ' hours; quality is the ultimate goal. *In large directories, use optimised ways to search through the'
  + ' directory. Or write optimized code in general.*'

/** Plugin config: the opener text. */
export interface Config {
  /** The opener the model reads first. An empty string removes the opener entirely. */
  text?: string
}

export const Config: z<Config> = z.object({
  text: z.string().default(DEFAULT_IDENTITY)
    .description('The first line of the system prompt, replacing the harness identity opener.'),
})

/**
 * Put `text` in the identity section of one assembly.
 *
 * Exported for the test that pins the three cases apart; the plugin itself
 * only ever calls it through the waterfall.
 * @param sections - the assembled sections, in render order.
 * @param text - the opener; empty removes the section.
 * @returns the sections with exactly one identity section, or none when `text` is empty.
 */
export function withIdentity(sections: readonly AssembledSection[], text: string): AssembledSection[] {
  const rest = sections.filter(section => section.name !== IDENTITY_SECTION)
  if (text.length === 0) return rest
  // The opener is order −1000, which is what puts it first; the assembly is
  // already sorted, so position rather than order carries that here.
  return [{ name: IDENTITY_SECTION, text }, ...rest]
}

/**
 * Register the rewrite.
 * @param ctx - the plugin context.
 * @param config - the resolved configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const text = config.text ?? DEFAULT_IDENTITY
  ctx.on('system-prompt/assemble', async (_assembly: PromptAssembly, _context: AssembleContext, next) => {
    const assembled = await next()
    return { ...assembled, sections: withIdentity(assembled.sections, text) }
  })
}
