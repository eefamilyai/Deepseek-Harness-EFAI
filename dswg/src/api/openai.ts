/**
 * OpenAI Chat Completions compatibility.
 *
 * @module dswg/api/openai
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Services } from './services.ts'
import type { Ctx } from '../util/http.ts'
import type { ApiKey } from '../store/keys.ts'
import type { CanonicalMessage, CanonicalRequest, CanonicalToolCall, TurnOutcome } from './canonical.ts'
import type { ToolDefinition } from '../tools/protocol.ts'
import { MODES, resolveMode } from '../engine/models.ts'
import { GatewayError, asGatewayError } from '../util/errors.ts'
import { header, readBody, sendJson, startSse } from '../util/http.ts'
import { requestId } from '../util/ids.ts'
import { estimateTokens } from '../engine/prompt.ts'
import { logger } from '../util/log.ts'

const log = logger('openai')

/** OpenAI tool declaration. */
interface OpenAiTool {
  type?: string
  function?: { name?: unknown; description?: unknown; parameters?: unknown }
}

/** Content part accepted by the OpenAI schema. */
interface ContentPart {
  type?: unknown
  text?: unknown
  image_url?: unknown
}

/** One OpenAI message. */
interface OpenAiMessage {
  role?: unknown
  content?: unknown
  name?: unknown
  tool_call_id?: unknown
  tool_calls?: unknown
}

/**
 * Flatten message content into text, noting anything that cannot be forwarded.
 * @param content - the message content value.
 * @returns the text and the dropped part descriptions.
 */
function flattenContent(content: unknown): { text: string; dropped: string[] } {
  if (typeof content === 'string') return { text: content, dropped: [] }
  if (!Array.isArray(content)) return { text: '', dropped: [] }
  const texts: string[] = []
  const dropped: string[] = []
  for (const part of content as ContentPart[]) {
    if (part === null || typeof part !== 'object') continue
    if (part.type === 'text' && typeof part.text === 'string') texts.push(part.text)
    else if (part.type === 'image_url') dropped.push('[image omitted: this gateway forwards text only]')
    else if (part.type === 'input_audio') dropped.push('[audio omitted: this gateway forwards text only]')
    else dropped.push(`[${String(part.type ?? 'unknown')} content omitted]`)
  }
  return { text: texts.join('\n'), dropped }
}

/**
 * Convert OpenAI tool declarations.
 * @param tools - the request's tools array.
 * @returns the canonical declarations.
 */
function convertTools(tools: unknown): ToolDefinition[] {
  if (!Array.isArray(tools)) return []
  const out: ToolDefinition[] = []
  for (const entry of tools as OpenAiTool[]) {
    if (entry === null || typeof entry !== 'object') continue
    const fn = entry.function
    if (!fn || typeof fn.name !== 'string') continue
    const parameters = fn.parameters !== null && typeof fn.parameters === 'object' ? (fn.parameters as Record<string, unknown>) : { type: 'object', properties: {} }
    out.push({
      name: fn.name,
      ...(typeof fn.description === 'string' ? { description: fn.description } : {}),
      parameters,
    })
  }
  return out
}

/**
 * Convert an assistant message's tool calls.
 * @param raw - the `tool_calls` value.
 * @returns the canonical calls.
 */
function convertToolCalls(raw: unknown): CanonicalToolCall[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const calls: CanonicalToolCall[] = []
  for (const entry of raw as Array<Record<string, unknown>>) {
    if (entry === null || typeof entry !== 'object') continue
    const fn = entry.function as { name?: unknown; arguments?: unknown } | undefined
    if (!fn || typeof fn.name !== 'string') continue
    let args: Record<string, unknown> = {}
    if (typeof fn.arguments === 'string') {
      try {
        const parsed: unknown = JSON.parse(fn.arguments)
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) args = parsed as Record<string, unknown>
      } catch {
        args = { _raw: fn.arguments }
      }
    } else if (fn.arguments !== null && typeof fn.arguments === 'object') {
      args = fn.arguments as Record<string, unknown>
    }
    calls.push({ id: typeof entry.id === 'string' ? entry.id : `call_${calls.length}`, name: fn.name, arguments: args })
  }
  return calls.length > 0 ? calls : undefined
}

/**
 * Parse a chat-completions body into the canonical request.
 * @param body - the request body.
 * @returns the canonical request.
 * @throws GatewayError for a body the schema cannot describe.
 */
export function parseOpenAiRequest(body: unknown): CanonicalRequest {
  if (body === null || typeof body !== 'object') throw new GatewayError('invalid_request', 'the request body must be a JSON object')
  const record = body as Record<string, unknown>
  const rawMessages = record.messages
  if (!Array.isArray(rawMessages) || rawMessages.length === 0) {
    throw new GatewayError('invalid_request', 'messages must be a non-empty array', { status: 400 })
  }
  const messages: CanonicalMessage[] = []
  for (const entry of rawMessages as OpenAiMessage[]) {
    if (entry === null || typeof entry !== 'object') continue
    const role = entry.role
    const { text, dropped } = flattenContent(entry.content)
    if (role === 'system' || role === 'developer') {
      messages.push({ role: 'system', content: text, ...(dropped.length > 0 ? { droppedParts: dropped } : {}) })
      continue
    }
    if (role === 'user') {
      messages.push({ role: 'user', content: text, ...(dropped.length > 0 ? { droppedParts: dropped } : {}) })
      continue
    }
    if (role === 'assistant') {
      const toolCalls = convertToolCalls(entry.tool_calls)
      messages.push({
        role: 'assistant',
        content: text,
        ...(toolCalls === undefined ? {} : { toolCalls }),
        ...(dropped.length > 0 ? { droppedParts: dropped } : {}),
      })
      continue
    }
    if (role === 'tool' || role === 'function') {
      messages.push({
        role: 'tool',
        content: text,
        ...(typeof entry.name === 'string' ? { name: entry.name } : {}),
        ...(typeof entry.tool_call_id === 'string' ? { toolCallId: entry.tool_call_id } : {}),
      })
      continue
    }
    throw new GatewayError('invalid_request', `unsupported message role "${String(role)}"`, { status: 400 })
  }

  const toolChoice = parseToolChoice(record.tool_choice)
  const mode = resolveMode(typeof record.model === 'string' ? record.model : null)
  return {
    model: mode.id,
    messages,
    tools: toolChoice === 'none' ? [] : convertTools(record.tools),
    toolChoice: toolChoice === 'none' ? 'none' : toolChoice === 'required' ? 'required' : 'auto',
    requiredTool: readRequiredTool(record.tool_choice),
    temperature: typeof record.temperature === 'number' ? record.temperature : null,
    maxTokens: typeof record.max_tokens === 'number' ? record.max_tokens : typeof record.max_completion_tokens === 'number' ? record.max_completion_tokens : null,
    stop: readStop(record.stop),
    stream: record.stream === true,
    thinking: mode.thinking,
    search: mode.search,
    sessionKey: typeof record.user === 'string' ? record.user : null,
    correction: null,
  }
}

/**
 * Read the `stop` field, which may be a string or an array.
 * @param raw - the field.
 * @returns the stop sequences.
 */
function readStop(raw: unknown): string[] {
  if (typeof raw === 'string' && raw.length > 0) return [raw]
  if (Array.isArray(raw)) return raw.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
  return []
}

/**
 * Read the `tool_choice` mode.
 * @param raw - the field.
 * @returns the mode.
 */
function parseToolChoice(raw: unknown): 'auto' | 'none' | 'required' {
  if (raw === 'none') return 'none'
  if (raw === 'required') return 'required'
  return 'auto'
}

/**
 * Read the named tool from a `tool_choice` object.
 * @param raw - the field.
 * @returns the tool name, or null.
 */
function readRequiredTool(raw: unknown): string | null {
  if (raw === null || typeof raw !== 'object') return null
  const fn = (raw as { function?: { name?: unknown } }).function
  return typeof fn?.name === 'string' ? fn.name : null
}

/**
 * Map a finish reason onto OpenAI's vocabulary.
 * @param outcome - the turn outcome.
 * @returns the finish reason.
 */
function finishReason(outcome: TurnOutcome): string {
  switch (outcome.finishReason) {
    case 'tool_calls':
      return 'tool_calls'
    case 'length':
      return 'length'
    case 'content_filter':
      return 'content_filter'
    default:
      return 'stop'
  }
}

/**
 * Render the assistant message body shared by stream and non-stream responses.
 * @param outcome - the turn outcome.
 * @returns the message object.
 */
function assistantMessage(outcome: TurnOutcome): Record<string, unknown> {
  const message: Record<string, unknown> = { role: 'assistant', content: outcome.toolCalls.length > 0 ? outcome.text || null : outcome.text }
  if (outcome.thinking.length > 0) message.reasoning_content = outcome.thinking
  if (outcome.toolCalls.length > 0) {
    message.tool_calls = outcome.toolCalls.map((call) => ({
      id: call.id,
      type: 'function',
      function: { name: call.name, arguments: JSON.stringify(call.arguments) },
    }))
  }
  return message
}

/**
 * Handle `POST /v1/chat/completions`.
 * @param ctx - the request context.
 * @param services - wired services.
 * @param key - the authenticated key.
 */
export async function handleChatCompletions(ctx: Ctx, services: Services, key: ApiKey): Promise<void> {
  const started = Date.now()
  const id = `chatcmpl-${requestId()}`
  const created = Math.floor(started / 1000)
  let request: CanonicalRequest
  try {
    request = parseOpenAiRequest(ctx.body)
  } catch (error) {
    throw asGatewayError(error, 'invalid request')
  }
  if (key.models.length > 0 && !key.models.includes(request.model)) {
    throw new GatewayError('permission', `this API key may not use model "${request.model}"`, { status: 403, code: 'model_not_allowed' })
  }

  const abort = new AbortController()
  ctx.req.on('close', () => {
    if (!ctx.res.writableEnded) abort.abort()
  })

  if (!request.stream) {
    const outcome = await services.engine.run({ request, key, hooks: {}, signal: abort.signal })
    record(services, { endpoint: '/v1/chat/completions', key, outcome, started, model: request.model, stream: false, request })
    sendJson(ctx.res, 200, {
      id,
      object: 'chat.completion',
      created,
      model: request.model,
      choices: [{ index: 0, message: assistantMessage(outcome), finish_reason: finishReason(outcome), logprobs: null }],
      usage: {
        prompt_tokens: estimateTokens(promptChars(request)),
        completion_tokens: estimateTokens(outcome.text + outcome.thinking),
        total_tokens: estimateTokens(promptChars(request)) + estimateTokens(outcome.text + outcome.thinking),
      },
      system_fingerprint: 'dswg',
    })
    return
  }

  const sse = startSse(ctx.res, 'openai')
  /**
   * Position of the next tool call in this stream.
   *
   * OpenAI clients assemble `delta.tool_calls` by their `index`: two calls that
   * share one index are concatenated into a single, unparseable argument string.
   */
  let streamCall = 0
  const includeUsage = ctx.body !== null && typeof ctx.body === 'object' && (ctx.body as { stream_options?: { include_usage?: boolean } }).stream_options?.include_usage === true
  const hooks = {
    onThinking: (text: string) => {
      sse.data({ id, object: 'chat.completion.chunk', created, model: request.model, choices: [{ index: 0, delta: { reasoning_content: text }, finish_reason: null }] })
    },
    onText: (text: string) => {
      sse.data({ id, object: 'chat.completion.chunk', created, model: request.model, choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })
    },
    onToolCall: (call: CanonicalToolCall) => {
      sse.data({
        id,
        object: 'chat.completion.chunk',
        created,
        model: request.model,
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                { index: streamCall++, id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } },
              ],
            },
            finish_reason: null,
          },
        ],
      })
    },
  }

  sse.data({ id, object: 'chat.completion.chunk', created, model: request.model, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] })
  try {
    const outcome = await services.engine.run({ request, key, hooks, signal: abort.signal })
    sse.data({ id, object: 'chat.completion.chunk', created, model: request.model, choices: [{ index: 0, delta: {}, finish_reason: finishReason(outcome) }] })
    if (includeUsage) {
      sse.data({
        id,
        object: 'chat.completion.chunk',
        created,
        model: request.model,
        choices: [],
        usage: {
          prompt_tokens: estimateTokens(promptChars(request)),
          completion_tokens: estimateTokens(outcome.text + outcome.thinking),
          total_tokens: estimateTokens(promptChars(request)) + estimateTokens(outcome.text + outcome.thinking),
        },
      })
    }
    record(services, { endpoint: '/v1/chat/completions', key, outcome, started, model: request.model, stream: true, request })
  } catch (error) {
    const gateway = asGatewayError(error)
    log.warn('stream failed', { kind: gateway.kind, message: gateway.message })
    sse.data(gateway.toOpenAI())
    record(services, { endpoint: '/v1/chat/completions', key, error: gateway, started, model: request.model, stream: true, request })
  } finally {
    sse.raw('data: [DONE]\n\n')
    sse.close()
  }
}

/**
 * Approximate prompt size for usage reporting.
 * @param request - the canonical request.
 * @returns character count.
 */
function promptChars(request: CanonicalRequest): string {
  return request.messages.map((message) => message.content).join('\n') + JSON.stringify(request.tools)
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
      promptChars: promptChars(entry.request).length,
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

/**
 * Handle `GET /v1/models`.
 * @param ctx - the request context.
 */
export function handleListModels(ctx: Ctx): void {
  sendJson(ctx.res, 200, {
    object: 'list',
    data: MODES.map((mode) => ({
      id: mode.id,
      object: 'model',
      created: Math.floor(Date.now() / 1000),
      owned_by: 'deepseek-web',
    })),
  })
}

/**
 * Read and parse a JSON body.
 * @param req - the request.
 * @returns the parsed value.
 */
export async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const raw = await readBody(req)
  if (raw.trim().length === 0) return null
  try {
    return JSON.parse(raw)
  } catch (error) {
    throw new GatewayError('invalid_request', `malformed JSON body: ${error instanceof Error ? error.message : String(error)}`, {
      status: 400,
    })
  }
}

/**
 * Extract a bearer token from an Authorization header.
 * @param req - the request.
 * @returns the token, or null.
 */
export function bearer(req: IncomingMessage): string | null {
  const value = header(req, 'authorization')
  if (value && /^bearer\s+/i.test(value)) return value.replace(/^bearer\s+/i, '').trim()
  const apiKey = header(req, 'x-api-key')
  return apiKey ? apiKey.trim() : null
}

/**
 * Stop the response with an error, in whichever envelope the path expects.
 * @param res - the response.
 * @param error - the failure.
 */
export function fail(res: ServerResponse, error: GatewayError): void {
  if (res.headersSent) {
    res.end()
    return
  }
  const headers: Record<string, string> = { 'content-type': 'application/json; charset=utf-8' }
  if (error.retryAfterMs !== undefined) headers['retry-after'] = String(Math.ceil(error.retryAfterMs / 1000))
  res.writeHead(error.status, headers)
  res.end(JSON.stringify(error.toOpenAI()))
}
