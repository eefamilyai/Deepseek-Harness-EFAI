/**
 * Structural salvage -- the reader of last resort.
 *
 * Every pass before this one is a RECOGNISER: it matches a spelling the model
 * was taught, plus the slips that spelling admits, and it refuses everything
 * else. That is the right default, but it is the wrong ENDING. A block that
 * reaches this module already failed every spelling rule, and the only question
 * left is whether it carries a call.
 *
 * Four stages, in order, because each one's output is the next one's input.
 * Naming them is what keeps the safety property visible: the reader is not one
 * clever regex, it is a pipeline whose every step can refuse.
 *
 *   1. IDENTIFY  -- the spans of text that carry call intent at all. Text
 *      between spans is prose and is never touched.
 *   2. SEPARATE  -- inside a span, pull apart the three things a call is made
 *      of: the TOOL it names, the PARAMETERS it carries, and the CONTENT that
 *      is neither. A tag whose name was never finished still says which tool
 *      the model was reaching for, so it is read as a tool rather than dropped.
 *   3. CLASSIFY  -- decide what the span IS: a finished composition, a call
 *      still being written, or an explanation. This is the stage that makes the
 *      module safe, and it is the one that is easy to leave out.
 *   4. ASSEMBLE  -- turn a finished composition into calls, coercing each
 *      argument against its own tool's schema.
 *
 * Stage 3 is the whole safety property, so it is worth stating precisely. A
 * stream that ends mid-write is byte-identical to a model that simply never
 * wrote a closer: nothing in the text says which happened. The reader resolves
 * that ambiguity the only honest way -- by counting compositions. A span that
 * decomposes into exactly ONE group is a single call, and if that group's last
 * argument never closed, the span might have been cut off anywhere inside it.
 * Completing it would invent an argument the model never finished writing, so
 * it is refused. A span that decomposes into TWO OR MORE groups is a sequence
 * the model plainly finished composing -- a truncation would have cut the first
 * call short, and the later groups would not exist at all.
 *
 * @module @deepseek-ai/dsh-llm-text-toolcalls/salvage
 */

import type { ToolSchema } from '@deepseek-ai/dsh-llm'
import { coerceParameter, parameterNames, requiredNames, resolveParameterName } from './protocol.ts'

/** One call this module recovered from a block nothing else could read. */
export interface SalvagedCall {
  /** The declared tool the parameters belong to. */
  readonly name: string
  /** The JSON arguments object, already coerced against that tool's schema. */
  readonly arguments: string
}

// Every tag in this module is built from these three characters rather than
// written out, because a literal closer in this source is a literal closer in
// whatever reads it next.
const LT = String.fromCharCode(60)
const GT = String.fromCharCode(62)
const SL = String.fromCharCode(47)

/**
 * How far apart two call signals may sit and still belong to one span.
 *
 * A block is closed as a unit, so in practice this bridges one block's worth of
 * markup and stops at the first stretch of real text between two calls. It is
 * generous on purpose: the cost of over-extending is that a span is refused as
 * one piece, while the cost of splitting is two half-calls and a false refusal.
 */
const SPAN_GAP = 20_000

/** Anything that can begin a call, in any spelling this fork has seen. */
// Anything that can begin a call, in ANY spelling -- deliberately not a
// list of the tag names this format defines. A model that reaches for a
// tool writes markup, and the markup's VOCABULARY is not the signal: the
// tool roster is. Naming the tags here would make the reader recognise only
// the spellings someone already thought of, which is the failure this
// module exists to end. Any tag opens a span; what the span IS gets decided
// later, against the request's own schemas.
/*
 * Anything that can begin a call, in ANY spelling.
 *
 * This is deliberately NOT a list of the tag names this format defines. A
 * model that reaches for a tool writes markup, and the markup's VOCABULARY is
 * not the signal -- the tool roster is. Naming any tag here would make the
 * reader recognise only the spellings someone already thought of, which is the
 * failure mode this module exists to end. Any tag opens a span; what the span
 * IS gets decided later, against the request's own schemas.
 */
const SIGNAL = new RegExp(LT + SL + '?[A-Za-z_][\\w-]*|\\uFF5C|\\|', 'gi')


/** A quoted, single-quoted, or bare name attribute. */
/**
 * Any tag at all: the delimiter a span is a sequence of.
 *
 * This is deliberately not a list of the tags the format defines. A span
 * reaches this module because no spelling rule matched it, so the one thing
 * that cannot be assumed is that it used the taught tag names in the taught
 * places. Every tag is therefore read the same way, and meaning is assigned
 * afterwards: an opener whose name is a declared tool is a call, and a
 * closer of the invoke family ends one.
 */
const ANY_TAG_TOKEN = new RegExp(LT + SL + '?\\s*([A-Za-z_][\\w-]*)([^' + GT + ']*)' + GT, 'gi')

const NAME_ATTR = /name\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i

/** Any tag, used only to strip markup before asking whether text is prose. */
const ANY_TAG = new RegExp(LT + '[^' + GT + ']*' + GT, 'g')

/** A run of structural closers, dropped from the tail of every captured value. */
const CLOSER = new RegExp(LT + SL + '(?:invoke|parameter|tool_calls|function_calls)\\s*' + GT, 'gi')

/** One thing found inside a span: a tool the model named, or an argument. */
type Item =
  | { readonly kind: 'tool'; readonly name: string }
  | { readonly kind: 'param'; readonly name: string; readonly value: string; readonly closed: boolean }
  | { readonly kind: 'boundary'; readonly tag: string }
  | { readonly kind: 'wrapper'; readonly tag: string; readonly closed: boolean }

/**
 * Stage 1 -- IDENTIFY. The spans of `text` that carry call intent.
 *
 * A span runs from the first call signal to the last one within {@link SPAN_GAP}
 * of its neighbour. Returning spans rather than one region is what lets prose
 * between two calls stay prose.
 * @param text - the block exactly as the model wrote it.
 * @returns each candidate span, in the order it appears.
 */
function identify(text: string): readonly string[] {
  const at: number[] = []
  for (const match of text.matchAll(SIGNAL)) at.push(match.index)
  if (at.length === 0) return []
  const out: string[] = []
  let start = at[0] ?? 0
  let previous = start
  for (let index = 1; index < at.length; index += 1) {
    const here = at[index] ?? previous
    if (here - previous > SPAN_GAP) {
      out.push(text.slice(start, previous + 1))
      start = here
    }
    previous = here
  }
  out.push(text.slice(start))
  return out
}

/**
 * Whether what is left after markup is prose rather than debris.
 *
 * Stripped of its tags and wrapper punctuation, debris leaves no words -- a
 * stray quote or equals sign is gone. An explanation leaves words, and a span
 * that carries one is a span this module has no business running.
 * @param content - the residue of a span after every item was claimed.
 * @returns true when the residue reads as language.
 */
function isProse(content: string): boolean {
  const stripped = content.replace(ANY_TAG, ' ').replace(/[\uFF5C|]/g, ' ').replace(/[^A-Za-z0-9_]+/g, ' ')
  return /[A-Za-z]{3,}/.test(stripped)
}

/**
 * Stage 2 -- SEPARATE. One span into the tools it names, the arguments it
 * carries, and the residue that is neither.
 *
 * One walk over every opener, in position order, whether it is a parameter or an
 * invoke. An opener's value is the text up to the next opener, which is what
 * makes a last argument that never closed still READABLE: its end is the end of
 * the span. Whether that reading is safe is {@link classify}'s question, not
 * this one's -- separating must not pre-judge it.
 *
 * Two shapes are read as calls rather than arguments, and both are common when
 * a model composes markup by hand. A tag whose name IS a declared tool is a
 * call with no arguments, not an argument whose name no tool declares. A tag
 * with no readable name at all is checked against the tool roster, because a
 * model reaching for a tool with no arguments writes the tool's name where an
 * argument name would go.
 * @param region - one span from {@link identify}.
 * @param tools - the request's own schemas, the only names that count.
 * @returns the items in order, or an empty list when the residue is prose.
 */
function separate(region: string, tools: ReadonlyMap<string, ToolSchema>): readonly Item[] {
  const tokens = [...region.matchAll(ANY_TAG_TOKEN)]
  const first = tokens[0]
  if (first === undefined) return []
  // The span's OUTERMOST opener, and whether the span's LAST tag closes it.
  // That pairing is the one proof of completion the text carries on its own: a
  // stream cut off anywhere leaves the wrapper it opened still open, so a
  // matching closer sitting at the tail says the model finished writing and
  // nothing was lost. It is read structurally -- the closer must name the same
  // tag the first opener named -- so an invented wrapper proves its own
  // completion exactly like a taught one, and no tag name is privileged.
  const firstIsCloser = first[0].charAt(1) === SL
  const firstTag = firstIsCloser ? '' : (first[1] ?? '').toLowerCase()
  const lastToken = tokens[tokens.length - 1]
  const lastIsCloser = lastToken !== undefined && lastToken[0].charAt(1) === SL
  const lastTag = lastIsCloser ? (lastToken?.[1] ?? '').toLowerCase() : ''
  const wrapperTag = firstTag.length > 0 && firstTag === lastTag ? firstTag : ''
  const items: Item[] = []
  // Only the text before the first tag, plus the text that sits where no value
  // can -- after a closer -- is residue. Text between two openers is a VALUE
  // and belongs to the item that owns it, and sweeping that up here would read
  // every argument as prose and discard the whole span.
  let residue = region.slice(0, first.index ?? 0)
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token === undefined) continue
    const next = tokens[index + 1]
    const slice = region.slice((token.index ?? 0) + token[0].length, next?.index ?? region.length)
    const closer = token[0].charAt(1) === SL
    const tag = (token[1] ?? '').toLowerCase()
    if (closer && wrapperTag.length > 0 && index === tokens.length - 1) continue
    if (closer) {
      // Every closer is a boundary, and the text after one belongs to no item --
      // which is exactly where a sentence wedged between two calls shows up, and
      // leaving it out would hide that prose from isProse and let a call the
      // model only described run. Which closers actually END a group is not
      // decided here: segments asks whether the run before the closer already
      // stands alone and whether what follows still fits it. Naming the tags in
      // this branch instead would let the reader recognise only the spellings
      // someone already thought of.
      residue += slice
      if (slice.trim().length === 0) items.push({ kind: 'boundary', tag })
      continue
    }
    // The span's outermost opener, when the span's LAST tag closes it, is the
    // wrapper the whole composition sits inside -- structure, not an argument.
    // It normally carries no name attribute, so this test has to run BEFORE the
    // guard that drops a nameless tag as debris: a wrapper is the one nameless
    // opener that still means something, and reading it as debris is what left
    // the call with no completion proof and no tool to infer.
    // An ARGUMENT carries a name; a wrapper does not. Requiring the outermost
    // opener to be nameless is what keeps a lone argument element -- an orphan
    // the per-line reader already owns -- from being read as a wrapper, while
    // still recognising every unnamed envelope a model invents around its
    // arguments. The test is structural on both sides, so no tag name is
    // privileged: an invented wrapper is read exactly like a taught one.
    const headRun = token[2] ?? ''
    const headAttr = NAME_ATTR.exec(headRun)
    const headNamed = (headAttr?.[1] ?? headAttr?.[2] ?? headAttr?.[3] ?? headRun.trim().split(/[\s"'=]/)[0] ?? '').trim()
    if (index === 0 && wrapperTag.length > 0 && tag === wrapperTag && headNamed.length === 0) {
      items.push({ kind: 'wrapper', tag: wrapperTag, closed: true })
      continue
    }
    const run = token[2] ?? ''
    const attr = NAME_ATTR.exec(run)
    // A tag may carry its name as `name="x"` or, in the older spelling this
    // fork still sees, as a bare first token: a parameter written `scope`.
    const named = (attr?.[1] ?? attr?.[2] ?? attr?.[3] ?? run.trim().split(/[\s"'=]/)[0] ?? '').trim()
    if (named.length === 0) {
      residue += token[0]
      continue
    }
    if (tools.has(named)) {
      items.push({ kind: 'tool', name: named })
      continue
    }
    // Only its OWN parameter closer closes a value. An invoke closer arriving
    // instead is the call ending, not the argument, and that is byte-identical
    // to the text a truncation leaves -- so it must not be read as a finished
    // argument. Whether a span is a finished composition is decided by how many
    // groups it holds, never by one closer.
    // A value is closed by a closer that NAMES THE OPENER IT CLOSES: the same
    // tag, spelled the same way, in closing form. That test is structural, so an
    // invented tag closes its own invented argument, while an invoke closer
    // arriving at a parameter is the call ending rather than the argument -- and
    // is byte-identical to the text a truncation leaves. Whether a span is a
    // finished composition is decided by how many groups it holds, never by one
    // closer.
    const closerTag = next !== undefined && next[0].charAt(1) === SL ? (next[1] ?? '').toLowerCase() : ''
    const closed = closerTag.length > 0 && closerTag === tag
    items.push({ kind: 'param', name: named, value: slice, closed })
  }
  return items.length === 0 ? [] : (isProse(residue) ? [] : items)
}

/**
 * The groups one span's items form, and the only decomposition this module has.
 *
 * Two things end a group, and both are about the next call rather than the one
 * being written. A tag that names a declared tool starts a new call -- that is
 * explicit evidence, and it is how a call written with the tool's name where an
 * argument name would go is still read as a call. A closer ends one only when
 * the items before it already stand alone as a call AND what follows does not
 * still fit them; a model that closes the tag it is inside and keeps writing the
 * same call's arguments wrote a sloppy closer, not a boundary. That one
 * distinction is what lets the reader accept a surplus closer inside a single
 * call and a genuine sequence of calls written back to back without a rule for
 * either.
 * @param items - the ordered items from {@link separate}.
 * @param tools - the request's own schemas, the only names that count.
 * @returns the groups, in order, with empty ones dropped.
 */
function segments(items: readonly Item[], tools: ReadonlyMap<string, ToolSchema>): readonly (readonly Item[])[] {
  const groups: Item[][] = []
  let current: Item[] = []
  const flush = (): void => {
    if (current.length > 0) groups.push(current)
    current = []
  }
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]
    if (item === undefined) continue
    // A wrapper is the envelope the composition sits inside, not a member of
    // it. Letting one into a group would open a group that carries no tool and
    // no argument at all -- a group nothing can resolve, which would refuse the
    // entire span it merely encloses. It is read once, by {@link complete}.
    if (item.kind === 'wrapper') continue
    if (item.kind === 'boundary') {
      if (!resolvable(current, tools)) continue
      // A closer ends the run only when the next thing starts a different call.
      // A model that closed the tag it was inside and then kept writing the SAME
      // call's arguments has not finished one -- it wrote a sloppy closer -- so
      // the run continues while the next argument still fits the tool. Only when
      // the next argument would no longer fit, or nothing follows, is the call
      // over.
      const after = items[index + 1]
      if (after !== undefined && after.kind === 'param' && resolvable([...current, after], tools)) continue
      flush()
      continue
    }
    if (item.kind === 'tool' && current.length > 0) flush()
    current.push(item)
  }
  flush()
  return groups
}

/**
 * Whether a run of items already names a call on its own.
 *
 * A run carrying a tool does. A run of arguments does when exactly one tool
 * declares every name it uses and requires nothing it lacks -- the question
 * {@link infer} answers, asked early so a closer can be told apart from an end.
 * A run that names one slot twice still resolves here, deliberately: deciding
 * that two same-named arguments are two calls is {@link assemble}'s refusal to
 * make, and making it here would split a block the model never separated into
 * groups that each look whole.
 * @param group - the items collected so far.
 * @param tools - the request's own schemas.
 * @returns true when the run could stand alone as a call.
 */
function resolvable(group: readonly Item[], tools: ReadonlyMap<string, ToolSchema>): boolean {
  if (group.length === 0) return false
  if (group.some(item => item.kind === 'tool')) return true
  const parameters = group.filter((item): item is Extract<Item, { kind: 'param' }> => item.kind === 'param')
  return infer(parameters, tools) !== undefined
}

/**
 * Stage 3 -- CLASSIFY. Whether a span is a finished composition, a call still
 * being written, or something this module must not run.
 *
 * The truncation rule, and the reason it reads the LAST group. The end of a span
 * is the only place where nothing in the text distinguishes a finished call from
 * a stream that stopped mid-argument, so it is the only place that must be
 * whole: a group whose tail never closed could have been cut off anywhere, and
 * completing it would invent an argument the model never wrote. A group naming a
 * tool with no argument is whole -- whether that tool needs an argument is the
 * schema's question, asked by {@link infer}. Earlier groups need no such check,
 * because a later group cannot exist unless the model finished the earlier one.
 * @param items - the ordered items from {@link separate}.
 * @param tools - the request's own schemas.
 * @returns true when the span may be assembled into calls.
 */
function complete(items: readonly Item[], tools: ReadonlyMap<string, ToolSchema>): boolean {
  const groups = segments(items, tools)
  const last = groups[groups.length - 1]
  if (last === undefined) return false
  const parameters = last.filter((item): item is Extract<Item, { kind: 'param' }> => item.kind === 'param')
  if (parameters.length === 0) return last.some(item => item.kind === 'tool')
  // An argument closed by its OWN closer is unambiguously finished.
  if (parameters[parameters.length - 1]?.closed === true) return true
  // Its tail was ended by something else. Two things settle what is otherwise the
  // ONE ambiguity this module cannot resolve from the text -- with a single
  // group, the same bytes are either a call whose last argument was closed by
  // its invoke closer or a call cut off mid-argument, and they are
  // byte-identical, so the reader refuses.
  //
  // A second group settles it, because a truncation would have cut the FIRST
  // call short and the later groups would not exist at all. So does a wrapper
  // the span opened and closed around everything, followed by a boundary at the
  // tail: the envelope's own closer cannot be read as the argument's -- the
  // reader skipped it as structure -- so a boundary standing there was written
  // by the model as an ending. A wrapper whose closer lands directly on the last
  // argument leaves no boundary at all, and that is a dangling argument, not a
  // finished one.
  // Its tail was ended by something else. Find that ending first, because a
  // group count on its own proves nothing: two groups can still leave the last
  // one with no closer at all, and that is a call cut off mid-argument.
  let tail = -1
  for (let index = 0; index < items.length; index += 1) if (items[index]?.kind === 'param') tail = index
  const after = tail < 0 ? undefined : items[tail + 1]
  // A boundary must actually stand there. The wrapper's own closer cannot be it:
  // separate() declined to read that one as a boundary, so it is not in the
  // items at all -- which is why the two-call shape, whose last argument the
  // envelope closes directly, is refused rather than read as finished.
  if (after === undefined || after.kind !== 'boundary') return false
  // What licenses reading that boundary as an ending is that the span is
  // provably whole. Two things prove it. A second group does: a truncation would
  // have cut the FIRST call short, so the later groups could not exist. So does
  // a wrapper the span opened and closed around everything, because a stream cut
  // off anywhere leaves the wrapper it opened still open, and this one has its
  // matching closer at the tail.
  if (groups.length > 1) return true
  // The envelope's closer settles the tail only for the shape that has no
  // invoke opener: arguments written straight under the wrapper. When the
  // last run names a tool, the model opened a real invoke element, and its
  // own closer is where that last argument should have ended -- an argument
  // that stops at the envelope instead is byte-identical to a truncation.
  if (last.some(item => item.kind === 'tool')) return false
  return items.some(item => item.kind === 'wrapper' && item.closed)
}

/**
 * The one declared tool that owns every argument name in a group.
 *
 * Two conditions, and both are needed. Every name must be declared by the tool,
 * or the call would carry a slot that tool does not have. Every name the tool
 * REQUIRES must be present, or the call would dispatch and fail on its own
 * schema -- a worse outcome than refusing it, because it looks to the model
 * like the tool ran and rejected the work.
 * @param parameters - the group's arguments.
 * @param tools - the request's own schemas.
 * @returns the owning tool's name, or undefined when none or several own it.
 */
function infer(
  parameters: readonly { readonly name: string }[],
  tools: ReadonlyMap<string, ToolSchema>,
): string | undefined {
  if (parameters.length === 0) return undefined
  let found: string | undefined
  for (const tool of tools.values()) {
    const declared = new Set(parameterNames(tool))
    const resolved = parameters.map(entry => resolveParameterName(tool, entry.name) ?? entry.name)
    if (!resolved.every(name => declared.has(name))) continue
    if (!requiredNames(tool).every(name => resolved.includes(name))) continue
    if (found !== undefined) return undefined
    found = tool.name
  }
  return found
}

/**
 * Stage 4 -- ASSEMBLE. The items of a finished span into calls.
 *
 * Groups are built first and resolved second, so one unresolvable group refuses
 * the whole span rather than letting the others run on a half-understood block.
 * Two arguments with one name cannot be one call -- no tool declares a slot
 * twice -- so a group that carries one is a run of calls the model never
 * separated, and splitting it would be inventing the boundary.
 * @param items - the ordered items from {@link separate}.
 * @param tools - the request's own schemas.
 * @returns the calls, or undefined when any group cannot be resolved.
 */
function assemble(items: readonly Item[], tools: ReadonlyMap<string, ToolSchema>): readonly SalvagedCall[] | undefined {
  const groups = segments(items, tools).map(group => ({
    tool: group.find((item): item is Extract<Item, { kind: 'tool' }> => item.kind === 'tool')?.name,
    params: group
      .filter((item): item is Extract<Item, { kind: 'param' }> => item.kind === 'param')
      .map(item => ({ name: item.name, value: item.value })),
  }))

  const calls: SalvagedCall[] = []
  for (const group of groups) {
    const seen = new Set<string>()
    for (const parameter of group.params) {
      if (seen.has(parameter.name)) return undefined
      seen.add(parameter.name)
    }
    const name = group.tool ?? infer(group.params, tools)
    if (name === undefined) return undefined
    const tool = tools.get(name)
    if (tool === undefined) return undefined
    const declared = new Set(parameterNames(tool))
    const args: Record<string, unknown> = {}
    for (const parameter of group.params) {
      const key = resolveParameterName(tool, parameter.name) ?? parameter.name
      if (!declared.has(key)) return undefined
      args[key] = coerceParameter(tool, key, parameter.value.replace(CLOSER, '').trim())
    }
    if (!requiredNames(tool).every(required => required in args)) return undefined
    calls.push({ name, arguments: JSON.stringify(args) })
  }
  return calls.length === 0 ? undefined : calls
}

/**
 * Read a block that every spelling pass refused.
 *
 * @param raw - the block exactly as the model wrote it.
 * @param tools - the request's own schemas, the only tool names that count.
 * @returns the recovered calls, or undefined when the block is not a finished
 * call -- in which case the caller shows it to the user as text, as before.
 */
export function salvageCalls(
  raw: string,
  tools: ReadonlyMap<string, ToolSchema>,
): readonly SalvagedCall[] | undefined {
  const recovered: SalvagedCall[] = []
  for (const region of identify(raw)) {
    const items = separate(region, tools)
    if (items.length === 0) continue
    if (!complete(items, tools)) return undefined
    const calls = assemble(items, tools)
    if (calls === undefined) return undefined
    recovered.push(...calls)
  }
  return recovered.length === 0 ? undefined : recovered
}
