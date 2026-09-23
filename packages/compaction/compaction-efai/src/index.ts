/**
 * The fork's compaction provider: upstream's basic engine with a
 * summarization call written for text-only routes, a pre-summarization prune,
 * and a manual `/compact` that waits for the turn in flight.
 *
 * Three differences from `@deepseek-ai/dsh-compaction-basic`, each of which
 * exists because of how this fork actually runs:
 *
 * 1. **A dedicated summarizer system prompt.** The replayed transcript is a
 *    coding-agent session — an agent system prompt plus hundreds of tool calls
 *    — and continuing that role is exactly what made free-web DeepSeek answer
 *    the compaction request with a `<tool_calls>` block instead of prose.
 *    Restating, as the system prompt, that this turn is summarization-only
 *    with no tools is the strongest lever against that. Upstream's call sends
 *    no system field at all, which is why this overrides the whole hook rather
 *    than decorating its input.
 * 2. **A prune before the manual path summarizes.** The automatic
 *    pressure/overflow path already lands the model-free tool-result prune;
 *    the manual one did not, so a `/compact` on a near-full conversation
 *    replayed every byte and overflowed the summarization call itself.
 * 3. **`/compact` waits for idle.** `compactNow` raises `busy` while the agent
 *    is mid-turn. Waiting once and retrying lets a `/compact` typed during an
 *    active run settle behind it, the way a queued message does, instead of
 *    failing with "the agent is not idle". Keeping that here rather than in
 *    the command means every caller of the seam gets it.
 *
 * ```yaml
 * - id: compaction-basic
 *   disabled: true
 * - id: compaction-efai
 *   name: '@deepseek-ai/dsh-compaction-efai'
 * ```
 *
 * @module @deepseek-ai/dsh-compaction-efai
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import { ManualCompactionError } from '@deepseek-ai/dsh-compaction'
// Type-only: carries the ctx.toolResultPruner merge this engine reads.
import type {} from '@deepseek-ai/dsh-compaction-tool-result-pruner'
import type { CompactionResult } from '@deepseek-ai/dsh-compaction'
import type { CommandId } from '@deepseek-ai/dsh-commands/brand'
import { BlockAssembler, LlmError, contentHasImage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, FinishReason, GenerateOptions, Message } from '@deepseek-ai/dsh-llm'
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic'
import type { SummarizationInput, SummaryResult } from '@deepseek-ai/dsh-compaction-basic/src/summarizer.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'compaction-efai'

/**
 * The summarizer's own system prompt, replacing the conversation's role for
 * this one call.
 */
export const COMPACTION_SYSTEM: string = [
  'You are a transcript-summarization engine, not an interactive agent.',
  'You have NO tools and cannot act. The tool schemas, system prompt, and agent role in the conversation above governed the assistant whose work you are summarizing — none of them apply to you.',
  'Your ONLY output is the requested Markdown checkpoint, written as plain prose. Never emit a tool call, a <tool_calls> block, an <invoke> tag, runnable code, or any attempt to continue the task. You are condensing what already happened, not doing more of it.',
].join('\n')

/**
 * The trailing instruction, written for a reader that cannot see the
 * transcript.
 *
 * The anti-action directive leads here as well as in the system prompt,
 * because the transcript's own tool-call examples are strong enough that the
 * reminder has to sit right next to the request.
 */
export const COMPACTION_INSTRUCTION: string = [
  'Summarize the conversation ABOVE into a structured checkpoint that lets another model resume the work with no loss of essential context. This is a summarization task ONLY: do not continue the work, do not call any tool, and do not emit a <tool_calls> block, an <invoke> tag, or runnable code. If the conversation above is full of tool calls, SUMMARIZE them — never imitate them. Output prose only.',
  '',
  'The reader is a fresh model that CANNOT see the conversation above — only your checkpoint. It must know, without guessing: where the work stands right now, the exact next action to take, and every fact needed to take it. Make "## Current Work" and "## Next Step" unambiguous and self-sufficient; those two sections are what the reader acts on first.',
  '',
  '## Work Done',
  '- [what was accomplished, with the files, commands, and decisions that carried it]',
  '',
  '## Current Work',
  '- [the exact position right now: which file/function, what was just done, what is half-finished, any command or tool call mid-flight and its state]',
  '',
  '## Next Step',
  '- [the single concrete next action the reader should take — the specific edit, command, or tool call, not a vague direction — directly in line with the most recent request, or "(none)"]',
  '',
  'Rules:',
  '- Preserve exact identifiers: file paths, symbol names, commands, error text, and numbers.',
  '- Output only the checkpoint text. Never call a tool or emit tool-call markup (<tool_calls>, <invoke>, or code to run); the transcript above is material to condense, not a pattern to continue.',
].join('\n')

/** Keep only text blocks, refusing image output the checkpoint cannot carry. */
function summaryText(blocks: readonly ContentBlock[]): Array<Extract<ContentBlock, { type: 'text' }>> {
  if (contentHasImage(blocks)) {
    throw new LlmError('compaction summary cannot contain image output', 'UNSUPPORTED_CONTENT')
  }
  return blocks.filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
}

/** Map a terminal summarization finish to its fail-closed error. */
function finishError(finish: FinishReason): Error | undefined {
  switch (finish.kind) {
    case 'error':
    case 'aborted': {
      const error = new Error(finish.failure.message) as Error & { code?: string }
      error.code = finish.failure.code
      return error
    }
    case 'max-tokens': {
      const error = new Error('summarization truncated at the token cap (incomplete checkpoint)') as Error & { code?: string }
      error.code = 'MAX_TOKENS'
      return error
    }
    default:
      return undefined
  }
}

/** Whether a failure is the seam's "the agent is not idle" refusal. */
function isBusy(error: unknown): boolean {
  return error instanceof ManualCompactionError && error.code === 'busy'
}

/** Upstream's engine, with this fork's summarization call and manual path. */
export class EfaiCompactionEngine extends BasicCompactionEngine {
  /**
   * Summarize through a one-shot call whose system prompt is the summarizer's
   * own, not the conversation's.
   *
   * Target selection matches the seam's: the configured summarization route
   * when one is set, else the route the latest request was durably sent to,
   * else the agent's own. No prefix-cache alignment is attempted — the system
   * prompt differs from the conversation's by design, so the prefix is novel
   * whatever else this call does.
   * @param input - replayed conversation prefix to condense.
   * @param agent - supplies routed-model history, fallback model, and session id.
   * @param signal - optional cancellation forwarded to the adapter.
   * @returns the summary blocks and the exact call envelope.
   */
  protected override async summarize(
    input: SummarizationInput,
    agent: Agent,
    signal?: AbortSignal,
  ): Promise<SummaryResult> {
    const routed = agent.session.requestHeader()?.config
    const configured = this.config.summarizationProvider.length === 0
      ? undefined
      : { provider: this.config.summarizationProvider, model: this.config.summarizationModel }
    const agentTarget = agent.options.provider !== undefined && agent.options.provider.length > 0
      && agent.options.model !== undefined && agent.options.model.length > 0
      ? { provider: agent.options.provider, model: agent.options.model }
      : undefined
    const target = configured
      ?? (routed !== undefined && routed.provider.length > 0 && routed.model.length > 0
        ? { provider: routed.provider, model: routed.model }
        : undefined)
      ?? agentTarget
    if (target === undefined) {
      throw new Error(
        'no provider/model available for summarization: set both summarization fields, route one request, or set both AgentOptions fields',
      )
    }

    const messages: Message[] = [
      ...input.messages,
      createUserMessage({
        content: [{ type: 'text', text: COMPACTION_INSTRUCTION }],
        source: { kind: 'plugin', plugin: 'dsh-compaction-efai' },
      }),
    ]
    const options: GenerateOptions = {
      provider: target.provider,
      model: target.model,
      system: COMPACTION_SYSTEM,
      messages,
      maxTokens: this.config.maxTokens,
      sessionId: agent.session.id,
      purpose: 'compaction',
      ...signal === undefined ? {} : { signal },
    }

    const assembler = new BlockAssembler()
    for await (const chunk of this.ctx.llm.stream(options)) assembler.push(chunk)
    const streamError = finishError(assembler.finish)
    if (streamError !== undefined) throw streamError

    const rawOutput = assembler.blocks()
    const summary = summaryText(rawOutput)
    if (!summary.some(block => block.text.trim().length > 0)) {
      throw new Error('summarization produced no text summary content')
    }
    return {
      summary,
      rawOutput,
      llmStreamCall: true,
      provider: options.provider,
      model: options.model,
      maxTokens: this.config.maxTokens,
      ...assembler.usage === undefined ? {} : { usage: assembler.usage },
    }
  }

  /**
   * Prune tool results first, and wait out a turn in flight rather than
   * refusing.
   *
   * The prune runs before the maintenance task rather than inside it, which is
   * the one behavioral difference from the automatic path: `compactNow`
   * requires an idle agent, so there is no turn to race with by the time this
   * runs.
   * @param agent - the agent whose surface is compacted.
   * @param signal - cancellation for the whole attempt, including the wait.
   * @param sourceCommandId - the command that asked, when one did.
   * @returns the compaction result, or null when nothing was compactable.
   */
  override async compactNow(
    agent: Agent,
    signal: AbortSignal,
    sourceCommandId?: CommandId,
  ): Promise<CompactionResult | null> {
    const prune = (): void => { this.ctx.get('toolResultPruner')?.pruneSession(agent.session) }
    try {
      prune()
      return await super.compactNow(agent, signal, sourceCommandId)
    } catch (error: unknown) {
      if (!isBusy(error) || signal.aborted) throw error
      await agent.whenIdle()
      signal.throwIfAborted()
      prune()
      return await super.compactNow(agent, signal, sourceCommandId)
    }
  }
}

export default EfaiCompactionEngine

/** Plugin config: upstream's, unchanged — the subclass adds no fields. */
export type { BasicCompactionConfig as Config } from '@deepseek-ai/dsh-compaction-basic'

/** Type-only re-export so a consumer can name what the ctx service is. */
export type { SummarizationInput, SummaryResult }
