/**
 * Streaming reader for the tool-call format {@link toolProtocolPrompt} writes.
 *
 * One rule, and it is the same rule in both directions: a `<tool_calls>` block
 * is a tool call, and everything else is prose. There is no second action
 * channel — no backtick convention, no bare-Python heuristic, no per-tool
 * special case. The previous translator had all three, and a model given three
 * plausible ways to act picks the one that does nothing roughly a third of the
 * time.
 *
 * Whatever tool the block names is the tool that gets called. The translator
 * holds the request's own schemas, so it can type each parameter and can tell
 * a real tool from a hallucinated one; an unknown name stays visible as text
 * rather than being silently dropped or coerced into some other tool.
 *
 * @module @deepseek-ai/dsh-llm-kiln/dsml
 */

import type { ToolSchema } from '@deepseek-ai/dsh-llm'
import { coerceParameter, parameterNames, requiredNames, unescapeXml } from './protocol.ts'

/** What the translator emits for one complete provider turn. */
export type DsmlEvent =
  /** Visible prose, forwarded unchanged. */
  | { readonly kind: 'text'; readonly text: string }
  /** One complete tool call: the tool's registered name and JSON arguments. */
  | { readonly kind: 'tool-call'; readonly name: string; readonly arguments: string }

/**
 * One tag's attribute run: everything between the tag name and the closing `>`.
 *
 * The alternation lets a quoted value contain `>` while keeping the three
 * branches disjoint on their first character, so the match stays linear — a
 * naive `(?:"[^"]*"|[^>])*` is ambiguous on a quote and backtracks
 * exponentially on a tag the model never closed.
 */
const ATTRIBUTE_RUN = '(?:"[^"]*"|\'[^\']*\'|[^>"\'])*'

/** Matches one `<invoke …>…</invoke>`, capturing the attribute run and the body. */
const INVOKE = new RegExp(`<invoke\\s+(${ATTRIBUTE_RUN})>([\\s\\S]*?)</invoke>`, 'gi')

/** Matches one `<parameter …>…</parameter>`, capturing the attribute run and the body. */
const PARAMETER = new RegExp(`<parameter\\s+(${ATTRIBUTE_RUN})>([\\s\\S]*?)</parameter>`, 'gi')

/** Matches one `key="value"`, `key='value'`, or bare `key=value` attribute. */
const ATTRIBUTE = /([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g

/** Opening and closing tags of the format {@link toolProtocolPrompt} teaches. */
const TOOL_CALLS_OPEN = '<tool_calls>'
const TOOL_CALLS_CLOSE = '</tool_calls>'

/**
 * A run of the vertical-line character DeepSeek wraps its own special tokens in
 * — the fullwidth U+FF5C the web session shows as `｜`, or an ASCII `|`. The
 * model's trained tool-call head emits these; our taught format never does, so
 * a tag built out of them is an unambiguous native call, not prose.
 */
const PIPES = '[|\\uFF5C]'

/**
 * DeepSeek's native tool-call opener, e.g. `<｜｜DSML｜｜ name="run_code">`.
 *
 * The captured group is the attribute run after `DSML`, read exactly like an
 * `<invoke>` tag's — the tool goes in `name`, and anything else is a candidate
 * argument. The opener carries no `/`, which is what keeps {@link DSML_CLOSE}
 * from matching it.
 */
const DSML_OPEN = new RegExp(`<${PIPES}+\\s*DSML${PIPES}*((?:"[^"]*"|'[^']*'|[^>"'])*)>`, 'gi')

/**
 * The matching end token: `</｜｜DSML｜｜>` or `<｜｜DSML｜｜/>`. A real pipe is
 * required on the DSML-adjacent side, which is what keeps this from swallowing
 * the pipeless bare `</DSML>` that {@link DSML_WRAP} is meant to strip.
 */
const DSML_CLOSE = new RegExp(`<${PIPES}*/${PIPES}*DSML${PIPES}+>|<${PIPES}+DSML${PIPES}*/${PIPES}*>`, 'gi')

/**
 * A bare `<DSML>` wrapper with no pipes and no attributes — the other way the
 * provider brackets a call, around an inner `<toolname …/>` rather than carrying
 * the tool on the tag itself. The inner tag is the actual call, so the wrapper
 * carries no information and is stripped. Disjoint from {@link DSML_OPEN}, which
 * requires the pipe run, so the two forms never collide.
 */
const DSML_WRAP = /<\/?DSML\s*\/?>/gi

/** Escape a tool name for embedding in a `RegExp`. Names are identifiers, but a stray metachar must never widen the match. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Parse a tag's attribute run into its key/value pairs.
 *
 * Matching the whole run rather than `name=` alone is what keeps ONE
 * unmodelled attribute from voiding a whole tool call. The previous pattern
 * required `name` to be the tag's only attribute, so `<invoke name="bash"
 * description="List files">` matched nothing and the entire call degraded to
 * prose, and `<parameter name="description" type="string">` dropped that one
 * argument while its siblings parsed — a call that reaches the harness missing
 * exactly one required property.
 * @param run - the text between the tag name and its closing bracket.
 * @returns the attributes, first occurrence winning.
 */
function attributes(run: string): Map<string, string> {
  const found = new Map<string, string>()
  for (const match of run.matchAll(ATTRIBUTE)) {
    const key = match[1] ?? ''
    if (key.length === 0 || found.has(key)) continue
    found.set(key, match[2] ?? match[3] ?? match[4] ?? '')
  }
  return found
}

/**
 * Build the arguments JSON for one invoke.
 *
 * Three shapes are read, in falling order of explicitness, because all three
 * are real DeepSeek web output and only the first is the taught one:
 *
 * 1. `<parameter>` elements — the format {@link toolProtocolPrompt} states.
 * 2. Attributes on the `<invoke>` tag itself, accepted only for names the
 *    schema declares. A model looking at a tool whose own parameter is called
 *    `description` writes `<invoke name="bash" description="…">` often enough
 *    that discarding it is a worse reading than honouring it, and restricting
 *    the harvest to declared names keeps it from inventing arguments.
 * 3. A bare body with no `<parameter>` wrapper, which fills the single
 *    parameter still unaccounted for — preferring the required ones, since an
 *    unlabelled value is far likelier to be the argument the tool cannot run
 *    without than an optional knob.
 * @param tool - the named tool's schema, when the request declared one.
 * @param body - the raw text between the invoke tags.
 * @param tagged - attributes written on the `<invoke>` tag.
 * @returns the JSON arguments string for the harness tool call.
 */
export function invokeArguments(
  tool: ToolSchema | undefined,
  body: string,
  tagged: ReadonlyMap<string, string> = new Map(),
): string {
  const args: Record<string, unknown> = {}
  let labelled = false
  for (const match of body.matchAll(PARAMETER)) {
    const name = attributes(match[1] ?? '').get('name')?.trim() ?? ''
    if (name.length === 0) continue
    labelled = true
    args[name] = coerceParameter(tool, name, unescapeXml(match[2] ?? ''))
  }
  const declared = new Set(parameterNames(tool))
  for (const [key, value] of tagged) {
    // `name` is the tag's own tool-name slot, never an argument. A tool that
    // really takes a parameter called `name` still receives it the explicit
    // way, where there is nothing to disambiguate.
    if (key === 'name' || !declared.has(key) || key in args) continue
    args[key] = coerceParameter(tool, key, unescapeXml(value))
  }
  if (!labelled) {
    const missing = requiredNames(tool).filter(name => !(name in args))
    const candidates = missing.length > 0 ? missing : parameterNames(tool).filter(name => !(name in args))
    const only = candidates.length === 1 ? candidates[0] : undefined
    const raw = unescapeXml(body).trim()
    if (only !== undefined && raw.length > 0) {
      args[only] = coerceParameter(tool, only, raw)
    }
  }
  return JSON.stringify(args)
}

/** One open block being buffered: the lines seen so far and the tag that ends it. */
interface OpenBlock {
  readonly lines: string[]
  readonly closer: string
}

/**
 * The earliest tool-call opener in a line, with the tag that will close it.
 *
 * Two openers are recognised: the taught `<tool_calls>` wrapper, closed by
 * `</tool_calls>`, and a bare `<invoke>` with no wrapper, closed by `</invoke>`.
 * The earliest wins, so a well-formed `<tool_calls><invoke>…` opens as one
 * `<tool_calls>` block — its inner `</invoke>` stays buffered until the wrapper
 * closes — while an unwrapped `<invoke>` opens on its own. The opener tag is
 * kept in the block so {@link DsmlTranslator} can parse it whole.
 * @param rest - the unconsumed remainder of one line.
 * @returns the opener position and its closing tag, or undefined for prose.
 */
function firstOpener(rest: string): { readonly index: number; readonly closer: string } | undefined {
  const wrapped = rest.indexOf(TOOL_CALLS_OPEN)
  const bare = rest.search(/<invoke\b/i)
  const candidates: { index: number; closer: string }[] = []
  if (wrapped !== -1) candidates.push({ index: wrapped, closer: TOOL_CALLS_CLOSE })
  if (bare !== -1) candidates.push({ index: bare, closer: '</invoke>' })
  if (candidates.length === 0) return undefined
  return candidates.reduce((best, candidate) => candidate.index < best.index ? candidate : best)
}

/**
 * Line-oriented incremental reader. A tool-call block may be split across any
 * number of stream chunks, so it is held until its closing tag arrives and then
 * parsed as one complete document.
 *
 * Two envelopes reach {@link closeBlock} in the same shape. The taught one is
 * `<tool_calls>…</tool_calls>`. The other is a bare `<invoke>…</invoke>` with no
 * wrapper, which the model writes constantly and which {@link normalizeNative}
 * also rewrites the provider's own dialects into: DeepSeek's `<｜｜DSML｜｜>`
 * special-token block and its habit of naming a tool as its own tag,
 * `<run_code>…</run_code>`. Every one of those is a call the model meant to
 * make; recognising them is the difference between the tool running and the
 * block reaching the user as prose.
 */
export class DsmlTranslator {
  private partial = ''
  private block: OpenBlock | undefined
  private readonly tools: ReadonlyMap<string, ToolSchema>
  /** `<toolname …>` for every KNOWN tool, or undefined when none look like tags. */
  private readonly namedOpen: RegExp | undefined
  /** The matching `</toolname>` for the same set. */
  private readonly namedClose: RegExp | undefined

  /**
   * @param tools - the request's tool schemas, keyed by name; an empty map makes
   * every invoke unknown, which is the correct reading of a request that
   * declared no tools.
   */
  constructor(tools: ReadonlyMap<string, ToolSchema> = new Map()) {
    this.tools = tools
    // Only recognise a tool named as its own tag when the name is an
    // identifier, so the pattern can never widen into arbitrary markup, and
    // only for tools this request actually declared, so prose about some other
    // `<tag>` is never mistaken for a call.
    const names = [...tools.keys()].filter(name => /^[A-Za-z_][\w.-]*$/.test(name)).map(escapeRegExp)
    if (names.length > 0) {
      const alt = names.join('|')
      // A lookahead pins a boundary after the name — `<run_code>` matches,
      // `<run_codex>` does not — without consuming the delimiter.
      this.namedOpen = new RegExp(`<(${alt})(?=[\\s/>])((?:"[^"]*"|'[^']*'|[^>"'])*)>`, 'gi')
      this.namedClose = new RegExp(`</(${alt})\\s*>`, 'gi')
    }
  }

  /** Consume one chunk of provider text. */
  push(chunk: string): DsmlEvent[] {
    this.partial += chunk.replace(/\r\n?/g, '\n')
    const events: DsmlEvent[] = []
    let newline = this.partial.indexOf('\n')
    while (newline !== -1) {
      this.consumeLine(this.partial.slice(0, newline), events)
      this.partial = this.partial.slice(newline + 1)
      newline = this.partial.indexOf('\n')
    }
    return events
  }

  /**
   * Flush the trailing partial line and any block the model never closed.
   *
   * An unterminated block is emitted as TEXT, not as a call: the harness would
   * have to invent the missing closing tag to read it as one, and inventing
   * the end of a truncated tool call is how a half-written command gets run.
   */
  end(): DsmlEvent[] {
    const events: DsmlEvent[] = []
    if (this.partial.length > 0) {
      this.consumeLine(this.partial, events)
      this.partial = ''
    }
    const open = this.block
    if (open !== undefined) {
      this.block = undefined
      events.push({ kind: 'text', text: `${open.lines.join('\n')}\n` })
    }
    return events
  }

  /**
   * Rewrite a provider's native tool-call dialects into the bare `<invoke>` the
   * scanner already understands. Runs per complete line, which is safe because
   * every token it touches lives on one line; the arguments between an opener
   * and its closer are separate lines the block machinery already buffers.
   *
   * Each rewrite is gated on the tool being one this request declared, so a
   * `<｜｜DSML｜｜>` or `<toolname>` that names nothing real is left exactly as
   * written and still surfaces to the user as text.
   */
  private normalizeNative(line: string): string {
    let out = line
    // DeepSeek's special-token envelope. The captured run already holds
    // `name="…"` and any other attributes, correctly quoted, so re-emitting it
    // on an `<invoke>` keeps every one of them.
    out = out.replace(DSML_OPEN, (whole, run: string) => {
      const name = attributes(run).get('name')?.trim() ?? ''
      return name.length > 0 && this.tools.has(name) ? `<invoke${run}>` : whole
    })
    out = out.replace(DSML_CLOSE, '</invoke>')
    // A bare `<DSML>`/`</DSML>` wrapper carries nothing; the inner tool tag
    // below is the call. Dropping it keeps the wrapper from surfacing as prose
    // around a call that did run.
    out = out.replace(DSML_WRAP, '')
    if (this.namedOpen !== undefined && this.namedClose !== undefined) {
      out = out.replace(this.namedOpen, (whole, name: string, run: string) => {
        if (!this.tools.has(name)) return whole
        // `<read_file path="x" />` self-closes: the whole call is on this line,
        // so it gets its own `</invoke>` immediately.
        const selfClosed = /\/\s*$/.test(run)
        const attrs = selfClosed ? run.replace(/\/\s*$/, '') : run
        const open = `<invoke name="${name}"${attrs}>`
        return selfClosed ? `${open}</invoke>` : open
      })
      out = out.replace(this.namedClose, '</invoke>')
    }
    return out
  }

  /**
   * Split one complete line into prose and block fragments.
   *
   * Scanning for the tags anywhere in the line, rather than requiring the line
   * to START with one, closes a silent-failure hole: a model that writes
   * `Sure. <tool_calls>` puts the whole call one character out of reach of a
   * starts-with test, and the block then passes through as visible text — a
   * tool call that reads to the user as if it ran and to the model as if it
   * returned nothing. Everything before the opening tag and after the closing
   * one is prose, exactly as written.
   */
  private consumeLine(rawLine: string, events: DsmlEvent[]): void {
    let rest = this.normalizeNative(rawLine)
    let split = false
    while (rest.length > 0) {
      const block = this.block
      if (block === undefined) {
        const opener = firstOpener(rest)
        if (opener === undefined) break
        if (opener.index > 0) events.push({ kind: 'text', text: rest.slice(0, opener.index) })
        this.block = { lines: [], closer: opener.closer }
        rest = rest.slice(opener.index)
        split = true
        continue
      }
      const close = rest.indexOf(block.closer)
      if (close === -1) {
        block.lines.push(rest)
        return
      }
      const end = close + block.closer.length
      block.lines.push(rest.slice(0, end))
      this.closeBlock(events)
      rest = rest.slice(end)
      split = true
    }
    if (this.block !== undefined) {
      // An open block swallowed the whole line, including an empty one.
      this.block.lines.push(rest)
      return
    }
    // A line the tags never touched keeps its newline even when blank, so
    // paragraph breaks in prose survive. A remainder AFTER a block on the same
    // line is only worth emitting when it carries something.
    if (!split || rest.length > 0) events.push({ kind: 'text', text: `${rest}\n` })
  }

  /** Parse a complete block into calls, or pass it through when it names nothing real. */
  private closeBlock(events: DsmlEvent[]): void {
    const block = this.block
    this.block = undefined
    if (block === undefined) return
    const raw = block.lines.join('\n')
    const produced: DsmlEvent[] = []
    let named = false
    for (const match of raw.matchAll(INVOKE)) {
      const tagged = attributes(match[1] ?? '')
      const name = (tagged.get('name') ?? '').trim()
      if (name.length === 0) continue
      named = true
      const tool = this.tools.get(name)
      if (tool === undefined) continue
      produced.push({ kind: 'tool-call', name, arguments: invokeArguments(tool, match[2] ?? '', tagged) })
    }
    // Nothing callable came out: show the block. A model that named a tool it
    // does not have needs to SEE that it did — the next turn's transcript is
    // the only correction channel this transport has, and a dropped block
    // reads to the model as a call that ran and returned nothing.
    if (produced.length === 0) {
      // The two ways to reach here are different mistakes and a single note
      // for both sends the model looking in the wrong place: a real tool
      // written in a malformed tag is not a tool that does not exist.
      const note = named
        ? '\n[no such tool — see the tool list in your instructions]\n'
        : raw.toLowerCase().includes('<invoke')
          ? '\n[malformed tool call — an <invoke> tag here carries no readable name="..."; nothing ran]\n'
          : ''
      events.push({ kind: 'text', text: `${raw}\n${note}` })
      return
    }
    events.push(...produced)
  }
}
