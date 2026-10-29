/**
 * Recovery of `<invoke>` blocks whose wrapper was lost.
 *
 * The model writes DSML: `<tool_calls>` holding one or more `<invoke name="…">`
 * elements, each with `<parameter name="…">` children. The primary reader parses
 * that when both the wrapper and the innermost closers survive. What survives in
 * a long context is often less than that: the reply begins at `<invoke>`, the
 * wrapper line was eaten by whatever rewrote the transcript, or a stray closer
 * from a previous block is still sitting between two parameters.
 *
 * Those replies are calls — the model wrote a tool name and its arguments — and
 * dropping them spends the turn. This module reads the element itself, without
 * its wrapper, and refuses anything it cannot read completely: a parameter whose
 * value never closed is a truncated call, and acting on it would write half a
 * file.
 *
 * @module dswg/tools/invoke
 */

/** One `<invoke>` element read out of a reply. */
export interface InvokeBlock {
  /** Offset of the `<invoke` opener. */
  start: number
  /** Offset just past the element, or past what could be read of it. */
  end: number
  /** Tool name as written. */
  name: string
  /** Arguments, in the order the reply wrote them. */
  arguments: Record<string, unknown>
  /** Repairs applied while reading. */
  repairs: string[]
  /** True when every parameter and the element itself closed. */
  complete: boolean
}

/** The DSML prefix, in the spellings the model uses, as a regex fragment. */
const DSML = String.raw`(?:[|｜]{1,2}\s*DSML\s*[|｜]{1,2}\s*)?`

/** An `<invoke>` opener, with or without the DSML prefix. */
const INVOKE_OPEN = new RegExp(String.raw`<\s*${DSML}invoke\b([^>]*)>`, 'gi')

/** An `<invoke>` closer. */
const INVOKE_CLOSE = new RegExp(String.raw`<\s*/\s*${DSML}invoke\s*>`, 'gi')

/** A `<parameter>` opener, capturing its attributes. */
const PARAM_OPEN = new RegExp(String.raw`<\s*${DSML}parameter\b([^>]*)>`, 'gi')

/** A `</parameter>` closer. */
const PARAM_CLOSE = new RegExp(String.raw`<\s*/\s*${DSML}parameter\s*>`, 'gi')

/**
 * A bare element naming the argument it holds, as in `<content>…</parameter>`.
 * Only accepted where a parameter is expected and nothing else intervenes, so an
 * HTML tag inside a value is not mistaken for the next argument.
 */
const BARE_PARAM = /<\s*([A-Za-z_][\w.-]*)\s*>/g

/** Element names that begin other structure and are never argument names. */
const NOT_ARGUMENTS = new Set(['invoke', 'parameter', 'tool_calls', 'function_calls', 'tool_call', 'function_call', 'antml', 'result'])

/**
 * Read the `name` attribute of a tag.
 * @param attributes - the text between the element name and `>`.
 * @returns the attribute value, or null.
 */
function attributeName(attributes: string): string | null {
  const match = /\bname\s*=\s*(?:"([^"]*)"|'([^']*)'|([\w.:-]+))/i.exec(attributes)
  if (match === null) return null
  return (match[1] ?? match[2] ?? match[3] ?? '').trim() || null
}

/**
 * Undo the XML entities a DSML value carries.
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
 * Read one parameter value.
 *
 * The value of a DSML parameter is text. A file body, a shell command, or a path
 * is the characters between the tags, and trying to read it as JSON would corrupt
 * it the moment it happens to contain a brace — a `write` whose content quotes a
 * JSON object would arrive at the tool as that object instead of the file. So
 * JSON is read only when the element says the value is not a string
 * (`string="false"`), or when the whole value is one container and nothing else.
 * @param raw - the value text as written.
 * @param asJson - true when the element declared a non-string type.
 * @returns the value to pass to the tool.
 */
export function parseParameterValue(raw: string, asJson = false): unknown {
  const text = raw.trim()
  if (text.length === 0) return ''
  const wholeContainer = /^[[{]/.test(text) && /[}\]]$/.test(text)
  if (asJson || wholeContainer) {
    try {
      return JSON.parse(text) as unknown
    } catch {
      // Not JSON after all; the literal text is what the model meant.
    }
  }
  return unescapeXml(text)
}

/**
 * Whether a parameter's opening tag declares a non-string value.
 * @param opener - the text ending at the parameter's `>`.
 * @returns true when the tag carries `string="false"`.
 */
function declaredJson(opener: string): boolean {
  return /\bstring\s*=\s*["']?false/i.test(opener)
}

/** Where the next structural token sits, and what kind it is. */
interface Token {
  kind: 'parameter' | 'bare' | 'close'
  index: number
  /** End of the token itself; for `close` this is past the closer. */
  end: number
  /** Parameter name, for `parameter`; element name, for `bare`. */
  name: string | null
}

/**
 * Find the next token that can end a parameter value.
 *
 * A `<parameter>` opener ends the value wherever it appears: a model that runs
 * out of output starts a new parameter without closing the previous one. A bare
 * element only counts when it is the next thing after whitespace, because a
 * value is allowed to contain markup.
 * @param text - the reply.
 * @param from - where to start looking.
 * @returns the token, or null when the element simply ends.
 */
function nextToken(text: string, from: number): Token | null {
  const candidates: Token[] = []

  PARAM_OPEN.lastIndex = from
  const parameter = PARAM_OPEN.exec(text)
  if (parameter !== null) {
    candidates.push({ kind: 'parameter', index: parameter.index, end: parameter.index + parameter[0].length, name: attributeName(parameter[1] ?? '') })
  }

  BARE_PARAM.lastIndex = 0
  const rest = text.slice(from)
  let bare: RegExpExecArray | null
  while ((bare = BARE_PARAM.exec(rest)) !== null) {
    const name = bare[1] ?? ''
    if (NOT_ARGUMENTS.has(name.toLowerCase())) continue
    if (rest.slice(0, bare.index).trim().length > 0) break
    candidates.push({ kind: 'bare', index: from + bare.index, end: from + bare.index + bare[0].length, name })
    break
  }

  INVOKE_CLOSE.lastIndex = from
  const close = INVOKE_CLOSE.exec(text)
  if (close !== null) {
    candidates.push({ kind: 'close', index: close.index, end: close.index + close[0].length, name: null })
  }

  let best: Token | null = null
  for (const candidate of candidates) {
    if (best === null || candidate.index < best.index) best = candidate
  }
  return best
}

/**
 * Where one parameter value stops.
 *
 * A value is text, and text is allowed to contain markup — a `write` whose
 * content is a test fixture for this very format holds complete `<invoke>`
 * elements as strings. So when the element's own closer turns up before the
 * parameter's closer does, and a parameter closer exists further on, the
 * earlier one is part of the value and the parameter wins. The element closer
 * only ends the value when nothing else could.
 * @param text - the reply.
 * @param from - just past the parameter's opening tag.
 * @returns the offset where the value stops, and the length of the closer that stopped it.
 */
function valueEnd(text: string, from: number): { at: number; closerLength: number } {
  PARAM_CLOSE.lastIndex = from
  const closer = PARAM_CLOSE.exec(text)
  const next = nextToken(text, from)
  if (closer !== null && (next === null || closer.index <= next.index)) {
    return { at: closer.index, closerLength: closer[0].length }
  }
  if (next === null) return { at: text.length, closerLength: 0 }
  if (next.kind === 'close' && closer !== null) return { at: closer.index, closerLength: closer[0].length }
  return { at: next.index, closerLength: 0 }
}

/**
 * Read one `<invoke>` element starting at its opener.
 * @param text - the reply.
 * @param start - offset of the opener.
 * @param openerLength - length of the opening tag.
 * @param name - the tool name from the opener.
 * @returns the element as far as it could be read.
 */
function readInvoke(text: string, start: number, openerLength: number, name: string): InvokeBlock {
  const args: Record<string, unknown> = {}
  const repairs: string[] = []
  let cursor = start + openerLength
  let complete = false
  let end = cursor
  /** Where the element body stops, whether or not a closer arrived. */
  let bodyEnd = text.length

  for (;;) {
    const token = nextToken(text, cursor)
    if (token === null) {
      end = text.length
      bodyEnd = text.length
      break
    }
    if (token.kind === 'close') {
      complete = true
      bodyEnd = token.index
      end = token.end
      break
    }
    const key = token.name ?? ''
    const value = valueEnd(text, token.end)
    args[key] = parseParameterValue(text.slice(token.end, value.at), declaredJson(text.slice(0, token.end)))
    if (value.closerLength === 0) repairs.push(`unclosed:${key}`)
    cursor = value.at + value.closerLength
    end = cursor
    bodyEnd = cursor
  }

  // A body that is one JSON object rather than parameters.
  if (Object.keys(args).length === 0) {
    const body = text.slice(start + openerLength, bodyEnd).trim()
    if (body.startsWith('{') && body.endsWith('}')) {
      try {
        const parsed = JSON.parse(body) as unknown
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
          Object.assign(args, parsed as Record<string, unknown>)
          repairs.push('invoke-json-body')
        }
      } catch {
        // A prose body; the element simply carried no arguments.
      }
    }
  }

  return { start, end, name, arguments: args, repairs, complete }
}

/**
 * Every `<invoke>` element in a reply, outermost first.
 * @param text - the assembled reply.
 * @returns the elements found, in order.
 */
export function findInvokeBlocks(text: string): InvokeBlock[] {
  const blocks: InvokeBlock[] = []
  INVOKE_OPEN.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = INVOKE_OPEN.exec(text)) !== null) {
    const name = attributeName(match[1] ?? '')
    if (name === null) continue
    const block = readInvoke(text, match.index, match[0].length, name)
    blocks.push(block)
    // Skip anything nested inside this element: its body is a value, and a name
    // that appears there is being quoted, not called.
    if (block.end > INVOKE_OPEN.lastIndex) INVOKE_OPEN.lastIndex = block.end
  }
  return blocks
}
