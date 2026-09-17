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
 * @module @deepseek-ai/dsh-llm-dsml/stream
 */

import { randomUUID } from 'node:crypto'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ContentBlockType, FinishReason, StreamChunk, ToolSchema } from '@deepseek-ai/dsh-llm'
import { DsmlTranslator, trailingReasoningCalls } from './dsml.ts'
import type { DsmlEvent, DsmlOptions } from './dsml.ts'

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
  /** The text of the last reasoning block to close, and whether it closed last. */
  private reasoning: string | undefined
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
    for (const event of source.translator.push(chunk.text)) yield* this.emit(event)
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
    if (!broken) yield* this.fromReasoning()
    // A turn that produced a call is a tool-calls turn: the loop has to run the
    // call, and the provider's own `stop` was reported about a text reply it did
    // not know carried one. A provider that already said `tool-calls`, and every
    // failure reason, are left exactly as the adapter reported them.
    const reason: FinishReason = this.recovered > 0 && (chunk.reason.kind === 'stop' || chunk.reason.kind === 'max-tokens')
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
