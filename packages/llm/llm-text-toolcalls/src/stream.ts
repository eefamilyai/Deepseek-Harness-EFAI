/**
 * The DSML reader as a filter over an ASSEMBLED provider stream.
 *
 * {@link DsmlTranslator} reads text. This reads a {@link StreamChunk} stream —
 * which is what every adapter in the harness already produces, native tool
 * channel or not — so one pass can sit above all of them and turn a tool call
 * the model wrote as text into the same chunks an adapter with a real tool
 * field would have emitted.
 *
 * Two properties make that safe to run over a stream some adapter already read:
 *
 *   * **Silent by default.** With {@link DsmlOptions.notes} off, the reader
 *     converts what it can and passes every other character through as written,
 *     so a block the adapter deliberately left visible stays exactly as the
 *     adapter left it, with no second opinion stapled to it.
 *   * **Only whole calls for declared tools.** The same rule the text reader
 *     obeys: a block naming a tool this request never declared is prose, and so
 *     is a call still being written.
 *
 * The block-index bookkeeping is the delicate part. A text block that turns out
 * to contain a call must close before the call's block opens, and indices must
 * neither repeat nor be reused, so this pass mints its OWN indices and maps the
 * provider's onto them rather than trying to edit them in place.
 *
 * @module @deepseek-ai/dsh-llm-text-toolcalls/stream
 */

import { randomUUID } from 'node:crypto'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ContentBlockType, FinishReason, StreamChunk, ToolSchema } from '@deepseek-ai/dsh-llm'
import { DsmlTranslator, GLITCH_RUN_DEFAULT, glitchRun, trailingReasoningCalls } from './dsml.ts'
import type { DsmlEvent, DsmlOptions } from './dsml.ts'
import { bumpShapes } from './catalog.ts'

/** How this pass reads one provider stream. */
export interface DsmlStreamOptions extends DsmlOptions {
  /**
   * Whether to recover a complete call left at the tail of the REASONING
   * channel when the turn otherwise produced none.
   *
   * A reasoning stream is the model talking to itself, and a call written there
   * was written in the wrong channel — but a turn that ends having run nothing,
   * with the action visible in a channel the user never sees, is the most
   * expensive failure this transport has. Recovery is refused the moment the
   * turn produced a call of its own, and refused for anything but a whole call
   * at the very end of the thought.
   */
  readonly reasoningRecovery?: boolean
}

/**
 * What the model is told when a closer run cuts its turn short.
 *
 * Deliberately free of tag literals: the note is prose, and writing the tags
 * back would teach the shape being refused.
 */
const GLITCH_NOTE =
  '\n\n[stopped: you repeated structural closers with no call between them. '
  + 'Nothing in that run was a call. Write the call you meant, once.]\n'

/** Mint a call id for a call this pass recovered rather than the provider issuing. */
export function mintDsmlCallId(name: string): ToolCallId {
  return ToolCallId(`dsml-${name}-${randomUUID()}`)
}

/**
 * Whether a finish reason means the turn ARRIVED rather than broke.
 *
 * A call recovered out of a stream that errored or was cancelled must never
 * dispatch: the text it was parsed from is a fragment of a turn that did not
 * finish, and running it is the harness acting on something the model may not
 * have finished asking for. Its text still surfaces, so nothing is hidden.
 */
function settled(reason: FinishReason): boolean {
  return reason.kind !== 'error' && reason.kind !== 'aborted'
}

/**
 * One provider stream being rewritten: the provider's block indices on the way
 * in, this pass's own on the way out.
 */
class DsmlStreamReader {
  /** The last index this pass handed out; the next block takes `index + 1`. */
  private index = -1
  /** Provider block index to output block index, for blocks forwarded as they are. */
  private readonly forwarded = new Map<number, number>()
  /** The provider text block being read, and the reader consuming it. */
  private source: { readonly index: number; readonly translator: DsmlTranslator } | undefined
  /** The output text block this pass has open, and the text assembled into it. */
  private open: { index: number; text: string } | undefined
  /** Calls seen or made this turn, native and recovered. */
  private calls = 0
  /** Calls this pass made, which is what can change the finish reason. */
  private recovered = 0
  /**
   * Every catalogue shape this turn's readers repaired, across all its text
   * blocks. A turn is the unit the catalogue is written in: the cost of the
   * file is the read and the write, so one pass per turn keeps a chatty model
   * from turning repairs into a per-token disk workload.
   */
  private readonly repaired = new Set<string>()
  /** The text of the last reasoning block to close, and whether it closed last. */
  private reasoning: string | undefined
  /**
   * DSH-FORK(fix): set once a run of closer-only lines proves the model is
   * repeating structure instead of writing a call. From then on this pass
   * emits no further text: the loop is cut here, and the note tells the model
   * to write the call again rather than re-emit the run.
   * EXIT: upstream detects closer spam and halts a turn.
   */
  private halted = false
  /** Rolling tail of the text block being read, for the closer-run test. */
  private tail = ''
  private readonly tools: ReadonlyMap<string, ToolSchema>
  private readonly options: DsmlStreamOptions

  constructor(tools: ReadonlyMap<string, ToolSchema>, options: DsmlStreamOptions) {
    this.tools = tools
    this.options = options
  }

  /** Read one provider chunk, yielding this pass's chunks for it. */
  *read(chunk: StreamChunk): Generator<StreamChunk> {
    switch (chunk.type) {
      case 'block-start':
        yield* this.start(chunk.index, chunk.blockType)
        return
      case 'text-delta':
        yield* this.delta(chunk)
        return
      case 'block-end':
        yield* this.end(chunk)
        return
      case 'finish':
        yield* this.finish(chunk)
        return
      default:
        yield* this.forward(chunk)
    }
  }

  /** Flush a stream that ended without its terminal `finish`. */
  *close(): Generator<StreamChunk> {
    yield* this.flush(true)
    yield* this.closeText()
    this.record()
  }

  /**
   * Whether this pass cut the provider stream short.
   *
   * The owner of the stream asks this after every chunk: true means stop
   * pulling, because the generation the provider is still producing is the loop
   * this pass just refused.
   * @returns true once a structural-spam run ended the turn.
   */
  stopped(): boolean {
    return this.halted
  }

  /**
   * The terminal chunk for a stream this pass cut short.
   *
   * {@link close} cannot serve here: a stream that stopped without its terminal
   * chunk is a protocol failure, and its recovered calls must not dispatch. This
   * one IS the terminal chunk, so the call written before the spam is read and
   * run -- which is what makes the cut a repair rather than a lost turn.
   *
   * The reason is the whole of what happens next. A turn that produced a call is
   * a tool-calls turn, so the call runs and the model continues from its result.
   * A turn that produced none is `stop`: the note already told the model what it
   * did, and inventing a call to keep the loop alive would run something the
   * model never finished asking for.
   * @returns the flush, the note already emitted, and the finish.
   */
  *halt(): Generator<StreamChunk> {
    yield* this.flush(false)
    yield* this.closeText()
    this.record()
    const reason: FinishReason = this.calls > 0 ? { kind: 'tool-calls' } : { kind: 'stop' }
    yield { type: 'finish', reason }
  }

  /**
   * Write this turn's repairs to the catalogue, once, at the turn's end.
   *
   * Best-effort and silent: `bumpShapes` returns false for every failure and
   * for a reader no one asked to count, and a turn that cannot write a
   * diagnostics file still runs the calls it repaired.
   */
  private record(): void {
    if (this.repaired.size === 0) return
    bumpShapes([...this.repaired])
  }

  private *start(index: number, blockType: ContentBlockType): Generator<StreamChunk> {
    // A text block is not forwarded: what it becomes depends on what it says,
    // and that is not known until its deltas have been read.
    if (blockType === 'text') {
      this.source = { index, translator: new DsmlTranslator(this.tools, this.options) }
      return
    }
    if (blockType === 'tool-call') this.calls += 1
    yield* this.closeText()
    this.index += 1
    this.forwarded.set(index, this.index)
    yield { type: 'block-start', index: this.index, blockType }
  }

  private *delta(chunk: StreamChunk & { type: 'text-delta' }): Generator<StreamChunk> {
    const source = this.source
    if (source === undefined || source.index !== chunk.index) {
      yield* this.forward(chunk)
      return
    }
    // Once halted, later deltas are the same run continuing: drop them rather
    // than streaming the spam the reader just refused.
    if (this.halted) return
    for (const event of source.translator.push(chunk.text)) yield* this.emit(event)
    // DSH-FORK(fix): a run of STRUCTURAL-ONLY lines is the model stuck, not a
    // call -- and a model looping on OPENERS writes the same pathology in a
    // shape the closer-only test could not see, so the loop streamed on.
    // Stop emitting text for this turn and say so once, so the next turn can
    // start clean; the caller stops pulling the provider on `stopped()`.
    // EXIT: upstream detects structural spam in any spelling.
    this.tail = (this.tail + chunk.text).slice(-4000)
    if (glitchRun(this.tail) >= GLITCH_RUN_DEFAULT) {
      this.halted = true
      this.repaired.add('closer-spam')
      yield* this.text(GLITCH_NOTE)
    }
  }

  private *end(chunk: StreamChunk & { type: 'block-end' }): Generator<StreamChunk> {
    if (this.source?.index === chunk.index) {
      // The provider's own `block-end` carries the text it assembled; this pass
      // discards it and closes the block it actually emitted, whose text is what
      // survived translation.
      yield* this.flush(false)
      yield* this.closeText()
      return
    }
    if (chunk.block.type === 'reasoning') this.reasoning = chunk.block.text
    else if (chunk.block.type !== 'text') this.reasoning = undefined
    yield* this.forward(chunk)
  }

  private *finish(chunk: StreamChunk & { type: 'finish' }): Generator<StreamChunk> {
    const broken = !settled(chunk.reason)
    yield* this.flush(broken)
    yield* this.closeText()
    this.record()
    if (!broken) yield* this.fromReasoning()
    // A turn that produced a call is a tool-calls turn: the loop has to run the
    // call, and the provider's own `stop` was reported about a text reply it did
    // not know carried one. A provider that already said `tool-calls`, and every
    // failure reason, are left exactly as the adapter reported them.
    const reason: FinishReason = this.halted
      ? (this.calls > 0 ? { kind: 'tool-calls' } : { kind: 'stop' })
      : this.recovered > 0 && (chunk.reason.kind === 'stop' || chunk.reason.kind === 'max-tokens')
        ? { kind: 'tool-calls' }
        : chunk.reason
    yield { ...chunk, reason }
  }

  /**
   * Flush the open reader at end of block or stream.
   * @param textOnly - drop recovered calls, keeping their text; used when the
   * stream broke, where a call parsed out of a fragment must not dispatch.
   */
  private *flush(textOnly: boolean): Generator<StreamChunk> {
    const source = this.source
    if (source === undefined) return
    this.source = undefined
    // Collect before the reader is dropped: this is the only point a text
    // block's repairs are still readable, and the set spans every block of the
    // turn because the catalogue is written once, per turn.
    for (const id of source.translator.repairedShapes()) this.repaired.add(id)
    for (const event of source.translator.end()) {
      if (textOnly && event.kind === 'tool-call') continue
      yield* this.emit(event)
    }
  }

  /** Recover a call the model left at the tail of its reasoning. */
  private *fromReasoning(): Generator<StreamChunk> {
    const reasoning = this.reasoning
    if (reasoning === undefined || this.calls > 0) return
    if (this.options.reasoningRecovery === false) return
    const calls = trailingReasoningCalls(reasoning, this.tools, this.options)
    if (calls === undefined) return
    for (const call of calls) yield* this.call(call.name, call.arguments)
  }

  private *emit(event: DsmlEvent): Generator<StreamChunk> {
    if (event.kind === 'text') yield* this.text(event.text)
    else yield* this.call(event.name, event.arguments)
  }

  private *text(text: string): Generator<StreamChunk> {
    if (text.length === 0) return
    let open = this.open
    if (open === undefined) {
      // Visible text after a thought means the thought is no longer the tail of
      // the turn, so nothing can be recovered from it any more.
      this.reasoning = undefined
      this.index += 1
      open = { index: this.index, text: '' }
      this.open = open
      yield { type: 'block-start', index: open.index, blockType: 'text' }
    }
    open.text += text
    yield { type: 'text-delta', index: open.index, text }
  }

  private *call(name: string, args: string): Generator<StreamChunk> {
    yield* this.closeText()
    this.index += 1
    this.calls += 1
    this.recovered += 1
    // The reasoning tail is consumed by the call it produced: a second flush
    // must not recover the same call twice.
    this.reasoning = undefined
    const id = mintDsmlCallId(name)
    yield { type: 'block-start', index: this.index, blockType: 'tool-call' }
    yield { type: 'tool-call-delta', index: this.index, id, name, argumentsDelta: args }
    yield { type: 'block-end', index: this.index, block: { type: 'tool-call', id, name, arguments: args } }
  }

  private *closeText(): Generator<StreamChunk> {
    const open = this.open
    if (open === undefined) return
    this.open = undefined
    yield { type: 'block-end', index: open.index, block: { type: 'text', text: open.text } }
  }

  /** Forward one chunk under this pass's index for its block. */
  private *forward(chunk: StreamChunk): Generator<StreamChunk> {
    if (!('index' in chunk)) {
      yield chunk
      return
    }
    const index = this.forwarded.get(chunk.index)
    if (index === undefined) {
      yield chunk
      return
    }
    if (chunk.type === 'block-end') this.forwarded.delete(chunk.index)
    yield { ...chunk, index }
  }
}

/**
 * Read DSML tool calls out of one provider stream.
 *
 * @param source - the adapter's chunk stream.
 * @param tools - the request's declared tool schemas, keyed by name. An empty
 * map returns the stream untouched: with no tools declared, every `<invoke>` is
 * prose about a tool that does not exist here.
 * @param options - see {@link DsmlStreamOptions}.
 * @returns the stream with text-channel tool calls promoted to real ones.
 */
export function readDsmlStream(
  source: AsyncIterable<StreamChunk>,
  tools: ReadonlyMap<string, ToolSchema>,
  options: DsmlStreamOptions = {},
): AsyncIterable<StreamChunk> {
  if (tools.size === 0) return source
  return (async function* (): AsyncIterable<StreamChunk> {
    const reader = new DsmlStreamReader(tools, { notes: false, ...options })
    let finished = false
    for await (const chunk of source) {
      if (chunk.type === 'finish') finished = true
      yield* reader.read(chunk)
      // DSH-FORK(fix): the reader cut the turn at a structural-spam run. Leaving
      // the loop is what actually ends the generation -- the provider stops
      // being pulled at all -- and this pass then owes the caller the terminal
      // chunk the provider will never send.
      // EXIT: upstream stops reading a provider stream mid-turn.
      if (reader.stopped() && !finished) {
        yield* reader.halt()
        return
      }
    }
    // A stream that stopped without its terminal chunk is already a protocol
    // failure the invariant layer reports; flushing here keeps this pass from
    // ALSO swallowing the text it had buffered when that happened.
    if (!finished) yield* reader.close()
  })()
}

/** Index a request's tool schemas by name, the shape every reader here takes. */
export function toolIndex(tools: readonly ToolSchema[] | undefined): Map<string, ToolSchema> {
  return new Map((tools ?? []).map(tool => [tool.name, tool]))
}
