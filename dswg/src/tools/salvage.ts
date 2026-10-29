/**
 * Last-resort call recovery.
 *
 * The primary reader (`envelope.ts`) understands the formats that are *known*:
 * a taught `<tool_call>` block, a DSML invoke, a fenced object, a bare object at
 * the start of a line. Real transcripts contain shapes nobody taught it — a call
 * wrapped in prose, a `{...}</tool_call>` whose opener was lost, a Python-ish
 * `tool(city="Paris")`, or a whole reply that is one JSON envelope with the call
 * nested inside a `tool_calls` field. Those are the leaks: the call never runs,
 * the raw blob reaches the user, and to the model the action returned nothing.
 *
 * This module runs *after* the primary pass has produced no call, over the whole
 * assembled text, and does three things:
 *
 * 1. **Normalise** the dialect: Python literals, single quotes, `None`/`True`,
 *    trailing commas, unquoted keys — the difference between "unparseable" and
 *    "obviously a call".
 * 2. **Locate** every balanced JSON object, anywhere in the text, and keep the
 *    ones that name a declared tool. A stray closer with no opener pulls the
 *    nearest preceding object in.
 * 3. **Replace** the recovered span in the text, so a caller that also shows the
 *    message does not show the blob twice.
 *
 * Nothing here invents a call: a recovered call must name a tool the request
 * declared, and its arguments must survive parsing.
 *
 * @module dswg/tools/salvage
 */

import { repairJson } from './repair.ts'
import { resolveToolName } from './envelope.ts'
import { findInvokeBlocks } from './invoke.ts'
import type { ToolDefinition } from './protocol.ts'

/** What recovery found. */
export interface SalvageResult {
  /** Calls recovered from text the primary reader left alone. */
  calls: Array<{ name: string; arguments: Record<string, unknown>; raw: string; shape: string; repairs: string[] }>
  /** The text with recovered call spans removed. */
  text: string
  /** Human-readable notes about what was recognised, for the request log. */
  notes: string[]
  /**
   * True when the reply started a call and could not finish it.
   *
   * This is the difference between a leak and a reply that merely talks about
   * tool markup: an unfinished element, an unbalanced block, or a marker left
   * outside every quoted region. Only this value justifies asking the model to
   * write the call again.
   */
  unrecovered: boolean
}

/** A balanced `{...}` span located in the text. */
interface Span {
  start: number
  end: number
  body: string
}

/**
 * Rewrite Python and JavaScript literals into JSON.
 *
 * Only used on a *candidate* object, never on the whole message, so an apostrophe
 * in prose cannot be turned into a string delimiter by accident.
 * @param text - the candidate object text.
 * @returns the rewritten text and whether anything changed.
 */
export function normaliseDialect(text: string): { text: string; changed: boolean } {
  let out = text
  let changed = false
  const rules: Array<[RegExp, string]> = [
    [/\bNone\b/g, 'null'],
    [/\bTrue\b/g, 'true'],
    [/\bFalse\b/g, 'false'],
    [/\bundefined\b/g, 'null'],
    [/\bNaN\b/g, 'null'],
    [/,\s*([}\]])/g, '$1'],
  ]
  for (const [pattern, replacement] of rules) {
    const next = out.replace(pattern, replacement)
    if (next !== out) {
      out = next
      changed = true
    }
  }
  // Single-quoted strings are common in Python-ish output; only converted when
  // the object contains no double-quoted strings at all, so a legitimate value
  // containing an apostrophe is left alone.
  if (!out.includes('"') && out.includes("'")) {
    const converted = out.replace(/'([^'\\]*(?:\\.[^'\\]*)*)'/g, '"$1"')
    if (converted !== out) {
      out = converted
      changed = true
    }
  }
  return { text: out, changed }
}

/**
 * Find every balanced `{...}` span in a text.
 * @param text - the text to scan.
 * @returns the spans, in order.
 */
export function findObjects(text: string): Span[] {
  const spans: Span[] = []
  for (let start = 0; start < text.length; start += 1) {
    if (text[start] !== '{') continue
    let depth = 0
    let inString = false
    let escaped = false
    for (let i = start; i < text.length; i += 1) {
      const char = text[i] as string
      if (inString) {
        if (escaped) escaped = false
        else if (char === '\\') escaped = true
        else if (char === '"') inString = false
        continue
      }
      if (char === '"') inString = true
      else if (char === '{') depth += 1
      else if (char === '}') {
        depth -= 1
        if (depth === 0) {
          spans.push({ start, end: i + 1, body: text.slice(start, i + 1) })
          // Continue scanning after this span; nested objects are covered by the
          // outer one, and a second call is a separate span.
          start = i
          break
        }
      }
    }
  }
  return spans
}

/**
 * Read one parsed value as a call.
 * @param value - the parsed JSON value.
 * @param tools - the request's declarations.
 * @param raw - the raw text the value came from.
 * @param shape - which shape recognised it.
 * @param repairs - repairs applied.
 * @returns the call, or null when the value is not call-shaped.
 */
function asCall(
  value: unknown,
  tools: readonly ToolDefinition[],
  raw: string,
  shape: string,
  repairs: string[],
): SalvageResult['calls'][number] | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>

  const nested = record.tool_calls ?? record.toolCalls ?? record.calls
  if (Array.isArray(nested)) {
    const first = nested.find((entry) => entry !== null && typeof entry === 'object')
    if (first !== undefined) {
      const inner = asCall(first, tools, raw, 'envelope:toll_calls', repairs)
      if (inner) return inner
    }
  }

  const fn = typeof record.function === 'object' && record.function !== null ? (record.function as Record<string, unknown>) : null
  const rawName =
    typeof record.name === 'string'
      ? record.name
      : typeof record.tool === 'string'
        ? record.tool
        : typeof record.tool_name === 'string'
          ? record.tool_name
          : typeof record.action === 'string'
            ? record.action
            : typeof fn?.name === 'string'
              ? (fn.name as string)
              : null
  if (rawName === null) return null

  const resolved = resolveToolName(rawName, tools)
  if (resolved.unknown) return null

  const rawArguments = record.arguments ?? record.args ?? record.parameters ?? record.input ?? fn?.arguments
  let args: Record<string, unknown> = {}
  if (typeof rawArguments === 'string') {
    const parsed = repairJson(rawArguments)
    if (parsed.ok && parsed.value !== null && typeof parsed.value === 'object' && !Array.isArray(parsed.value)) {
      args = parsed.value as Record<string, unknown>
      repairs.push(...parsed.repairs.map((id) => `args:${id}`))
    }
  } else if (rawArguments !== null && typeof rawArguments === 'object' && !Array.isArray(rawArguments)) {
    args = rawArguments as Record<string, unknown>
  } else {
    // A flat call object: every key that is not a call keyword is an argument.
    const keywords = new Set(['name', 'tool', 'tool_name', 'action', 'function', 'arguments', 'args', 'parameters', 'input', 'id', 'type'])
    for (const [key, entry] of Object.entries(record)) {
      if (!keywords.has(key)) args[key] = entry
    }
    if (Object.keys(args).length === 0) return null
  }

  return { name: resolved.name, arguments: args, raw, shape, repairs }
}

/**
 * Whether a recovered call sits where a real call sits.
 *
 * A model that *describes* a call — quoting `{"name":"kernel","arguments":{…}}`
 * in the middle of an explanation — would otherwise have it executed, with
 * arguments the model invented for illustration. A real call ends the turn, so
 * recovery only accepts a call in the last stretch of the reply, or anywhere in a
 * short reply where there is no essay to be part of.
 * @param text - the whole reply.
 * @param endIndex - the character just after the recovered call.
 * @returns true when the position is plausible for a call.
 */
function nearEnd(text: string, endIndex: number): boolean {
  return text.length <= 1000 || text.length - endIndex <= 400
}

/** One region of the reply that recovery must not read out of. */
interface Region {
  start: number
  end: number
}

/**
 * Fenced code regions.
 *
 * A fenced block is usually how the model shows a call it means to make, and
 * sometimes how it shows one it is only talking about. Telling those apart needs
 * the block's content, so the region is reported rather than decided here.
 * @param text - the whole reply.
 * @returns the fenced regions, with the body between the fences.
 */
function fencedRegions(text: string): Array<Region & { bodyStart: number; bodyEnd: number }> {
  const marks: number[] = []
  let at = text.indexOf('```')
  while (at !== -1) {
    marks.push(at)
    at = text.indexOf('```', at + 3)
  }
  const regions: Array<Region & { bodyStart: number; bodyEnd: number }> = []
  for (let index = 0; index + 1 < marks.length; index += 2) {
    const open = marks[index] as number
    const close = marks[index + 1] as number
    const lineEnd = text.indexOf('\n', open + 3)
    const tagEnd = lineEnd !== -1 && lineEnd < close ? lineEnd : open + 3
    regions.push({ start: open, end: close + 3, bodyStart: tagEnd, bodyEnd: close })
  }
  // A fence that never closed still owns everything after its opener.
  if (marks.length % 2 === 1) {
    const open = marks[marks.length - 1] as number
    const lineEnd = text.indexOf('\n', open + 3)
    regions.push({ start: open, end: text.length, bodyStart: lineEnd === -1 ? open + 3 : lineEnd, bodyEnd: text.length })
  }
  return regions
}

/**
 * Regions after an element nobody closed.
 *
 * `<tool_calls> <parameter name="code">grep(r"x", "pkg")` is a call whose header
 * was lost: the code sample is the argument, and the `grep(` in it is Python.
 * Anything after an unmatched opener is therefore data, not a call site.
 * @param text - the whole reply.
 * @returns the regions that follow an unclosed element.
 */
function openMarkupRegions(text: string): Region[] {
  const regions: Region[] = []
  const pairs: Array<[RegExp, RegExp]> = [
    [/<parameter\b/gi, /<\/parameter\s*>/gi],
    [/<invoke\b/gi, /<\/invoke\s*>/gi],
    [/<tool_calls>/gi, /<\/tool_calls\s*>/gi],
    [/<tool_call>/gi, /<\/tool_call\s*>/gi],
  ]
  for (const [openPattern, closePattern] of pairs) {
    const opens = [...text.matchAll(openPattern)].map((match) => match.index ?? 0)
    const closes = [...text.matchAll(closePattern)].map((match) => match.index ?? 0)
    if (opens.length === 0) continue
    const lastOpen = opens[opens.length - 1] as number
    const lastClose = closes.length > 0 ? (closes[closes.length - 1] as number) : -1
    if (opens.length > closes.length && lastOpen > lastClose) regions.push({ start: lastOpen, end: text.length })
  }
  return regions
}

/**
 * Whether a call marker sits where a call could have been written.
 *
 * A marker inside a fenced block or inside an element's value is the model
 * talking about a call. The same marker in the open is a call that did not
 * register, and the turn it belonged to produced nothing.
 * @param text - the whole reply.
 * @param fenced - the fenced regions.
 * @param open - the regions after an unclosed element.
 * @returns true when a marker is outside every quoted region.
 */
function strayMarker(text: string, fenced: readonly Region[], open: readonly Region[]): boolean {
  const pattern = /<\s*(?:[|｜]{1,2}\s*DSML\s*[|｜]{1,2}\s*)?(?:invoke|tool_calls|tool_call)\b|<\|\/?tool_call\|>/gi
  for (const match of text.matchAll(pattern)) {
    const at = match.index ?? 0
    const end = at + match[0].length
    const quoted = quotedSpan(text, at, end)
    if (quoted) continue
    if (overlaps(fenced, at, end) || overlaps(open, at, end)) continue
    return true
  }
  return false
}

/**
 * Whether a span begins or ends inside a string literal.
 *
 * `const D = '<tool_calls>…</tool_calls>'` is a reply writing code about a call.
 * The quote that encloses the markup is what distinguishes it from a call the
 * model is making, and neither reader can see it from the markup alone.
 * @param text - the whole reply.
 * @param start - span start.
 * @param end - span end.
 * @returns true when a quote character brackets the span.
 */
function quotedSpan(text: string, start: number, end: number): boolean {
  const before = text[start - 1] ?? ''
  const after = text[end] ?? ''
  const quote = /['"`]/
  return quote.test(before) || quote.test(after)
}

/**
 * Whether a span overlaps any region.
 * @param regions - the regions to test.
 * @param start - span start.
 * @param end - span end.
 * @returns true on overlap.
 */
function overlaps(regions: readonly Region[], start: number, end: number): boolean {
  return regions.some((region) => start < region.end && end > region.start)
}

/**
 * Whether one text is the whole content of a fence body.
 *
 * The model's own formatting habit wraps a real call in fences; a code listing
 * that happens to contain call markup is the other case, and the difference is
 * whether anything else is in the block.
 * @param body - the fence body, without its language tag.
 * @param text - the markup being considered.
 * @returns true when the body is that markup and nothing else.
 */
function fenceBodyIsOnly(body: string, text: string): boolean {
  const trimmed = body.trim()
  const candidate = text.trim()
  if (trimmed === candidate) return true
  // Trailing punctuation or a closing quote is the author's, not the call's.
  return trimmed.length > candidate.length && trimmed.startsWith(candidate) && /^[\s'"`,;.)\]]*$/.test(trimmed.slice(candidate.length))
}

/**
 * Recover calls from a reply the primary reader could not parse.
 *
 * Order matters. An `<invoke>` element is read first, because a reply carrying
 * one has structure this module can follow; the scans that follow work on
 * position alone and must therefore be told what was already claimed and what is
 * quoted material.
 * @param text - the assembled model text.
 * @param tools - the tools the request declared.
 * @returns the recovered calls and the cleaned text.
 */
export function salvageCalls(text: string, tools: readonly ToolDefinition[]): SalvageResult {
  const notes: string[] = []
  if (tools.length === 0 || text.length === 0) return { calls: [], text, notes, unrecovered: false }

  const found: SalvageResult['calls'] = []
  /** Ranges of the text already claimed by a recovered call. */
  const claimed: Region[] = []
  /** Ranges whose content is data — a quoted listing, or a value being written. */
  const fenced = fencedRegions(text)
  const open = openMarkupRegions(text)
  const protectedRegions: Array<Region & { bodyStart?: number; bodyEnd?: number }> = [...fenced, ...open]
  // An element left open is a call the model was still writing. Nothing can run
  // from it, and the client must not be handed it as an answer.
  let unrecovered = open.length > 0

  const claim = (start: number, end: number): void => {
    claimed.push({ start, end })
  }

  // An `<invoke>` element with no wrapper around it, or with its wrapper
  // damaged. A complete element is a call, whatever else the reply mentions: a
  // reply that also discusses this markup is normal for an agent working on a
  // parser, and refusing every such reply would waste the turns that matter
  // most. An element that never closed is a call the model was still writing,
  // and running it would act on half an argument.
  for (const block of findInvokeBlocks(text)) {
    if (overlaps(claimed, block.start, block.end)) continue
    if (quotedSpan(text, block.start, block.end)) {
      protectedRegions.push({ start: block.start, end: block.end })
      notes.push(`invoke@${block.start} is quoted inside a string literal`)
      continue
    }
    if (!block.complete) {
      protectedRegions.push({ start: block.start, end: block.end })
      notes.push(`incomplete-invoke@${block.start} ${block.name} (${block.repairs.join(',') || 'no closer'})`)
      continue
    }
    const fence = protectedRegions.find((region) => region.bodyStart !== undefined && block.start >= region.start && block.end <= region.end)
    if (fence && fence.bodyStart !== undefined && fence.bodyEnd !== undefined) {
      if (!fenceBodyIsOnly(text.slice(fence.bodyStart, fence.bodyEnd), text.slice(block.start, block.end))) continue
    }
    const resolved = resolveToolName(block.name, tools)
    if (resolved.unknown) {
      notes.push(`invoke@${block.start} names ${block.name}, which this request did not declare`)
      continue
    }
    if (!nearEnd(text, block.end)) {
      protectedRegions.push({ start: block.start, end: block.end })
      notes.push(`invoke@${block.start} ${block.name} sits mid-reply; treated as quoted material`)
      continue
    }
    found.push({ name: resolved.name, arguments: block.arguments, raw: text.slice(block.start, block.end), shape: 'invoke-orphan', repairs: ['invoke-orphan', ...block.repairs] })
    claim(block.start, block.end)
    notes.push(`invoke@${block.start} -> ${resolved.name}`)
  }

  for (const span of findObjects(text)) {
    if (overlaps(claimed, span.start, span.end)) continue
    if (overlaps(protectedRegions, span.start, span.end)) continue
    if (quotedSpan(text, span.start, span.end)) continue
    const normalised = normaliseDialect(span.body)
    const parsed = repairJson(normalised.text)
    if (!parsed.ok) continue
    const repairs = normalised.changed ? ['dialect'] : []
    repairs.push(...parsed.repairs)
    const call = asCall(parsed.value, tools, span.body, 'object', repairs)
    if (call && nearEnd(text, span.end)) {
      found.push(call)
      claim(span.start, span.end)
      notes.push(`object@${span.start} -> ${call.name}`)
    }
  }

  // A closer with no opener: pull the nearest preceding object in.
  const closers = ['</tool_call>', '</tool_calls>', '</invoke>', '<|/tool_call|>', '<｜/tool_call｜>']
  for (const closer of closers) {
    let at = text.indexOf(closer)
    while (at !== -1) {
      const before = text.slice(0, at)
      const spans = findObjects(before)
      const last = spans[spans.length - 1]
      if (
        last &&
        last.end > at - 400 &&
        nearEnd(text, last.end) &&
        !overlaps(claimed, last.start, last.end) &&
        !overlaps(protectedRegions, last.start, last.end)
      ) {
        const normalised = normaliseDialect(last.body)
        const parsed = repairJson(normalised.text)
        if (parsed.ok) {
          const call = asCall(parsed.value, tools, last.body, 'orphan-closer', ['orphan-closer'])
          if (call) {
            found.push(call)
            claim(last.start, last.end)
            notes.push(`orphan-closer@${at} -> ${call.name}`)
          }
        }
      }
      at = text.indexOf(closer, at + closer.length)
    }
  }

  // Function-call syntax: tool_name(city="Paris", days=2).
  //
  // This is the weakest signal recovery has — the same characters appear in
  // every code sample a model writes — so it is skipped inside anything that
  // quotes or carries code, and inside a backtick span.
  const namePattern = tools.map((tool) => tool.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
  if (namePattern.length > 0) {
    const callSyntax = new RegExp(`\\b(${namePattern})\\s*\\(([^()]{0,2000})\\)`, 'g')
    let match: RegExpExecArray | null
    while ((match = callSyntax.exec(text)) !== null) {
      const start = match.index
      const end = start + match[0].length
      if (overlaps(claimed, start, end)) continue
      if (overlaps(protectedRegions, start, end)) continue
      if (text[start - 1] === '`' || text[end] === '`') continue
      const name = match[1] as string
      const inside = match[2] ?? ''
      const args: Record<string, unknown> = {}
      const argPattern = /([A-Za-z_][\w]*)\s*[:=]\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^,]+)\s*(?:,|$)/g
      let arg: RegExpExecArray | null
      let sawArgument = false
      while ((arg = argPattern.exec(inside)) !== null) {
        sawArgument = true
        const key = arg[1] as string
        const rawValue = (arg[2] as string).trim()
        const unquoted = rawValue.replace(/^['"]|['"]$/g, '')
        const parsedValue = repairJson(unquoted)
        args[key] = parsedValue.ok ? parsedValue.value : unquoted
      }
      if (!sawArgument) continue
      found.push({ name, arguments: args, raw: match[0], shape: 'call-syntax', repairs: ['call-syntax'] })
      claim(start, end)
      notes.push(`call-syntax@${start} -> ${name}`)
    }
  }

  // A long object repeated verbatim is the model pasting the same blob twice —
  // the shape in the wild is a tool result echoed back into prose. Keep the
  // first copy so the message still reads as written, and drop the repeats.
  const seenBodies = new Map<string, number>()
  for (const span of findObjects(text)) {
    if (span.body.length < 200) continue
    if (overlaps(protectedRegions, span.start, span.end)) continue
    const first = seenBodies.get(span.body)
    if (first === undefined) {
      seenBodies.set(span.body, span.start)
      continue
    }
    claim(span.start, span.end)
    notes.push(`collapsed repeated blob@${span.start} (first at ${first})`)
  }

  if (found.length === 0 && claimed.length === 0) {
    return { calls: [], text, notes, unrecovered: unrecovered || strayMarker(text, fenced, open) }
  }

  claimed.sort((a, b) => a.start - b.start)
  const merged: Region[] = []
  for (const range of claimed) {
    const last = merged[merged.length - 1]
    if (last && range.start <= last.end) last.end = Math.max(last.end, range.end)
    else merged.push({ ...range })
  }

  let cleaned = ''
  let cursor = 0
  for (const range of merged) {
    cleaned += text.slice(cursor, range.start)
    cursor = range.end
  }
  cleaned += text.slice(cursor)

  // Remove the closers that were matched, so the remaining prose does not read
  // as half a call to the user.
  for (const closer of ['</tool_call>', '</tool_calls>', '<|/tool_call|>', '<｜/tool_call｜>']) {
    cleaned = cleaned.split(closer).join('')
  }
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n').trim()

  return { calls: found, text: cleaned, notes, unrecovered: found.length === 0 && (unrecovered || strayMarker(text, fenced, open)) }
}


/**
 * Whether a reply looks like it was trying to call something.
 *
 * Used to decide between "the model answered in prose" and "the model tried to
 * call and we missed it" — the second is a bug worth recording and repairing.
 *
 * The test is deliberately structural. An earlier version fired on "a declared
 * tool name appears anywhere near a brace", which classified ordinary agent prose
 * ("the append mutated `open(p, \"a\")`") as a missed call, and recorded those
 * replies as leaks — which would then have trained the delimiter miner on noise.
 * A name only counts when it is *written as a name*: quoted, or followed by an
 * argument list.
 * @param text - the model's reply.
 * @param tools - the tools the request declared.
 * @returns true when the text carries a call-shaped signal.
 */
export function looksLikeCall(text: string, tools: readonly ToolDefinition[]): boolean {
  if (text.trim().length === 0) return false
  const lower = text.toLowerCase()
  const markers = ['<tool_call', '</tool_call', 'tool_calls', '"arguments"', "'arguments'", 'invoke name', '<|tool_call', 'tool_use']
  if (markers.some((marker) => lower.includes(marker))) return true
  if (/<\s*(?:[|｜]{1,2}\s*dsml\s*[|｜]{1,2}\s*)?invoke\b/.test(lower)) return true

  for (const tool of tools) {
    const name = tool.name.toLowerCase()
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    // Written as a function call: `get_weather(city="Paris")`. The parenthesis
    // must be attached (a space makes it prose: "read (the file)") and the body
    // must look like arguments, not a sentence.
    // The preceding character must not make it an attribute access or a longer
    // identifier: `open(p).read()` is Python, not a call to a tool named `read`.
    const callSyntax = new RegExp(`(^|[^a-z0-9_.$])${escaped}\\(([^()]{0,400})\\)`, 'i').exec(lower)
    if (callSyntax) {
      const body = (callSyntax[2] ?? '').trim()
      if (body.length === 0 || /[=:]/.test(body)) return true
    }
    // Written as a value: {"name": "get_weather"} or name: 'get_weather'.
    for (const form of [`"${name}"`, `'${name}'`]) {
      const at = lower.indexOf(form)
      if (at === -1) continue
      const before = lower.slice(Math.max(0, at - 120), at)
      if (/[{\[,]\s*(?:"?name"?|"?tool"?|"?function"?|"?tool_name"?)\s*:\s*$/.test(before)) return true
    }
  }
  return false
}
