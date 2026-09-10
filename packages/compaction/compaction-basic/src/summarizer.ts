// DSH-FORK(kiln): fork edit on an upstream-owned file. EXIT: a fork-owned compaction provider supplies this.
/**
 * Default one-shot summarization and durable checkpoint framing.
 *
 * @module @deepseek-ai/dsh-compaction-basic/summarizer
 */

import type { Context } from '@deepseek-ai/cordis'
import { contentHasImage, createUserMessage, BlockAssembler, LlmError } from '@deepseek-ai/dsh-llm'
import type {
  ContentBlock, FinishReason, GenerateOptions, Message, TokenUsage, ToolSchema,
} from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'

interface SummaryConfig {
  readonly summarizationProvider: string
  readonly summarizationModel: string
  readonly maxTokens: number
}

/** Tags wrapping the structured summary inside the landed checkpoint node. */
const SUMMARY_OPEN_TAG = '<compacted-summary>'
const SUMMARY_CLOSE_TAG = '</compacted-summary>'

/**
 * A dedicated summarizer system prompt that overrides the conversation's own
 * agent system prompt for the compaction call. The replayed transcript is a
 * coding-agent session — an agent system prompt plus hundreds of tool calls —
 * and continuing that role is exactly what made free-web DeepSeek answer the
 * compaction request with a `<tool_calls>` block instead of prose. Restating,
 * as the system prompt, that this turn is summarization-only with no tools is
 * the strongest lever against that. The compaction call already runs in an
 * isolated one-shot chat (see the llm-kiln adapter), so there is no warm prefix
 * cache to preserve by reusing the conversation's system prompt.
 */
const COMPACTION_SYSTEM = [
  'You are a transcript-summarization engine, not an interactive agent.',
  'You have NO tools and cannot act. The tool schemas, system prompt, and agent role in the conversation above governed the assistant whose work you are summarizing — none of them apply to you.',
  'Your ONLY output is the requested Markdown checkpoint, written as plain prose. Never emit a tool call, a <tool_calls> block, an <invoke> tag, runnable code, or any attempt to continue the task. You are condensing what already happened, not doing more of it.',
].join('\n')

/**
 * The summarization directive, delivered as the FINAL user message after the
 * replayed conversation. It pairs with {@link COMPACTION_SYSTEM}; the anti-action
 * directive leads here too because the transcript's tool-call examples are strong
 * enough that the reminder has to sit right next to the request.
 */
const COMPACTION_INSTRUCTION = [
  'Summarize the conversation ABOVE into a structured checkpoint that lets another model resume the work with no loss of essential context. This is a summarization task ONLY: do not continue the work, do not call any tool, and do not emit a <tool_calls> block, an <invoke> tag, or runnable code. If the conversation above is full of tool calls, SUMMARIZE them — never imitate them. Output prose only.',
  '',
  'The reader is a fresh model that CANNOT see the conversation above — only your checkpoint. It must know, without guessing: where the work stands right now, the exact next action to take, and every fact needed to take it. Make "## Current Work" and "## Next Step" unambiguous and self-sufficient; those two sections are what the reader acts on first.',
  '',
  'Output EXACTLY the Markdown structure below: keep every section, in order. Use terse bullets, not prose paragraphs. Write "(none)" for an empty section — never drop a section.',
  '',
  '## Primary Request and Intent',
  "- [the user's original and evolving goals; quote verbatim where the exact wording matters]",
  '',
  '## Key Technical Concepts',
  '- [technologies, frameworks, patterns, and conventions in play]',
  '',
  '## Files and Code',
  '- [exact path: why it matters, key changes or snippets]',
  '',
  '## Errors and Fixes',
  '- [error: how it was resolved, plus any related user feedback]',
  '',
  '## Pending Jobs',
  '- [explicitly requested work not yet completed]',
  '',
  '## Current Work',
  '- [the exact position right now: which file/function, what was just done, what is half-finished, any command or tool call mid-flight and its state]',
  '',
  '## Next Step',
  '- [the single concrete next action the reader should take — the specific edit, command, or tool call, not a vague direction — directly in line with the most recent request, or "(none)"]',
  '',
  '## Critical Context',
  '- [decisions and their rationale, constraints, user preferences, open questions, data needed to continue]',
  '',
  'Rules:',
  '- Write concise English engineering prose. Preserve exact file paths, commands, error strings, identifiers, numeric values, function signatures, and syntax fragments.',
  '- Capture user feedback and explicit instructions faithfully, especially corrections.',
  '- Do NOT mention this summarization request or that the context was compacted.',
  '- Output only the checkpoint text. Never call a tool or emit tool-call markup (<tool_calls>, <invoke>, or code to run); the transcript above is material to condense, not a pattern to continue.',
  `- If the conversation already contains a ${SUMMARY_OPEN_TAG} block, it is a PRIOR checkpoint. Do not copy it forward verbatim: preserve still-true facts, drop stale ones, and merge newer information into a single consolidated summary under the same structure.`,
].join('\n')

/** Framing that makes the replacement user message established context. */
const CHECKPOINT_PREAMBLE =
  'This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context. Treat the captured context as established background and build on it without restating it. Continue the task directly from the messages that follow, without acknowledging this checkpoint.'

/**
 * The replayed conversation surface the summarizer condenses. Reproducing the
 * last routed request's system prompt, tools, and leading messages verbatim
 * lets the auxiliary call reuse the provider's warm prefix cache; the trailing
 * compaction instruction is then the only novel input.
 */
export interface SummarizationInput {
  /** The conversation's own system prompt, reused for prefix-cache alignment; absent for a system-less request. */
  readonly system?: string
  /** The conversation's tool schemas, reused for prefix-cache alignment; absent when the request carried none. */
  readonly tools?: readonly ToolSchema[]
  /** The shadowed region, in surface order, that precedes the compaction instruction. */
  readonly messages: readonly Message[]
}

/** Safe summary content plus the exact auxiliary call envelope recorded with it. */
export type SummaryResult = {
  summary: ContentBlock[]
  provider: string
  model: string
  maxTokens?: number
  /** Provider-reported usage for this summarization request. */
  usage?: TokenUsage
} & (
  | {
    /** Complete provider output before the text-only summary projection. */
    rawOutput: ContentBlock[]
    /** Identifies exactly one call through this context's `ctx.llm.stream()`. */
    llmStreamCall: true
  }
  | {
    /** Optional complete output from an unmarked template, remote, or other summarizer. */
    rawOutput?: ContentBlock[]
    /** An unmarked result does not identify a call through this context's LLM seam. */
    llmStreamCall?: never
  }
)

/**
 * Run the default cache-reusing `ctx.llm.stream()` summarization call: replay
 * the conversation prefix, then append the compaction instruction as the final
 * user message so the provider's warm prefix cache is reused.
 * @param ctx - context providing the LLM service.
 * @param config - resolved backend configuration.
 * @param input - replayed conversation prefix (system, tools, and leading messages) to condense.
 * @param agent - supplies routed-model history, fallback model, and session id.
 * @param signal - optional cancellation forwarded to the adapter.
 * @returns safe text-only summary blocks and the exact call envelope and output.
 */
export async function summarizeWithLlm(
  ctx: Context,
  config: SummaryConfig,
  input: SummarizationInput,
  agent: Agent,
  signal?: AbortSignal,
): Promise<SummaryResult> {
  const latest = agent.session.requestHeader()?.config
  const configured = config.summarizationProvider.length === 0
    ? undefined
    : { provider: config.summarizationProvider, model: config.summarizationModel }
  const agentTarget = agent.options.provider !== undefined
    && agent.options.provider.length > 0
    && agent.options.model !== undefined
    && agent.options.model.length > 0
    ? { provider: agent.options.provider, model: agent.options.model }
    : undefined
  const target = configured ?? latest ?? agentTarget
  if (target === undefined) {
    throw new Error(
      'no provider/model available for summarization: set both BasicCompactionConfig summarization fields, route one request, or set both AgentOptions fields',
    )
  }

  const assembler = new BlockAssembler()
  const messages: Message[] = [
    ...input.messages,
    createUserMessage({
      content: [{ type: 'text', text: COMPACTION_INSTRUCTION }],
      source: { kind: 'plugin', plugin: 'dsh-compaction-basic' },
    }),
  ]
  // A summarizer must never emit a tool call. Two things make free-web DeepSeek
  // answer the compaction request WITH a tool call instead of prose, and both
  // are countered here:
  //   1. Tools: replaying the conversation's tool roster advertised callable
  //      tools, so the model called one. Withholding tools keeps the call
  //      text-only. (A leaked block then also can't be parsed as a real call,
  //      so summaryText() strips its markup rather than landing it as prose.)
  //   2. Role: the replayed agent system prompt told the model it was a tool-
  //      using coder, and it continued that loop. COMPACTION_SYSTEM overrides it
  //      with a summarizer-only role. The isolated one-shot chat has no warm
  //      prefix cache to preserve, so dropping the conversation's system prompt
  //      costs nothing.
  // Correctness before cache reuse.
  const options: GenerateOptions = {
    provider: target.provider,
    model: target.model,
    messages,
    system: COMPACTION_SYSTEM,
    maxTokens: config.maxTokens,
    sessionId: agent.session.id,
    purpose: 'compaction',
    ...signal === undefined ? {} : { signal },
  }
  for await (const chunk of ctx.llm.stream(options)) assembler.push(chunk)

  const rawOutput = assembler.blocks()
  const finish = assembler.finish
  const streamError = finishError(finish)
  if (streamError !== undefined) {
    ctx.logger.warn(compactionDiagnostic('stream error', input, rawOutput, finish, streamError))
    throw streamError
  }

  const summary = summaryText(rawOutput)
  if (!summary.some(block => block.text.trim().length > 0)) {
    ctx.logger.warn(compactionDiagnostic('no text output', input, rawOutput, finish))
    throw new Error('summarization produced no text summary content')
  }
  return {
    summary,
    rawOutput,
    llmStreamCall: true,
    provider: options.provider,
    model: options.model,
    maxTokens: config.maxTokens,
    ...(assembler.usage === undefined ? {} : { usage: assembler.usage }),
  }
}

/**
 * Wrap raw summary blocks in the durable checkpoint framing.
 * @param summary - safe text-only model output.
 * @returns content for the synthesized replacement user message.
 */
export function frameSummary(summary: readonly ContentBlock[]): ContentBlock[] {
  return [
    { type: 'text', text: `${CHECKPOINT_PREAMBLE}\n\n${SUMMARY_OPEN_TAG}` },
    ...summary,
    { type: 'text', text: SUMMARY_CLOSE_TAG },
  ]
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

/**
 * Excise any tool-call markup the model echoed into its prose.
 *
 * The compaction call withholds the tool schemas, so the DSML translator cannot
 * recognise a `<tool_calls>`/`<invoke>`/`<tool_call>` block and forwards it as
 * literal text — which, unstripped, lands raw tool-call markup inside the
 * checkpoint (the exact symptom that motivated this backstop). Only balanced
 * blocks are removed, so prose that merely mentions the tag names survives; a
 * reply that was ONLY a tool call strips to empty and fails closed as
 * "no text summary content", leaving the conversation unchanged.
 */
function stripToolMarkup(text: string): string {
  return text
    .replace(/<tool_calls\b[\s\S]*?<\/tool_calls>/gi, '')
    .replace(/<tool_call\b[\s\S]*?<\/tool_call>/gi, '')
    .replace(/<invoke\b[\s\S]*?<\/invoke>/gi, '')
    // DeepSeek's native tool-call markup (fullwidth-pipe DSML tokens), which a
    // tools-withheld compaction call leaks as text just like the taught format:
    // first a complete `<｜｜DSML｜｜ name="…">…</｜｜DSML｜｜>` block, then any
    // leftover `<｜｜DSML｜｜_calls>` frame tokens.
    .replace(/<[|｜]+\s*DSML[\s\S]*?<\/[|｜]+\s*DSML[|｜]*>/gi, '')
    .replace(/<[|｜]*\/?[|｜]*DSML[|｜]*[_▁](?:calls?|sep)[^>]*>/gi, '')
    .trim()
}

/** Reject visual output, keep only text, and strip any leaked tool-call markup. */
function summaryText(
  blocks: readonly ContentBlock[],
): Array<Extract<ContentBlock, { type: 'text' }>> {
  if (contentHasImage(blocks)) {
    throw new LlmError('compaction summary cannot contain image output', 'UNSUPPORTED_CONTENT')
  }
  return blocks
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map(block => ({ ...block, text: stripToolMarkup(block.text) }))
}

/**
 * One-line reason a compaction summarization call yielded no usable summary.
 * Distinguishes an oversized/errored request (`finish=error`, large input) from
 * the model answering with non-text — a tool call or reasoning-only reply
 * (`finish=tool-calls`/`stop`, `output` without a `text` entry).
 */
function compactionDiagnostic(
  reason: string,
  input: SummarizationInput,
  output: readonly ContentBlock[],
  finish: FinishReason,
  error?: Error & { code?: string },
): string {
  const blockCounts: Record<string, number> = {}
  let outputTextChars = 0
  for (const block of output) {
    blockCounts[block.type] = (blockCounts[block.type] ?? 0) + 1
    if (block.type === 'text') outputTextChars += block.text.length
  }
  const inputChars = input.messages.reduce((total, message) => total + JSON.stringify(message).length, 0)
  const fields = [
    `compaction summarize failed (${reason})`,
    `finish=${finish.kind}`,
    `inputMsgs=${input.messages.length}`,
    `~inputChars=${inputChars}`,
    `system=${input.system === undefined ? 'none' : `${input.system.length}c`}`,
    `tools=${input.tools?.length ?? 0}`,
    `output=${JSON.stringify(blockCounts)}`,
    `outputTextChars=${outputTextChars}`,
  ]
  if (error !== undefined) {
    fields.push(`err=${error.message}${error.code === undefined ? '' : ` [${error.code}]`}`)
  }
  return fields.join(' ')
}
