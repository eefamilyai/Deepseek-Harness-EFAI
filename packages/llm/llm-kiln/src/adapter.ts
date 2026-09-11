/**
 * `KilnAdapter`: the Kiln provider registry as a harness {@link LlmAdapter}.
 *
 * Two translations happen here and nowhere else.
 *
 * 1. **Messages down.** The harness's structured content blocks are flattened
 *    to the plain `{role, content}` turns the registry's adapters expect. A
 *    prior tool call is re-rendered as the same DSML block the model wrote, and
 *    its result as a labelled `OUTPUT:` block, so the transcript the model
 *    reads back is written in the one format it was taught.
 * 2. **DSML up.** None of these providers speaks native tool-calling, so a
 *    `<tool_calls>` block in the reply becomes a real harness tool call for
 *    whatever tool it names — {@link DsmlTranslator}. That is what makes a
 *    text-only route — `ds_direct` above all — a usable agent here.
 *
 * The system slot carries the harness's prompt plus the transport's format
 * statement, and nothing else. No provider in the Python runtime adds text of
 * its own; the tool catalog in that statement is generated from the request's
 * own `tools`, never hand-written here.
 *
 * @module @deepseek-ai/dsh-llm-kiln/adapter
 */

import { randomUUID } from 'node:crypto'
import type { AttachmentStore, ImageAttachmentRef, ImageMediaType } from '@deepseek-ai/dsh-attachment'
import { CONTEXT_WINDOW_EXCEEDED_CODE, isContextWindowExceededError, LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import type {
  ContentBlock,
  FinishReason,
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  Message,
  StreamChunk,
  TokenUsage,
  ToolSchema,
} from '@deepseek-ai/dsh-llm'
import { DsmlTranslator, trailingReasoningCalls } from './dsml.ts'
import { DSML_CLOSE, DSML_OPEN, escapeXml, renderParameter, toolProtocolPrompt } from './protocol.ts'
import type { KilnBridge, KilnMessage, KilnProvider, KilnUploadFile } from './bridge.ts'

/** Constructor options: the sidecar and the route mapping the plugin owns. */
export interface KilnAdapterOptions {
  /** The live sidecar client. */
  readonly bridge: KilnBridge
  /** Current catalog snapshot, keyed by harness route name. */
  readonly routes: () => ReadonlyMap<string, KilnProvider>
  /** Map a harness route name back to the Kiln provider id. */
  readonly kilnId: (provider: string) => string
  /**
   * The login a route is pinned to, or undefined for a route that takes
   * whichever account the sidecar's ring offers.
   */
  readonly account?: (provider: string) => string | undefined
  /**
   * The mounted attachment service, read per request rather than captured at
   * registration: the service can be replaced by a later composition, and a
   * cached store would pin the wrong one. Absent means attached images cannot
   * be read for upload, which degrades to the placeholder rather than failing.
   */
  readonly resolveAttachments?: () => AttachmentStore | undefined
}

/**
 * Provider whose routes can carry an image.
 *
 * Only `ds_direct` has a file store to push bytes into and a turn parameter to
 * attach the resulting ids to; every other route in the registry is a plain
 * text protocol. That is a property of the sidecar, not of this adapter, so it
 * is named here in one place instead of being probed per request.
 */
const IMAGE_CAPABLE_KILN_PROVIDER = 'deepseek'

/** What one request's attached images became. */
interface ImageUpload {
  /** Provider file ids to attach to this turn, in message order. */
  readonly fileIds: readonly string[]
  /** Login owning those ids; must accompany them into the stream call. */
  readonly account?: string
  /** Substitution for each image occurrence when none were delivered. */
  readonly placeholder?: string
}

/** File extension for one media type, for the name the provider stores. */
function imageExtension(mediaType: ImageMediaType): string {
  switch (mediaType) {
    case 'image/png': return '.png'
    case 'image/jpeg': return '.jpg'
    case 'image/webp': return '.webp'
    case 'image/gif': return '.gif'
  }
}

/** Trailing image extension a display name may already carry. */
const IMAGE_EXTENSION_RE = /\.(?:png|jpe?g|webp|gif)$/iu

/**
 * Name one request image for the provider's file store.
 *
 * The digest prefix keeps two attachments that share a display name from
 * colliding, and the extension comes from the media type the attachment
 * service proved. Any extension the display name already carried is dropped
 * first, so the result has exactly one — and it is the one matching the bytes
 * — rather than accumulating a second `.png` per attempt. A name is never
 * interpreted as a path anywhere in this pipeline, so this is presentation,
 * not identity.
 */
function imageFilename(ref: ImageAttachmentRef): string {
  const digest = String(ref.attachmentId).slice('sha256:'.length, 'sha256:'.length + 8)
  const bare = ref.name === undefined || ref.name.length === 0
    ? `image-${digest}`
    : ref.name.replace(IMAGE_EXTENSION_RE, '')
  return `${bare}${imageExtension(ref.mediaType)}`
}

/** Collect attached images in request order, walking nested tool results. */
function collectImageRefs(content: readonly ContentBlock[], refs: ImageAttachmentRef[]): void {
  for (const block of content) {
    if (block.type === 'image') refs.push(block.attachment)
    else if (block.type === 'tool-result') collectImageRefs(block.content, refs)
  }
}

/**
 * Push this request's attached images into the provider's file store.
 *
 * Every image in the request is uploaded, and the returned ids ride the turn as
 * `ref_file_ids` — the one channel a route with no native attachment field has.
 * The upload's `account` is returned rather than discarded because the ids are
 * scoped to the login that stored them: attaching them to a turn served by a
 * different login names files that login cannot see.
 *
 * A route that cannot store files, a request with no images, or a store that is
 * not mounted all resolve to an empty result, which leaves the caller's
 * placeholder in place — the honest outcome, since the image genuinely did not
 * travel.
 */
async function uploadRequestImages(
  options: GenerateOptions,
  bridge: KilnBridge,
  kilnProvider: string,
  attachments: AttachmentStore | undefined,
  account: string | undefined,
): Promise<ImageUpload> {
  const refs: ImageAttachmentRef[] = []
  for (const message of options.messages) collectImageRefs(message.content, refs)
  if (refs.length === 0) return { fileIds: [] }
  if (kilnProvider !== IMAGE_CAPABLE_KILN_PROVIDER || attachments === undefined) {
    return {
      fileIds: [],
      placeholder: attachments === undefined
        ? '[an image was attached, but no attachment store is mounted to read it]'
        : '[an image was attached, which this provider cannot receive]',
    }
  }
  const files: KilnUploadFile[] = []
  for (const ref of refs) {
    const stored = await attachments.readImage(ref, options.signal)
    files.push({ name: imageFilename(ref), data: stored.data })
  }
  const result = await bridge.uploadFiles(kilnProvider, files, account, options.signal)
  if (result.files.length === 0) {
    const detail = result.errors.length > 0 ? `: ${result.errors.join('; ')}` : ''
    return { fileIds: [], placeholder: `[an image was attached but the provider rejected it${detail}]` }
  }
  // A per-file failure is not fatal to the turn: the files that did upload ride
  // it, and the placeholder for the rest is the caller-visible record of which.
  //
  // A FULLY successful upload still needs an explicit placeholder. The image
  // block must render as something, and leaving it to the caller's default made
  // a delivered image narrate itself as one the provider refused — the same
  // notice the not-capable branch emits, so the two were indistinguishable.
  const outcome = result.errors.length > 0
    ? `[${result.errors.length} attached image(s) could not be uploaded: ${result.errors.join('; ')}]`
    : '[an image was delivered to the model]'
  return {
    fileIds: result.files.map(file => file.id),
    ...result.account === undefined ? {} : { account: result.account },
    placeholder: outcome,
  }
}

/**
 * Message source kinds the sidecar must never clip away, whatever the prompt
 * budget.
 *
 * `user` is the operator's actual request: the harness appends large injected
 * context after it, so an oldest-first clip dropped the ask and left the model
 * with pages of context and no question.
 *
 * `skill-catalog` and `skill-invocation` are the recovery affordance. `tool-skill`
 * re-publishes the catalog and re-injects an always-load body precisely when
 * compaction has pruned them from the session surface, so they arrive on the
 * turn that most needs them and are then the only durable record that skills
 * exist and that this session's history can be read back from disk. They are
 * also small — a name list plus one body — so pinning them costs a fraction of
 * the context they share the budget with.
 *
 * Read as widened strings: `MessageSourceMap` is merge-extensible, and these
 * two kinds are declared by the tool-skill plugin rather than by this package,
 * so they are not literals in this program's type of `message.source`.
 */
const PINNED_SOURCE_KINDS: readonly string[] = ['user', 'skill-catalog', 'skill-invocation']

/**
 * Flatten one harness message into the registry's turn shape.
 *
 * Reasoning blocks are dropped: they are the model's own prior thinking, and
 * every one of these providers either regenerates it or rejects it on input.
 * Tool calls and results are rendered as text because that is the only channel
 * these routes have — the same convention the translator reads back.
 * @param message - the harness message.
 * @param imageText - text standing in for one image block; defaults to the
 *   provider-cannot-receive notice, and is replaced by the upload outcome when
 *   this request actually delivered the images.
 * @returns the flattened turn, or undefined when nothing survived flattening.
 */
export function flattenMessage(message: Message, imageText?: string): KilnMessage | undefined {
  const parts: string[] = []
  for (const block of message.content) {
    parts.push(...flattenBlock(block, imageText))
  }
  const content = parts.join('\n').trim()
  if (content.length === 0) return undefined
  // See PINNED_SOURCE_KINDS: these are the turns an oldest-first clip must never
  // take, because each is either the operator's actual request or the only
  // surviving record of how to recover after a compaction.
  const kind = (message.source as { kind?: string }).kind
  const pinned = kind !== undefined && PINNED_SOURCE_KINDS.includes(kind)
  return { role: message.role, content, ...pinned ? { pin: true } : {} }
}

/** Render one content block as the text these providers can carry. */
function flattenBlock(block: ContentBlock, imageText?: string): string[] {
  switch (block.type) {
    case 'text':
      return [block.text]
    case 'tool-call':
      // Echoed back as the DSML block the model wrote, so its own transcript
      // stays self-consistent and keeps demonstrating the one format.
      return [renderToolCall(block.name, block.arguments)]
    case 'tool-result': {
      const body = block.content
        .flatMap(inner => flattenBlock(inner, imageText))
        .join('\n')
      return [`OUTPUT:\n${body}`]
    }
    case 'reasoning':
      return []
    case 'image':
      // The image itself does not travel as text: it rides the turn as an
      // uploaded file reference, or it did not travel at all. The default
      // notice is the un-uploaded case, so a route that cannot store files
      // never silently implies the model saw something it did not.
      return [imageText ?? '[an image was attached, which this provider cannot receive]']
    default:
      return []
  }
}

/**
 * Render a prior harness tool call as the DSML block that produced it.
 *
 * Generic by construction: the arguments object is the schema's own, so a tool
 * added to the roster tomorrow round-trips without a line changing here.
 * @param name - the registered tool name.
 * @param args - the call's JSON arguments string.
 * @returns the DSML block, or a labelled fallback when the arguments will not parse.
 */
export function renderToolCall(name: string, args: string): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(args)
  } catch {
    return `[tool call ${name}] ${args}`
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return `[tool call ${name}] ${args}`
  }
  const lines = [DSML_OPEN, `<invoke name="${name}">`]
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (value === undefined) continue
    lines.push(`<parameter name="${key}">${escapeXml(renderParameter(value))}</parameter>`)
  }
  lines.push('</invoke>', DSML_CLOSE)
  return lines.join('\n')
}

/**
 * Build the registry's per-request options from a harness request.
 * @param options - the harness generate options.
 * @param account - the login this route is pinned to, when it is an account route.
 * @param refFileIds - provider file ids to attach to this turn, from a prior upload.
 * @returns the `opts` dict the registry's adapters read.
 */
export function requestOptions(
  options: GenerateOptions,
  account?: string,
  refFileIds?: readonly string[],
): Record<string, unknown> {
  // An auxiliary one-shot (compaction or session-title summary) must NOT thread
  // onto the conversation's persistent DeepSeek chat. That chat holds the whole
  // running transcript — for compaction it is often the very chat that just hit
  // its length limit — so appending the summarization request to it overflows
  // instantly, and the summarizer ends up "summarizing inside the full chat it
  // is trying to shrink". Route these calls to their own throwaway chat (unique
  // conv_id + `oneshot`, which ds_direct opens fresh and discards after) so the
  // summary is primed only with the compacted region it was given.
  const oneshot = options.purpose === 'compaction' || options.purpose === 'session-title'
  const convId = oneshot
    ? `${options.sessionId === undefined ? 'aux' : String(options.sessionId)}#${options.purpose}#${randomUUID()}`
    : options.sessionId === undefined ? undefined : String(options.sessionId)
  return {
    ...options.temperature !== undefined ? { temperature: options.temperature } : {},
    ...options.maxTokens !== undefined ? { max_tokens: options.maxTokens } : {},
    ...options.reasoningEffort !== undefined ? { reasoning_effort: String(options.reasoningEffort) } : {},
    // `conv_id` pins one DeepSeek web chat session per harness session, which is
    // what keeps ds_direct's server-side context aligned with ours instead of
    // opening a fresh chat on every request. Auxiliary one-shots get a unique id
    // (see above) so they never share the conversation's chat.
    ...convId !== undefined ? { conv_id: convId } : {},
    ...oneshot ? { oneshot: true } : {},
    // Which LOGIN serves the request, as opposed to which chat. Absent, the
    // sidecar takes the next account in its ring, so two agents starting near
    // each other can land on the same one; naming it is what lets a subagent be
    // kept off the account its parent is using. It is also what makes uploaded
    // file ids reachable — see `ref_file_ids` below.
    ...account !== undefined ? { account } : {},
    // Ids of files already stored under that login. This is the ONLY channel an
    // image has on these routes: the registry's adapters take no attachment
    // field, so the bytes are uploaded first and named here. Ids without their
    // owning `account` are names the serving login cannot resolve.
    ...refFileIds !== undefined && refFileIds.length > 0 ? { ref_file_ids: [...refFileIds] } : {},
  }
}

/**
 * How long the harness waits before retrying a rate-limited Kiln request.
 *
 * Matched to `DS_RATE_WAIT` in `ds_direct.py`, which is the layer that actually
 * absorbs these: the sidecar resends on this interval on its own, and this
 * value keeps the harness from retrying on a shorter one after the sidecar
 * finally gives up.
 */
export const RATE_LIMIT_RETRY_MS = 180_000

/** Provider vocabulary for a quota window, as opposed to transient overload. */
const RATE_LIMIT_RE = /rate.?limit|too many requests|请求过于频繁|访问过于频繁|too frequent|slow down|quota|\b429\b/i

/**
 * Whether a terminal provider failure is a rate limit.
 *
 * Applied only to the sidecar's structured `error` field, never to model
 * output: an answer that discusses rate limiting is not a rate-limited request.
 * @param message - the reason the sidecar reported for a failed stream.
 * @returns true when the harness should treat it as `RATE_LIMIT`.
 */
export function isRateLimit(message: string): boolean {
  return RATE_LIMIT_RE.test(message)
}

/** Index the request's tool schemas by name for the translator. */
export function toolIndex(tools: readonly ToolSchema[] | undefined): Map<string, ToolSchema> {
  return new Map((tools ?? []).map(tool => [tool.name, tool]))
}

/**
 * Mint the id for one call. These providers return no call id of their own, so
 * the adapter is the only thing that can.
 *
 * It has to be unique across the whole session, not just the response. Consumers
 * key by call id: the conversation projection resolves a call's nested
 * dispatches through `children.get(callId)`, and a result is matched to its
 * call the same way. An id derived from the block index restarts at zero every
 * response, so the first call of turn 5 carries the id of the first call of
 * turn 1 — and every one of those rows then renders the newest call's children
 * and output. The transcript reads as if the model kept re-running one thing.
 *
 * A per-process counter would not fix it either: a resumed session replays call
 * ids out of its log, and a fresh process counting from zero would collide with
 * them all over again.
 * @param name - the tool being called, kept in the id so it stays legible in a log.
 * @returns a session-unique call id.
 */
export function mintCallId(name: string): ToolCallId {
  return ToolCallId(`kiln-${name}-${randomUUID()}`)
}

/** The Kiln registry as one harness adapter over many routes. */
export class KilnAdapter extends LlmAdapter {
  private readonly options: KilnAdapterOptions

  constructor(options: KilnAdapterOptions) {
    super()
    this.options = options
  }

  override providerInfo(provider: string): LlmProviderInfo {
    const entry = this.options.routes().get(provider)
    const name = entry?.name ?? provider
    // An account-pinned route shares its provider's display name, so without
    // the login the picker would show several identical rows that behave
    // differently.
    const account = this.options.account?.(provider)
    return { id: provider, name: account === undefined ? name : `${name} (${account})` }
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const entry = this.options.routes().get(provider)
    if (entry === undefined) return Promise.resolve([])
    // `advertised` is the fallback for a route that lists nothing until it is
    // configured — ds_direct without a token, above all. Without it the route
    // would be invisible in a picker, and invisible is unconfigurable.
    const models = entry.models.length > 0 ? entry.models : entry.advertised
    return Promise.resolve(models.map(model => ({
      provider,
      id: model.id,
      name: model.name,
    })))
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const entry = this.options.routes().get(provider)
    const known = [...entry?.models ?? [], ...entry?.advertised ?? []]
      .find(candidate => candidate.id === model)
    return Promise.resolve({
      provider,
      id: model,
      name: known?.name ?? model,
      ...known?.context_limit !== undefined && known.context_limit > 0
        ? { context: { contextWindow: known.context_limit } }
        : {},
      // Image capability is declared on the ROUTE, not on the model: the
      // registry's model list says nothing about attachments, and the only
      // thing that decides whether an image can travel is whether the sidecar
      // can store it. Without this the runtime projects every image to a
      // text placeholder BEFORE dispatch — the adapter would never see one, and
      // uploading in `stream` would be dead code.
      ...this.imagesSupported(provider) ? { inputModalities: ['text', 'image'] as const } : {},
    })
  }

  /**
   * Whether images can reach the model on one route.
   *
   * True only where the sidecar can store the bytes and attach the ids: the
   * free DeepSeek web session. Every other route in the registry is a text
   * protocol with no file store, so declaring otherwise would promise a
   * capability the upload path then refuses.
   */
  private imagesSupported(provider: string): boolean {
    return this.options.kilnId(provider) === IMAGE_CAPABLE_KILN_PROVIDER
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const kilnProvider = this.options.kilnId(options.provider)
    const routeAccount = this.options.account?.(options.provider)
    // Attached images are pushed into the provider's own file store before the
    // turn is assembled, because the ids are the only way they can ride it: this
    // route has no native attachment field, so an image that is not uploaded
    // here cannot be shown to the model at all. The upload's own account wins
    // over the route's — ids are scoped to the login that stored them, and a
    // route pinned to a different login would otherwise name files it cannot see.
    const upload = await uploadRequestImages(
      options,
      this.options.bridge,
      kilnProvider,
      this.options.resolveAttachments?.(),
      routeAccount,
    )
    const messages = buildTurns(options, upload.placeholder)
    const events = this.options.bridge.stream({
      provider: kilnProvider,
      model: options.model,
      messages,
      opts: requestOptions(options, upload.account ?? routeAccount, upload.fileIds),
    }, options.signal)

    const emitter = new ChunkEmitter(toolIndex(options.tools))
    for await (const event of events) {
      switch (event.type) {
        case 'reasoning':
          yield* emitter.reasoning(event.text ?? '')
          break
        case 'content':
          yield* emitter.text(event.text ?? '')
          break
        case 'notice':
          // Busy-retry status and similar operational notices are the
          // provider talking about itself, not model output. They belong in
          // reasoning, where a UI shows them without polluting the answer.
          yield* emitter.reasoning(event.text ?? '')
          break
        case 'meta':
          emitter.observeMeta(event.finish, event.usage, event.error)
          break
        default:
          // `refs` (web-search citations) and `title` carry no chunk of their
          // own in this vocabulary; they are dropped rather than guessed at.
          break
      }
    }
    yield* emitter.finish()
  }
}

/**
 * Assemble the registry's message list: the system slot, then the flattened
 * conversation.
 *
 * The system slot is the harness's own prompt plus the transport's format
 * statement — the encoding these providers need in order to have a tool
 * channel at all — and nothing else. The statement's tool catalog is generated
 * from `options.tools`, so it describes the roster the harness actually
 * composed for this request.
 * @param options - the harness generate options.
 * @param imageText - text standing in for each image block; see {@link flattenMessage}.
 * @returns the turns to send.
 */
export function buildTurns(options: GenerateOptions, imageText?: string): KilnMessage[] {
  const parts: string[] = []
  if (options.system !== undefined && options.system.length > 0) parts.push(options.system)
  const protocol = toolProtocolPrompt(options.tools)
  if (protocol.length > 0) parts.push(protocol)
  const system = parts.join('\n\n')
  const turns: KilnMessage[] = []
  if (system.length > 0) {
    turns.push({ role: 'system', content: system })
  }
  for (const message of options.messages) {
    const turn = flattenMessage(message, imageText)
    if (turn !== undefined) turns.push(turn)
  }
  return turns
}

/**
 * Turns provider events into a well-formed harness chunk stream.
 *
 * The block-index bookkeeping lives here because the contract is strict: every
 * block opens with `block-start`, closes with `block-end` carrying the whole
 * block, and indices never repeat. Text and a tool call are separate blocks, so
 * a DSML block must close the preceding text before the tool call opens —
 * exactly the sequencing a naive translation gets wrong.
 */
class ChunkEmitter {
  private index = -1
  private open: 'text' | 'reasoning' | undefined
  private buffer = ''
  private readonly dsml: DsmlTranslator
  private readonly tools: ReadonlyMap<string, ToolSchema>
  private calls = 0
  private usage: TokenUsage | undefined
  private finishHint: string | undefined
  private errorText: string | undefined

  constructor(tools: ReadonlyMap<string, ToolSchema>) {
    this.tools = tools
    this.dsml = new DsmlTranslator(tools)
  }

  /** Emit reasoning text, opening or continuing the reasoning block. */
  *reasoning(text: string): Generator<StreamChunk> {
    if (text.length === 0) return
    if (this.open !== 'reasoning') {
      yield* this.close()
      this.index += 1
      this.open = 'reasoning'
      this.buffer = ''
      yield { type: 'block-start', index: this.index, blockType: 'reasoning' }
    }
    this.buffer += text
    yield { type: 'reasoning-delta', index: this.index, text }
  }

  /** Feed visible provider text through the DSML translator. */
  *text(chunk: string): Generator<StreamChunk> {
    for (const event of this.dsml.push(chunk)) {
      yield* this.emit(event)
    }
  }

  private *emit(event: { kind: 'text'; text: string } | { kind: 'tool-call'; name: string; arguments: string }): Generator<StreamChunk> {
    if (event.kind === 'text') yield* this.visible(event.text)
    else yield* this.call(event.name, event.arguments)
  }

  private *visible(text: string): Generator<StreamChunk> {
    if (text.length === 0) return
    if (this.open !== 'text') {
      yield* this.close()
      this.index += 1
      this.open = 'text'
      this.buffer = ''
      yield { type: 'block-start', index: this.index, blockType: 'text' }
    }
    this.buffer += text
    yield { type: 'text-delta', index: this.index, text }
  }

  private *call(name: string, args: string): Generator<StreamChunk> {
    yield* this.close()
    this.index += 1
    this.calls += 1
    const id = mintCallId(name)
    yield { type: 'block-start', index: this.index, blockType: 'tool-call' }
    yield { type: 'tool-call-delta', index: this.index, id, name, argumentsDelta: args }
    yield {
      type: 'block-end',
      index: this.index,
      block: { type: 'tool-call', id, name, arguments: args },
    }
    this.open = undefined
    this.buffer = ''
  }

  /** Close whatever block is open, emitting its `block-end`. */
  private *close(): Generator<StreamChunk> {
    const open = this.open
    if (open === undefined) return
    const block: ContentBlock = open === 'text'
      ? { type: 'text', text: this.buffer }
      : { type: 'reasoning', text: this.buffer }
    yield { type: 'block-end', index: this.index, block }
    this.open = undefined
    this.buffer = ''
  }

  /** Record the registry's terminal metadata for {@link finish}. */
  observeMeta(
    finish: string | undefined,
    usage: { input?: number; output?: number; reasoning?: number; cache_read?: number } | undefined,
    error?: string,
  ): void {
    if (finish !== undefined) this.finishHint = finish
    if (error !== undefined && error.length > 0) this.errorText = error
    if (usage !== undefined) {
      this.usage = {
        inputTokens: usage.input ?? 0,
        outputTokens: usage.output ?? 0,
        ...usage.cache_read !== undefined ? { cacheReadTokens: usage.cache_read } : {},
        ...usage.reasoning !== undefined ? { reasoningTokens: usage.reasoning } : {},
      }
    }
  }

  /**
   * Recover a call the model left in its reasoning channel.
   *
   * When the turn produced no call and its last open block is reasoning, a
   * complete `<tool_calls>` block at the tail of that reasoning is the action the
   * model meant to take but wrote in the wrong channel — the content scanner
   * never saw it, so the turn would otherwise end having run nothing. Emit it as
   * a real call ({@link call} closes the reasoning block first, so the thought
   * still survives verbatim ahead of the call it ended on). Does nothing for a
   * truncated or mid-thought block, or when a content-channel call already ran.
   */
  private *recoverReasoningCall(): Generator<StreamChunk> {
    if (this.open !== 'reasoning' || this.calls > 0) return
    const recovered = trailingReasoningCalls(this.buffer, this.tools)
    if (recovered === undefined) return
    for (const recoveredCall of recovered) yield* this.call(recoveredCall.name, recoveredCall.arguments)
  }

  /** Flush the translator, close the last block, and finish the stream. */
  *finish(): Generator<StreamChunk> {
    for (const event of this.dsml.end()) {
      yield* this.emit(event)
    }
    yield* this.recoverReasoningCall()
    yield* this.close()
    if (this.usage !== undefined) yield { type: 'usage', usage: this.usage }
    yield { type: 'finish', reason: this.reason() }
  }

  private reason(): FinishReason {
    // A turn that produced a call is a tool-calls turn regardless of what the
    // provider said about its own stop condition: the loop must run the call.
    if (this.calls > 0) return { kind: 'tool-calls' }
    if (this.finishHint === 'error') {
      const message = this.errorText ?? 'the Kiln provider reported an error'
      // A full DeepSeek chat ("length limit reached") is a context overflow, not
      // a transport fault. Reported under the canonical code, it triggers the
      // harness's context-overflow path — the same compaction as `/compact` —
      // which summarizes the history and retries, instead of failing the turn.
      if (isContextWindowExceededError(message)) {
        return { kind: 'error', failure: { message, code: CONTEXT_WINDOW_EXCEEDED_CODE } }
      }
      // A rate limit is not a transport fault, and the difference is not
      // cosmetic: the retry policy backs a TRANSPORT failure off in
      // milliseconds, which against a quota window is just a faster way to stay
      // blocked. `providerRetryAfterMs` makes the harness wait the same
      // interval the sidecar does.
      if (isRateLimit(message)) {
        return {
          kind: 'error',
          failure: {
            message,
            code: 'RATE_LIMIT',
            status: 429,
            providerRetryAfterMs: RATE_LIMIT_RETRY_MS,
          },
        }
      }
      return { kind: 'error', failure: { message, code: 'TRANSPORT' } }
    }
    if (this.finishHint === 'length') return { kind: 'max-tokens' }
    return { kind: 'stop' }
  }
}
