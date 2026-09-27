/**
 * Read a tool call out of a notation nobody wrote a rule for.
 *
 * Every rule in the reader is about SPELLING: an invoke element, a wrapper, a
 * pipe token, an equals sign. That covers the dialects it was taught and
 * nothing else, so a model writing the same call in the notation it grew up on
 * - JSON, YAML, a colon pair, an element per key, a shell flag, a Python call -
 * gets no call at all, or worse, a call whose argument is the markup it was
 * written in.
 *
 * What every one of those notations carries is the same two things: a tool name
 * and a set of named argument values. This reads those two things directly, so
 * the notation stops mattering. The only questions are whether a name and its
 * values are present, and whether they are unambiguous.
 *
 * Four properties keep that from becoming a way to invent calls:
 *
 *   * The ROSTER is the oracle. A candidate exists only if it names a tool the
 *     request declared, and an argument only if that tool declares the slot.
 *   * The RESIDUE must be empty. Once the name, the bound values, and every
 *     complete tag run are cut out, what remains has to be punctuation and the
 *     vocabulary every envelope is built from. A sentence about a call leaves
 *     words behind, and words mean prose.
 *   * A CONFLICT refuses. One slot bound to two different values is a guess,
 *     not a reading, so the candidate is dropped rather than resolved.
 *   * A LONE POSITIONAL argument is read only for a tool that declares exactly
 *     one slot. With one slot there is nothing to choose between; with two, the
 *     text never says which one the value belongs to, and refusing is the only
 *     reading that cannot invent.
 *
 * None of the four is a spelling rule, so none needs extending when a new
 * spelling appears. That is the whole point.
 * @module @deepseek-ai/dsh-llm-dsml/shapes
 */

import type { ToolSchema } from '@deepseek-ai/dsh-llm'
import { parameterNames, requiredNames } from './protocol.ts'

/** One read call: the tool's registered name, and the value per declared slot. */
export interface ShapeCandidate {
  readonly name: string
  readonly args: ReadonlyMap<string, string>
}

/**
 * What one pass over a piece of text found.
 *
 * `conflicted` is not decoration. A caller that holds a run of lines has to
 * tell "this text is not a call" from "this text IS a call that binds one slot
 * twice", because the two demand opposite responses: the first is prose, and
 * the second is a REFUSAL that must not be downgraded to the first line alone,
 * which would run an argument the model never settled on.
 */
export interface ShapeReading {
  readonly candidate: ShapeCandidate | undefined
  /** True when a candidate the text plainly names was refused for a conflict. */
  readonly conflicted: boolean
}

/** Both quote characters, for a pattern that must accept either one. */
const QUOTES = '"' + "'"

/** A character class matching either quote, for embedding in a pattern. */
const QUOTED = '[' + QUOTES + ']'

/**
 * Characters that end a bare value, written as a character-class body.
 *
 * The closing bracket MUST stay escaped. Unescaped it closes the class right
 * there, so a pattern meant to read "key = value" instead demands a literal
 * bracket after every value - a branch that then matches nothing but text
 * already carrying one, which reads as "this argument was never bound" and
 * drops the whole call.
 */
const STOP = ' \\t\\r\\n,;}\\]'

/** The same set plus both quote characters, for a value written bare. */
const BARE = STOP + QUOTES

/** Escape one literal for embedding in a RegExp. */
function escape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Every key or attribute name a notation may use to carry the TOOL name.
 *
 * Kept to words that mean "the name of the thing being called". `command` and
 * `action` are deliberately absent: they are ordinary parameter names on real
 * tools (the shell tool declares `command`), so treating them as labels would
 * let an argument's own value be read as the tool that was called.
 */
const TOOL_LABEL =
  '(?:name|tool|fn|function|tool[_-]?name|toolName|function[_-]?name|functionName)'

/**
 * Every attribute name a notation may use to carry an ARGUMENT name.
 *
 * `name` is on the list for the same reason it is on the tool list: the taught
 * envelope spells it that way, and a dialect that renames the element while
 * keeping the attribute is the same call.
 */
const ARG_LABEL = '(?:name|key|arg|param|parameter)'

/** Where a piece of markup sat, and what it bound. */
interface Hit {
  readonly from: number
  readonly to: number
  readonly value: string
}

/** A key written bare, pinned so it never matches inside a longer word. */
const bare = (key: string): string => '(?<![\\w.-])' + key

/**
 * Every way one argument name is bound to one value, across notations.
 *
 * A quoted branch always precedes the bare branch covering the same syntax at
 * the same position, and every BARE value class excludes both quote characters.
 * That is not tidiness. If a quoted value can also be captured WITH its quotes,
 * the same text binds one slot twice with two different strings, and the
 * conflict rule then refuses a call that was never ambiguous.
 *
 * Which branch matched does not matter downstream - every one captures the
 * value as group 1 - so a binding is always a (slot, text) pair.
 */
function bindings(slot: string): readonly RegExp[] {
  const key = escape(slot)
  const at = bare(key)
  return [
    // key="value" and key='value'. The closing quote must be TERMINATED by
    // the notation - a closer, punctuation, whitespace, or the end of the line.
    // Without that requirement a value carrying a quote of its own
    // (`code="say "hi" twice"`) matched only as far as the inner quote, and the
    // twin below then bound the same slot to a second, longer string, so the
    // conflict rule refused a call that was never ambiguous.
    new RegExp(at + '\\s*=\\s*"([^"]*)"(?=[ \\t]*(?:[)\\]},;/>]|\n|$))', 'gi'),
    new RegExp(at + "\\s*=\\s*'([^']*)'(?=[ \\t]*(?:[)\\]},;/>]|\n|$))", 'gi'),
    // The same pair, letting the value carry the delimiter itself. A quote the
    // notation does not terminate is CONTENT, not the end of the value, so the
    // value runs on to the next quote that is properly terminated. Both
    // branches agree wherever the strict one matches, so they never disagree
    // about a value; the loose one only adds the reading the strict one lost.
    new RegExp(at + '\\s*=\\s*"([\\s\\S]*?)"(?=[ \\t]*(?:[)\\]},;/>]|\n|$))', 'gi'),
    new RegExp(at + "\\s*=\\s*'([\\s\\S]*?)'(?=[ \\t]*(?:[)\\]},;/>]|\n|$))", 'gi'),
    // --key "value", --key=value, -key value - a shell flag
    new RegExp('--?' + key + '\\s*(?:=\\s*)?\\s*"([^"]*)"', 'gi'),
    new RegExp('--?' + key + "\\s*(?:=\\s*)?\\s*'([^']*)'", 'gi'),
    // --key=value and -key value, unquoted. A shell flag is the one notation
    // where the separator is optional, so both positions are tried and the
    // value stops at whitespace.
    new RegExp('--?' + key + '\\s*=\\s*([^' + BARE + ']+)', 'gi'),
    new RegExp('--?' + key + '\\s+([^' + BARE + ']+)', 'gi'),
    // "key": "value" and "key": value - a JSON object member. Same terminator
    // rule and same quote-carrying twin as the `=` pair above.
    new RegExp('"' + key + '"\\s*:\\s*"([^"]*)"(?=[ \\t]*(?:[)\\]},;/>]|\n|$))', 'gi'),
    new RegExp('"' + key + '"\\s*:\\s*"([\\s\\S]*?)"(?=[ \\t]*(?:[)\\]},;/>]|\n|$))', 'gi'),
    new RegExp('"' + key + '"\\s*:\\s*([^' + BARE + ']+)', 'gi'),
    // key: "value" and key: 'value' - a colon pair with a quoted value, with
    // the same terminator rule and the same quote-carrying twin.
    new RegExp(at + '\\s*:\\s*"([^"]*)"(?=[ \\t]*(?:[)\\]},;/>]|\n|$))', 'gi'),
    new RegExp(at + '\\s*:\\s*"([\\s\\S]*?)"(?=[ \\t]*(?:[)\\]},;/>]|\n|$))', 'gi'),
    new RegExp(at + "\\s*:\\s*'([^']*)'(?=[ \\t]*(?:[)\\]},;/>]|\n|$))", 'gi'),
    new RegExp(at + "\\s*:\\s*'([\\s\\S]*?)'(?=[ \\t]*(?:[)\\]},;/>]|\n|$))", 'gi'),
    // key: value, unquoted. The value class already excludes newline, quotes,
    // and the closing characters, so it stops at the end of its own line.
    new RegExp(at + '\\s*:\\s*([^' + BARE + ']+)', 'gi'),
    // an element whose own name is the slot
    new RegExp('<' + key + '\\b[^>]*>([\\s\\S]*?)</' + key + '\\s*>', 'gi'),
    // a container element naming the slot in one of its attributes
    new RegExp(
      '<[\\w:.-]+\\b[^>]*\\b' + ARG_LABEL + '\\s*=\\s*' + QUOTED + key + QUOTED + '[^>]*>([\\s\\S]*?)</[\\w:.-]+\\s*>',
      'gi',
    ),
    // key=value, unquoted, last so a quoted value never falls through to it
    new RegExp(at + '\\s*=\\s*([^' + BARE + ']+)', 'gi'),
  ]
}

/** Every way one tool name is bound to the call, across notations. */
function toolBindings(name: string): readonly RegExp[] {
  const key = escape(name)
  return [
    // an attribute carrying the tool name, quoted or bare
    new RegExp(TOOL_LABEL + '\\s*=\\s*"(' + key + ')"', 'gi'),
    new RegExp(TOOL_LABEL + '\\s*=\\s*' + QUOTED + '(' + key + ')' + QUOTED, 'gi'),
    new RegExp(TOOL_LABEL + '\\s*=\\s*(' + key + ')(?![\\w.-])', 'gi'),
    // a JSON member carrying the tool name
    new RegExp('"' + TOOL_LABEL + '"\\s*:\\s*"(' + key + ')"', 'gi'),
    // an element of its own carrying the tool name
    new RegExp('<' + TOOL_LABEL + '\\s*>\\s*(' + key + ')\\s*</' + TOOL_LABEL + '\\s*>', 'gi'),
    // a whole line that is just the label and the tool
    new RegExp('^\\s*' + TOOL_LABEL + '\\s*:\\s*(' + key + ')\\s*$', 'gim'),
    // the tool worn as its own element
    new RegExp('</?(' + key + ')(?=[\\s/>])', 'gi'),
    // a call in any C-like, Python-like, or bracket notation
    new RegExp('(?<![\\w.-])(' + key + ')\\s*[(\\[]', 'gi'),
    // the bare name, anywhere, as a last resort
    new RegExp('(?<![\\w.-])(' + key + ')(?![\\w.-])', 'gi'),
  ]
}

/** Whether any one of `patterns` occurs in `text`. */
function anyMatch(text: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => {
    pattern.lastIndex = 0
    return pattern.test(text)
  })
}

/** Every value bound to `slot`, and whether two of them disagree. */
function valuesOf(text: string, slot: string): { readonly hits: readonly Hit[]; readonly conflict: boolean } {
  const hits: Hit[] = []
  const distinct = new Set<string>()
  for (const pattern of bindings(slot)) {
    pattern.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = pattern.exec(text)) !== null) {
      // A zero-length match would spin this loop forever.
      if (match[0].length === 0) break
      const value = (match[1] ?? '').trim()
      if (value.length === 0) continue
      distinct.add(value)
      hits.push({ from: match.index, to: match.index + match[0].length, value })
    }
  }
  return { hits, conflict: distinct.size > 1 }
}

/**
 * A complete tag run - the envelope's own vocabulary rather than its content.
 *
 * Cut before the residue test, because a notation's element names are layout: a
 * call written as a nest of elements carries one name and one value, and
 * letting its scaffolding count as leftover words would refuse a call whose
 * whole content had already been read.
 */
const TAG = /<[^<>]*>/g

/**
 * What a candidate leaves behind once it is cut out.
 *
 * This is the test that separates a call from a sentence ABOUT a call. A
 * sentence keeps its words; a call is only its own layout plus the vocabulary
 * every envelope may carry, which is listed here because it means nothing the
 * reader needs.
 *
 * Every listed word allows its plural explicitly. The filter is one
 * left-to-right pass, so a bare singular would strip that much of the plural
 * and leave the trailing `s` behind as a word - enough on its own to refuse
 * every call whose envelope names its argument list in the plural.
 */
const STRUCTURAL = new RegExp(
  [
    '[\\s\\p{P}\\p{S}]+',
    '(?:tools?|functions?|calls?|invokes?|parameters?|params?)',
    '(?:arguments?|args?|names?|keys?|values?|uses?|use|using|inputs?)',
    '(?:requests?|payloads?|bodies|body|shells?|cmds?|commands?)',
    '(?:json|yaml|blocks?)',
  ].join('|'),
  'giu',
)

/** The text left over once the name, every bound value, and every tag are removed. */
function residueOf(text: string, spans: readonly Hit[], name: string): string {
  // A mask rather than successive slices: two branches can bind the same text,
  // and cutting those spans from the end still applies stale offsets to text an
  // earlier cut already shortened.
  const cut = new Array<boolean>(text.length).fill(false)
  for (const span of spans) {
    const from = Math.max(0, span.from)
    const to = Math.min(text.length, span.to)
    for (let at = from; at < to; at++) cut[at] = true
  }
  let rest = ''
  for (let at = 0; at < text.length; at++) rest += cut[at] === true ? ' ' : text.charAt(at)
  rest = rest.replace(new RegExp(escape(name), 'gi'), ' ')
  rest = rest.replace(TAG, ' ')
  return rest.replace(STRUCTURAL, '')
}

/**
 * The one value of a call written with no argument name at all.
 *
 * A call in a C-like notation names the tool and a value and nothing in
 * between, so the notation never says which slot the value belongs to. A tool
 * declaring exactly ONE slot settles it: there is no other slot it could be. A
 * tool declaring two does not, and nothing here tries to choose - which is what
 * keeps this a reading rather than a guess.
 * @param name - the tool name.
 * @returns the patterns that bind the positional value, value as group 1.
 */
function positionalBindings(name: string): readonly RegExp[] {
  const key = escape(name)
  const call = '(?<![\\w.-])' + key + '\\s*[(\\[]\\s*'
  const close = '\\s*[)\\]]'
  return [
    new RegExp(call + '"([^"]*)"' + close, 'gi'),
    new RegExp(call + '"([^"]*)"' + close, 'gi'),
    new RegExp(call + "'([^']*)'" + close, 'gi'),
    // A bare payload is read to the LAST bracket on the line, not the first.
    // The value may itself be a call - `kernel(print(1))` passes a call whose
    // own brackets are content - so stopping at the first closer would hand the
    // tool `print(1` and leave the last bracket as residue, refusing a call
    // that was never ambiguous. Greedy to the end is the only reading that
    // keeps the whole payload, and a line with trailing prose still fails the
    // residue test below.
    //
    // The payload must carry no EQUALS or COLON. A parenthesised list that
    // names its own arguments is a named call with a notation this reader did
    // not recognise - `kernel(timeoutMs=30)` - and reading its whole text as
    // the one positional value turned a call that named a slot the tool does
    // not have into a call that ran a string. Positional means what it says:
    // a value and nothing else.
    new RegExp(call + '([^' + BARE + '=:]+)' + close + '\\s*$', 'gim'),
  ]
}

/**
 * Read one call out of `text` by structure rather than by spelling.
 * @param text - one block or line of channel text the spelling rules missed.
 * @param tools - the request's declared schemas; the only oracle there is.
 * @returns the call, or undefined when the text is not one.
 */
/**
 * Whether `text` is an EXPLANATION of the format rather than a call in it.
 *
 * This is the second duty and it is not optional. A model that documents the
 * notation, quotes a transcript, or shows a worked example writes the same
 * name-and-value shape a call does, and running that example is as wrong as
 * dropping a real call: it executes something the model was describing.
 *
 * Two markers separate them, and both are structure rather than spelling:
 *
 *   * A QUOTED SPAN. A call written inside backticks is being NAMED, not made -
 *     the same example the fenced block shows, quoted rather than fenced.
 *   * A FENCE MARKER. A line that opens or closes a code block is displaying
 *     what follows, not running it.
 *
 * The third marker is the residue test every candidate already passes: an
 * explanation keeps the words that describe it, and a call does not.
 * @param text - one line or block of channel text.
 * @returns true when the text is showing the format rather than using it.
 */
function isIllustration(text: string): boolean {
  // A fence marker anywhere in the line means the line is delimiting an
  // example, not making a call.
  if (/^\s{0,3}(?:`{3,}|~{3,})/.test(text)) return true
  // A backtick span that encloses the whole candidate is a quoted mention.
  const spans = text.match(/`[^`]*`/g)
  if (spans !== null) {
    const quoted = spans.join('')
    // The mention wins when the quoted text is where the call's name sits: a
    // sentence with one quoted tag and an unquoted call beside it is still a
    // call, so the test asks whether ANY quoted span carries a tool name.
    if (quoted.length > 0 && text.trimStart().startsWith('`')) return true
  }
  return false
}

export function extractShape(text: string, tools: ReadonlyMap<string, ToolSchema>): ShapeCandidate | undefined {
  return readShape(text, tools).candidate
}

/**
 * Read one call out of `text`, and say whether the text refused to be one.
 * @param text - one block or line of channel text the spelling rules missed.
 * @param tools - the request's declared schemas; the only oracle there is.
 * @returns the call and whether a conflict was what refused it.
 */
export function readShape(text: string, tools: ReadonlyMap<string, ToolSchema>): ShapeReading {
  const nothing: ShapeReading = { candidate: undefined, conflicted: false }
  if (text.length === 0 || tools.size === 0) return nothing
  // An explanation is not a call. This runs FIRST: nothing below may dispatch
  // text the reader is only being shown.
  if (isIllustration(text)) return nothing
  const found: ShapeCandidate[] = []
  let conflicted = false
  for (const tool of tools.values()) {
    if (!anyMatch(text, toolBindings(tool.name))) continue
    const args = new Map<string, string>()
    const spans: Hit[] = []
    let conflict = false
    for (const slot of parameterNames(tool)) {
      const bound = valuesOf(text, slot)
      if (bound.conflict) {
        conflict = true
        break
      }
      const first = bound.hits[0]
      if (first === undefined) continue
      args.set(slot, first.value)
      spans.push(...bound.hits)
    }
    if (conflict) {
      // The tool was named and read, and one of its slots holds two different
      // values. That is a guess, not a reading, so the candidate is dropped -
      // and the caller is TOLD, because a run of lines that conflicts must be
      // refused whole rather than read one line at a time.
      conflicted = true
      continue
    }
    // Nothing was named: the call may still be carrying its one argument
    // positionally, which only a single-slot tool can have meant.
    if (args.size === 0) {
      const declared = parameterNames(tool)
      if (declared.length !== 1) continue
      const only = declared[0]
      if (only === undefined) continue
      for (const pattern of positionalBindings(tool.name)) {
        pattern.lastIndex = 0
        const match = pattern.exec(text)
        if (match === null) continue
        const value = (match[1] ?? '').trim()
        if (value.length === 0) continue
        args.set(only, value)
        spans.push({ from: match.index, to: match.index + match[0].length, value })
        break
      }
      // The slot the positional value would have filled is the only thing the
      // loop above can bind, so its absence is the same as nothing binding.
      if (!args.has(only)) continue
    }
    // A tool that requires a slot the text never bound is not this tool.
    if (requiredNames(tool).some(slot => !args.has(slot))) continue
    if (residueOf(text, spans, tool.name).length > 0) continue
    found.push({ name: tool.name, args })
  }
  if (found.length === 0) return { candidate: undefined, conflicted }
  // Two tools claiming the same text is a coin flip, and a coin flip that RUNS
  // something is not a reading. More bound slots wins only when it STRICTLY
  // wins; a tie is refused.
  const ranked = [...found].sort((left, right) => right.args.size - left.args.size)
  const best = ranked[0]
  const next = ranked[1]
  if (best === undefined) return { candidate: undefined, conflicted }
  if (next !== undefined && next.args.size === best.args.size) return { candidate: undefined, conflicted: true }
  return { candidate: best, conflicted }
}
