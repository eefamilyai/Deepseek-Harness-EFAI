/**
 * The one tool-call format a Kiln route speaks, stated once.
 *
 * None of these providers has a `tools` field — `ds_direct` is a web chat
 * session and physically cannot have one — so the harness's tool schemas reach
 * the model only as text, and a tool call comes back only as text. That makes
 * the encoding a transport concern, and this module is the single place it is
 * defined: {@link toolProtocolPrompt} writes the format down, and
 * {@link DsmlTranslator} reads exactly what was written down.
 *
 * The catalog here is GENERATED from `GenerateOptions.tools` — the same
 * schemas a native provider would receive in its `tools` field. Nothing about
 * any particular tool is hardcoded: the roster the harness composed is the
 * roster the model is told about, so a tool that is switched off cannot linger
 * in the prompt as an instruction to call something that no longer exists.
 *
 * @module @deepseek-ai/dsh-llm-kiln/protocol
 */

import type { ToolSchema } from '@deepseek-ai/dsh-llm'

/** Opening tag of a tool-call block. */
export const DSML_OPEN = '<tool_calls>'

/** Closing tag of a tool-call block. */
export const DSML_CLOSE = '</tool_calls>'

/**
 * The format statement, verbatim and provider-independent.
 *
 * It says one thing about where output goes — inside a block it runs, outside
 * it does not — because the failure this replaces was the model believing
 * there were two action channels and picking the one that was prose.
 *
 * The closing rule names NO wrong format on purpose. It used to spell out the
 * four it meant — the special-token markup by name, a `<tool_call>` JSON
 * envelope, a tool worn as its own tag, bare JSON — and a prohibition cannot be
 * written without writing the thing prohibited. The reader on the other side of
 * this transport then had to grow a case for each of those exact shapes, which
 * is not the direction of causation you want between a prompt and its parser.
 * State the one shape that works; say only that everything else is prose.
 */
const FORMAT = [
  '# Calling tools',
  '',
  'You have no native tool-call channel here, so a tool call is written into your reply',
  'as a tool_calls block, in exactly this shape:',
  '',
  DSML_OPEN,
  '<invoke name="TOOL_NAME">',
  '<parameter name="PARAMETER_NAME">value</parameter>',
  '</invoke>',
  DSML_CLOSE,
  '',
  '- One `<parameter>` per argument. Its value is the raw text between the tags, so',
  '  multi-line values need no quoting or escaping.',
  '- Arguments go in `<parameter>` elements, never as attributes on the `<invoke>` tag.',
  '  `<invoke name="TOOL_NAME">` carries the tool name and nothing else.',
  '- Every parameter listed as required for a tool must be present in every call to it,',
  '  including ones whose value seems obvious. A call missing one does not run.',
  '- A parameter typed `object`, `array`, `number`, `integer`, or `boolean` in the schema',
  '  below takes JSON. A `string` parameter takes the text as written.',
  '- Several `<invoke>` blocks may sit inside one `<tool_calls>` block to call more than',
  '  one tool at once.',
  '- A tool_calls block is the ONLY thing that executes. Everything else you write is',
  '  prose shown to the user — including fenced code blocks, which never run.',
  '- Use exactly the block above and nothing else. Any other tool-call notation your',
  '  training may suggest is not wired to anything here: it is read as prose, shown to',
  '  the user, and the tool does not run.',
  '- After emitting a block, stop and wait. Each result comes back as `OUTPUT:` in the',
  '  next turn. Never write, guess, or continue past a result you have not been given.',
].join('\n')

/**
 * Render one tool's schema as the catalog entry the model reads.
 *
 * The required list is restated above the schema because inside it, requiredness
 * is a `required` array sitting under every parameter's own prose — and JSON
 * Schema spells that prose `description`, so a tool whose parameter is *also*
 * named `description` (`bash`, `pwsh`) mentions the word six times as a keyword
 * and once as an argument. Models read past the array and omit the argument.
 */
function toolEntry(tool: ToolSchema): string {
  const required = requiredNames(tool)
  return [
    `## ${tool.name}`,
    '',
    tool.description,
    '',
    required.length > 0
      ? `Required parameters (every call must include all of these): ${required.map(name => `\`${name}\``).join(', ')}`
      : 'Required parameters: none.',
    '',
    'Parameters (JSON Schema):',
    '```json',
    JSON.stringify(tool.parameters, undefined, 2),
    '```',
  ].join('\n')
}

/**
 * Build the transport's addition to the system slot: the format, then the
 * catalog. Returns the empty string when the request carries no tools, so a
 * toolless request (a title or compaction call) is not told how to call
 * nothing.
 * @param tools - the request's tool schemas, exactly as a native provider would receive them.
 * @returns the block to append after the harness's own system prompt, or `''`.
 */
export function toolProtocolPrompt(tools: readonly ToolSchema[] | undefined): string {
  if (tools === undefined || tools.length === 0) return ''
  const catalog = tools.map(tool => toolEntry(tool)).join('\n\n')
  return `${FORMAT}\n\n# Tools available to you\n\n${catalog}`
}

/** Escape the five XML metacharacters for a value written into DSML. */
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** Reverse {@link escapeXml}. `&amp;` unescapes last so `&amp;lt;` survives as `&lt;`. */
export function unescapeXml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
}

/** The JSON Schema `type` declared for one parameter, when the tool declares one. */
function parameterType(tool: ToolSchema | undefined, name: string): string | undefined {
  const properties = (tool?.parameters as { properties?: unknown } | undefined)?.properties
  if (typeof properties !== 'object' || properties === null) return undefined
  const property: unknown = (properties as Record<string, unknown>)[name]
  if (typeof property !== 'object' || property === null) return undefined
  const type: unknown = (property as { type?: unknown }).type
  if (typeof type === 'string') return type
  // A union (`type: ['string', 'null']`) is decided by its first concrete member.
  if (Array.isArray(type)) return type.find((entry): entry is string => typeof entry === 'string')
  return undefined
}

/** The tool's declared parameter names, in schema order. */
export function parameterNames(tool: ToolSchema | undefined): string[] {
  const properties = (tool?.parameters as { properties?: unknown } | undefined)?.properties
  if (typeof properties !== 'object' || properties === null) return []
  return Object.keys(properties)
}

/**
 * The tool's required parameter names, in the order the schema lists them.
 * @param tool - the schema of the tool being called, when it is known.
 * @returns the required names, or `[]` when the tool declares none.
 */
export function requiredNames(tool: ToolSchema | undefined): string[] {
  const required = (tool?.parameters as { required?: unknown } | undefined)?.required
  if (!Array.isArray(required)) return []
  return required.filter((name): name is string => typeof name === 'string')
}

/**
 * Convert one raw `<parameter>` body to the JSON value its schema calls for.
 *
 * A declared type is obeyed: a `string` parameter stays the exact text even
 * when it happens to look like JSON, which is what keeps a Python cell that
 * begins `{` from being parsed into an object. Only an undeclared parameter is
 * guessed at, and a guess that fails falls back to the text.
 * @param tool - the schema of the tool being called, when it is known.
 * @param name - the parameter name.
 * @param raw - the unescaped text between the parameter tags.
 * @returns the value to place in the arguments object.
 */
export function coerceParameter(tool: ToolSchema | undefined, name: string, raw: string): unknown {
  const type = parameterType(tool, name)
  if (type === 'string') return raw
  const trimmed = raw.trim()
  if (type === 'number' || type === 'integer') {
    const parsed = Number(trimmed)
    return Number.isFinite(parsed) ? parsed : raw
  }
  if (type === 'boolean') {
    if (/^true$/i.test(trimmed)) return true
    if (/^false$/i.test(trimmed)) return false
    return raw
  }
  if (type === 'object' || type === 'array') {
    try {
      return JSON.parse(trimmed)
    } catch {
      // A malformed JSON argument is still the model's intent; the tool's own
      // schema validation reports it far better than a transport guess would.
      return raw
    }
  }
  // Undeclared: JSON only when the text is unambiguously JSON-shaped.
  if (/^[[{]/.test(trimmed) || /^(true|false|null|-?\d+(\.\d+)?)$/.test(trimmed)) {
    try {
      return JSON.parse(trimmed)
    } catch {
      return raw
    }
  }
  return raw
}

/**
 * Render an argument value back into a `<parameter>` body.
 * @param value - one argument value from a prior tool call.
 * @returns the text to place between the parameter tags.
 */
export function renderParameter(value: unknown): string {
  // A value parsed out of a JSON arguments string is always serializable, so
  // `JSON.stringify` cannot return undefined here.
  if (typeof value === 'string') return value
  return JSON.stringify(value)
}
