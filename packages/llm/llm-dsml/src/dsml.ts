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
import {
  coerceParameter,
  coerceParameterDetailed,
  parameterNames,
  requiredNames,
  resolveParameterName,
  unescapeXml,
} from './protocol.ts'
import { learnedLiterals, literalKey } from './catalog.ts'
import { extractShape, readShape } from './shapes.ts'

/** What the translator emits for one complete provider turn. */
export type DsmlEvent =
  /** Visible prose, forwarded unchanged. */
  | { readonly kind: 'text'; readonly text: string }
  /** One complete tool call: the tool's registered name and JSON arguments. */
  | { readonly kind: 'tool-call'; readonly name: string; readonly arguments: string }

/**
 * The tool-call arm of {@link DsmlEvent}.
 *
 * A reader only ever HOLDS a call. Prose is emitted the moment it is read, so
 * the held slot and the structural reader both carry this arm rather than the
 * whole union — which is what lets the pair rule compare two calls' tool names
 * without narrowing at every use.
 */
type ToolCall = Extract<DsmlEvent, { readonly kind: 'tool-call' }>

/** How one reader treats output it could not turn into a call. */
export interface DsmlOptions {
  /**
   * Whether the reader may append its own correction notes — the bracketed
   * `[no such tool …]` lines — to visible text.
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

/**
 * Every parameter element in one invoke body, with the value each one carries.
 *
 * A value is RAW TEXT and may itself quote the format, so neither end of an
 * element can be read off the first tag that looks like structure. Two rules
 * together settle it from structure alone, and both are needed:
 *
 *   * An opener only BOUNDS an element when it sits at depth zero. A value
 *     quoting the markup contains an opener of its own, and cutting the value
 *     there dropped everything after it — a command that merely showed the
 *     format ran truncated, or failed for a required argument that was present
 *     in the text the whole time.
 *   * Within one element the terminator is the LAST closer before the next
 *     depth-zero opener, not the first. The first closer inside a value is
 *     content for the same reason, and stopping there is what silently cut a
 *     value off mid-way.
 *
 * Depth is counted over the same two tags the element is made of, so a value
 * carrying a balanced pair stays level and one carrying a lone opener simply
 * reads as content. A closer the model wrote one time too many survives the
 * capture as trailing text and is dropped by {@link stripTrailingClosers}.
 * @param body - the text between one invoke's tags.
 * @returns each element's attribute run and its value, closer excluded.
 */
function scanParameters(body: string): { readonly run: string; readonly at: number; readonly from: number }[] {
  const token = new RegExp('<' + 'parameter\\b(' + ATTRIBUTE_RUN + ')>|<' + '/parameter\\s*>', 'gi')
  const spans: { run: string; at: number; from: number }[] = []
  let depth = 0
  for (const match of body.matchAll(token)) {
    if (match[1] !== undefined) {
      if (depth === 0) spans.push({ run: match[1], at: match.index, from: match.index + match[0].length })
      depth += 1
      continue
    }
    if (depth > 0) depth -= 1
  }
  return spans
}

/**
 * Every parameter element in one invoke body, with the value each one carries.
 *
 * Two rules, and both are needed. An opener only BOUNDS an element at depth zero,
 * so a value quoting the markup keeps the opener it contains. The terminator is
 * the LAST closer before the next depth-zero opener, not the first, so a value
 * may quote a closer without being cut off at it.
 * @param body - the text between one invoke's tags.
 * @returns each element's attribute run and its value, closer excluded.
 */
function parameterElements(body: string): { readonly run: string; readonly value: string }[] {
  const spans = scanParameters(body)
  const close = new RegExp('<' + '/parameter\\s*>', 'gi')
  return spans.map((span, index) => {
    const end = index + 1 < spans.length ? (spans[index + 1]?.at ?? body.length) : body.length
    const segment = body.slice(span.from, end)
    const at = lastMatchIndex(segment, close)
    const value = at < 0 ? segment : segment.slice(0, at)
    return { run: span.run, value: stripSurplusClosers(value) }
  })
}

/**
 * Read a wrapped block that carries whole `<parameter>` elements and no
 * `<invoke>` opener at all.
 *
 * The orphan argument {@link DsmlTranslator.impliedInvoke} already reads on ONE
 * line arrives here when the model ALSO wrote the wrapper: from the moment
 * `<tool_calls>` opened, the block owns its lines and the per-line pass stands
 * down, so the arguments reach the user as markup and read back to the model as
 * a call that ran and returned nothing. Same reading, block scope — the tool
 * comes from the arguments' own names, and only when exactly one declared tool
 * owns every one of them. Two candidates is a coin flip that RUNS something,
 * and that is not a reading.
 *
 * Nothing but the arguments and the structure around them may sit in the block.
 * An argument's value is raw text that may quote the format, so the residue is
 * taken by walking the elements rather than by stripping tags: prose between
 * two arguments is a mention of the format, not a call.
 * @param raw - one block's raw text, closers already restored.
 * @param tools - the tools this request declared.
 * @returns the inferred tool and the argument region to read, or undefined.
 */
function orphanParameterCall(
  raw: string,
  tools: ReadonlyMap<string, ToolSchema>,
): { readonly name: string; readonly region: string } | undefined {
  // The invoke and envelope closers are structure here: the block-level reader
  // drops them wherever it meets them, and a stray one between two arguments
  // would otherwise be read into a value. `</parameter>` stays — it bounds each
  // argument, and the surplus-closer rule already owns the model that writes
  // one too many.
  // The wrapper is framing whichever end of it survived into the block, so
  // both spellings of both envelope tags come off here: left in, the opener
  // sits in the residue ahead of the first argument and the block is refused
  // for carrying text it never carried.
  const region = raw.replace(INVOKE_ENVELOPE_CLOSE, '').replace(ENVELOPE_TAG, '')
  // A call dispatches only when it is WHOLE, and that rule does not relax
  // because the opener went missing: an argument whose own closer never arrived
  // is a command cut off mid-write, and its end must never be invented.
  if (unfinished(region)) return undefined
  const spans = scanParameters(region)
  if (spans.length === 0) return undefined
  const names: string[] = []
  const close = new RegExp('<' + '/parameter\\s*>', 'gi')
  let residue = ''
  let cursor = 0
  for (let index = 0; index < spans.length; index += 1) {
    const span = spans[index]
    if (span === undefined) return undefined
    // Everything the walk has not claimed by the time this opener arrives sits
    // between the wrapper and the arguments, or between two of them.
    residue += region.slice(cursor, span.at)
    const next = index + 1 < spans.length ? (spans[index + 1]?.at ?? region.length) : region.length
    const segment = region.slice(span.from, next)
    // The element's own closer is the LAST one before the next opener, for the
    // same reason {@link parameterElements} reads it that way: the first closer
    // inside a value is content.
    let last: RegExpExecArray | null = null
    let match: RegExpExecArray | null
    close.lastIndex = 0
    while ((match = close.exec(segment)) !== null) last = match
    cursor = last === null ? next : span.from + last.index + last[0].length
    const name = (attributes(span.run).get('name') ?? '').trim()
    if (name.length === 0) return undefined
    names.push(name)
  }
  residue += region.slice(cursor)
  if (residue.trim().length > 0) return undefined
  // Two arguments with one name cannot be one call — no tool declares a slot
  // twice — so a block that writes one is a run of calls the model never
  // separated, and splitting it would be inventing the boundary.
  if (new Set(names).size !== names.length) return undefined
  let found: string | undefined
  for (const tool of tools.values()) {
    const declared = new Set(parameterNames(tool))
    if (!names.every(name => declared.has(name))) continue
    if (found !== undefined) return undefined
    found = tool.name
  }
  if (found === undefined) return undefined
  return { name: found, region }
}

/**
 * One structural parameter opener, spelled as the grammar allows it: the tag
 * name followed by whatever a real tag puts there -- whitespace before an
 * attribute run, the `>` that ends a bare tag, or the `/` of a self-closing
 * one.
 *
 * A word boundary is NOT that test, though it reads like one. What follows
 * the name in a genuine tag is a space or an angle bracket, while a boundary
 * accepts ANY non-word character -- including the backslash of a regex
 * source. A value that merely quotes the format therefore opened a parameter
 * the reader never saw close: the depth stayed at one, the block read as cut
 * off mid-write, and a complete call was dropped as prose.
 */
const PARAMETER_OPENER = '<' + 'parameter(?=[\\s/>=]|$)'

/**
 * Every bodied invoke element in one block, with the text between them.
 *
 * A parameter's value is RAW TEXT and may quote the format, so neither end of a
 * call can be read off the first tag that looks like one: an invoke opener or
 * closer inside a value is that value's content, exactly as a parameter opener
 * is. What separates structure from content is DEPTH, counted over the same
 * tokens the grammar is made of:
 *
 *   * an invoke opener only BOUNDS a call at parameter depth zero, and
 *   * an invoke closer only ENDS one at parameter depth zero.
 *
 * Reading the closer off the first match cut a call off at the first tag in its
 * own text. The arguments were complete in the block the whole time, and the
 * call that ran was missing everything after that tag — while the tail then
 * read as a body with an unclosed parameter, which refused the call entirely.
 * A value whose own parameter pair balances never moves the depth at all, so a
 * value that merely documents the format is untouched.
 * @param raw - one block's raw text.
 * @returns each element's attribute run and body, closer excluded.
 */
function invokeElements(raw: string): { readonly run: string; readonly body: string; readonly start: number; readonly end: number }[] {
  const token = new RegExp(
    '<invoke\\s+(' + ATTRIBUTE_RUN + ')>|</invoke\\s*>|' + PARAMETER_OPENER + '|</parameter\\s*>',
    'gi',
  )
  const close = new RegExp('</invoke\\s*>', 'gi')
  const opens: { run: string; at: number; from: number; to: number }[] = []
  let depth = 0
  let openParameters = 0
  for (const match of raw.matchAll(token)) {
    const written = match[0]
    if (written.startsWith('</parameter')) {
      if (openParameters > 0) openParameters -= 1
      continue
    }
    if (written.startsWith('<parameter')) {
      openParameters += 1
      continue
    }
    if (written.startsWith('</invoke')) {
      // A closer inside a VALUE is the value quoting the format. It ends the
      // call only once every parameter this call opened has closed again.
      if (openParameters > 0) continue
      if (depth === 0) continue
      depth -= 1
      if (depth === 0) {
        const open = opens[opens.length - 1]
        if (open !== undefined) open.to = match.index
      }
      continue
    }
    if (written.endsWith('/>')) continue
    // An opener inside a VALUE is content for the same reason.
    if (openParameters > 0) continue
    if (depth === 0) opens.push({ run: match[1] ?? '', at: match.index, from: match.index + written.length, to: -1 })
    depth += 1
  }
  const found: { run: string; body: string; start: number; end: number }[] = []
  opens.forEach((open, index) => {
    if (open.to >= 0) {
      found.push({ run: open.run, body: raw.slice(open.from, open.to), start: open.at, end: open.to })
      return
    }
    const end = index + 1 < opens.length ? (opens[index + 1]?.at ?? raw.length) : raw.length
    const at = lastMatchIndex(raw.slice(open.from, end), close)
    if (at < 0) return
    found.push({ run: open.run, body: raw.slice(open.from, open.from + at), start: open.at, end: open.from + at })
  })
  return found
}

/**
 * Drop the closers left dangling at the tail of a captured value — and only those.
 *
 * Running the value to the LAST closer before the next opener is what lets it
 * quote the format without being cut short at its own first closer. That same
 * rule sweeps up a closer the model wrote one time too many, because the capture
 * had to run past the surplus tag to reach the element's own.
 *
 * How many are surplus is COUNTED, never guessed. A closer at the tail is
 * structure only while the value holds more closers than openers, and each
 * surplus tag comes off one at a time from the very end. A blanket strip of
 * every trailing closer ate the second half of a balanced pair the value was
 * legitimately quoting, so a value that documented the format lost the tag it
 * was showing. A closer the value still balances against an opener of its own is
 * content, and one that never reaches the tail — a quoted closer inside a string
 * — is content too, because the count says surplus but the tail says no.
 * @param value - the text captured between an element's opener and its closer.
 * @returns the value with exactly its surplus trailing closers gone.
 */
function stripSurplusClosers(value: string): string {
  const openers = (value.match(new RegExp(PARAMETER_OPENER, 'gi')) ?? []).length
  const closers = [...value.matchAll(new RegExp('<' + '/parameter\\s*>', 'gi'))].length
  const tail = new RegExp('<' + '/parameter\\s*>\\s*$')
  let surplus = closers - openers
  let out = value
  while (surplus > 0) {
    const found = tail.exec(out)
    if (found === null) break
    out = out.slice(0, found.index)
    surplus -= 1
  }
  return out
}

/**
 * One `<invoke …>` opener on its own — self-closing (`<invoke …/>`) or an
 * attribute-only tag whose closer is an OUTER wrapper, not its own `</invoke>`.
 *
 * {@link DsmlTranslator.parseCalls} uses this to recover the shape DeepSeek's
 * `｜｜DSML｜｜` tool_calls wrapper produces: the arguments ride the `<invoke>` tag
 * and the wrapper's close is the only close, so there is no `</invoke>` for the
 * bodied {@link invokeElements} to match.
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
 * The closers that are structure wherever they appear: the two envelope words
 * and the invoke wrapper. `</parameter>` is deliberately absent — it is what
 * bounds an argument, so the reader that walks the arguments keeps it.
 *
 * A wrapped block whose invoke opener went missing leaves these scattered
 * between its arguments. Dropped before those arguments are read, they never
 * land inside a value; left in place, the last one in the block is read as the
 * end of the last argument and the tail becomes that argument's text.
 */
const INVOKE_ENVELOPE_CLOSE = /<\/(?:tool_calls|function_calls|invoke)\s*>/gi

/** Whether a block opened an `<invoke>` anywhere — the question that separates the wrapper-closed spelling from the wrapped-orphan one. */
const INVOKE_OPENER = new RegExp('<' + 'invoke(?=[\\s/>=]|$)', 'i')

/** The same opener as a global scan, for the walks that need every hit rather than the first. */
const INVOKE_SCAN = new RegExp('<' + 'invoke(?=[\\s/>=]|$)', 'gi')

/** Either taught envelope tag, opener or closer, in either spelling. */
const ENVELOPE_TAG = /<\/?(?:tool|function)[_▁]?calls?\s*>/gi

/**
 * Whether a block is nothing but an empty taught envelope.
 *
 * A wrapper the model opened and closed around no call carries no
 * information, so it is framing rather than content. The test strips every
 * envelope tag and asks what is left, which lets the opener and the closer
 * be spelled differently — they rewrite to one taught wrapper either way —
 * and leaves a wrapper holding anything at all, prose included, as a block
 * the reader must still show.
 * @param body - the block's raw text.
 * @returns true when only whitespace remains once the envelope is removed.
 */
function emptyEnvelope(body: string): boolean {
  return body.replace(ENVELOPE_TAG, '').trim().length === 0
}

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
 * The shape is booked so the spelling actually occurring in the wild can be counted.
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
const MARKUP = new RegExp(`</?(?:invoke|tool_calls|function_calls)(?=[\\s/>=]|$)|<${PIPES}`, 'i')

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
const UNPLACEABLE = new RegExp('｜|' + PARAMETER_OPENER + '|' + '<' + 'invoke(?=[\\s/>=]|$)', 'i')

/** One `<parameter …` opener, however it is spelled from there on. */
const PARAMETER_OPEN = new RegExp(PARAMETER_OPENER, 'i')

/**
 * How many parameter openers and closers a body holds.
 *
 * The two counts answer two different questions and must not be
 * collapsed into one boolean. {@link unfinished} asks whether an
 * opener is still waiting for its closer; the surplus-closer check
 * asks whether a FINISHED body closed one time too many. Reading
 * them against each other made a complete call carrying a stray
 * closer look truncated, so it fell through to prose and drew a note
 * telling the model its tool did not exist.
 *
 * A parameter element never nests, so counting is exact.
 * @param body - the text between one invoke's tags, or up to the next invoke.
 * @returns the opener count and the closer count, uncompared.
 */
function parameterCounts(body: string): { readonly open: number; readonly close: number; readonly surplus: number } {
  const token = new RegExp(PARAMETER_OPENER + '|<' + '/parameter\\s*>', 'gi')
  let open = 0
  let close = 0
  let depth = 0
  let surplus = 0
  for (const match of body.matchAll(token)) {
    if (match[0].startsWith('<' + '/')) {
      close += 1
      if (depth > 0) depth -= 1
      else surplus += 1
      continue
    }
    open += 1
    depth += 1
  }
  return { open, close, surplus }
}

/**
 * Whether a body holds a `<parameter>` opener that never closed.
 *
 * Only ONE direction of imbalance means "still being written", and the two
 * directions are not the same mistake. An opener with no closer is a command
 * cut off mid-write. A model that writes one `</parameter>` too many produces
 * an imbalance from the other side, and that body is FINISHED: every argument
 * in it closed, and the surplus closer is the same stray structural tag
 * {@link ORPHAN_CLOSE} drops in prose. Measuring the counts against each other
 * read both as the same thing, so a complete, correct call was refused, fell
 * through to prose, and drew a note telling the model its tool did not exist.
 *
 * `<parameter>` never nests, so counting is enough to see the one direction
 * that matters.
 * @param body - the text between one invoke's tags, or up to the next invoke.
 * @returns true when the body is a call still being written.
 */
function unfinished(body: string): boolean {
  const token = new RegExp(PARAMETER_OPENER + '|<' + '/parameter\\s*>', 'gi')
  let depth = 0
  for (const match of body.matchAll(token)) {
    if (match[0].startsWith('<' + '/')) {
      if (depth > 0) depth -= 1
      continue
    }
    depth += 1
  }
  return depth > 0
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
  const at = wrapper >= 0 ? wrapper : lastMatchIndex(reasoning, INVOKE_SCAN)
  if (at < 0) return undefined
  const candidate = reasoning.slice(at)
  const translator = new DsmlTranslator(tools, options)
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
  shapes?: Set<string>,
): string {
  const args: Record<string, unknown> = {}
  let labelled = false
  for (const element of parameterElements(body)) {
    const written = attributes(element.run).get('name')?.trim() ?? ''
    if (written.length === 0) continue
    labelled = true
    // A name the schema does not declare but one slot plainly means is placed in
    // that slot; anything ambiguous keeps the model's own spelling and is left
    // for the tool's own validation to report.
    const resolved = resolveParameterName(tool, written, Object.keys(args))
    const name = resolved ?? written
    if (resolved !== undefined && resolved !== written) shapes?.add('near-miss-argument')
    const coerced = coerceParameterDetailed(tool, name, unescapeXml(element.value))
    if (coerced.repaired) shapes?.add('quoted-scalar')
    args[name] = coerced.value
  }
  const declared = new Set(parameterNames(tool))
  for (const [key, value] of tagged) {
    // `name` is the tag's own tool-name slot, never an argument. A tool that
    // really takes a parameter called `name` still receives it the explicit
    // way, where there is nothing to disambiguate.
    if (key === 'name' || !declared.has(key) || key in args) continue
    const coerced = coerceParameterDetailed(tool, key, unescapeXml(value))
    if (coerced.repaired) shapes?.add('quoted-scalar')
    args[key] = coerced.value
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
    // A body that is ONE element named for the slot still carries that slot's
    // value: `<code>print(1)</code>` written inside an invoke that already named
    // the tool. Taken whole it became the value, and `kernel` ran the tag text
    // itself. The unwrap is limited to the element whose name IS the slot, so a
    // value that merely looks like markup keeps every character of its own text.
    const element = /^<([\w:.-]+)\b[^>]*>([\s\S]*)<\/\1\s*>$/.exec(raw)
    const inner = element !== null && element[1] === only ? (element[2] ?? '').trim() : undefined
    if (only !== undefined && inner !== undefined && inner.length > 0) {
      const coerced = coerceParameterDetailed(tool, only, inner)
      if (coerced.repaired) shapes?.add('quoted-scalar')
      args[only] = coerced.value
    } else if (only !== undefined && raw.length > 0 && !UNPLACEABLE.test(peeled)) {
      const coerced = coerceParameterDetailed(tool, only, raw)
      if (coerced.repaired) shapes?.add('quoted-scalar')
      args[only] = coerced.value
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
  const bare = rest.search(INVOKE_OPENER)
  const candidates: { index: number; closer: string }[] = []
  if (wrapped !== -1) candidates.push({ index: wrapped, closer: TOOL_CALLS_CLOSE })
  if (functional !== -1) candidates.push({ index: functional, closer: FUNCTION_CALLS_CLOSE })
  // A bare invoke is the one ambiguous opener, and it is the one an
  // explanation writes inside a sentence. Treating a mention as a delimiter
  // swallowed the rest of the answer, so it opens a block only as the
  // line's own content -- the same line-leading test this file already
  // applies to the framing tag and to a lone parameter. The taught wrappers
  // above are unambiguous and stay readable anywhere on the line.
  if (bare !== -1 && rest.slice(0, bare).trim().length === 0) {
    candidates.push({ index: bare, closer: '</invoke>' })
  }
  if (candidates.length === 0) return undefined
  return candidates.reduce((best, candidate) => candidate.index < best.index ? candidate : best)
}

/**
 * The fence marker a line opens a code block with, or undefined for a line that
 * opens none.
 *
 * A fence is the model's own signal that what follows is DISPLAYED rather than
 * done, and the statement this transport hands it says so in as many words:
 * fenced code blocks never run. Reading the signal costs one line of state;
 * ignoring it means a transcript, a diff, or a worked example inside a fence is
 * dispatched as a real call — the same failure as a call that silently does not
 * run, seen from the other side.
 *
 * Three or more backticks or tildes, at most three columns in, optionally
 * followed by an info word. A line carrying a SECOND marker is not matched, so
 * an opener and closer on one line stays prose rather than swallowing the turn.
 */
const FENCE_OPEN = /^\s{0,3}(`{3,}|~{3,})\s*[^\s`]*\s*$/

/**
 * Whether a line closes the fence a marker opened.
 *
 * The closer is nothing but the fence character, at least as long as the
 * opener — markdown's own rule, so a fence the model left open runs to the end
 * of its turn rather than being closed by the next unrelated run of backticks.
 * @param line - one line of channel text.
 * @param marker - the marker returned by {@link FENCE_OPEN}.
 * @returns true when this line ends the block.
 */
function closesFence(line: string, marker: string): boolean {
  const char = marker.charAt(0)
  const trimmed = line.trim()
  if (char.length === 0 || trimmed.length < marker.length) return false
  for (let at = 0; at < trimmed.length; at++) {
    if (trimmed.charAt(at) !== char) return false
  }
  return true
}

/**
 * The character ranges of one line that sit inside a code span.
 *
 * A run of N backticks opens a span and the next run of exactly N closes it,
 * which is the rule that keeps `` ``a`b`` `` one span rather than three. A run
 * left unclosed spans to the end of the line: markdown does the same, and a
 * quote that runs off the line is far likelier to be unfinished than to be an
 * invitation to act.
 * @param line - one line of channel text.
 * @returns each span as a half-open `[from, to)` range, in order.
 */
function codeSpans(line: string): readonly (readonly [number, number])[] {
  const spans: [number, number][] = []
  const RUN = /`+/g
  let open: RegExpExecArray | null = null
  let match: RegExpExecArray | null
  while ((match = RUN.exec(line)) !== null) {
    if (open === null) {
      open = match
      continue
    }
    if (match[0].length !== open[0].length) continue
    spans.push([open.index, RUN.lastIndex])
    open = null
  }
  if (open !== null) spans.push([open.index, line.length])
  return spans
}

/**
 * The same line with every code span blanked out.
 *
 * Blanked rather than deleted so every character index stays where it was: the
 * answer to "is there markup OUTSIDE a span" is then about the text the model
 * wrote, not about a rewritten copy of it.
 * @param line - one line of channel text.
 * @returns the line with each span replaced by spaces of the same width.
 */
function outsideSpans(line: string): string {
  const spans = codeSpans(line)
  if (spans.length === 0) return line
  let out = ''
  let at = 0
  for (const [from, to] of spans) {
    out += line.slice(at, from) + ' '.repeat(to - from)
    at = to
  }
  return out + line.slice(at)
}

/**
 * Any taught tag or native token, whoever wrote it and whatever it became.
 *
 * Deliberately wider than {@link MARKUP}: this one asks whether anything on a
 * line could be read as a call, and is only ever consulted about text with the
 * code spans already blanked out.
 */
const ANY_MARKUP = new RegExp(`<${PIPES}|</?DSML\\b|<(?:invoke|tool_calls|function_calls|parameter)\\b`, 'i')

/**
 * Any trace of the TAUGHT dialect in a piece of text.
 *
 * The structural reader exists for notations nobody wrote a rule for, so text
 * that carries this reader's own vocabulary is the wrong input for it: there
 * the spelling rules already had their say, and a block they refused was
 * refused for a reason — a parameter that never closed, an invoke cut off
 * mid-write. Reading such a block's fragments as a name plus bindings would
 * dispatch the very call the spelling rules declined, which is the one outcome
 * worse than refusing it.
 */
const TAUGHT_MARKUP = new RegExp(`<${PIPES}|</?(?:DSML|invoke|parameter)\\b`, 'i')

/**
 * How many tool-naming lines are held before the oldest is released as prose.
 *
 * A bound is what keeps a multi-line notation from turning into a buffered
 * reader: past this the run is a paragraph that mentions a tool, not a call,
 * and it is shown.
 */
const PENDING_LINES = 8

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
  /**
   * Tool-naming lines the spelling rules read nothing from, held in case they
   * are the front of a notation that runs across lines. See {@link absorbLine}.
   */
  private pending: string[] = []
  /**
   * A line already read as a call, held for ONE more line.
   *
   * A call written alone on its line and a line of a recitation look identical
   * in isolation, and a binding repeated on the next line only becomes a
   * conflict once that line has arrived. Holding the call for one line is what
   * lets the pair be read as a pair: two lines that bind one slot twice are a
   * conflict, and two lines naming different tools are a list of tools being
   * SHOWN rather than a call being made. Both are refused, and the run leaves
   * as the text it is. See {@link absorbLine}.
   */
  private held: { readonly line: string; readonly event: ToolCall } | undefined
  /**
   * True while the lines being read are a LIST of tools rather than a call.
   *
   * Two calls written back to back that name different tools are not two calls;
   * they are the tool list being quoted, and every further item belongs to the
   * same list. Set when such a pair is refused, cleared by a blank line.
   */
  private listed = false
  private block: OpenBlock | undefined
  /** True while inside an echoed `<system_reminder>` span whose text is dropped. */
  private suppressing = false
  /**
   * Every catalogue shape this reader repaired this turn, by id.
   *
   * This is what tells the shapes actually occurring in the wild apart, so they
   * can be counted rather than guessed at. A Set, because a model that repeats
   * one mistake five times in a turn made that mistake once for the purpose of
   * knowing the shape is live.
   */
  private readonly shapes = new Set<string>()
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
   * The fence marker of an open code block, or undefined when none is open.
   *
   * Set only while no block is open, so the two states are mutually exclusive:
   * a fence marker inside a call body is that body's content, and a call cannot
   * open inside a fence because no line there is ever scanned for one.
   */
  private fence: string | undefined
  /**
   * Parameter depth inside the open block, carried across its lines.
   *
   * A block closer only ends the block at depth zero — see
   * {@link blockCloserIndex} — so the count has to survive the line boundary
   * between a parameter opener and the closer that ends it.
   */
  private blockParams = 0

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

  /**
   * The catalogue ids this reader repaired, in order of first occurrence.
   *
   * Reading does not clear them: a caller that owns a whole turn collects once
   * at the end, and a caller that owns one block sees the turn so far.
   */
  repairedShapes(): readonly string[] {
    return [...this.shapes]
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
    const sofar = this.partial.trim()
    if (sofar.length === 0) return
    // A line that could still BECOME a fence marker is held too. A fence is
    // what makes an example an illustration rather than an action, and it is
    // recognised by the whole line — so releasing the opening backticks before
    // the newline arrives left `FENCE_OPEN` with the language tag alone, the
    // fence never armed, and the example inside it DISPATCHED. Streaming a
    // documented example one character at a time is how a live turn arrives,
    // so that is not a corner: it is the path a reader's own format statement
    // takes. Held only while the line still starts with a backtick or tilde,
    // which is the whole of what a fence can begin with.
    if (sofar.startsWith('`') || sofar.startsWith('~')) return
    // A line that NAMES a declared tool is held to its newline too. The
    // structural reader decides over the whole line, so releasing the front of
    // a streamed envelope as prose left it with a fragment that no longer
    // carried the name, and a call streamed a token at a time was never read.
    if (this.holdable(sofar)) return
    // A held run that is still growing owns the lines after it: releasing the
    // front of the next line as prose would show text ahead of a call that is
    // about to run, and would cut the run in half.
    if (this.pending.length > 0) return
    if (this.binding(this.partial)) return
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
    // A held run the turn ended on is read once more as a whole — the last
    // line may have completed it — and shown as prose when it is not a call.
    if (this.pending.length > 0) {
      const joined = this.pending.join('\n')
      const call = this.structuralCall(joined)
      this.pending.length = 0
      if (call !== undefined) events.push(call)
      else events.push({ kind: 'text', text: `${joined}\n` })
    }
    // A call read at the very end of the turn has no next line to wait for.
    this.settleHeld(events)
    const open = this.block
    if (open !== undefined) {
      this.block = undefined
      this.blockParams = 0
      const raw = open.lines.join('\n')
      const { produced } = this.parseCalls(raw)
      if (produced.length > 0) events.push(...produced)
      else {
        // The same last resort `closeBlock` reaches for, on the flush path: a
        // block the model never closed may still BE a call in a notation the
        // spelling rules do not know, and structure is what reads it.
        const structural = this.structuralCall(raw)
        if (structural !== undefined) events.push(structural)
        else events.push({ kind: 'text', text: `${raw}\n` })
      }
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
    // Two tags fused into one token — see FUSED_OPENER. The inner opener is the
    // tag the model meant, so the false start ahead of it is dropped and the
    // rest of this routine reads the one tag that remains.
    const fused = lastMatchIndex(payload, FUSED_OPENER)
    const one = fused < 0 ? payload : payload.slice(fused + 1)
    if (fused >= 0) this.shapes.add('fused-opener')
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
    // opener and `unfinished()` read the whole invoke as cut off mid-write.
    if (keyword.length > 0 && (rest.startsWith('"') || rest.startsWith("'"))) {
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
    // The model's own frame word — `calls`, `_call` — is the same envelope in
    // the shorter spelling, so it becomes the one taught wrapper as well. It
    // cannot simply be dropped: the invoke it wraps is frequently self-closing
    // or carries its arguments on the opener, and this wrapper is then the only
    // closer the block has. A frame that vanishes leaves that call unbounded,
    // swallowing the rest of the stream. A wrapper that framed nothing is
    // dropped whole by {@link DsmlTranslator.closeBlock} instead.
    if (/^calls?/.test(word)) return closing ? TOOL_CALLS_CLOSE : TOOL_CALLS_OPEN

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
    if (DSML_TOKEN.test(out)) this.shapes.add('pipe-wrapped-token')
    out = out.replace(DSML_TOKEN, (whole, slash: string, payload: string) => this.nativeToken(whole, slash === '/', payload))
    // A bare `<DSML>`/`</DSML>` wrapper carries nothing; the inner tool tag
    // below is the call. Dropping it keeps the wrapper from surfacing as prose
    // around a call that did run.
    out = out.replace(DSML_WRAP, '')
    // The taught tags written with `=` instead of ` name=` — see EQUALS_TAG.
    out = out.replace(EQUALS_TAG, (_whole, tag: string, name: string, slash: string) => {
      this.shapes.add('equals-tag')
      const word = tag.toLowerCase()
      const open = `<${word} name="${name}">`
      return slash === '/' ? `${open}</${word}>` : open
    })
    // A `<parameter>` that names nothing is left standing — only
    // `invokeArguments` knows which slot is still open, and it peels the wrapper
    // there — but it is a repair either way, so the reminder is booked here with
    // the rest of them.
    if (NAMELESS_PARAMETER.test(out)) {
      this.shapes.add('nameless-parameter')
    }
    if (this.namedOpen !== undefined && this.namedClose !== undefined) {
      out = out.replace(this.namedOpen, (whole, name: string, run: string) => {
        if (!this.tools.has(name)) return whole
        this.shapes.add('tool-named-tag')
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
    if (BARE_FRAME.test(out)) this.shapes.add('bare-frame')
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
    this.shapes.add('orphan-parameter')
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
    let suppressed = false
    while ((match = SYSTEM_REMINDER_TAG.exec(line)) !== null) {
      const isClose = match[0].includes('/')
      if (this.suppressing) {
        // Inside the span: drop text up to here; only a closer ends it, and a
        // nested opener is left suppressed.
        suppressed = true
        if (isClose) {
          this.suppressing = false
          idx = SYSTEM_REMINDER_TAG.lastIndex
        }
      } else if (isClose) {
        // A closer with no open span is a leftover token: drop it, keep the text.
        suppressed = true
        out += line.slice(idx, match.index)
        idx = SYSTEM_REMINDER_TAG.lastIndex
      } else if (!this.emitted && line.slice(0, match.index).trim().length === 0) {
        // A block opener: keep the text before it, then suppress until the
        // closer.
        suppressed = true
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
    // The span was framing, not the model's answer, and dropping it is a repair
    // like any other: reported so the catalogue counts how often a model recites
    // its own prompt back. An inline mention keeps the tag and reports nothing —
    // the same `suppressed` flag that decides the shape decides the count.
    if (suppressed) this.shapes.add('system-reminder-echo')
    return out
  }

  /**
   * Replay every exact-text rewrite the catalogue has learned.
   *
   * This is what makes the reader adaptive: a fragment a previous turn
   * repaired is rewritten BEFORE the rules run, so the second occurrence costs
   * one string replacement rather than another full trip through the parser.
   * Literals only — never a pattern — so the catalogue can never widen the
   * reader's grammar beyond text it has already seen and fixed.
   */
  private applyLearned(line: string): string {
    let out = line
    for (const literal of learnedLiterals()) {
      if (!out.includes(literal.broken)) continue
      out = out.split(literal.broken).join(literal.fixed)
      // Reported through the same channel as a named shape, so the catalogue's
      // hit counter learns which learned fragments are still earning their
      // keep and which were a one-off. `literalKey` keeps the two key spaces
      // apart, so a fragment spelling a shape id cannot inflate that shape.
      this.shapes.add(literalKey(literal.broken))
    }
    return out
  }


  /**
   * Where one line ends the open block, or -1 when it does not.
   *
   * A block closer only ends the block at PARAMETER DEPTH ZERO, because a
   * parameter's value is raw text that may quote the format: a tool_calls or
   * invoke closer of its own is content, and closing the block there cut the
   * call off at the first inner tag — the same truncation invokeElements was
   * fixed for, one level up. The depth rides {@link blockParams}, because an
   * opener and its closer need not share a line.
   * @param text - the part of the line not yet consumed by this block.
   * @param closer - the tag that ends this block.
   * @returns the closer's index, or -1 when it does not close here.
   */
  private blockCloserIndex(text: string, closer: string): number {
    const scan = new RegExp(PARAMETER_OPENER + '|</parameter\\s*|' + escapeRegExp(closer), 'gi')
    for (const match of text.matchAll(scan)) {
      const written = match[0]
      if (written === closer) {
        if (this.blockParams === 0) return match.index
        continue
      }
      if (written.startsWith('<parameter')) {
        this.blockParams += 1
        continue
      }
      if (this.blockParams > 0) this.blockParams -= 1
    }
    return -1
  }

  /**
   * Read a line or block by STRUCTURE when the spelling rules found no call.
   *
   * Every rule above is about spelling, so a call written in a notation this
   * reader was never taught reaches this point as prose: a JSON envelope, a
   * colon pair, an element per key, a shell flag, a C-like call. Structure is
   * what all of those share - a tool name and named argument values - so
   * structure is what this reads, and `extractShape` is where that reading
   * lives.
   *
   * The two duties are the same two duties here. A candidate exists only when
   * the text names a tool this request declared, binds that tool's arguments,
   * and leaves nothing behind but punctuation and the vocabulary every envelope
   * is built from. Text that keeps words is an explanation, and is refused: a
   * sentence, a fenced example, and a quoted snippet all still pass through as
   * text, which is what keeps an example from running.
   *
   * A read here is a REPAIR all the same - the reader could not read the
   * notation the model used - so it books the same reminder the taught dialect
   * would have earned.
   * @param text - one line, or one joined block, the spelling rules read nothing from.
   * @returns the call, or undefined when the text is prose.
   */
  /**
   * Whether a line may be the FRONT of a call that runs across lines.
   *
   * A YAML block, a run of key/value pairs, and a JSON envelope all become
   * readable only once their last line has arrived. The first line of any of
   * them is not yet a call, and deciding on it alone is how a streamed
   * multi-line call went unread. Holding is limited to lines that name a
   * declared tool and carry no element of this reader's own dialect, so only
   * prose that mentions a tool pays any latency at all.
   * @param line - one line the spelling rules read nothing from.
   * @returns true when the line should be held rather than shown.
   */
  private holdable(line: string): boolean {
    if (line.length === 0) return false
    if (TAUGHT_MARKUP.test(line)) return false
    // A fence or a quoted snippet is an explanation, never the front of a call.
    if (line.startsWith('`') || line.startsWith('~')) return false
    return this.mentionsTool(line)
  }

  /** Show every held line, in the order it arrived. */
  private releasePending(events: DsmlEvent[]): void {
    for (const line of this.pending) events.push({ kind: 'text', text: `${line}\n` })
    this.pending.length = 0
  }

  /**
   * Read the held run as one call, or release it once it has grown too long.
   * @param events - where to emit.
   */
  private settlePending(events: DsmlEvent[]): void {
    if (this.pending.length < 2) return
    const joined = this.pending.join('\n')
    const call = this.structuralCall(joined)
    if (call !== undefined) {
      this.pending.length = 0
      this.hold(joined, call)
      return
    }
    while (this.pending.length > PENDING_LINES) {
      const oldest = this.pending.shift()
      if (oldest !== undefined) events.push({ kind: 'text', text: `${oldest}\n` })
    }
  }

  /**
   * Read one line the spelling rules produced no call from, holding it when it
   * may be part of a notation that runs across lines.
   *
   * The line alone is tried first, because a one-line call is the common case
   * and must not pay for the multi-line one. Failing that, a line that may be
   * the front of a longer call is held; anything else is prose.
   * @param line - one line the spelling rules read nothing from.
   * @param events - where to emit.
   * @returns true when the line was consumed as a call or held for one.
   */
  private absorbLine(line: string, events: DsmlEvent[]): void {
    if (line.length === 0) {
      this.settleHeld(events)
      this.releasePending(events)
      this.listed = false
      events.push({ kind: 'text', text: '\n' })
      return
    }
    // A call already read is held until the NEXT line has been seen, because
    // two lines that each look like a call may be one call written twice or a
    // list of tools being shown - and only the pair says which.
    const held = this.held
    if (held !== undefined) {
      const pair = readShape(`${held.line}\n${line}`, this.tools)
      const alone = this.structuralCall(line)
      if (pair.candidate !== undefined && pair.candidate.name === held.event.name) {
        // The same call, said again. One reading, one call.
        this.held = undefined
        events.push(held.event)
        return
      }
      if (pair.conflicted || (alone !== undefined && alone.name !== held.event.name)) {
        // One slot bound to two values is a guess; two different tools named
        // one after the other is a list of tools being SHOWN. Neither is a
        // call, so the run is shown as the text it is, and every further line
        // belongs to the same list.
        this.held = undefined
        this.listed = true
        events.push({ kind: 'text', text: `${held.line}\n${line}\n` })
        this.releasePending(events)
        return
      }
      this.held = undefined
      events.push(held.event)
    }
    if (this.listed) {
      this.releasePending(events)
      events.push({ kind: 'text', text: `${line}\n` })
      return
    }
    // A line that is a complete call on its own runs once the next line has
    // confirmed it, and anything held ahead of it is prose written before it.
    const alone = this.structuralCall(line)
    if (alone !== undefined) {
      this.releasePending(events)
      this.hold(line, alone)
      return
    }
    // Otherwise it may be the front of a notation that runs across lines, or
    // the continuation of one already held. Held either way, and the run is
    // tried as a whole each time it grows.
    if (this.pending.length > 0 || this.holdable(line)) {
      this.pending.push(line)
      this.settlePending(events)
      return
    }
    this.releasePending(events)
    events.push({ kind: 'text', text: `${line}\n` })
  }

  /** Keep a read call until the next line either confirms it or contradicts it. */
  private hold(line: string, event: ToolCall): void {
    this.held = { line, event }
  }

  /** Emit a held call once no further line can contradict it. */
  private settleHeld(events: DsmlEvent[]): void {
    const held = this.held
    if (held === undefined) return
    this.held = undefined
    events.push(held.event)
  }

  /**
   * Whether an unfinished line could still become a call.
   *
   * The spelling reader could release a partial with no `<` in it, because
   * nothing without a tag could become one of the tags it reads. That is no
   * longer true: a call in an untaught notation carries no tags at all, so a
   * line that has not finished arriving may still be `kernel(code=…` or the
   * front of a JSON object, and releasing it would show the user the front of
   * a call and lose the call itself.
   *
   * The test is deliberately about what the line COULD become, never about
   * what it means, so it costs prose only a bounded lookahead:
   *
   *   * Text with no space yet is held — it is one token, and a token may be a
   *     tool name still arriving (`k`, `ke`, `ker`).
   *   * Text carrying a binding character is held — `=`, `:`, `(`, `[`, `{`,
   *     or `<` is where a notation starts saying what its arguments are.
   *   * Text whose last word could still grow into a declared tool's name is
   *     held — `tool: kern` has not finished naming anything.
   *
   * Everything else is prose, and is released at once. A sentence about a call
   * is refused by the reader's own residue test whether it arrives whole or in
   * pieces, so streaming it early costs nothing and buys back the token-by-
   * token stream a native provider gives.
   * @param line - the UNTRIMMED text accumulated for the unfinished line.
   * @returns true when the line should be held rather than shown.
   */
  private binding(line: string): boolean {
    // A space is what a notation puts between its name and its arguments, so a
    // line that has reached one has said as much as a name alone can. Prose
    // that reaches a space and names no tool is released on the spot.
    if (!/\s/.test(line)) return true
    // A quote is where a quoted value starts, and a line that has opened one has
    // not finished saying what it says: releasing it showed the user the front
    // of a JSON member and left the call without the name it carried.
    if (/[=:(\[{<"']/.test(line)) return true
    const tail = /([\w.-]+)\s*$/.exec(line)
    if (tail === null) return false
    const word = tail[1] ?? ''
    for (const name of this.tools.keys()) {
      if (name.startsWith(word) || word.startsWith(name)) return true
    }
    return false
  }

  private structuralCall(text: string): ToolCall | undefined {
    // Cheap gate first. The structural reader builds a pattern set per tool, so
    // running it on every sentence of a long answer would pay that cost for
    // nothing; a line that does not even contain a declared tool's name cannot
    // become a call, and this is the same substring test the note path uses.
    // Taught markup is the SPELLING rules' territory, not this reader's. A block
    // that carried `<invoke>` and still produced nothing was refused on purpose
    // — truncated mid-write, or naming a slot that never closed — and reading
    // its fragments structurally would dispatch the very call the spelling
    // rules just declined. Structure is for a notation with no tags at all.
    if (TAUGHT_MARKUP.test(text)) return undefined
    if (!this.mentionsTool(text)) return undefined
    const found = extractShape(text, this.tools)
    if (found === undefined) return undefined
    const tool = this.tools.get(found.name)
    const args: Record<string, unknown> = {}
    for (const [key, value] of found.args) {
      const coerced = coerceParameterDetailed(tool, key, value)
      if (coerced.repaired) this.shapes.add('quoted-scalar')
      args[key] = coerced.value
    }
    this.shapes.add('structural-notation')
    return { kind: 'tool-call', name: found.name, arguments: JSON.stringify(args) }
  }

  private consumeLine(rawLine: string, events: DsmlEvent[]): void {
    const stripped = this.stripSuppressed(rawLine)
    // A line wholly inside a suppressed span yields no visible text; emit
    // nothing rather than a blank line. Checked before the illustration rules
    // so a fenced example inside a recited prompt is suppressed with the rest
    // of that prompt rather than surfacing on its own. A genuinely blank prose
    // line (empty input) still falls through below, so paragraph breaks live.
    if (stripped.length === 0 && rawLine.length > 0) return

    // Illustration is not action. While a fence is open the model is DISPLAYING
    // the format rather than writing a call — the statement it was handed says
    // fenced code blocks never run — so the line is shown whole and never
    // scanned. Kept ahead of every other rule because a fenced example is
    // exactly the text that would otherwise parse as a real block.
    const fence = this.fence
    if (fence !== undefined) {
      events.push({ kind: 'text', text: `${stripped}\n` })
      if (closesFence(stripped, fence)) this.fence = undefined
      return
    }
    // A block already open owns its lines: a fence marker inside a call body is
    // that body's content, not the start of an illustration.
    if (this.block === undefined) {
      const opened = FENCE_OPEN.exec(stripped)
      if (opened !== null) {
        this.fence = opened[1] ?? '```'
        events.push({ kind: 'text', text: `${stripped}\n` })
        return
      }
    }

    const learned = this.applyLearned(stripped)
    // A line whose only markup sits inside a code span is the model NAMING the
    // format — the same example, quoted rather than fenced. Shown verbatim, so
    // the backticks stay backticks and the mention never opens a block that
    // would swallow the prose after it. A line carrying markup OUTSIDE a span
    // as well falls through to the ordinary rules, which read it whole; the
    // test is skipped entirely for a line with no span, so span-free input is
    // read exactly as it was before this rule existed.
    // Only for a line that opens no block: while a block is open its lines are
    // that call's BODY, where a fence marker is content and a quoted tag is an
    // argument value. Applying the rule there dropped the closing fence of a
    // fenced argument, which left the invoke without its closer and lost the
    // whole call.
    if (this.block === undefined) {
      const bare = outsideSpans(learned)
      if (bare !== learned && !ANY_MARKUP.test(bare)) {
        events.push({ kind: 'text', text: `${learned}\n` })
        return
      }
    }
    const visible = restoreStrippedClosers(learned)
    if (visible !== learned) this.shapes.add('closer-stripped')
    let rest = this.normalizeNative(visible)
    // A stray taught closer reaching prose is structure, not content: drop it
    // and remember the exact token, so the next occurrence is rewritten before
    // the parse rather than stripped during it.
    // A stray taught closer reaching prose is structure, not content, and is
    // dropped from the output below. It is deliberately NOT learned as a
    // literal rewrite: the fragment is a legitimate closer, so replaying
    // "delete this exact text" on every later line deleted the closers of
    // well-formed blocks, and every such block then read as a truncation.
    let split = false
    while (rest.length > 0) {
      const block = this.block
      if (block === undefined) {
        const opener = firstOpener(rest)
        if (opener === undefined) break
        if (opener.index > 0) {
          const lead = rest.slice(0, opener.index)
          const cleaned = lead.replace(ORPHAN_CLOSE, '')
          if (cleaned !== lead) this.shapes.add('orphan-closer')
          events.push({ kind: 'text', text: cleaned })
        }
        this.block = { lines: [], closer: opener.closer }
        this.blockParams = 0
        rest = rest.slice(opener.index)
        split = true
        continue
      }
      const close = this.blockCloserIndex(rest, block.closer)
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
    if (!split || rest.length > 0) {
      const cleaned = rest.replace(ORPHAN_CLOSE, '')
      if (cleaned !== rest) this.shapes.add('orphan-closer')
      // A line the spelling rules found no call in is not necessarily prose: it
      // may be the same call in a notation nobody wrote a rule for. That is what
      // the structural reader is for, and it refuses anything that keeps words,
      // so a sentence, an example, and a quoted snippet all still leave as text.
      this.absorbLine(cleaned, events)
    }
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
    // A closer-stripped block only becomes repairable once the whole block
    // is in hand: per line the guard sees one invoke and stays out of the
    // way, so the restore has to run again here, on the joined text. This is
    // the one point every close path funnels through — a block the model
    // closed, and one it left open that end() flushes.
    const beforeCloserRestore = raw
    raw = restoreStrippedClosers(raw)
    if (raw !== beforeCloserRestore) this.shapes.add('closer-stripped')
    const calls: { readonly index: number; readonly event: DsmlEvent }[] = []
    let named = false
    let unknown = false
    // Bodied `<invoke>…</invoke>` first, remembering each span so the
    // self-closing pass below never reads an opener that already dispatched.
    const consumed: (readonly [number, number])[] = []
    for (const element of invokeElements(raw)) {
      const start = element.start
      const tagged = attributes(element.run)
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
      const body = element.body
      if (unfinished(body)) continue
      // Every argument closed and one closer is left over, so the body is
      // FINISHED and the surplus tag is structure the reader drops. It is a
      // repair all the same, and it is counted.
      if (parameterCounts(body).surplus > 0) this.shapes.add('surplus-closer')
      // The body is one JSON arguments object rather than a run of parameter
      // elements, which is the whole of what this shape means; a body that
      // merely begins with a brace is a value and is read as one.
      if (jsonBodyArguments(tool, body.replace(NAMELESS_PARAMETER_PAIR, ''), new Set(parameterNames(tool))) !== undefined) {
        this.shapes.add('json-body')
      }
      calls.push({ index: start, event: { kind: 'tool-call', name, arguments: invokeArguments(tool, body, tagged, this.shapes) } })
      // Only a DISPATCHED invoke blocks the self-closing pass below. An invoke
      // whose own closer arrived but whose last argument never closed is
      // exactly the shape that pass repairs, so it must stay readable there.
      consumed.push([element.start, element.end])
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
      const nextInvoke = after.search(INVOKE_OPENER)
      const region = nextInvoke === -1 ? after : after.slice(0, nextInvoke)
      if (PARAMETER_OPEN.test(region)) {
        // A region that still holds an unclosed argument is a call being
        // written, not a call to read: an invoke closer read as an argument
        // end is byte-identical to a truncation, so it is refused here.
        if (unfinished(region)) continue
        // The same surplus-closer repair the bodied pass above counts: this
        // invoke has no closer of its own, so an extra argument closer in the
        // region is dropped by the same rule and is the same shape.
        if (parameterCounts(region).surplus > 0) this.shapes.add('surplus-closer')
        this.shapes.add('missing-invoke-close')
        calls.push({ index: start, event: { kind: 'tool-call', name, arguments: invokeArguments(tool, region, tagged, this.shapes) } })
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
        this.shapes.add('json-body')
        this.shapes.add('missing-invoke-close')
        calls.push({ index: start, event: { kind: 'tool-call', name, arguments: invokeArguments(tool, bodied, tagged, this.shapes) } })
        continue
      }
      const hasArg = [...tagged].some(([key]) => key !== 'name' && declared.has(key))
      if (!hasArg && requiredNames(tool).length > 0) continue
      this.shapes.add('missing-invoke-close')
      calls.push({ index: start, event: { kind: 'tool-call', name, arguments: invokeArguments(tool, '', tagged, this.shapes) } })
    }
    // A block that opened no invoke element anywhere but still carries whole
    // parameter elements is the wrapped-orphan shape: the model wrote the
    // taught envelope and then the arguments, and never named a tool at all.
    // Neither pass above can read it -- both are keyed on an invoke opener --
    // so without this the block is dumped as raw markup, runs nothing, and
    // draws no note either, because the note rules match TOOL names and only
    // an argument name is present. The tool comes from the arguments
    // themselves, and only when exactly one declared tool owns every one of
    // them; two candidates is a coin flip that RUNS something, and that is
    // not a reading.
    if (calls.length === 0 && !INVOKE_OPENER.test(raw)) {
      // DSH-FORK(fix): a wrapped block whose invoke openers are all missing
      // but whose invoke closers are present -- one closer per call.
      // EXIT: upstream reads closer-bounded orphan groups.
      const groups = orphanGroupCalls(raw, this.tools)
      const orphans = groups !== undefined
        ? groups
        : (() => {
          const one = orphanParameterCall(raw, this.tools)
          return one === undefined ? [] : [one]
        })()
      for (const orphan of orphans) {
        const orphanTool = this.tools.get(orphan.name)
        if (orphanTool === undefined) continue
        this.shapes.add(groups !== undefined ? 'orphan-group' : 'orphan-parameter')
        named = true
        calls.push({
          index: 0,
          event: {
            kind: 'tool-call',
            name: orphan.name,
            arguments: invokeArguments(orphanTool, orphan.region, new Map(), this.shapes),
          },
        })
      }
    }
    calls.sort((left, right) => left.index - right.index)
    return { produced: calls.map(entry => entry.event), named, unknown }
  }

  /** Parse a complete block into calls, or pass it through when it names nothing real. */
  private closeBlock(events: DsmlEvent[]): void {
    const block = this.block
    this.block = undefined
    this.blockParams = 0
    if (block === undefined) return
    const joined = block.lines.join('\n')
    const raw = restoreStrippedClosers(joined)
    if (raw !== joined) this.shapes.add('closer-stripped')
    const { produced, named, unknown } = this.parseCalls(raw)
    // Nothing callable came out: show the block. A model that named a tool it
    // does not have needs to SEE that it did — the next turn's transcript is
    // the only correction channel this transport has, and a dropped block
    // reads to the model as a call that ran and returned nothing.
    if (produced.length === 0) {
      // An envelope the model opened and closed around no call at all is
      // framing, not content. Nothing came out of it and there is nothing in
      // it to show, so emitting the block here would put the bare wrapper tags
      // in the answer where the model wrote a frame.
      if (emptyEnvelope(raw)) return
      // A block the spelling rules could not read is not necessarily a failed
      // call: it may be a whole call in a notation nobody wrote a rule for,
      // wrapped in the taught envelope or not. Structure is tried before the
      // model is shown its own markup back, and the structural reader refuses
      // prose on its own terms - so an example still cannot run from here.
      const structural = this.structuralCall(raw)
      if (structural !== undefined) {
        events.push(structural)
        return
      }
      events.push({ kind: 'text', text: `${raw}\n${this.blockNote(raw, named, unknown)}` })
      return
    }
    events.push(...produced)
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

  /**
   * Whether `text` names a declared tool as a WORD rather than as a substring.
   *
   * The substring test the note path uses is deliberately loose — it only
   * decides which sentence to append — but the structural reader's gate feeds a
   * regex sweep, and a tool called `read` matches inside `already`, `thread`,
   * and `spread`. Those are prose, and paying the sweep for them is what makes
   * this gate worth having. A name bordered by word characters is a mention.
   * @param text - the line or block about to be tried structurally.
   * @returns true when a declared tool's name appears as a word.
   */
  private mentionsTool(text: string): boolean {
    for (const name of this.tools.keys()) {
      let at = text.indexOf(name)
      while (at !== -1) {
        const before = at === 0 ? '' : text.charAt(at - 1)
        const after = text.charAt(at + name.length)
        if (!/[\w.-]/.test(before) && !/[\w.-]/.test(after)) return true
        at = text.indexOf(name, at + 1)
      }
    }
    return false
  }

  /** Whether a block that produced nothing at least NAMES a tool this request declared. */
  private namesTool(raw: string): boolean {
    for (const name of this.tools.keys()) {
      if (raw.includes(name)) return true
    }
    return false
  }
}

/**
 * Restore the closers a transport stripped from a tool-call block.
 *
 * A stripped block keeps every opener and loses every closer, so its arguments
 * are intact but the markup that ended them is gone. Counting openers against
 * closers reads that as a command cut off mid-write, and the turn falls through
 * to prose with a note saying the tool does not exist.
 *
 * The grammar makes this decidable rather than guessed: an element never nests.
 * A second invoke opener therefore PROVES the first invoke closed, and proves
 * any parameter open inside it closed too. Only structure is read, never
 * content, so a parameter whose value merely mentions a tag is untouched.
 *
 * Fires only when closers are entirely absent AND at least two invoke openers
 * are present. One truncated invoke is indistinguishable from one stripped
 * invoke, and completing it would invent arguments the model never wrote, so
 * that case is left to the truncation path.
 * @param text - one line, or one block, of raw channel text.
 * @returns the same text with the provable closers restored.
 */
export function restoreStrippedClosers(text: string): string {
  const PC = '<' + '/' + 'parameter' + '>'
  const IC = '<' + '/' + 'invoke' + '>'
  const invokes = (text.match(INVOKE_SCAN) ?? []).length
  if (invokes < 2) return text
  const closed = (text.split(PC).length - 1) + (text.split(IC).length - 1)
  if (closed > 0) return text

  const TAG = /<(\/?)(parameter|invoke)\b[^>]*>/gi
  const SEPARATOR = /[ \t\r\n]+$/
  const out: string[] = []
  const stack: string[] = []
  let last = 0
  let match: RegExpExecArray | null
  // The whitespace between a value and the tag that follows it separates them
  // rather than belonging to the value, so a restored closer goes BEFORE it.
  // Inserted after, it landed inside the argument and `a.txt` arrived as
  // `a.txt `. Newlines are separator whitespace here too: a block written
  // across lines has one between every value and the next opener.
  const emit = (gap: string, closers: readonly string[]): void => {
    if (closers.length === 0) { out.push(gap); return }
    const trailing = SEPARATOR.exec(gap)
    if (trailing === null) { out.push(gap, ...closers); return }
    out.push(gap.slice(0, gap.length - trailing[0].length), ...closers, trailing[0])
  }
  while ((match = TAG.exec(text)) !== null) {
    const gap = text.slice(last, match.index)
    last = TAG.lastIndex
    const closers: string[] = []
    if (match[1] === '/') {
      if (stack.length > 0) stack.pop()
    } else {
      const name = (match[2] ?? '').toLowerCase()
      if (name === 'parameter') {
        while (stack[stack.length - 1] === 'parameter') {
          closers.push('<' + '/' + (stack.pop() ?? '') + '>')
        }
      } else {
        while (stack.length > 0) closers.push('<' + '/' + (stack.pop() ?? '') + '>')
      }
      stack.push(name)
    }
    emit(gap, closers)
    out.push(match[0])
  }
  const tail: string[] = []
  while (stack.length > 0) tail.push('<' + '/' + (stack.pop() ?? '') + '>')
  emit(text.slice(last), tail)
  return out.join('')
}


/**
 * How many closer-only lines in a row mean the model stopped writing a call and
 * started repeating structure. Twelve is above any real call.
 */
export const GLITCH_RUN_DEFAULT = 12

/** One line that is nothing but taught structural closers. */
const CLOSER_ONLY_LINE = new RegExp(
  '^[ \\t]*(?:'
    + '<' + '/parameter\\s*>'
    + '|' + '<' + '/invoke\\s*>'
    + '|' + '<' + '/tool_calls\\s*>'
    + '|' + '<' + '/function_calls\\s*>'
    + ')[ \\t]*$',
  'i',
)

/**
 * The length of the run of closer-only lines at the tail of the text. Pure, so
 * a stream pass can call it on a rolling window.
 * @param text - the tail of the channel text, complete lines only.
 * @returns how many closer-only lines end `text`.
 */
export function closerRun(text: string): number {
  let run = 0
  for (const line of text.split('\n')) {
    if (line.trim().length === 0) continue
    if (CLOSER_ONLY_LINE.test(line)) run += 1
    else run = 0
  }
  return run
}

/**
 * Read a wrapped block whose invoke openers are all missing but whose invoke
 * closers are present, so each closer bounds one call.
 *
 * The single-call reading refuses this because an argument name repeats, and it
 * is right to. The closer between them is a boundary the model actually wrote,
 * so the run is read one call per group rather than refused.
 * @param raw - one block's raw text, closers already restored.
 * @param tools - the tools this request declared, keyed by name.
 * @returns one entry per closer-bounded group, or undefined when any group
 * is not itself a whole call for exactly one declared tool.
 */
export function orphanGroupCalls(
  raw: string,
  tools: ReadonlyMap<string, ToolSchema>,
): readonly { readonly name: string; readonly region: string }[] | undefined {
  const parts = raw.replace(ENVELOPE_TAG, '').split(new RegExp('<' + '/invoke\\s*>', 'gi'))
  const groups: { readonly name: string; readonly region: string }[] = []
  for (const part of parts) {
    if (part.trim().length === 0) continue
    const one = orphanParameterCall(part, tools)
    if (one === undefined) return undefined
    groups.push(one)
  }
  if (groups.length < 2) return undefined
  return groups
}
