/**
 * JSON repair for model-authored tool arguments.
 *
 * The model writes JSON inside a text block, and in a long or degraded context
 * it drifts: a trailing comma, an unclosed string, a fence around the object,
 * smart quotes copied from prose, a value cut off when the answer hit a limit.
 * Every one of those is recoverable, and recovering is much cheaper than
 * spending another turn — so each repair is attempted in order, and the ones
 * that fired are reported for the request log.
 *
 * A repair never invents a value: it only closes, unquotes, or drops structure.
 *
 * @module dswg/tools/repair
 */

/** The outcome of repairing one JSON text. */
export interface RepairResult {
  ok: boolean
  value: unknown
  /** Stable ids of the repairs that were applied, in order. */
  repairs: string[]
  /** Parse error text when `ok` is false. */
  error?: string
}

/** Characters that prose swaps in for JSON quotes. */
const SMART_QUOTES: Array<[RegExp, string]> = [
  [/[\u201c\u201d\u2033]/g, '"'],
  [/[\u2018\u2019\u2032]/g, "'"],
  [/\u00a0/g, ' '],
]

/**
 * Strip a Markdown code fence that wraps the whole payload.
 * @param text - candidate text.
 * @returns the unwrapped text and whether a fence was removed.
 */
export function stripFence(text: string): { text: string; stripped: boolean } {
  const trimmed = text.trim()
  const fence = /^```[a-zA-Z0-9_-]*\s*\n?([\s\S]*?)\n?```$/.exec(trimmed)
  if (fence && fence[1] !== undefined) return { text: fence[1].trim(), stripped: true }
  // An opening fence whose closer was never written.
  const open = /^```[a-zA-Z0-9_-]*\s*\n?([\s\S]*)$/.exec(trimmed)
  if (open && open[1] !== undefined) return { text: open[1].trim(), stripped: true }
  return { text: trimmed, stripped: false }
}

/**
 * Extract the first balanced `{...}` span, ignoring braces inside strings.
 * @param text - text that may contain prose around the object.
 * @returns the span, or null when no balanced object exists.
 */
export function firstBalancedObject(text: string): string | null {
  const start = text.indexOf('{')
  if (start === -1) return null
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
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return null
}

/**
 * Remove `//` and block comments that are outside strings.
 * @param text - JSON-ish text.
 * @returns the text without comments.
 */
function dropComments(text: string): string {
  let out = ''
  let inString = false
  let escaped = false
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i] as string
    const next = text[i + 1]
    if (inString) {
      out += char
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') {
      inString = true
      out += char
      continue
    }
    if (char === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i += 1
      out += '\n'
      continue
    }
    if (char === '/' && next === '*') {
      i += 2
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1
      i += 1
      continue
    }
    out += char
  }
  return out
}

/**
 * Remove a comma that precedes `}` or `]`.
 * @param text - JSON-ish text.
 * @returns the text and whether anything was removed.
 */
function dropTrailingCommas(text: string): { text: string; changed: boolean } {
  let out = ''
  let inString = false
  let escaped = false
  let changed = false
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i] as string
    if (inString) {
      out += char
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') {
      inString = true
      out += char
      continue
    }
    if (char === ',') {
      let j = i + 1
      while (j < text.length && /\s/.test(text[j] as string)) j += 1
      const after = text[j]
      if (after === '}' || after === ']') {
        changed = true
        continue
      }
    }
    out += char
  }
  return { text: out, changed }
}

/**
 * Escape raw newlines, tabs and control characters that appear inside strings.
 * @param text - JSON-ish text.
 * @returns the text and whether anything changed.
 */
function escapeControlChars(text: string): { text: string; changed: boolean } {
  let out = ''
  let inString = false
  let escaped = false
  let changed = false
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i] as string
    if (inString) {
      if (escaped) {
        out += char
        escaped = false
        continue
      }
      if (char === '\\') {
        out += char
        escaped = true
        continue
      }
      if (char === '"') {
        inString = false
        out += char
        continue
      }
      if (char === '\n') {
        out += '\\n'
        changed = true
        continue
      }
      if (char === '\r') {
        out += '\\r'
        changed = true
        continue
      }
      if (char === '\t') {
        out += '\\t'
        changed = true
        continue
      }
      const code = char.charCodeAt(0)
      if (code < 0x20) {
        out += `\\u${code.toString(16).padStart(4, '0')}`
        changed = true
        continue
      }
      out += char
      continue
    }
    if (char === '"') inString = true
    out += char
  }
  return { text: out, changed }
}

/**
 * Close strings, objects and arrays left open at the end of a truncated payload.
 * @param text - JSON-ish text.
 * @returns the closed text and whether anything was added.
 */
export function closeTruncated(text: string): { text: string; changed: boolean } {
  let inString = false
  let escaped = false
  const stack: string[] = []
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i] as string
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === '{') stack.push('}')
    else if (char === '[') stack.push(']')
    else if (char === '}' || char === ']') stack.pop()
  }
  let out = text
  let changed = false
  if (inString) {
    // A dangling escape would swallow the closing quote, so drop it first.
    if (escaped) out = out.slice(0, -1)
    out += '"'
    changed = true
  }
  // A member that never got a value is not completed by the closer that follows
  // it: `{"path":` closed as `{"path":}` is not JSON. The model ran out of
  // output, so the member is dropped and the tool's own required-argument check
  // reports what is missing.
  if (stack.length > 0) {
    const trimmed = out.replace(/,\s*"[^"]*"\s*:\s*$/, '').replace(/\{\s*"[^"]*"\s*:\s*$/, '{')
      .replace(/,\s*[A-Za-z_$][\w$]*\s*:\s*$/, '').replace(/\{\s*[A-Za-z_$][\w$]*\s*:\s*$/, '{')
      .replace(/,\s*$/, '')
    if (trimmed !== out) {
      out = trimmed
      changed = true
    }
  }
  while (stack.length > 0) {
    out += stack.pop() as string
    changed = true
  }
  return { text: out, changed }
}

/**
 * Quote bare object keys (`{a: 1}` -> `{"a": 1}`).
 * @param text - JSON-ish text.
 * @returns the text and whether anything changed.
 */
function quoteBareKeys(text: string): { text: string; changed: boolean } {
  let changed = false
  const out = text.replace(/([{,]\s*)([A-Za-z_$][A-Za-z0-9_$]*)(\s*:)/g, (_match, prefix: string, key: string, suffix: string) => {
    changed = true
    return `${prefix}"${key}"${suffix}`
  })
  return { text: out, changed }
}

/**
 * Repair and parse one JSON payload.
 * @param raw - the text the model wrote.
 * @returns the parse outcome and the repairs that fired.
 */
export function repairJson(raw: string): RepairResult {
  const repairs: string[] = []
  let text = (raw ?? '').trim()
  if (text.length === 0) return { ok: false, value: undefined, repairs, error: 'empty payload' }

  const fenced = stripFence(text)
  if (fenced.stripped) {
    text = fenced.text
    repairs.push('fence')
  }
  const balanced = firstBalancedObject(text)
  if (balanced && balanced !== text) {
    text = balanced
    repairs.push('extract-object')
  }

  const attempt = (candidate: string): unknown | undefined => {
    try {
      return JSON.parse(candidate)
    } catch {
      return undefined
    }
  }

  const first = attempt(text)
  if (first !== undefined) return { ok: true, value: first, repairs }

  let normalised = false
  for (const [pattern, replacement] of SMART_QUOTES) {
    if (pattern.test(text)) {
      text = text.replace(pattern, replacement)
      repairs.push('smart-quotes')
      normalised = true
    }
  }
  const noComments = dropComments(text)
  if (noComments !== text) {
    text = noComments
    repairs.push('comments')
    normalised = true
  }
  if (normalised) {
    const value = attempt(text)
    if (value !== undefined) return { ok: true, value, repairs }
  }

  const stages: Array<[string, (input: string) => { text: string; changed: boolean }]> = [
    ['trailing-comma', dropTrailingCommas],
    ['escaped-controls', escapeControlChars],
    ['bare-keys', quoteBareKeys],
    ['closed-truncated', closeTruncated],
  ]

  for (const [id, stage] of stages) {
    const applied = stage(text)
    if (!applied.changed) continue
    text = applied.text
    repairs.push(id)
    const value = attempt(text)
    if (value !== undefined) return { ok: true, value, repairs }
  }

  // One more pass: truncation often also leaves a trailing comma behind.
  const combo = closeTruncated(dropTrailingCommas(text).text)
  if (combo.changed) {
    repairs.push('closed-truncated+trailing-comma')
    const value = attempt(combo.text)
    if (value !== undefined) return { ok: true, value, repairs }
  }

  let error = 'unparseable'
  try {
    JSON.parse(text)
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught)
  }
  return { ok: false, value: undefined, repairs, error }
}
