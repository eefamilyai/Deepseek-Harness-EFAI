/**
 * Anthropic Messages compatibility.
 *
 * The Anthropic wire format differs from OpenAI's in ways that matter here:
 * tool results are content blocks inside a `user` turn, tools carry
 * `input_schema`, and streaming is a typed event sequence with per-block
 * indexes. The translation keeps that structure rather than flattening it, so a
 * real Anthropic SDK sees the events it expects.
 *
 * @module dswg/api/anthropic
 */

import type { ApiKey } from '../store/keys.ts'
import type { Services } from './services.ts'
import type { Ctx } from '../util/http.ts'
import type { CanonicalMessage, CanonicalRequest, CanonicalToolCall, TurnOutcome } from './canonical.ts'
import type { ToolDefinition } from '../tools/protocol.ts'
import { resolveMode } from '../engine/models.ts'
import { GatewayError, asGatewayError } from '../util/errors.ts'
import { sendJson, startSse } from '../util/http.ts'
import { requestId } from '../util/ids.ts'
import { estimateTokens } from '../engine/prompt.ts'
import { logger } from '../util/log.ts'

const log = logger('anthropic')

/** One Anthropic content block. */
interface ContentBlock {
  type?: unknown
  text?: unknown
  id?: unknown
  name?: unknown
  input?: unknown
  tool_use_id?: unknown
  content?: unknown
  thinking?: unknown
}

/** One Anthropic message. */
interface AnthropicMessage {
  role?: unknown
  content?: unknown
}

/** One Anthropic tool declaration. */
interface AnthropicTool {
  name?: unknown
  description?: unknown
  input_schema?: unknown
}

/**
 * Flatten one content value into text, collecting tool calls and tool results.
 * @param content - string or block array.
 * @param role - the message role.
 * @returns text, calls, tool results and dropped parts.
 */
function readContent(
  content: unknown,
  role: string,
): { text: string; calls: CanonicalToolCall[]; results: Array<{ id: string; text: string }>; dropped: string[] } {
  if (typeof content === 'string') return { text: content, calls: [], results: [], dropped: [] }
  const text: string[] = []
  const calls: CanonicalToolCall[] = []
  const results: Array<{ id: string; text: string }> = []
  const dropped: string[] = []
  if (!Array.isArray(content)) return { text: '', calls, results, dropped }
  for (const block of content as ContentBlock[]) {
    if (block === null || typeof block !== 'object') continue
    switch (block.type) {
      case 'text':
        if (typeof block.text === 'string') text.push(block.text)
        break
      case 'tool_use': {
        if (typeof block.name !== 'string') break
        const input = block.input !== null && typeof block.input === 'object' ? (block.input as Record<string, unknown>) : {}
        calls.push({ id: typeof block.id === 'string' ? block.id : `call_${calls.length}`, name: block.name, arguments: input })
        break
      }
      case 'tool_result': {
        const inner = block.content
        let body = ''
        if (typeof inner === 'string') body = inner
        else if (Array.isArray(inner)) {
          body = inner
            .map((part) => (part !== null && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string' ? (part as { text: string }).text : ''))
            .join('\n')
        }
        results.push({ id: typeof block.tool_use_id === 'string' ? block.tool_use_id : '', text: body })
        break
      }
      case 'image':
        dropped.push('[image omitted: this gateway forwards text only]')
        break
      case 'document':
        dropped.push('[document omitted: this gateway forwards text only]')
        break
      case 'thinking':
        if (role === 'assistant' && typeof block.thinking === 'string') text.push(block.thinking)
        break
      default:
        dropped.push(`[${String(block.type ?? 'unknown')} block omitted]`)
        break
    }
  }
  return { text: text.join('\n'), calls, results, dropped }
}

/**
 * Convert Anthropic tool declarations.
 * @param tools - the request's tools.
 * @returns the canonical declarations.
 */
function convertTools(tools: unknown): ToolDefinition[] {
  if (!Array.isArray(tools)) return []
  const out: ToolDefinition[] = []
  for (const entry of tools as AnthropicTool[]) {
    if (entry === null || typeof entry !== 'object' || typeof entry.name !== 'string') continue
    out.push({
      name: entry.name,
      ...(typeof entry.description === 'string' ? { description: entry.description } : {}),
      parameters: entry.input_schema !== null && typeof entry.input_schema === 'object' ? (entry.input_schema as Record<string, unknown>) : { type: 'object', properties: {} },
    })
  }
  return out
}

/**
 * Parse a `/v1/messages` body into the canonical request.
 * @param body - the request body.
 * @returns the canonical request.
 */
export function parseAnthropicRequest(body: unknown): CanonicalRequest {
  if (body === null || typeof body !== 'object') throw new GatewayError('invalid_request', 'the request body must be a JSON object')
  const record = body as Record<string, unknown>
  const rawMessages = record.messages
  if (!Array.isArray(rawMessages) || rawMessages.length === 0) {
    throw new GatewayError('invalid_request', 'messages must be a non-empty array', { status: 400 })
  }
  const messages: CanonicalMessage[] = []
  const systemText = readSystem(record.system)
  if (systemText.length > 0) messages.push({ role: 'system', content: systemText })

  for (const entry of rawMessages as AnthropicMessage[]) {
    if (entry === null || typeof entry !== 'object') continue
    const role = entry.role === 'assistant' ? 'assistant' : 'user'
    const parsed = readContent(entry.content, role)
    if (role === 'assistant') {
      messages.push({
        role: 'assistant',
        content: parsed.text,
        ...(parsed.calls.length > 0 ? { toolCalls: parsed.calls } : {}),
        ...(parsed.dropped.length > 0 ? { droppedParts: parsed.dropped } : {}),
      })
      continue
    }
    // A user turn can carry tool results; those become their own tool messages so
    // the prompt attributes each result to the call that produced it.
    if (parsed.results.length > 0) {
      for (const result of parsed.results) {
        messages.push({ role: 'tool', content: result.text, ...(result.id.length > 0 ? { toolCallId: result.id } : {}) })
      }
    }
    if (parsed.text.length > 0 || parsed.dropped.length > 0 || parsed.results.length === 0) {
      messages.push({
        role: 'user',
        content: parsed.text,
        ...(parsed.dropped.length > 0 ? { droppedParts: parsed.dropped } : {}),
      })
    }
  }

  const choice = parseToolChoice(record.tool_choice)
  const mode = resolveMode(typeof record.model === 'string' ? record.model : null)
  return {
    model: mode.id,
    messages,
    tools: choice.mode === 'none' ? [] : convertTools(record.tools),
    toolChoice: choice.mode,
    requiredTool: choice.name,
    temperature: typeof record.temperature === 'number' ? record.temperature : null,
    maxTokens: typeof record.max_tokens === 'number' ? record.max_tokens : null,
    stop: Array.isArray(record.stop_sequences)
      ? (record.stop_sequences as unknown[]).filter((entry): entry is string => typeof entry === 'string')
      : [],
    stream: record.stream === true,
    thinking: mode.thinking,
    search: mode.search,
    sessionKey: typeof (record.metadata as { user_id?: unknown } | undefined)?.user_id === 'string' ? (record.metadata as { user_id: string }).user_id : null,
    correction: null,
  }
}

/**
 * Read an Anthropic system prompt.
 * @param system - string or block array.
 * @returns the text.
 */
function readSystem(system: unknown): string {
  if (typeof system === 'string') return system
  if (!Array.isArray(system)) return ''
  return system
    .map((block) => (block !== null && typeof block === 'object' && typeof (block as { text?: unknown }).text === 'string' ? (block as { text: string }).text : ''))
    .filter((text) => text.length > 0)
    .join('\n\n')
}

/**
 * Read the Anthropic `tool_choice` field.
 * @param raw - the field.
 * @returns the mode and the named tool.
 */
function parseToolChoice(raw: unknown): { mode: 'auto' | 'none' | 'required'; name: string | null } {
  if (raw === null || typeof raw !== 'object') return { mode: 'auto', name: null }
  const record = raw as { type?: unknown; name?: unknown }
  if (record.type === 'none') return { mode: 'none', name: null }
  if (record.type === 'any') return { mode: 'required', name: null }
  if (record.type === 'tool' && typeof record.name === 'string') return { mode: 'required', name: record.name }
  return { mode: 'auto', name: null }
}

/**
 * Map a finish reason onto Anthropic's vocabulary.
 * @param outcome - the turn outcome.
 * @returns the stop reason.
 */
function stopReason(outcome: TurnOutcome): string {
  switch (outcome.finishReason) {
    case 'tool_calls':
      return 'tool_use'
    case 'length':
      return 'max_tokens'
    default:
      return 'end_turn'
  }
}

/**
 * Build the non-streaming content blocks.
 * @param outcome - the turn outcome.
 * @param allowThinking - whether thinking blocks may be emitted.
 * @returns the blocks.
 */
function contentBlocks(outcome: TurnOutcome, allowThinking: boolean): unknown[] {
  const blocks: unknown[] = []
  if (allowThinking && outcome.thinking.length > 0) {
    blocks.push({ type: 'thinking', thinking: outcome.thinking, signature: '' })
  }
  if (outcome.text.length > 0) blocks.push({ type: 'text', text: outcome.text })
  for (const call of outcome.toolCalls) {
    blocks.push({ type: 'tool_use', id: call.id, name: call.name, input: call.arguments })
  }
  if (blocks.length === 0) blocks.push({ type: 'text', text: '' })
  return blocks
}

/**
 * Handle `POST /v1/messages`.
 * @param ctx - the request context.
 * @param services - wired services.
 * @param key - the authenticated key.
 */
export async function handleMessages(ctx: Ctx, services: Services, key: ApiKey): Promise<void> {
  const started = Date.now()
  const id = `msg_${requestId()}`
  let request: CanonicalRequest
  try {
    request = parseAnthropicRequest(ctx.body)
  } catch (error) {
    throw asGatewayError(error, 'invalid request')
  }
  if (key.models.length > 0 && !key.models.includes(request.model)) {
    throw new GatewayError('permission', `this API key may not use model "${request.model}"`, { status: 403, code: 'model_not_allowed' })
  }
  const requestedModel = typeof (ctx.body as { model?: unknown }).model === 'string' ? (ctx.body as { model: string }).model : request.model
  const allowThinking = isThinkingEnabled(ctx.body)

  const abort = new AbortController()
  ctx.req.on('close', () => {
    if (!ctx.res.writableEnded) abort.abort()
  })

  const inputTokens = estimateTokens(request.messages.map((message) => message.content).join('\n'))

  if (!request.stream) {
    const outcome = await services.engine.run({ request, key, hooks: {}, signal: abort.signal })
    record(services, { endpoint: '/v1/messages', key, outcome, started, model: requestedModel, stream: false, request })
    sendJson(ctx.res, 200, {
      id,
      type: 'message',
      role: 'assistant',
      model: requestedModel,
      content: contentBlocks(outcome, allowThinking),
      stop_reason: stopReason(outcome),
      stop_sequence: null,
      usage: { input_tokens: inputTokens, output_tokens: estimateTokens(outcome.text + outcome.thinking) },
    })
    return
  }

  const sse = startSse(ctx.res, 'anthropic')
  let index = 0
  let blockOpen = false
  let blockKind: 'text' | 'thinking' | 'tool' = 'text'
  const outputText: string[] = []

  const closeBlock = (): void => {
    if (!blockOpen) return
    sse.event('content_block_stop', { type: 'content_block_stop', index })
    blockOpen = false
  }
  const openBlock = (kind: 'text' | 'thinking' | 'tool', block: Record<string, unknown>): void => {
    closeBlock()
    index += 1
    blockKind = kind
    blockOpen = true
    sse.event('content_block_start', { type: 'content_block_start', index, content_block: block })
  }

  sse.event('message_start', {
    type: 'message_start',
    message: {
      id,
      type: 'message',
      role: 'assistant',
      model: requestedModel,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: inputTokens, output_tokens: 0 },
    },
  })
  sse.event('ping', { type: 'ping' })

  const hooks = {
    onThinking: (text: string) => {
      if (!allowThinking) return
      if (!blockOpen || blockKind !== 'thinking') openBlock('thinking', { type: 'thinking', thinking: '', signature: '' })
      outputText.push(text)
      sse.event('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: text } })
    },
    onText: (text: string) => {
      if (!blockOpen || blockKind !== 'text') openBlock('text', { type: 'text', text: '' })
      outputText.push(text)
      sse.event('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text } })
    },
    onToolCall: (call: CanonicalToolCall) => {
      openBlock('tool', { type: 'tool_use', id: call.id, name: call.name, input: {} })
      sse.event('content_block_delta', {
        type: 'content_block_delta',
        index,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(call.arguments) },
      })
      closeBlock()
    },
  }

  try {
    const outcome = await services.engine.run({ request, key, hooks, signal: abort.signal })
    closeBlock()
    sse.event('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: stopReason(outcome), stop_sequence: null },
      usage: { output_tokens: estimateTokens(outputText.join('')) },
    })
    sse.event('message_stop', { type: 'message_stop' })
    record(services, { endpoint: '/v1/messages', key, outcome, started, model: requestedModel, stream: true, request })
  } catch (error) {
    const gateway = asGatewayError(error)
    log.warn('stream failed', { kind: gateway.kind, message: gateway.message })
    sse.event('error', gateway.toAnthropic())
    record(services, { endpoint: '/v1/messages', key, error: gateway, started, model: requestedModel, stream: true, request })
  } finally {
    sse.close()
  }
}

/**
 * Whether the client asked for extended thinking.
 * @param body - the request body.
 * @returns true when thinking is enabled.
 */
function isThinkingEnabled(body: unknown): boolean {
  if (body === null || typeof body !== 'object') return false
  const thinking = (body as { thinking?: { type?: unknown } }).thinking
  return thinking !== undefined && thinking.type === 'enabled'
}

/**
 * Write one usage row.
 * @param services - wired services.
 * @param entry - the row data.
 */
function record(
  services: Services,
  entry: {
    endpoint: string
    key: ApiKey
    model: string
    started: number
    stream: boolean
    request: CanonicalRequest
    outcome?: TurnOutcome
    error?: GatewayError
  },
): void {
  try {
    services.usage.record({
      ts: Date.now(),
      keyId: entry.key.id,
      accountId: entry.outcome?.accountId ?? null,
      endpoint: entry.endpoint,
      model: entry.model,
      status: entry.error ? (entry.error.kind === 'cancelled' ? 'cancelled' : 'error') : 'ok',
      httpStatus: entry.error?.status ?? 200,
      errorKind: entry.error?.kind ?? null,
      promptChars: entry.request.messages.reduce((total, message) => total + message.content.length, 0),
      outputChars: (entry.outcome?.text.length ?? 0) + (entry.outcome?.thinking.length ?? 0),
      toolCalls: entry.outcome?.toolCalls.length ?? 0,
      latencyMs: Date.now() - entry.started,
      ttfbMs: null,
      stream: entry.stream,
    })
    services.keys.touch(entry.key.id)
  } catch (error) {
    log.warn('usage write failed', { error: String(error) })
  }
}
