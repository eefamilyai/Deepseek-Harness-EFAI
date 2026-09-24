/**
 * The text channel as a fallback for a model that cannot take native tools.
 *
 * Some models answer a request that carries a `tools` field with a refusal
 * rather than a reply: OpenRouter routes a model only to endpoints that
 * support tool use, and a model with none fails the whole turn with
 * "No endpoints found that support tool use"; Ollama and some OpenAI-compatible
 * servers refuse the same way. The model itself can still act — it only needs
 * the tools described as text, which is exactly the channel the Kiln routes
 * use. So the refused request is sent again with the tools stated in the
 * system prompt (the same format statement Kiln teaches), the tool calls and
 * results already in the history rendered as text, and no `tools` field; the
 * reader turns the text calls in the reply into real tool calls.
 * @module @deepseek-ai/dsh-llm-dsml/fallback
 */

import type { ContentBlock, GenerateOptions, LlmFailure, RequestMessage, StreamChunk } from '@deepseek-ai/dsh-llm'
import { DSML_CLOSE, DSML_OPEN, escapeXml, renderParameter, toolProtocolPrompt } from './protocol.ts'

/**
 * Refusals that mean "this model cannot take a native `tools` field", as the
 * providers word them. Anything else — a bad key, a rate limit, an outage —
 * fails exactly as before.
 */
const NATIVE_TOOLS_REFUSED: readonly RegExp[] = [
  // OpenRouter: every endpoint serving the model lacks tool support.
  /no endpoints found that support tool use/i,
  // Ollama: "registry.ollama.ai/library/<model> does not support tools".
  /does not support tools/i,
  // OpenAI-compatible servers and gateways.
  /does not support (?:tool|function)[ _-]?(?:use|call|calling)/i,
  /(?:tool|function)[ _-]?(?:use|call|calling)s? (?:is|are) not supported/i,
]

/**
 * Whether a failed request was refused because it carried native tools.
 * @param failure - the provider failure.
 * @returns true for a tool-support refusal.
 */
export function refusesNativeTools(failure: LlmFailure): boolean {
  return NATIVE_TOOLS_REFUSED.some(pattern => pattern.test(failure.message))
}

/**
 * Pass a stream through, unless the provider refused it for carrying native
 * tools — then answer with `retry()` instead.
 *
 * A refusal arrives before any output, as the stream's terminal error chunk,
 * so the chunks ahead of it (at most a usage report) are held until the first
 * one that decides it. Once real output starts, nothing is held or retried.
 * @param source - the stream of the request as sent.
 * @param retry - the text-channel stream to answer with on a refusal.
 * @returns the stream to hand on.
 */
export async function* retryOnToolRefusal(
  source: AsyncIterable<StreamChunk>,
  retry: () => AsyncIterable<StreamChunk>,
): AsyncIterable<StreamChunk> {
  const iterator = source[Symbol.asyncIterator]()
  try {
    const held: StreamChunk[] = []
    for (;;) {
      const item = await iterator.next()
      if (item.done === true) {
        yield* held
        return
      }
      const chunk = item.value
      if (chunk.type === 'usage') {
        held.push(chunk)
        continue
      }
      if (chunk.type === 'finish' && chunk.reason.kind === 'error' && refusesNativeTools(chunk.reason.failure)) {
        yield* retry()
        return
      }
      yield* held
      yield chunk
      break
    }
    for (;;) {
      const item = await iterator.next()
      if (item.done === true) return
      yield item.value
    }
  } finally {
    await iterator.return?.()
  }
}

/**
 * Render one prior tool call as the text block a model writes in this format,
 * so the history it reads back demonstrates the one format it was taught.
 * @param name - the tool name.
 * @param args - the call's JSON arguments.
 * @returns the call as a DSML block, or a labelled line when the arguments are not an object.
 */
export function renderInvoke(name: string, args: string): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(args)
  } catch {
    return `[tool call ${name}] ${args}`
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return `[tool call ${name}] ${args}`
  const lines = [DSML_OPEN, `<invoke name="${escapeXml(name)}">`]
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (value === undefined) continue
    lines.push(`<parameter name="${escapeXml(key)}">${escapeXml(renderParameter(value))}</parameter>`)
  }
  lines.push('</invoke>', DSML_CLOSE)
  return lines.join('\n')
}

/** A message's blocks with every tool call rendered as text. */
function flattenCalls(content: readonly ContentBlock[]): ContentBlock[] {
  return content.map(block => block.type === 'tool-call'
    ? { type: 'text', text: renderInvoke(block.name, block.arguments) }
    : block)
}

/**
 * The refused request, rewritten for the text channel.
 *
 * The format statement and tool catalog join the system prompt: the leading
 * system-role message a loop-built request carries, or the `system` field a
 * one-shot uses. Prior calls become text in their assistant turns, and each
 * tool result becomes a user turn labelled `OUTPUT:`, the way the Kiln routes
 * read results back — a provider that refuses a `tools` field may refuse a
 * history that implies one just the same.
 * @param options - the refused request.
 * @returns the request to send instead.
 */
export function textChannelRequest(options: GenerateOptions): GenerateOptions {
  const protocol = toolProtocolPrompt(options.tools)
  const systemAt = options.messages.findIndex(message => message.role === 'system')
  const messages: RequestMessage[] = options.messages.map((message, index): RequestMessage => {
    if (index === systemAt && message.role === 'system') {
      return { ...message, content: [...message.content, { type: 'text', text: `\n\n${protocol}` }] }
    }
    if (message.role === 'assistant' && message.content.some(block => block.type === 'tool-call')) {
      return { ...message, content: flattenCalls(message.content) }
    }
    if (message.role === 'tool') {
      const [first, ...rest] = message.content
      const label = message.isError === true ? 'OUTPUT (error):' : 'OUTPUT:'
      const body: ContentBlock[] = first?.type === 'text'
        ? [{ ...first, text: `${label}\n${first.text}` }, ...rest]
        : [{ type: 'text', text: label }, ...message.content]
      return { role: 'user', content: body }
    }
    return message
  })
  const request: GenerateOptions = { ...options, messages }
  Reflect.deleteProperty(request, 'tools')
  if (systemAt < 0) {
    request.system = [options.system, protocol].filter(part => part !== undefined && part.length > 0).join('\n\n')
  }
  return request
}
