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

/**
 * One `<invoke …>` opener on its own — self-closing (`<invoke …/>`) or an
 * attribute-only tag whose closer is an OUTER wrapper, not its own `</invoke>`.
 *
 * {@link DsmlTranslator.parseCalls} uses this to recover the shape DeepSeek's
 * `｜｜DSML｜｜` tool_calls wrapper produces: the arguments ride the `<invoke>` tag
 * and the wrapper's close is the only close, so there is no `</invoke>` for the
 * bodied {@link INVOKE} to match.
 */
const INVOKE_OPEN = new RegExp(`<invoke\\s+(${ATTRIBUTE_RUN})/?>`, 'gi')

/** Matches one `key="value"`, `key='value'`, or bare `key=value` attribute. */
const ATTRIBUTE = /([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g

/** Opening and closing tags of the format {@link toolProtocolPrompt} teaches. */
const TOOL_CALLS_OPEN = '<tool_calls>'
const TOOL_CALLS_CLOSE = '</tool_calls>'

/**
 * A taught envelope CLOSER — `</tool_calls>`, `</invoke>` or `</parameter>` —
 * reaching the prose path with no open block to close. It is structure, not
 * content: the model paired a native opener (which
 * {@link DsmlTranslator.normalizeNative} strips) with a taught closer, or split
 * one call across the two dialects. Left in place it surfaces as a stray tag
 * around a call that already ran; stripped, only when no block is open to
 * consume it as a real closer, it never reaches the user.
 *
 * `parameter` belongs here for the same reason the other two do, and it became
 * reachable the moment {@link DsmlTranslator.nativeToken} started rewriting
 * `</｜｜DSML｜｜parameter>` into the taught closer. A model that writes one
 * closer too many — or closes its last parameter after the invoke it belonged
 * to — used to leak the raw pipe token and now leaks a clean-looking
 * `</parameter>`; neither is the model's answer, so neither is shown.
 */
const ORPHAN_CLOSE = /<\/(?:tool_calls|invoke|parameter)\s*>/gi

/**
 * A run of the vertical-line character DeepSeek wraps its own special tokens in
 * — the fullwidth U+FF5C the web session shows as `｜`, or an ASCII `|`. The
 * model's trained tool-call head emits these; our taught format never does, so
 * a tag built out of them is an unambiguous native call, not prose.
 */
const PIPES = '[|\\uFF5C]'

/**
 * DeepSeek's `system_reminder` framing, echoed back into visible output.
 *
 * The free-web model recites the system prompt it was handed, wrapped in a
 * `system_reminder` token — plain `<system_reminder>`, or pipe-wrapped like its
 * other native tokens (`<｜system_reminder｜>`), underscore or hyphen. That span
 * is system→model framing, never the model's answer, so the reader suppresses
 * the whole thing: the opener, the recited prompt inside (tool-protocol examples
 * and all), and the closer. Matching either an opener or a closer here; a `/` in
 * the matched token marks the closer.
 */
const SYSTEM_REMINDER_TAG = new RegExp(`<${PIPES}*/?${PIPES}*\\s*system[_-]?reminder\\s*${PIPES}*/?${PIPES}*>`, 'gi')

/**
 * ONE native DSML token, whatever it turns out to wrap.
 *
 * There is a single matcher rather than one per shape because the model does
 * not emit a fixed set of tokens — it emits a FAMILY. The pipe run comes from
 * its trained tool head; the word inside comes from whatever vocabulary is in
 * context, which is to say from the format {@link toolProtocolPrompt} teaches.
 * A live session produced `calls`, `invoke`, `parameter` and the tool's own
 * name, each with and without a space after the pipes, and each of those was a
 * separate silent failure back when each spelling needed its own pattern.
 *
 * So the token is parsed, not spelled out: `<`, an optional `/` anywhere in the
 * leading pipe run, `DSML`, a pipe run, then the payload. The captures are that
 * slash and the payload; {@link DsmlTranslator.nativeToken} reads the payload's
 * first word to decide what the token meant. Spacing stops being load-bearing,
 * and a spelling nobody has seen yet lands on the same branch as its siblings.
 *
 * The payload uses {@link ATTRIBUTE_RUN} rather than `[^>]*` so a quoted
 * attribute value may itself contain `>`.
 */
const DSML_TOKEN = new RegExp(`<${PIPES}*(/?)${PIPES}*\\s*DSML${PIPES}*\\s*(${ATTRIBUTE_RUN})>`, 'gi')

/**
 * The payload's leading word, and whatever follows it, when that word is a
 * KEYWORD rather than the first attribute's name.
 *
 * The trailing `(=?)` is the whole discriminator: `<｜｜DSML｜｜ name="run_code">`
 * opens with the word `name`, but it is an attribute — it is followed by `=` —
 * whereas `<｜｜DSML｜｜ parameter name="code">` opens with a keyword that is not.
 * Capturing the `=` and testing it afterwards, rather than a lookahead inside
 * the word, keeps the word match from backtracking to a shorter prefix that
 * happens to satisfy the lookahead (`name=` would otherwise match as `nam`).
 */
const DSML_KEYWORD = /^([A-Za-z_▁][\w▁.-]*)\s*(=?)/

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

/** The index of the LAST place `pattern` matches in `text`, or -1. */
function lastMatchIndex(text: string, pattern: RegExp): number {
  let at = -1
  for (const match of text.matchAll(pattern)) at = match.index ?? at
  return at
}

/**
 * Recover a tool call the model left at the TAIL of its reasoning channel.
 *
 * The taught reader only scans visible CONTENT, so a `<tool_calls>` block the
 * model writes inside its `<think>` stream — which the free-web model does when
 * its context is thick with tool-call examples — is never seen as a call, and
 * the turn ends having run nothing. This recovers exactly that shape and nothing
 * looser: a COMPLETE `<tool_calls>`/`<invoke>` block for a DECLARED tool sitting
 * at the very end of the reasoning, with only whitespace after it. A block in
 * the middle of a longer thought (the model quoting an example) is not at the
 * tail and is refused; a truncated block parses to nothing and is refused.
 *
 * @param reasoning - the full reasoning-block text.
 * @param tools - the request's declared tool schemas.
 * @returns the recovered call(s), or undefined when the tail is not a whole call.
 */
export function trailingReasoningCalls(
  reasoning: string,
  tools: ReadonlyMap<string, ToolSchema>,
): readonly { readonly name: string; readonly arguments: string }[] | undefined {
  // Anchor on the taught wrapper if the tail has one, so a multi-invoke block is
  // taken whole; otherwise on a bare invoke. An earlier quoted example sits
  // before this anchor and is excluded from the candidate.
  const wrapper = lastMatchIndex(reasoning, /<tool_calls>/gi)
  const at = wrapper >= 0 ? wrapper : lastMatchIndex(reasoning, /<invoke\b/gi)
  if (at < 0) return undefined
  const candidate = reasoning.slice(at)
  const translator = new DsmlTranslator(tools)
  const events = [...translator.push(candidate.endsWith('\n') ? candidate : `${candidate}\n`), ...translator.end()]
  const calls: { name: string; arguments: string }[] = []
  let trailing = ''
  for (const event of events) {
    if (event.kind === 'tool-call') calls.push({ name: event.name, arguments: event.arguments })
    else trailing += event.text
  }
  // The tail must be JUST the call: real prose after it means this was a mention
  // mid-thought, not the model's closing action.
  if (calls.length === 0 || trailing.trim().length > 0) return undefined
  return calls
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
    // A body still carrying a pipe token is a native tag no rewrite above
    // placed, not an argument. Taking it anyway is how `kernel` ended up
    // executing `<｜｜DSML｜｜parameter name="code">import os…` as Python and
    // failing on U+FF5C — a call that RUNS and is wrong, which costs a turn and
    // teaches the model nothing. Refusing here leaves the block visible as
    // text, which is the same answer this reader gives every other tag it
    // cannot place, and keeps the next unseen spelling from poisoning a call.
    if (only !== undefined && raw.length > 0 && !raw.includes('｜')) {
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
  /** True while inside an echoed `<system_reminder>` span whose text is dropped. */
  private suppressing = false
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
   * A wrapper left open is recovered only as far as it is whole: a COMPLETE
   * `<invoke>…</invoke>` inside a `<tool_calls>` whose closing tag never arrived
   * — dropped, or written as a native token {@link normalizeNative} stripped —
   * is the call the model meant, and it dispatches. A TRUNCATED block, where the
   * `<invoke>` itself has no closing tag, matches nothing and is emitted as
   * TEXT: inventing the end of a half-written command is how that command
   * wrongly runs. The distinction is exactly "is the call itself finished",
   * which is what `parseCalls` finding an invoke answers.
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
      const raw = open.lines.join('\n')
      const { produced } = this.parseCalls(raw)
      if (produced.length > 0) events.push(...produced)
      else events.push({ kind: 'text', text: `${raw}\n` })
    }
    return events
  }

  /**
   * Decide what ONE native `<｜｜DSML｜｜…>` token meant, and rewrite it into the
   * taught tag that says the same thing.
   *
   * The token's payload is read as an optional keyword followed by an attribute
   * run. That keyword is the whole decision, and it comes from one of three
   * places, all of which a live session produced:
   *
   *   * the model's OWN frame vocabulary — `_calls`, `▁call`, `_sep`;
   *   * a word from the taught format it fused into the token — `tool_calls`,
   *     `invoke`, `parameter`, which is the dialect the two formats blend into;
   *   * the tool's own name, `<｜｜DSML｜｜kernel>`.
   *
   * A token with no keyword at all is the plain envelope, carrying the tool in
   * `name=` exactly as an `<invoke>` tag would.
   *
   * Anything this cannot place is returned VERBATIM, which keeps the rule that
   * a tag naming nothing real stays visible to the user rather than being
   * silently dropped or coerced into some other tool.
   *
   * @param whole - the token as written, returned unchanged when unrecognised.
   * @param closing - true when the token carried a `/` in its leading pipe run.
   * @param payload - everything between the pipe run and the closing `>`.
   */
  private nativeToken(whole: string, closing: boolean, payload: string): string {
    // A trailing `/` self-closes, exactly as it does on an ordinary tag.
    const trimmed = payload.trim()
    const selfClosed = trimmed.endsWith('/')
    const body = (selfClosed ? trimmed.slice(0, -1) : trimmed).trim()
    const found = DSML_KEYWORD.exec(body)
    const keyword = found !== null && found[2] !== '=' ? (found[1] ?? '') : ''
    const rest = body.slice(keyword.length).trim()
    // `_calls` and `▁calls` are the same word wearing the model's own token
    // separators; strip them so one comparison covers every spelling.
    const word = keyword.replace(/^[_▁]+/, '').toLowerCase()

    // The per-call separator frames nothing the reader needs and has no taught
    // equivalent, so it is simply removed.
    if (word.startsWith('sep')) return ''
    // The taught `tool_calls` word worn inside the token is REWRITTEN, not
    // stripped: the invoke inside is frequently self-closing with this wrapper
    // as its only closer, so the block needs a real closer to buffer against.
    // Stripping it would leave that invoke unbounded, swallowing the stream.
    if (/^tool[_▁]?calls?/.test(word)) return closing ? TOOL_CALLS_CLOSE : TOOL_CALLS_OPEN
    // The model's own frame, which always pairs with its own closer, so there
    // is nothing for an inner tag to bind to and stripping is safe. Removing it
    // rather than rewriting also keeps an EMPTY frame pair from surfacing as a
    // visible `<tool_calls></tool_calls>` around a turn that called nothing.
    if (/^calls?/.test(word)) return ''

    if (word.startsWith('invoke')) {
      if (closing || (selfClosed && rest.length === 0)) return '</invoke>'
      const name = attributes(rest).get('name')?.trim() ?? ''
      if (name.length === 0 || !this.tools.has(name)) return whole
      return selfClosed ? `<invoke ${rest}></invoke>` : `<invoke ${rest}>`
    }

    // `parameter` inside the token is the shape that made a call run on
    // GARBAGE rather than not run at all: the opener stayed unrewritten, so
    // `invokeArguments` saw no `<parameter>` element, fell through to its
    // unlabelled-body path, and handed the tool the tag text as its argument.
    if (word.startsWith('param')) {
      if (closing) return '</parameter>'
      return attributes(rest).has('name') ? `<parameter ${rest}>` : whole
    }

    // The tool named as the keyword itself. Checked after the reserved words so
    // a tool called `invoke` or `calls` could never shadow the structure.
    if (keyword.length > 0 && this.tools.has(keyword)) {
      if (closing) return '</invoke>'
      const open = `<invoke name="${keyword}"${rest.length > 0 ? ` ${rest}` : ''}>`
      return selfClosed ? `${open}</invoke>` : open
    }

    // No keyword: the plain envelope. `<｜｜DSML｜｜ name="run_code">` opens it and
    // both `</｜｜DSML｜｜>` and `<｜｜DSML｜｜/>` close it.
    if (keyword.length === 0) {
      if (closing || selfClosed) return '</invoke>'
      const name = attributes(body).get('name')?.trim() ?? ''
      if (name.length > 0 && this.tools.has(name)) return `<invoke ${body}>`
    }
    return whole
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
    // Every pipe-wrapped token, whatever it wraps, in one pass.
    out = out.replace(DSML_TOKEN, (whole, slash: string, payload: string) => this.nativeToken(whole, slash === '/', payload))
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
  /**
   * Remove any `<system_reminder>` span from one line, tracking an open span
   * across lines. Text before an opener and after a closer survives; everything
   * inside — and a line-leading opener that never closes, which suppresses to
   * the end of the turn — is dropped. Runs BEFORE tool-call scanning so a recited
   * `<tool_calls>` example inside the framing never reaches {@link firstOpener}.
   *
   * Only a LINE-LEADING opener starts a span. Reciting the prompt writes the tag
   * as a block delimiter; merely naming it writes the tag inside a sentence, and
   * that mention is prose the reader must keep.
   */
  private stripSuppressed(line: string): string {
    SYSTEM_REMINDER_TAG.lastIndex = 0
    let out = ''
    let idx = 0
    let match: RegExpExecArray | null
    while ((match = SYSTEM_REMINDER_TAG.exec(line)) !== null) {
      const isClose = match[0].includes('/')
      if (this.suppressing) {
        // Inside the span: drop text up to here; only a closer ends it, and a
        // nested opener is left suppressed.
        if (isClose) {
          this.suppressing = false
          idx = SYSTEM_REMINDER_TAG.lastIndex
        }
      } else if (isClose) {
        // A closer with no open span is a leftover token: drop it, keep the text.
        out += line.slice(idx, match.index)
        idx = SYSTEM_REMINDER_TAG.lastIndex
      } else if (line.slice(0, match.index).trim().length === 0) {
        // A block opener: keep the text before it, then suppress until the
        // closer.
        out += line.slice(idx, match.index)
        this.suppressing = true
        idx = SYSTEM_REMINDER_TAG.lastIndex
      } else {
        // The same tag inline in a sentence is the model DISCUSSING the framing
        // rather than reciting its prompt, so the tag stays visible. Suppressing
        // here deletes the rest of the answer with no trace on either side: a
        // model writing that the tag above is the proof lost the whole
        // remainder of its own message.
        out += line.slice(idx, SYSTEM_REMINDER_TAG.lastIndex)
        idx = SYSTEM_REMINDER_TAG.lastIndex
      }
    }
    if (!this.suppressing) out += line.slice(idx)
    return out
  }

  private consumeLine(rawLine: string, events: DsmlEvent[]): void {
    const visible = this.stripSuppressed(rawLine)
    // A line wholly inside a suppressed span yields no visible text; emit
    // nothing rather than a blank line. A genuinely blank prose line (empty
    // input) still falls through below, so paragraph breaks in real prose live.
    if (visible.length === 0 && rawLine.length > 0) return
    let rest = this.normalizeNative(visible)
    let split = false
    while (rest.length > 0) {
      const block = this.block
      if (block === undefined) {
        const opener = firstOpener(rest)
        if (opener === undefined) break
        if (opener.index > 0) events.push({ kind: 'text', text: rest.slice(0, opener.index).replace(ORPHAN_CLOSE, '') })
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
    // line is only worth emitting when it carries something. A stray taught
    // closer here belongs to no open block, so it is structure to drop, not text.
    if (!split || rest.length > 0) events.push({ kind: 'text', text: `${rest.replace(ORPHAN_CLOSE, '')}\n` })
  }

  /**
   * Parse a complete block's raw text into the calls it names.
   *
   * One routine serves both a properly closed block and a wrapper the model
   * left open at end of stream: each hands over raw text whose complete
   * `<invoke>…</invoke>` elements are the calls. A `<invoke>` with no closing
   * tag matches nothing here, so a truncated call contributes no dispatch — the
   * caller decides whether the leftover text is shown.
   *
   * Two flags let the caller say something TRUE about why nothing ran, because
   * the three ways to get here are three different mistakes and one note for
   * all of them sends the model looking in the wrong place. `named` records
   * whether any invoke carried a readable `name=`; `unknown` records whether
   * one of those names is a tool this request never declared. A real tool that
   * merely came out unfinished is neither nameless nor unknown, and telling the
   * model it does not exist is how a correct spelling gets "fixed" into a loop.
   */
  private parseCalls(raw: string): { readonly produced: DsmlEvent[]; readonly named: boolean; readonly unknown: boolean } {
    const calls: { readonly index: number; readonly event: DsmlEvent }[] = []
    let named = false
    let unknown = false
    // Bodied `<invoke>…</invoke>` first, remembering each span so the
    // self-closing pass below never reads an opener that already dispatched.
    const consumed: (readonly [number, number])[] = []
    for (const match of raw.matchAll(INVOKE)) {
      const start = match.index ?? 0
      consumed.push([start, start + match[0].length])
      const tagged = attributes(match[1] ?? '')
      const name = (tagged.get('name') ?? '').trim()
      if (name.length === 0) continue
      named = true
      const tool = this.tools.get(name)
      if (tool === undefined) {
        unknown = true
        continue
      }
      calls.push({ index: start, event: { kind: 'tool-call', name, arguments: invokeArguments(tool, match[2] ?? '', tagged) } })
    }
    // Invokes with no `</invoke>` of their own, closed by an outer wrapper
    // instead (the `｜｜DSML｜｜` tool_calls shape, and the very common slip of
    // writing `</tool_calls>` while forgetting `</invoke>`). The rule is still
    // that a call dispatches only when it is WHOLE — what changes here is how
    // "whole" is measured:
    //   * a body whose LAST `<parameter>` never closed is a command cut off
    //     mid-write, and its end must never be invented; but
    //   * a body whose parameters all closed is FINISHED. Only the `</invoke>`
    //     is missing, and that tag carries no information the arguments need.
    //     Refusing it was the expensive failure: a complete, correct call
    //     parsed to nothing, dumped its whole block as prose — visible stray
    //     `</parameter>` tags and all — and drew a note saying the tool did not
    //     exist, so the model "corrected" a spelling that was never wrong and
    //     wrote the identical block again.
    //   * an opener with NO parameters and no declared attribute for a tool
    //     that requires one is an unfinished call — a bare `<invoke
    //     name="kernel">` about to grow a body — not an empty request to run.
    for (const match of raw.matchAll(INVOKE_OPEN)) {
      const start = match.index ?? 0
      if (consumed.some(([from, to]) => start >= from && start < to)) continue
      const tagged = attributes(match[1] ?? '')
      const name = (tagged.get('name') ?? '').trim()
      if (name.length === 0) continue
      named = true
      const tool = this.tools.get(name)
      if (tool === undefined) {
        unknown = true
        continue
      }
      const after = raw.slice(start + match[0].length)
      const nextInvoke = after.search(/<invoke\b/i)
      const region = nextInvoke === -1 ? after : after.slice(0, nextInvoke)
      const openers = (region.match(/<parameter\b/gi) ?? []).length
      if (openers > 0) {
        // Counting rather than matching pairs is enough: `<parameter>` never
        // nests, so equal counts mean every opener found its closer.
        if (openers !== (region.match(/<\/parameter\s*>/gi) ?? []).length) continue
        calls.push({ index: start, event: { kind: 'tool-call', name, arguments: invokeArguments(tool, region, tagged) } })
        continue
      }
      const declared = new Set(parameterNames(tool))
      const hasArg = [...tagged].some(([key]) => key !== 'name' && declared.has(key))
      if (!hasArg && requiredNames(tool).length > 0) continue
      calls.push({ index: start, event: { kind: 'tool-call', name, arguments: invokeArguments(tool, '', tagged) } })
    }
    calls.sort((left, right) => left.index - right.index)
    return { produced: calls.map(entry => entry.event), named, unknown }
  }

  /** Parse a complete block into calls, or pass it through when it names nothing real. */
  private closeBlock(events: DsmlEvent[]): void {
    const block = this.block
    this.block = undefined
    if (block === undefined) return
    const raw = block.lines.join('\n')
    const { produced, named, unknown } = this.parseCalls(raw)
    // Nothing callable came out: show the block. A model that named a tool it
    // does not have needs to SEE that it did — the next turn's transcript is
    // the only correction channel this transport has, and a dropped block
    // reads to the model as a call that ran and returned nothing.
    if (produced.length === 0) {
      // Three different mistakes, three different notes. A real tool left
      // unfinished is not a tool that does not exist, and is not a tag with no
      // name; told the wrong one, the model rewrites the part that was already
      // right and arrives back here with the same block.
      const note = unknown
        ? '\n[no such tool — see the tool list in your instructions]\n'
        : named
          ? '\n[unfinished tool call — the tool exists, but this block never completed one; nothing ran]\n'
          : raw.toLowerCase().includes('<invoke')
            ? '\n[malformed tool call — an <invoke> tag here carries no readable name="..."; nothing ran]\n'
            : ''
      events.push({ kind: 'text', text: `${raw}\n${note}` })
      return
    }
    events.push(...produced)
  }
}
