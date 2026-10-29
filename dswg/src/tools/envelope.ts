/**
 * Reading tool calls out of a text reply, as the text arrives.
 *
 * The model is taught one envelope (`<tool_call>…</tool_call>` with a JSON
 * object inside). Everything else here exists because a long, rotated context
 * does not always produce the taught shape: the block may arrive with DSML tags,
 * as a fenced object, as bare JSON, as the provider's own `tool_calls` array, or
 * with the JSON clipped by a length limit. The reader converts what it can and
 * leaves every other character as prose for the user.
 *
 * Two rules keep it safe:
 *
 * - A shape that is *only* a call when a declared tool backs it (bare JSON, a
 *   fenced object) is not treated as a call otherwise, so an example or a
 *   transcript in the reply cannot fire a tool.
 * - A call that cannot be read is reported, not silently dropped, so the turn
 *   can be repaired instead of answering with nothing.
 *
 * @module dswg/tools/envelope
 */

import { firstBalancedObject, repairJson } from './repair.ts'
import { parameterNames, requiredNames, type ToolDefinition } from './protocol.ts'
import { editDistance, normalizeName } from '../util/text.ts'
import { parseParameterValue } from './invoke.ts'

/** Which markup produced a call. */
export type EnvelopeSource = 'tool_call' | 'dsml' | 'fence' | 'bare-json' | 'openai-array' | 'learned'

/** One call the model made. */
export interface ToolCall {
  /** Tool name, already resolved against the declared tools when possible. */
  name: string
  /** Arguments object. */
  arguments: Record<string, unknown>
  /** Argument text exactly as written, for logs. */
  rawArguments: string
  /** Which shape it came from. */
  source: EnvelopeSource
  /** Repairs applied while reading it. */
  repairs: string[]
  /** True when the name matched no declared tool. */
  unknownName: boolean
  /** Required arguments the call did not carry. */
  missing: string[]
}

/** What the extractor produced for a chunk of text. */
export type ExtractorEvent =
  | { type: 'text'; text: string }
  | { type: 'call'; call: ToolCall }
  | { type: 'malformed'; raw: string; error: string; source: EnvelopeSource }

/** One recognised opening marker. */
interface Envelope {
  open: string
  close: string
  source: EnvelopeSource
  /** Only a call when its body names a declared tool. */
  requiresDeclaredTool: boolean
}

/** The taught and known envelopes. Learned pairs are appended per instance. */
const ENVELOPES: Envelope[] = [
  { open: '<tool_call>', close: '</tool_call>', source: 'tool_call', requiresDeclaredTool: false },
  { open: '<|tool_call|>', close: '<|/tool_call|>', source: 'tool_call', requiresDeclaredTool: false },
  { open: '<｜tool_call｜>', close: '<｜/tool_call｜>', source: 'tool_call', requiresDeclaredTool: false },
  { open: '<tool_calls>', close: '</tool_calls>', source: 'dsml', requiresDeclaredTool: true },
  { open: '<function_call>', close: '</function_call>', source: 'tool_call', requiresDeclaredTool: false },
  { open: '```json', close: '```', source: 'fence', requiresDeclaredTool: true },
  { open: '```JSON', close: '```', source: 'fence', requiresDeclaredTool: true },
]

/** Longest opening marker, used to hold back a partial marker at a chunk edge. */
const MAX_OPEN = Math.max(...ENVELOPES.map((envelope) => envelope.open.length))

/**
 * Resolve a model-written tool name against the declared tools.
 * @param raw - the name as written.
 * @param tools - the request's declarations.
 * @returns the declared name when it can be resolved, otherwise the cleaned raw name.
 */
export function resolveToolName(raw: string, tools: readonly ToolDefinition[]): { name: string; unknown: boolean } {
  const cleaned = raw.trim().replace(/^functions[.:/]/i, '')
  if (tools.length === 0) return { name: cleaned, unknown: false }
  const exact = tools.find((tool) => tool.name === cleaned)
  if (exact) return { name: exact.name, unknown: false }
  const normalized = normalizeName(cleaned)
  const normalizedHit = tools.find((tool) => normalizeName(tool.name) === normalized)
  if (normalizedHit) return { name: normalizedHit.name, unknown: false }
  const suffixHit = tools.find((tool) => normalizeName(tool.name).endsWith(`_${normalized}`) || normalized.endsWith(`_${normalizeName(tool.name)}`))
  if (suffixHit) return { name: suffixHit.name, unknown: false }
  let best: { name: string; distance: number } | null = null
  for (const tool of tools) {
    const distance = editDistance(normalized, normalizeName(tool.name))
    if (best === null || distance < best.distance) best = { name: tool.name, distance }
  }
  if (best && best.distance <= 2 && normalized.length > 3) return { name: best.name, unknown: false }
  return { name: cleaned, unknown: true }
}

/**
 * Coerce one argument value to the type its schema declares.
 * @param value - the parsed value.
 * @param schema - the property schema, when present.
 * @returns the coerced value.
 */
function coerceValue(value: unknown, schema: unknown): unknown {
  const type = (schema as { type?: unknown } | undefined)?.type
  if (typeof value !== 'string') return value
  switch (type) {
    case 'number':
    case 'integer': {
      const trimmed = value.trim()
      if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
        const numeric = Number(trimmed)
        return type === 'integer' ? Math.trunc(numeric) : numeric
      }
      return value
    }
    case 'boolean': {
      const lowered = value.trim().toLowerCase()
      if (lowered === 'true') return true
      if (lowered === 'false') return false
      return value
    }
    case 'array': {
      const parsed = repairJson(value)
      return parsed.ok && Array.isArray(parsed.value) ? parsed.value : value
    }
    case 'object': {
      const parsed = repairJson(value)
      return parsed.ok && parsed.value !== null && typeof parsed.value === 'object' && !Array.isArray(parsed.value)
        ? parsed.value
        : value
    }
    default:
      return value
  }
}

/**
 * Apply schema types to an arguments object.
 * @param args - the parsed arguments.
 * @param tool - the declared tool, when known.
 * @returns the coerced arguments.
 */
function coerceArguments(args: Record<string, unknown>, tool: ToolDefinition | undefined): Record<string, unknown> {
  if (!tool) return args
  const properties = (tool.parameters as { properties?: Record<string, unknown> } | undefined)?.properties
  if (!properties) return args
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(args)) {
    out[key] = coerceValue(value, properties[key])
  }
  return out
}

/**
 * Turn a parsed JSON value into calls, whatever shape it took.
 * @param value - the parsed value.
 * @param source - the envelope that produced it.
 * @param tools - the request's declarations.
 * @param repairs - repairs already applied.
 * @returns the calls; empty when the value is not call-shaped.
 */
function callsFromValue(
  value: unknown,
  source: EnvelopeSource,
  tools: readonly ToolDefinition[],
  repairs: string[],
): ToolCall[] {
  const entries: unknown[] = Array.isArray(value) ? value : [value]
  const calls: ToolCall[] = []
  for (const entry of entries) {
    if (entry === null || typeof entry !== 'object') continue
    const record = entry as Record<string, unknown>
    if (Array.isArray(record.tool_calls)) {
      calls.push(...callsFromValue(record.tool_calls, 'openai-array', tools, repairs))
      continue
    }
    const fn = record.function
    const rawName =
      typeof record.name === 'string'
        ? record.name
        : typeof record.tool === 'string'
          ? record.tool
          : typeof record.tool_name === 'string'
            ? record.tool_name
            : fn !== null && typeof fn === 'object' && typeof (fn as { name?: unknown }).name === 'string'
              ? ((fn as { name: string }).name)
              : null
    if (rawName === null) continue
    let rawArguments = record.arguments ?? record.parameters ?? record.args
    if (rawArguments === undefined && fn !== null && typeof fn === 'object') {
      rawArguments = (fn as { arguments?: unknown }).arguments
    }
    let argsObject: Record<string, unknown> = {}
    let rawText = ''
    if (typeof rawArguments === 'string') {
      rawText = rawArguments
      const parsed = repairJson(rawArguments)
      if (parsed.ok && parsed.value !== null && typeof parsed.value === 'object' && !Array.isArray(parsed.value)) {
        argsObject = parsed.value as Record<string, unknown>
        if (parsed.repairs.length > 0) repairs.push(...parsed.repairs.map((id) => `args:${id}`))
      }
    } else if (rawArguments !== null && typeof rawArguments === 'object' && !Array.isArray(rawArguments)) {
      argsObject = rawArguments as Record<string, unknown>
      rawText = JSON.stringify(rawArguments)
    } else if (rawArguments !== undefined) {
      rawText = String(rawArguments)
      argsObject = { value: rawArguments }
    }
    const resolved = resolveToolName(rawName, tools)
    const tool = tools.find((candidate) => candidate.name === resolved.name)
    const coerced = coerceArguments(argsObject, tool)
    const required = tool ? requiredNames(tool) : []
    const missing = required.filter((key) => coerced[key] === undefined)
    calls.push({
      name: resolved.name,
      arguments: coerced,
      rawArguments: rawText,
      source,
      repairs: [...repairs],
      unknownName: resolved.unknown,
      missing,
    })
  }
  return calls
}

/**
 * Parse a DSML-style `<invoke>` body.
 * @param block - the block text including `<invoke>`.
 * @param tools - the request's declarations.
 * @param repairs - repairs already applied.
 * @returns the calls found, or null when the block is not invoke-shaped.
 */
function callsFromInvoke(block: string, tools: readonly ToolDefinition[], repairs: string[]): ToolCall[] | null {
  const invokeRe = /<invoke\b[^>]*\bname\s*=\s*"([^"]+)"[^>]*>([\s\S]*?)<\/invoke>/gi
  const calls: ToolCall[] = []
  let match: RegExpExecArray | null
  while ((match = invokeRe.exec(block)) !== null) {
    const rawName = match[1] ?? ''
    const body = match[2] ?? ''
    const args: Record<string, unknown> = {}
    const paramRe = /<parameter\b([^>]*)>([\s\S]*?)<\/parameter>/gi
    let param: RegExpExecArray | null
    while ((param = paramRe.exec(body)) !== null) {
      const attributes = param[1] ?? ''
      const key = /\bname\s*=\s*"([^"]+)"/i.exec(attributes)?.[1]
      if (key === undefined) continue
      args[key] = parseParameterValue(param[2] ?? '', /\bstring\s*=\s*["']?false/i.test(attributes))
    }
    if (Object.keys(args).length === 0) {
      const inline = repairJson(body.trim())
      if (inline.ok && inline.value !== null && typeof inline.value === 'object' && !Array.isArray(inline.value)) {
        Object.assign(args, inline.value as Record<string, unknown>)
        repairs.push('invoke-json-body')
      }
    }
    const resolved = resolveToolName(rawName, tools)
    const tool = tools.find((candidate) => candidate.name === resolved.name)
    const coerced = coerceArguments(args, tool)
    calls.push({
      name: resolved.name,
      arguments: coerced,
      rawArguments: JSON.stringify(args),
      source: 'dsml',
      repairs: [...repairs],
      unknownName: resolved.unknown,
      missing: tool ? requiredNames(tool).filter((key) => coerced[key] === undefined) : [],
    })
  }
  return calls.length > 0 ? calls : null
}

/**
 * Undo the XML escaping a DSML value may carry.
 * @param value - escaped text.
 * @returns the raw text.
 */
function unescapeXml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
}

/**
 * Parse one complete envelope.
 * @param block - text from the opener through the closer (inclusive).
 * @param envelope - which envelope matched.
 * @param tools - the request's declarations.
 * @returns calls, a malformed report, or null when the block is prose.
 */
function parseBlock(
  block: string,
  envelope: Envelope,
  tools: readonly ToolDefinition[],
): Array<{ type: 'call'; call: ToolCall } | { type: 'malformed'; raw: string; error: string; source: EnvelopeSource }> {
  const inner = block.slice(envelope.open.length, block.length - envelope.close.length)
  const repairs: string[] = []

  if (envelope.source === 'dsml') {
    const invokes = callsFromInvoke(inner, tools, repairs)
    if (invokes) return invokes.map((call) => ({ type: 'call' as const, call }))
  }

  const parsed = repairJson(inner)
  if (parsed.ok) {
    repairs.push(...parsed.repairs)
    const calls = callsFromValue(parsed.value, envelope.source, tools, repairs)
    if (calls.length > 0) {
      if (envelope.requiresDeclaredTool) {
        const declared = calls.filter((call) => !call.unknownName)
        if (declared.length === 0) return [{ type: 'malformed', raw: block, error: 'no declared tool in the block', source: envelope.source }]
        return declared.map((call) => ({ type: 'call' as const, call }))
      }
      return calls.map((call) => ({ type: 'call' as const, call }))
    }
    if (envelope.requiresDeclaredTool) return [{ type: 'malformed', raw: block, error: 'no tool call in the block', source: envelope.source }]
    return [{ type: 'malformed', raw: block, error: 'JSON carried no tool name', source: envelope.source }]
  }

  const invokes = callsFromInvoke(inner, tools, repairs)
  if (invokes) return invokes.map((call) => ({ type: 'call' as const, call }))

  return [{ type: 'malformed', raw: block, error: parsed.error ?? 'unparseable JSON', source: envelope.source }]
}

/**
 * Incremental reader that separates prose from tool calls.
 *
 * Feed it the model's text in whatever chunks the transport delivers; it emits
 * prose as soon as it is unambiguous and a call as soon as its envelope closes.
 */
export class ToolCallExtractor {
  #tools: readonly ToolDefinition[]
  #envelopes: Envelope[]
  #pending = ''
  #finished = false
  /** True when the next emitted character begins a line. */
  #atLineStart = true
  /**
   * The `<invoke>` and `<parameter>` elements still open around the buffer.
   *
   * A marker met while anything is open sits inside a value the model is
   * writing: a file whose content quotes tool-call markup, or a cell whose code
   * does. It is data there, and reading it as a call would run the quoted thing.
   * The stack, rather than a count, is what makes a *balanced* fixture inside an
   * unclosed element still count as data.
   */
  #openValues: string[] = []
  /** The last character the reader consumed, for telling a quoted fixture apart. */
  #lastChar = ''
  /** True when the buffer sits inside a fenced code block. */
  #inFence = false
  /** Count of malformed blocks seen, for the request log. */
  malformed = 0

  /**
   * @param tools - the request's tool declarations, used to resolve names and types.
   */
  /**
   * @param tools - the request's tool declarations, used to resolve names and types.
   * @param learned - delimiter pairs induced from the gateway's own transcripts.
   */
  constructor(tools: readonly ToolDefinition[], learned: ReadonlyArray<{ opener: string; closer: string }> = []) {
    this.#tools = tools
    this.#envelopes = [
      ...ENVELOPES,
      ...learned
        .filter((pattern) => pattern.opener.length > 0 && pattern.closer.length > 0)
        .map((pattern) => ({ open: pattern.opener, close: pattern.closer, source: 'learned' as EnvelopeSource, requiresDeclaredTool: true })),
    ]
  }

  /**
   * Feed a chunk of model text.
   * @param chunk - the next piece of text.
   * @returns the events it produced.
   */
  push(chunk: string): ExtractorEvent[] {
    if (this.#finished) return []
    this.#pending += chunk
    return this.#drain(false)
  }

  /**
   * End the stream, salvaging any half-written block.
   * @returns the final events.
   */
  finish(): ExtractorEvent[] {
    if (this.#finished) return []
    this.#finished = true
    return this.#drain(true)
  }

  /**
   * Update the element and fence depth for text leaving the buffer.
   *
   * Called for every character the reader consumes, whether it was emitted as
   * prose or read as a call, because both change where the next marker sits.
   * @param text - the consumed text.
   */
  #account(text: string): void {
    if (text.length === 0) return
    this.#lastChar = text.slice(-1)
    const scopePattern = /<\s*(\/?)\s*(?:[|｜]{1,2}\s*DSML\s*[|｜]{1,2}\s*)?(invoke|parameter)\b/gi
    let scope: RegExpExecArray | null
    while ((scope = scopePattern.exec(text)) !== null) {
      const name = (scope[2] ?? '').toLowerCase()
      if ((scope[1] ?? '') === '/') {
        const at = this.#openValues.lastIndexOf(name)
        // An unmatched closer belongs to a block this reader already consumed
        // whole; leaving the stack alone keeps the enclosing element open.
        if (at !== -1) this.#openValues.length = at
      } else {
        this.#openValues.push(name)
      }
    }
    const fences = text.match(/```/g)
    if (fences !== null && fences.length % 2 === 1) this.#inFence = !this.#inFence
  }

  /**
   * Emit everything that is decidable from the buffer.
   * @param atEnd - true when no more text will arrive.
   * @returns the events.
   */
  #drain(atEnd: boolean): ExtractorEvent[] {
    const events: ExtractorEvent[] = []
    for (;;) {
      const marker = this.#findMarker()
      const bareAllowed = this.#tools.length > 0 && this.#atLineStart
      const braceAt = bareAllowed ? this.#leadingBrace() : -1
      if (marker === null && braceAt === -1) {
        const keep = atEnd ? 0 : Math.min(MAX_OPEN - 1, this.#pending.length)
        const emit = this.#pending.slice(0, this.#pending.length - keep)
        if (emit.length > 0) {
          events.push({ type: 'text', text: emit })
          this.#account(emit)
          this.#pending = this.#pending.slice(emit.length)
          this.#atLineStart = /\n\s*$/.test(emit)
        }
        if (atEnd && this.#pending.length > 0) {
          events.push({ type: 'text', text: this.#pending })
          this.#account(this.#pending)
          this.#pending = ''
        }
        return events
      }

      // A bare JSON object earlier in the buffer wins only when it starts the
      // pending region; a marked envelope is otherwise consumed in order.
      if (marker === null || (braceAt === 0 && marker.index > 0)) {
        if (this.#consumeBareJson(atEnd, events)) continue
        return events
      }

      if (marker.index > 0) {
        const text = this.#pending.slice(0, marker.index)
        events.push({ type: 'text', text })
        this.#account(text)
        this.#pending = this.#pending.slice(marker.index)
        this.#atLineStart = /\n\s*$/.test(text)
        continue
      }

      // A marker inside a value the model is writing names data, not a tool.
      // Advance past it as prose so the reader does not keep matching it.
      if (this.#openValues.length > 0 || this.#quotedMarkup()) {
        const text = this.#pending.slice(0, marker.envelope.open.length)
        events.push({ type: 'text', text })
        this.#account(text)
        this.#pending = this.#pending.slice(text.length)
        this.#atLineStart = false
        continue
      }

      const closeAt = this.#closerIndex(marker.envelope)
      if (closeAt === -1) {
        if (!atEnd) return events
        const candidate = `${this.#pending}${marker.envelope.close}`
        const salvaged = parseBlock(candidate, marker.envelope, this.#tools)
        this.#account(this.#pending)
        this.#pending = ''
        for (const item of salvaged) {
          if (item.type === 'call') {
            events.push({ type: 'call', call: { ...item.call, repairs: [...item.call.repairs, 'salvaged-truncated'] } })
          } else {
            this.malformed += 1
            events.push(item)
          }
        }
        continue
      }

      const blockSize = closeAt + marker.envelope.close.length

      // A call inside a fenced code block is the model's formatting habit when
      // the block holds nothing else, and quoted markup when it does. Only the
      // block's remaining content can tell them apart.
      if (this.#inFence && marker.envelope.source !== 'fence') {
        const nextFence = this.#pending.indexOf('```', blockSize)
        if (nextFence === -1) {
          if (!atEnd) return events
        } else if (this.#pending.slice(blockSize, nextFence).trim().length > 0) {
          const text = this.#pending.slice(0, blockSize)
          events.push({ type: 'text', text })
          this.#account(text)
          this.#pending = this.#pending.slice(blockSize)
          this.#atLineStart = /\n\s*$/.test(text)
          continue
        }
      }

      const block = this.#pending.slice(0, blockSize)
      this.#account(block)
      this.#pending = this.#pending.slice(block.length)
      this.#atLineStart = /\n\s*$/.test(block)
      for (const item of parseBlock(block, marker.envelope, this.#tools)) {
        if (item.type === 'call') events.push({ type: 'call', call: item.call })
        else {
          this.malformed += 1
          events.push(item)
        }
      }
      continue
    }
  }

  /**
   * Where one envelope's closer sits, ignoring closers inside JSON strings.
   *
   * The taught envelope holds a JSON object, and a `write` or `edit` argument is
   * a file body: one that quotes this very markup would otherwise end the block
   * inside its own content, and the tool would receive a truncated file. The
   * scan therefore tracks string state and only accepts a closer outside one.
   * A body with unbalanced quotes cannot be tracked that way, so the plain first
   * match is the fallback rather than a dropped call.
   * @param envelope - the envelope to close.
   * @returns the index of the closer, or -1.
   */
  #closerIndex(envelope: Envelope): number {
    const from = envelope.open.length
    const plain = this.#pending.indexOf(envelope.close, from)
    if (plain === -1) return -1
    if (envelope.source === 'dsml') return plain

    const angle = envelope.close.startsWith('<')
    let inString = false
    let escaped = false
    /** True when the first plain match is text inside the payload. */
    let plainIsContent = false
    for (let at = from; at < this.#pending.length; at += 1) {
      const char = this.#pending[at] as string
      if (at === plain) plainIsContent = inString
      if (inString) {
        if (escaped) escaped = false
        else if (char === '\\') escaped = true
        else if (char === '"') inString = false
        continue
      }
      if (char === '"') {
        inString = true
        continue
      }
      if (angle && char === '<' && this.#pending.startsWith(envelope.close, at)) return at
    }
    // Nothing outside a string yet. A body that is still inside one, or whose
    // first match was inside one, has not ended: the rest is content the model
    // is writing, and the caller must wait for more of it.
    if (inString || plainIsContent) return -1
    return plain
  }

  /**
   * Whether the marker at the head of the buffer is inside a string literal.
   *
   * A reply that writes a test fixture as `const D = '<tool_calls>…'` is code
   * about a call. The quote before the opener is what says so; a model making a
   * call does not put one there.
   * @returns true when the opener follows a quote character.
   */
  #quotedMarkup(): boolean {
    return this.#lastChar === "'" || this.#lastChar === '"' || this.#lastChar === '`'
  }

  /**
   * Index of the leading `{` when the pending region starts with an optional
   * whitespace run followed by one, or -1.
   * @returns the index.
   */
  #leadingBrace(): number {
    const match = /^\s*\{/.exec(this.#pending)
    return match === null ? -1 : match[0].length - 1
  }

  /**
   * Consume a bare JSON object at the start of the pending region.
   * @param atEnd - whether the stream ended.
   * @param events - the event sink.
   * @returns true when the buffer advanced.
   */
  #consumeBareJson(atEnd: boolean, events: ExtractorEvent[]): boolean {
    const braceAt = this.#leadingBrace()
    if (braceAt === -1) return false
    const from = this.#pending.slice(braceAt)
    const span = firstBalancedObject(from)
    if (span === null) {
      if (!atEnd) {
        events.push({ type: 'text', text: this.#pending })
        this.#pending = ''
        this.#atLineStart = false
        return true
      }
      events.push({ type: 'text', text: this.#pending })
      this.#pending = ''
      return true
    }
    const before = this.#pending.slice(0, braceAt)
    this.#account(`${before}${span}`)
    const rest = this.#pending.slice(braceAt + span.length)
    const parsed = repairJson(span)
    let emitted = false
    if (parsed.ok) {
      const calls = callsFromValue(parsed.value, 'bare-json', this.#tools, parsed.repairs)
      const declared = calls.filter((call) => !call.unknownName)
      if (declared.length > 0) {
        for (const call of declared) events.push({ type: 'call', call })
        emitted = true
      }
    }
    if (!emitted) {
      events.push({ type: 'text', text: `${before}${span}` })
      this.#atLineStart = /\n\s*$/.test(span)
    }
    this.#pending = rest
    return true
  }

  /**
   * Locate the earliest opening marker in the buffer.
   * @returns the envelope and its index, or null.
   */
  #findMarker(): { envelope: Envelope; index: number } | null {
    let best: { envelope: Envelope; index: number } | null = null
    for (const envelope of this.#envelopes) {
      const index = this.#pending.indexOf(envelope.open)
      if (index === -1) continue
      if (best === null || index < best.index || (index === best.index && envelope.open.length > best.envelope.open.length)) {
        best = { envelope, index }
      }
    }
    return best
  }
}
