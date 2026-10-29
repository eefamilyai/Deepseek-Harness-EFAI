/**
 * The provider-neutral request and response the gateway's engine works on.
 *
 * Both public APIs (OpenAI chat completions, Anthropic messages) are translated
 * into this shape, so the prompt builder, the tool protocol and the account
 * pool never need to know which client is calling.
 *
 * @module dswg/api/canonical
 */

import type { ToolDefinition } from '../tools/protocol.ts'

/** Who wrote one message. */
export type Role = 'system' | 'user' | 'assistant' | 'tool'

/** One tool call, in the form the engine reasons about. */
export interface CanonicalToolCall {
  id: string
  name: string
  arguments: Record<string, unknown>
}

/** One message in the conversation. */
export interface CanonicalMessage {
  role: Role
  /** Flattened text content. */
  content: string
  /** Tool name for `tool` messages. */
  name?: string
  /** Which call a `tool` message answers. */
  toolCallId?: string
  /** Calls the assistant made in this message. */
  toolCalls?: CanonicalToolCall[]
  /** Non-text content that could not be forwarded, kept only to report it. */
  droppedParts?: string[]
}

/** Why generation stopped. */
export type FinishReason = 'stop' | 'length' | 'tool_calls' | 'content_filter'

/** A normalised turn request. */
export interface CanonicalRequest {
  /** Client-visible model id, already resolved to a mode. */
  model: string
  messages: CanonicalMessage[]
  tools: ToolDefinition[]
  /** How the client wants tools used. */
  toolChoice: 'auto' | 'none' | 'required'
  /** When set with `required`, the one tool that must be called. */
  requiredTool: string | null
  temperature: number | null
  maxTokens: number | null
  stop: string[]
  stream: boolean
  /** Upstream toggles derived from the model id. */
  thinking: boolean
  search: boolean
  /** Client-supplied conversation hint, used only when session reuse is enabled. */
  sessionKey: string | null
  /** Extra instruction appended to the system slot (a repair retry). */
  correction: string | null
}

/** What the engine produced for one turn. */
export interface TurnOutcome {
  text: string
  thinking: string
  toolCalls: CanonicalToolCall[]
  finishReason: FinishReason
  /** Upstream token accounting, when the stream reported it. */
  tokens: number | null
  /** Account that served the turn. */
  accountId: string
  /** Upstream chat session id, for logs. */
  sessionId: string | null
  /** Names and repairs observed while reading tool markup. */
  diagnostics: string[]
}
