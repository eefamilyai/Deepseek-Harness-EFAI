/**
 * Rendering a conversation into the single string a web chat turn accepts.
 *
 * The web endpoint takes one prompt, not a message array, so the transcript has
 * to be written out unambiguously: every turn labelled, tool calls rendered in
 * the same envelope the model is taught (so its own history reads the way it
 * writes), and tool results attributed to the tool that produced them.
 *
 * @module dswg/engine/prompt
 */

import type { CanonicalMessage, CanonicalRequest } from '../api/canonical.ts'
import { toolProtocolPrompt } from '../tools/protocol.ts'

/** Marker placed where a transcript was clipped for length. */
export const OMIT_MARKER = '\n\n[… earlier messages omitted to fit the context …]\n\n'

/**
 * Render one tool call in the taught envelope.
 * @param call - the call.
 * @returns the text.
 */
function renderToolCall(call: { name: string; arguments: Record<string, unknown> }): string {
  const body = JSON.stringify({ name: call.name, arguments: call.arguments })
  return `<tool_call>\n${body}\n</tool_call>`
}

/**
 * Render one message.
 * @param message - the message.
 * @returns the text, without a trailing blank line.
 */
function renderMessage(message: CanonicalMessage): string {
  switch (message.role) {
    case 'user':
      return `User:\n${message.content}`
    case 'assistant': {
      const parts: string[] = []
      if (message.content.trim().length > 0) parts.push(message.content)
      for (const call of message.toolCalls ?? []) parts.push(renderToolCall(call))
      return `Assistant:\n${parts.join('\n\n')}`
    }
    case 'tool': {
      const label = message.name ? `Tool result (${message.name})` : 'Tool result'
      return `${label}:\n${message.content}`
    }
    case 'system':
      return message.content
    default:
      return message.content
  }
}

/**
 * Build the prompt string for a turn.
 * @param request - the normalised request.
 * @returns the prompt text.
 */
export function buildPrompt(request: CanonicalRequest): string {
  const systemParts: string[] = []
  const turns: string[] = []

  for (const message of request.messages) {
    if (message.role === 'system') {
      if (message.content.trim().length > 0) systemParts.push(message.content.trim())
    } else if (message.droppedParts && message.droppedParts.length > 0) {
      turns.push(renderMessage({ ...message, content: `${message.content}\n${message.droppedParts.join('\n')}`.trim() }))
    } else {
      turns.push(renderMessage(message))
    }
  }

  const protocol = toolProtocolPrompt(request.tools)
  if (protocol) systemParts.push(protocol)
  if (request.correction) systemParts.push(request.correction)

  const head = systemParts.length > 0 ? `${systemParts.join('\n\n')}\n\n` : ''
  const body = turns.join('\n\n')
  return `${head}${body}\n\nAssistant:\n`
}

/**
 * Clip a prompt that exceeds the character budget, keeping the system head and
 * the most recent turns.
 * @param prompt - the full prompt.
 * @param maxChars - the budget.
 * @returns the possibly clipped prompt.
 */
export function clipPrompt(prompt: string, maxChars: number): { prompt: string; clipped: boolean } {
  if (prompt.length <= maxChars) return { prompt, clipped: false }
  const keepTail = Math.max(1, maxChars - OMIT_MARKER.length)
  // The head holds the system prompt and the first user turn, which carry the
  // instructions; the tail holds the live exchange.
  const headBudget = Math.min(80_000, Math.floor(keepTail * 0.25))
  const head = prompt.slice(0, headBudget)
  const tail = prompt.slice(prompt.length - (keepTail - headBudget))
  return { prompt: `${head}${OMIT_MARKER}${tail}`, clipped: true }
}

/**
 * Rough token estimate for accounting when the upstream reports nothing.
 * @param text - the text.
 * @returns an approximate token count.
 */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0
  const cjk = (text.match(/[\u3400-\u9fff\uf900-\ufaff]/g) ?? []).length
  const rest = text.length - cjk
  return Math.ceil(cjk * 1.6 + rest / 3.9)
}


/**
 * The most recent tool result in a conversation.
 * @param messages - the conversation.
 * @returns its text, or null when the conversation holds no tool result.
 */
export function lastToolResult(messages: readonly CanonicalMessage[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message && message.role === 'tool' && message.content.trim().length > 0) return message.content
  }
  return null
}
