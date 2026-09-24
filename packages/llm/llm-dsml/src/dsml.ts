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
 * The reader is provider-neutral on purpose. A model that learned this markup
 * writes it wherever it is allowed to write — including through a provider
 * whose native tool field the harness filled in correctly — so the text channel
 * of EVERY route is read, while only a route with no native channel is told the
 * format ({@link toolProtocolPrompt}). What separates the two is
 * {@link DsmlOptions.notes}: a transport that taught the format may correct the
 * model that misspelled it, and a transport that taught nothing says nothing.
 *
 * @module @deepseek-ai/dsh-llm-dsml/dsml
 */

import type { ToolSchema } from '@deepseek-ai/dsh-llm'
import { coerceParameter, parameterNames, requiredNames, unescapeXml } from './protocol.ts'

/** What the translator emits for one complete provider turn. */
export type DsmlEvent =
  /** Visible prose, forwarded unchanged. */
  | { readonly kind: 'text'; readonly text: string }
  /** One complete tool call: the tool's registered name and JSON arguments. */
  | { readonly kind: 'tool-call'; readonly name: string; readonly arguments: string }

/** How one reader treats output it could not turn into a call. */
export interface DsmlOptions {
  /**
   * Whether the reader may append its own correction notes — the bracketed
   * `[no such tool …]` lines and the {@link FORMAT_REMINDER} — to visible text.
   *
   * On (the default) for a transport that TAUGHT this format: there, a block
   * that named nothing real is a mistake in the one channel the model was given,
   * and the next turn's transcript is the only place to say so.
   *
   * Off for a transport that taught nothing. A provider with a native tool
   * channel received the schemas in its own `tools` field; DSML in its text is
   * read as a courtesy, and a note correcting the model's spelling of a format
   * nobody asked it for would be the harness inventing a protocol dispute. With
   * notes off the reader is silent: it converts what it can and passes every
   * other character through exactly as written, which also makes it safe to run
   * over a stream some adapter already read.
   */
  readonly notes?: boolean
}

/**
 * One tag's attribute run: everything between the tag name and the closing `>`.
 *
 * The alternation lets a quoted value contain `>` while keeping the three
 * branches disjoint on their first character, so the match stays linear — a
 * naive `(?:"[^"]*"|[^>])*` is ambiguous on a quote and backtracks
 * exponentially on a tag the model never closed.
 *
 * The trailing optional quote is for a run holding an ODD number of them, which
 * is what a FUSED tag writes: `parameter name="invoke name="kernel"`. Every
 * branch above needs its quotes paired, so one left over leaves the run unable
 * to reach the `>` — and a tag that matches NOTHING is not degraded, it is
 * invisible. That was the worst of the reported leaks: the block reached the
 * user verbatim, no call ran, and no note said why, because every rule that
 * could have explained it is keyed on a tag this one never became. Greedy
 * pairing puts the odd quote out at the end, so allowing exactly one there
 * covers any number of them, and one optional character is not a second way to
 * read a quote — the run stays linear.
 */
const ATTRIBUTE_RUN = '(?:"[^"]*"|\'[^\']*\'|[^>"\'])*["\']?'

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
 * The same wrapper under the other name the training data gives it.
 *
 * `<function_calls>` wraps the identical `<invoke>`/`<parameter>` body; only
 * the frame word differs. A model carries the word it learned into whatever
 * transport it is speaking, and the word is not the part that says what to run,
 * so it is read as the wrapper it is. Everything inside is parsed by the one
 * set of rules below — there is no second dialect here, only a second spelling
 * of the envelope.
 */
const FUNCTION_CALLS_OPEN = '<function_calls>'
const FUNCTION_CALLS_CLOSE = '</function_calls>'

/** Either envelope word, with the model's own token separators allowed inside. */
const CALLS_WORD = /^(?:tool|function)[_▁]?calls?/

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
const ORPHAN_CLOSE = /<\/(?:tool_calls|function_calls|invoke|parameter)\s*>/gi

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

/**
 * A taught tag opener that begins INSIDE the previous attribute's quoted value.
 *
 * `<｜｜DSML｜｜ parameter name="invoke name="kernel">` is ONE token carrying two
 * tags: the model opened its native `parameter` token, then wrote the tag it
 * actually meant inside that token's own `name=` value. The inner tag is the
 * call and the outer one is a false start, so everything before the inner
 * opener is discarded.
 *
 * Both halves of the pattern are load-bearing. The quote before the keyword is
 * what distinguishes a fusion from an ordinary second attribute, so
 * `<｜｜DSML｜｜kernel parameter name="code">` keeps its outer reading. The
 * `name=` after it is what keeps a parameter LEGITIMATELY called `invoke` —
 * `<｜｜DSML｜｜ parameter name="invoke">` — from being read as one.
 */
const FUSED_OPENER = /["'](?:(?:tool|function)[_▁]?calls?|invoke|parameter)\s+name\s*=/gi

/**
 * A taught tag written with `=` where its `name` attribute belongs:
 * `<parameter=code>`, `<invoke=kernel>`, either one self-closing.
 *
 * A near-miss of a format is not the same failure as a different format. This
 * tag names the right thing in the wrong punctuation, so reading it costs
 * nothing and refusing it costs the turn — and refusing it cost more than the
 * turn, because `invokeArguments` then saw no `<parameter>` element, fell
 * through to its unlabelled-body path, and handed `kernel` the string
 * `<parameter=code>print(1)</parameter>` to run as Python.
 *
 * Only the two taught tag words are read this way. An unrelated `<foo=bar>` is
 * prose and stays prose, and a dialect that names tools some third way is still
 * the prose the format statement says it is. Every repaired tag also books a
 * {@link FORMAT_REMINDER}, so accepting the spelling does not teach it.
 */
const EQUALS_TAG = /<(invoke|parameter)\s*=\s*["']?([\w.:-]+)["']?\s*(\/?)>/gi

/** A `<parameter>` opener carrying no name at all: `<parameter>` or `<parameter=>`. */
const NAMELESS_PARAMETER = /<parameter\s*=?\s*>/i

/**
 * A `<parameter …>` element opening a LINE, which is how a call arrives with its
 * `<invoke>` missing altogether — the model wrote the argument and dropped
 * everything around it, wrapper included.
 *
 * Line-leading is the same test {@link DsmlTranslator.stripSuppressed} uses on
 * the framing tag, for the same reason: writing a tag as a block delimiter is
 * structure, writing it inside a sentence is a mention, and a mention is prose
 * the reader must keep. The tool comes from the parameter's own name and only
 * when exactly one declared tool could own it — see
 * {@link DsmlTranslator.toolForParameter} — so the recited format statement,
 * whose example names `PARAMETER_NAME`, resolves to nothing and runs nothing.
 */
const LEADING_PARAMETER = new RegExp(`^\\s*<parameter\\s+(?:${ATTRIBUTE_RUN})>`, 'i')

/**
 * The model's own frame word with the pipes worn off: `<calls>`, `</calls>`.
 *
 * `<｜｜DSML｜｜ calls>` is already stripped as the native frame it is, and this is
 * the same token arriving bare — the pipes dropped somewhere between the model's
 * head and the wire. It frames nothing the reader needs and has no taught
 * equivalent, so it is removed rather than rewritten.
 *
 * The leading `[_▁]*` matches the model's own separators without ever reaching
 * the taught `<tool_calls>`: that tag begins `<t`, and this pattern's first
 * character after the optional slash and separators must be a `c`.
 */
const BARE_FRAME = /<\/?[_▁]*calls?\s*\/?>/gi

/**
 * Tool-call markup of the model's own: an invoke or wrapper tag either way up,
 * or a native token left unresolved because it named nothing real.
 *
 * {@link DsmlTranslator.impliedInvoke} refuses to infer a tool once a turn has
 * written any of these, and the unresolved token is the whole reason the test
 * exists. `<｜｜DSML｜｜ name="rm_rf">` opens no block — the tool does not exist, so
 * the token stays verbatim — and the `<parameter name="path">` under it then
 * looks exactly like an orphaned argument. Inferring there does not recover a
 * lost call, it redirects one: the model asked for a tool it was never given and
 * would have had a DIFFERENT tool run on its argument.
 */
const MARKUP = new RegExp(`</?(?:invoke|tool_calls|function_calls)\\b|<${PIPES}`, 'i')

/**
 * The nameless opener above, and the closer that ends it.
 *
 * {@link invokeArguments} peels both off an unlabelled body. Every `</parameter>`
 * is fair game there: a closer that belonged to a NAMED opener would have made
 * that body labelled, so anything still standing is this wrapper's or an orphan.
 */
const NAMELESS_PARAMETER_PAIR = /<parameter\s*=?\s*>|<\/parameter\s*>/gi

/**
 * Markup an unlabelled body must never carry into an argument: a native pipe
 * token no rewrite placed, or a `<parameter>`/`<invoke>` tag still standing.
 *
 * Tested BEFORE `unescapeXml`, so an escaped `&lt;parameter&gt;` in a genuine
 * value is data and stays. What this refuses is a call that would RUN and be
 * wrong, which costs a turn and teaches the model nothing; left visible as
 * text, the block is the same answer this reader gives every other tag it
 * cannot place. The pipe is matched fullwidth only — an ASCII `|` is an
 * operator in every language these tools run.
 */
const UNPLACEABLE = /｜|<parameter\b|<invoke\b/i

/**
 * What the reader says once per block it had to REPAIR.
 *
 * A repaired call runs, so this is not an error report; it is the one thing the
 * model can act on, sent through the only correction channel this transport has
 * — the next turn's transcript. It states the shape that works and never the
 * spelling that was accepted, for the same reason the format statement names no
 * wrong format: a note that named it would teach the model the reader takes it.
 */
const FORMAT_REMINDER = '\n[format reminder — one argument per `<parameter name="NAME">value</parameter>` inside'
  + ' `<invoke name="TOOL">`, as your instructions show. The block above was repaired to run; write it that way.]\n'

/** One `<parameter …` opener, however it is spelled from there on. */
const PARAMETER_OPEN = /<parameter\b/i

/**
 * Whether a body's `<parameter>` openers and closers fail to pair up.
 *
 * Counting rather than matching pairs is enough: `<parameter>` never nests, so
 * equal counts mean every opener found its closer. One unpaired opener is
 * exactly what "cut off mid-write" looks like, and it is what both dispatch
 * passes measure before they call anything.
 * @param body - the text between one invoke's tags, or up to the next invoke.
 * @returns true when the body is a call still being written.
 */
function unbalanced(body: string): boolean {
  return (body.match(/<parameter\b/gi) ?? []).length !== (body.match(/<\/parameter\s*>/gi) ?? []).length
}

/** Escape a tool name for embedding in a `RegExp`. Names are identifiers, but a stray metachar must never widen the match. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** The index of the LAST place `pattern` matches in `text`, or -1. */
function lastMatchIndex(text: string, pattern: RegExp): number {
  let at = -1
  for (const match of text.matchAll(pattern)) at = match.index
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
 * @param options - reader options; only the recovered calls are returned either
 * way, so this decides nothing visible and exists so one caller can hold one
 * policy for both channels.
 * @returns the recovered call(s), or undefined when the tail is not a whole call.
 */
export function trailingReasoningCalls(
  reasoning: string,
  tools: ReadonlyMap<string, ToolSchema>,
  options: DsmlOptions = {},
): readonly { readonly name: string; readonly arguments: string }[] | undefined {
  // Anchor on the taught wrapper if the tail has one, so a multi-invoke block is
  // taken whole; otherwise on a bare invoke. An earlier quoted example sits
  // before this anchor and is excluded from the candidate.
  const wrapper = lastMatchIndex(reasoning, /<(?:tool|function)_calls>/gi)
  const at = wrapper >= 0 ? wrapper : lastMatchIndex(reasoning, /<invoke\b/gi)
  if (at < 0) return undefined
  const candidate = reasoning.slice(at)
  const translator = new DsmlTranslator(tools, options)
  const events = [...translator.push(candidate.endsWith('\n') ? candidate : `${candidate}\n`), ...translator.end()]
  const calls: { name: string; arguments: string }[] = []
  let trailing = ''
  for (const event of events) {
    if (event.kind === 'tool-call') calls.push({ name: event.name, arguments: event.arguments })
    // A reminder is the READER's text, not the model's, so it cannot be the
    // prose that disqualifies this tail. Counting it would make a repaired call
    // in the reasoning channel unrecoverable — the one case where the repair
    // and the recovery are both needed to get the turn to act at all.
    else if (event.text !== FORMAT_REMINDER) trailing += event.text
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
 * Read an unlabelled invoke body as the arguments OBJECT it is, or refuse it.
 *
 * `<invoke name="search_files">{ "query": "database connection" }</invoke>` is
 * one of the shapes a model that learned a native tool-call API writes: the
 * envelope came from this format and the arguments came from that one. Read by
 * the single-slot rule below it becomes a string — the tool receives the
 * literal text `{ "query": … }` as its query — which runs, returns nothing
 * useful, and looks to the model like the tool disagreeing with it.
 *
 * The refusal is where the care goes, because a body that merely BEGINS with
 * `{` is far more often a value than an arguments object: a Python dict, a JSON
 * document being written to a file, a code cell. So an object is taken only
 * when every one of its keys is a parameter this tool declares, and only when
 * it declares at least one. `{"a": 1}` handed to a tool with no parameter `a`
 * is a value and falls through to the rule that treats it as one.
 * @param tool - the named tool's schema, when the request declared one.
 * @param body - the invoke body with any nameless `<parameter>` wrapper peeled.
 * @param declared - the tool's declared parameter names.
 * @returns the arguments object, or undefined when the body is not one.
 */
function jsonBodyArguments(
  tool: ToolSchema | undefined,
  body: string,
  declared: ReadonlySet<string>,
): Record<string, unknown> | undefined {
  if (declared.size === 0) return undefined
  const trimmed = unescapeXml(body).trim()
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    // Not JSON at all: the body is text, and the single-slot rule reads it as
    // the value it is. Inventing a repair for half-written JSON here would run
    // a call on arguments the model never finished writing.
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  const entries = Object.entries(parsed as Record<string, unknown>)
  if (entries.length === 0 || entries.some(([key]) => !declared.has(key))) return undefined
  // The values arrive already typed by JSON. A string one still goes through
  // the schema so a parameter the tool declares as `object` but the model sent
  // as a quoted JSON string lands the same way it would from a `<parameter>`.
  return Object.fromEntries(entries.map(([key, value]) =>
    [key, typeof value === 'string' ? coerceParameter(tool, key, value) : value]))
}

/**
 * Build the arguments JSON for one invoke.
 *
 * Four shapes are read, in falling order of explicitness, because all four are
 * real model output and only the first is the taught one:
 *
 * 1. `<parameter>` elements — the format {@link toolProtocolPrompt} states.
 * 2. Attributes on the `<invoke>` tag itself, accepted only for names the
 *    schema declares. A model looking at a tool whose own parameter is called
 *    `description` writes `<invoke name="bash" description="…">` often enough
 *    that discarding it is a worse reading than honouring it, and restricting
 *    the harvest to declared names keeps it from inventing arguments.
 * 3. A JSON object as the whole body, which is how a model that learned a
 *    native tool-call API writes the arguments it would have put in that API's
 *    `arguments` field — see {@link jsonBodyArguments}.
 * 4. A bare body with no `<parameter>` wrapper, which fills the single
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
    // A `<parameter>` with no name has no slot to go in BY NAME, but its value is
    // still the argument the model wrote, so the wrapper is peeled and the value
    // placed by the single-slot rule below. Left in place it became part of the
    // value: `kernel` ran the tag text itself as Python.
    const peeled = body.replace(NAMELESS_PARAMETER_PAIR, '')
    const json = jsonBodyArguments(tool, peeled, declared)
    if (json !== undefined) {
      for (const [key, value] of Object.entries(json)) {
        if (!(key in args)) args[key] = value
      }
      return JSON.stringify(args)
    }
    const raw = unescapeXml(peeled).trim()
    // A body still carrying a pipe token or a whole tag is markup no rewrite
    // above placed, not an argument — see UNPLACEABLE. Taking it anyway is how
    // `kernel` ended up executing `<｜｜DSML｜｜parameter name="code">import os…`
    // as Python and failing on U+FF5C.
    if (only !== undefined && raw.length > 0 && !UNPLACEABLE.test(peeled)) {
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
 * Three openers are recognised: the taught `<tool_calls>` wrapper, closed by
 * `</tool_calls>`; the same envelope spelled `<function_calls>`, closed by its
 * own word; and a bare `<invoke>` with no wrapper, closed by `</invoke>`.
 * The earliest wins, so a well-formed `<tool_calls><invoke>…` opens as one
 * `<tool_calls>` block — its inner `</invoke>` stays buffered until the wrapper
 * closes — while an unwrapped `<invoke>` opens on its own. The opener tag is
 * kept in the block so {@link DsmlTranslator} can parse it whole.
 * @param rest - the unconsumed remainder of one line.
 * @returns the opener position and its closing tag, or undefined for prose.
 */
function firstOpener(rest: string): { readonly index: number; readonly closer: string } | undefined {
  const wrapped = rest.indexOf(TOOL_CALLS_OPEN)
  const functional = rest.indexOf(FUNCTION_CALLS_OPEN)
  const bare = rest.search(/<invoke\b/i)
  const candidates: { index: number; closer: string }[] = []
  if (wrapped !== -1) candidates.push({ index: wrapped, closer: TOOL_CALLS_CLOSE })
  if (functional !== -1) candidates.push({ index: functional, closer: FUNCTION_CALLS_CLOSE })
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
  /** True once a repair happened whose {@link FORMAT_REMINDER} is still owed. */
  private repaired = false
  /** True once this turn wrote tool-call markup of its own — see {@link MARKUP}. */
  private sawMarkup = false
  private readonly tools: ReadonlyMap<string, ToolSchema>
  /** `<toolname …>` for every KNOWN tool, or undefined when none look like tags. */
  private readonly namedOpen: RegExp | undefined
  /** The matching `</toolname>` for the same set. */
  private readonly namedClose: RegExp | undefined
  /** Whether this reader may write its own notes into the visible text. */
  private readonly notes: boolean
  /** True once the line being accumulated has already had text released — see {@link releasePartial}. */
  private emitted = false

  /**
   * @param tools - the request's tool schemas, keyed by name; an empty map makes
   * every invoke unknown, which is the correct reading of a request that
   * declared no tools.
   * @param options - reader options; see {@link DsmlOptions}.
   */
  constructor(tools: ReadonlyMap<string, ToolSchema> = new Map(), options: DsmlOptions = {}) {
    this.tools = tools
    this.notes = options.notes ?? true
    // Only recognise a tool named as its own tag when the name is an
    // identifier, so the pattern can never widen into arbitrary markup, and
    // only for tools this request actually declared, so prose about some other
    // `<tag>` is never mistaken for a call.
    const names = [...tools.keys()].filter(name => /^[A-Za-z_][\w.-]*$/.test(name)).map(escapeRegExp)
    if (names.length > 0) {
      const alt = names.join('|')
      // A lookahead pins a boundary after the name — `<run_code>` matches,
      // `<run_codex>` does not — without consuming the delimiter.
      this.namedOpen = new RegExp(`<(${alt})(?=[\\s/>])(${ATTRIBUTE_RUN})>`, 'gi')
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
      this.emitted = false
      newline = this.partial.indexOf('\n')
    }
    this.releasePartial(events)
    return events
  }

  /**
   * Release the part of an unfinished line that cannot be markup.
   *
   * The reader decides per LINE, because every tag it knows lives on one, so a
   * held partial line is text the user has not been shown yet. Holding all of it
   * would make every route stream a paragraph at a time — correct, and visibly
   * worse than the token-by-token stream a native provider gives today.
   *
   * A partial with no `<` in it cannot become any tag this reader reads, so it
   * is released immediately and the line continues to accumulate from there. The
   * moment a `<` appears, the rest of the line is held again, because from there
   * on it might be a call.
   *
   * What the release costs is the notion of "line-leading", which two rules
   * depend on: {@link impliedInvoke} and the block-opener test in
   * {@link stripSuppressed}. {@link emitted} records that this line already put
   * text out, and both rules treat a line like that as what it is — a tag inside
   * a sentence, which is a mention rather than a block.
   */
  private releasePartial(events: DsmlEvent[]): void {
    if (this.block !== undefined || this.suppressing) return
    if (this.partial.length === 0 || this.partial.includes('<')) return
    // Whitespace alone is held: it is as likely to be the indentation in front
    // of a tag, which the block consumes, as it is to be text. Releasing it
    // would leave that indentation visible above a call that ran.
    if (this.partial.trim().length === 0) return
    events.push({ kind: 'text', text: this.partial })
    this.partial = ''
    this.emitted = true
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
    // A repair nothing closed a block over — a tag mended in prose, or a block
    // the model never terminated — still owes its reminder.
    events.push(...this.reminder())
    return events
  }

  /**
   * The {@link FORMAT_REMINDER} this turn owes, and clear the debt.
   *
   * At most one reminder per block, and none at all for a turn that wrote the
   * taught shape: a note repeated after every call is read as decoration, and
   * this transport has no channel to spend on decoration.
   */
  private reminder(): DsmlEvent[] {
    if (!this.repaired) return []
    this.repaired = false
    // The debt is cleared either way: a silent reader still repaired the block,
    // it just has no standing to correct a format it never stated.
    return this.notes ? [{ kind: 'text', text: FORMAT_REMINDER }] : []
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
    // Two tags fused into one token — see FUSED_OPENER. The inner opener is the
    // tag the model meant, so the false start ahead of it is dropped and the
    // rest of this routine reads the one tag that remains.
    const fused = lastMatchIndex(payload, FUSED_OPENER)
    const one = fused < 0 ? payload : payload.slice(fused + 1)
    if (fused >= 0) this.repaired = true
    // A trailing `/` self-closes, exactly as it does on an ordinary tag.
    const trimmed = one.trim()
    const selfClosed = trimmed.endsWith('/')
    const body = (selfClosed ? trimmed.slice(0, -1) : trimmed).trim()
    const found = DSML_KEYWORD.exec(body)
    const keyword = found !== null && found[2] !== '=' ? (found[1] ?? '') : ''
    const rest = body.slice(keyword.length).trim()
    // `_calls` and `▁calls` are the same word wearing the model's own token
    // separators; strip them so one comparison covers every spelling.
    const word = keyword.replace(/^[_▁]+/, '').toLowerCase()

    // A parameter tag that lost its `name="` on the wire, which cost more live
    // calls than every other native shape put together. The model writes
    // `<｜｜DSML｜｜parameter name="timeoutMs" string="false">` and what arrives is
    // `<｜｜DSML｜｜ timeoutMs" string="false">` — often with a `/` in the pipe run
    // as well, though no closer carries attributes, so the slash is part of the
    // same damage and is ignored rather than read.
    //
    // The tell is the ODD QUOTE, and it cannot be forged: an attribute run opens
    // every value before it closes one, so a leading word followed straight by a
    // CLOSING quote is a `name="` that went missing and nothing else. A
    // well-formed token never reaches here with one — `parameter name="code"`
    // leaves `rest` starting at `name=`. That is also why this is tested ahead of
    // the keyword branches instead of after them: read as a keyword, a parameter
    // called `parameters` would match the `param` branch and close a tag the
    // model was opening.
    //
    // Unplaced, this token did double damage: it reached the user verbatim AND
    // took the call with it, because the `</parameter>` after it then had no
    // opener and `unbalanced()` read the whole invoke as cut off mid-write.
    if (keyword.length > 0 && (rest.startsWith('"') || rest.startsWith("'"))) {
      this.repaired = true
      return `<parameter name="${keyword}"${rest.slice(1)}>`
    }

    // The per-call separator frames nothing the reader needs and has no taught
    // equivalent, so it is simply removed.
    if (word.startsWith('sep')) return ''
    // An envelope word — `tool_calls`, or `function_calls` from the other
    // dialect — worn inside the token is REWRITTEN, not stripped: the invoke
    // inside is frequently self-closing with this wrapper as its only closer,
    // so the block needs a real closer to buffer against. Stripping it would
    // leave that invoke unbounded, swallowing the stream. Both words rewrite to
    // the one taught wrapper, so an opener and closer that disagree about which
    // word they used still pair.
    if (CALLS_WORD.test(word)) return closing ? TOOL_CALLS_CLOSE : TOOL_CALLS_OPEN
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
      // An envelope carrying NOTHING — no keyword, no attributes — names no tool
      // and frames nothing, so it goes the way every other information-free
      // frame token does. Returning it verbatim was not a conservative choice
      // here: one live turn emitted 4074 of these back to back after a refused
      // call, and every one reached the user as a literal `<｜｜DSML｜｜>`.
      if (body.length === 0) return ''
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
    // The taught tags written with `=` instead of ` name=` — see EQUALS_TAG.
    out = out.replace(EQUALS_TAG, (_whole, tag: string, name: string, slash: string) => {
      this.repaired = true
      const word = tag.toLowerCase()
      const open = `<${word} name="${name}">`
      return slash === '/' ? `${open}</${word}>` : open
    })
    // A `<parameter>` that names nothing is left standing — only
    // `invokeArguments` knows which slot is still open, and it peels the wrapper
    // there — but it is a repair either way, so the reminder is booked here with
    // the rest of them.
    if (NAMELESS_PARAMETER.test(out)) this.repaired = true
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
    // The model's own frame word arriving with no pipes on it — see BARE_FRAME.
    out = out.replace(BARE_FRAME, '')
    // Read BEFORE the implied opener below, so the opener this reader writes
    // itself is never the markup that blocks the next one.
    const first = !this.sawMarkup
    if (MARKUP.test(out)) this.sawMarkup = true
    return first ? this.impliedInvoke(out) : out
  }

  /**
   * Put the `<invoke>` back in front of an argument that arrived without one.
   *
   * A line-leading `<parameter name="code">…` with no block open is a whole call
   * the model wrote the inside of and nothing else: no wrapper, no invoke, no
   * tool named anywhere. It reaches the user as markup and reads back to the
   * model as a call that returned nothing, which is the most expensive failure
   * this transport has — the turn is spent and neither side knows why.
   *
   * The tool is inferred from the argument's own name, and only when one tool can
   * own it, so this is a reading rather than a guess. The invoke is synthesized
   * rather than the call dispatched here so that everything downstream — the
   * block machinery, the parameter typing, the `whole call only` rule — applies
   * unchanged, including a second `<parameter>` on the next line.
   * @param line - the normalized line.
   * @returns the line, with an `<invoke>` opener prepended when one is implied.
   */
  private impliedInvoke(line: string): string {
    // Text already went out for this line, so this tag opens no line: it sits
    // after prose, which makes it a mention. See {@link releasePartial}.
    if (this.block !== undefined || this.emitted) return line
    const bare = LEADING_PARAMETER.exec(line)
    if (bare === null) return line
    // An argument standing on its own is malformed whether or not its tool can
    // be inferred, so the reminder is owed either way. The alternative is the
    // failure this whole pass exists to end: markup reaching the user with not
    // one word about why nothing ran.
    this.repaired = true
    const argument = attributes(bare[0]).get('name')?.trim() ?? ''
    const tool = argument.length === 0 ? undefined : this.toolForParameter(argument)
    if (tool === undefined) return line
    return `<invoke name="${tool}">${line}`
  }

  /**
   * The one tool a parameter of this name can only belong to.
   *
   * Two tools declaring the same parameter makes the inference a coin flip, and a
   * coin flip that RUNS something is not a reading — `code` is `kernel`'s
   * argument on one roster and two tools' argument on the next, so the answer has
   * to come from the roster the request actually composed.
   * @param name - the parameter name read off a bare `<parameter>` tag.
   * @returns the sole declaring tool's name, or undefined when it is not sole.
   */
  private toolForParameter(name: string): string | undefined {
    let found: string | undefined
    for (const tool of this.tools.values()) {
      if (!parameterNames(tool).includes(name)) continue
      if (found !== undefined) return undefined
      found = tool.name
    }
    return found
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
      } else if (!this.emitted && line.slice(0, match.index).trim().length === 0) {
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
      const start = match.index
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
      // A closed `</invoke>` does not make the call inside it whole: a body
      // whose last `<parameter>` never closed is a command cut off mid-write,
      // and the model's next line was `</invoke>`, not the end of that command.
      // Dispatching it ran the tag text as the argument until the check below
      // existed, and refusing the argument alone only turned that into a call
      // with NO argument — a tool invoked for nothing either way. This is the
      // same measurement the wrapper-closed pass makes; see its note.
      const body = match[2] ?? ''
      if (unbalanced(body)) continue
      calls.push({ index: start, event: { kind: 'tool-call', name, arguments: invokeArguments(tool, body, tagged) } })
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
      const start = match.index
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
      if (PARAMETER_OPEN.test(region)) {
        if (unbalanced(region)) continue
        calls.push({ index: start, event: { kind: 'tool-call', name, arguments: invokeArguments(tool, region, tagged) } })
        continue
      }
      const declared = new Set(parameterNames(tool))
      // A JSON arguments object is as complete a body as `<parameter>` elements
      // are, so an invoke the wrapper closed carries its arguments either way.
      // Only THIS shape is read out of the region — an arbitrary text body here
      // is a call still being written, and the rule below keeps refusing it.
      // The wrapper's own closer sits inside the region (nothing consumed it,
      // since this invoke has no closer of its own), so it comes off first.
      const bodied = region.replace(ORPHAN_CLOSE, '')
      if (jsonBodyArguments(tool, bodied, declared) !== undefined) {
        calls.push({ index: start, event: { kind: 'tool-call', name, arguments: invokeArguments(tool, bodied, tagged) } })
        continue
      }
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
      events.push({ kind: 'text', text: `${raw}\n${this.blockNote(raw, named, unknown)}` }, ...this.reminder())
      return
    }
    events.push(...produced, ...this.reminder())
  }

  /**
   * What to tell the model about a block that ran nothing.
   *
   * Three different mistakes, three different notes. A real tool left
   * unfinished is not a tool that does not exist, and is not a tag with no
   * name; told the wrong one, the model rewrites the part that was already
   * right and arrives back here with the same block. A reader that taught this
   * format says one of them; a reader that taught nothing says nothing — see
   * {@link DsmlOptions.notes}.
   * @param raw - the block exactly as the model wrote it.
   * @param named - whether any invoke in it carried a readable name.
   * @param unknown - whether one of those names is a tool this request never declared.
   * @returns the note to append after the block, or `''`.
   */
  private blockNote(raw: string, named: boolean, unknown: boolean): string {
    if (!this.notes) return ''
    if (unknown) return '\n[no such tool — see the tool list in your instructions]\n'
    if (named) return '\n[unfinished tool call — the tool exists, but this block never completed one; nothing ran]\n'
    if (raw.toLowerCase().includes('<invoke')) {
      return '\n[malformed tool call — an <invoke> tag here carries no readable name="..."; nothing ran]\n'
    }
    // No `<invoke>` at all, yet the block names a real tool: the model wrapped
    // some OTHER notation — a JSON envelope, prose — in the taught wrapper.
    // Saying so is the difference between a turn that ran nothing for a stated
    // reason and one that silently did not; silence here is what this reader
    // was reported for. A block naming no tool is the model DISCUSSING the
    // format, and gets no note.
    if (this.namesTool(raw)) {
      return '\n[malformed tool call — a tool_calls block runs only <invoke name="TOOL">…</invoke>; nothing ran]\n'
    }
    return ''
  }

  /** Whether a block that produced nothing at least NAMES a tool this request declared. */
  private namesTool(raw: string): boolean {
    for (const name of this.tools.keys()) {
      if (raw.includes(name)) return true
    }
    return false
  }
}
