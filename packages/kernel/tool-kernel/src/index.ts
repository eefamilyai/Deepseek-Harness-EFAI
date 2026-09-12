/**
 * The model-facing `kernel` tool: run Python in a persistent namespace.
 *
 * In a composition built around this package the kernel is not one tool among
 * many — it is the model's entire hands. Reading a file, editing it, searching
 * the disk, running a command, driving a browser: all of it is Python, written
 * against the helpers the Kiln runtime preloads into the namespace. That is why
 * the roster this package expects to sit in has web access and nothing else
 * beside it. Where a conventional harness gives the model twenty narrow verbs,
 * this one gives it a programming language and a live interpreter.
 *
 * Execution goes through `ctx.kernel`; this module owns only the model-facing
 * schema, prompt guidance, and result presentation — never process lifetime or
 * the wire protocol.
 * @module @deepseek-ai/dsh-tool-kernel
 */

import { Buffer } from 'node:buffer'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { AttachmentStore, ImageAttachmentRef, ImageMediaType } from '@deepseek-ai/dsh-attachment'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView, GenericResultView, ToolResult } from '@deepseek-ai/dsh-tools'
import type { KernelCellImage } from '@deepseek-ai/dsh-kernel'
import type {} from '@deepseek-ai/dsh-system-prompt'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'tool-kernel'

/**
 * Services required by the kernel tool.
 *
 * `attachments` is required: a cell that returns an image can only hand it on
 * through the durable store, and a kernel tool that silently dropped pictures
 * would be worse than one that refuses the call.
 */
export const inject = ['tools', 'kernel', 'systemPrompt', 'attachments']

/** Default cooperative tool-call budget (ms), matching the Kiln kernel's own default. */
export const DEFAULT_KERNEL_TIMEOUT_MS = 180_000

/**
 * Extra time the TOOL gets on top of the cell budget.
 *
 * Two timeouts race over one call: the harness's tool-call policy and the
 * kernel's own cell budget. Given equal deadlines the harness usually wins, and
 * the model gets a bare "tool timed out" — losing the fact that matters most,
 * that the kernel restarted and the namespace is empty. The grace period makes
 * the kernel's own path win, so the model is told what it actually lost.
 */
export const TOOL_TIMEOUT_GRACE_MS = 15_000

/** Upper bound on the output characters returned for one cell. */
export const DEFAULT_MAX_OUTPUT_CHARS = 200_000
/** Upper bound on an AI-chosen per-cell timeout (ms). */
export const DEFAULT_MAX_TIMEOUT_MS = 600_000
/**
 * Default SECONDARY budget (ms): how long a cell that overran its primary budget
 * may keep running in the background before the kernel force-stops it. Much more
 * generous than the primary — the point of backgrounding is to let a long job
 * finish while the model works on, so the stop deadline is measured in tens of
 * minutes, not the primary's few.
 */
export const DEFAULT_BACKGROUND_TIMEOUT_MS = 1_800_000

/** Plugin config: the per-cell budget and the output cap. */
export interface Config {
  /** PRIMARY cooperative budget (ms) for one cell; on expiry the cell backgrounds. Defaults to 180000. */
  timeoutMs?: number
  /** Cap on returned output characters for one cell. Defaults to 200000. */
  maxOutputChars?: number
  /** Upper bound on a model-chosen per-cell (primary) timeout (ms). Defaults to 600000. */
  maxTimeoutMs?: number
  /** SECONDARY budget (ms): when a backgrounded cell is force-stopped. Defaults to 1800000. */
  backgroundTimeoutMs?: number
}

export const Config: z<Config> = z.object({
  timeoutMs: z.number().step(1).min(1).default(DEFAULT_KERNEL_TIMEOUT_MS),
  maxOutputChars: z.number().step(1).min(1).default(DEFAULT_MAX_OUTPUT_CHARS),
  maxTimeoutMs: z.number().step(1).min(1).default(DEFAULT_MAX_TIMEOUT_MS),
  backgroundTimeoutMs: z.number().step(1).min(1).default(DEFAULT_BACKGROUND_TIMEOUT_MS),
})

/** Complete config after schemastery applies every field default. */
type ResolvedConfig = Required<Config>

/** One stored cell image, in the shape the output schema declares. */
export interface KernelValueImage {
  attachmentId: string
  mediaType: ImageMediaType
  bytes: number
  width: number
  height: number
  name?: string
  /** Orientation-applied dimensions before normalization; present only when storage reduced it. */
  originalDimensions?: { width: number; height: number }
  /** Caption the cell attached for the model. */
  note?: string
}

/**
 * Output-schema shape of one stored image.
 *
 * Deliberately carries no top-level `required`. This node is used as an array's
 * `items`, and the value schema DSL only accepts `required` on a *property*
 * (`allowRequired` is false for `items` and `oneOf` branches), so a `required`
 * here fails the whole tool at mount time. Requiredness belongs to the `images`
 * property that holds the array, which is where it is declared.
 */
const IMAGE_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    attachmentId: { type: 'string', required: true },
    mediaType: { type: 'string', enum: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'], required: true },
    bytes: { type: 'integer', required: true },
    width: { type: 'integer', required: true },
    height: { type: 'integer', required: true },
    name: { type: 'string' },
    originalDimensions: {
      type: 'object',
      additionalProperties: false,
      properties: {
        width: { type: 'integer', required: true },
        height: { type: 'integer', required: true },
      },
    },
    note: { type: 'string' },
  },
} as const

/** Name one returned image in a diagnostic, preferring its display name. */
function imageLabel(image: KernelCellImage): string {
  const name = image.name === undefined ? 'image' : `"${image.name}"`
  return `${name} (${image.mediaType}, ${image.bytes} bytes)`
}

/**
 * Commit one cell's returned images to the durable attachment store.
 *
 * Each image is validated and normalized by the store, so a cell cannot put
 * bytes into the transcript that no provider would accept. The store enforces
 * its own batch limits, which may be tighter than the kernel's per-cell caps —
 * so a refused batch is retried one image at a time, and a single oversized or
 * unreadable picture costs only itself.
 *
 * Never throws. A cell that produced a good traceback must still deliver it
 * even when one of its pictures cannot be stored, so every failure comes back
 * as a note to show beside the text.
 * @param attachments - the deployment attachment store.
 * @param images - images as they crossed the process boundary.
 * @param signal - cancellation for the storage work.
 * @returns durable references in the order they were committed, and one
 *   human-readable note per image that could not be committed.
 */
export async function admitCellImages(
  attachments: AttachmentStore,
  images: readonly KernelCellImage[],
  signal?: AbortSignal,
): Promise<{ refs: ImageAttachmentRef[]; notes: string[] }> {
  const notes: string[] = []
  const accepted: KernelCellImage[] = []
  for (const image of images) {
    // The store is the authority on accepted types; refusing here rather than
    // letting it throw keeps one unsupported type from costing the whole cell.
    if (attachments.imageLimits.mediaTypes.includes(image.mediaType)) accepted.push(image)
    else notes.push(`${imageLabel(image)} was not stored: ${image.mediaType} is not accepted by this deployment.`)
  }
  if (accepted.length === 0) return { refs: [], notes }

  const inputs = accepted.map(image => ({
    data: new Uint8Array(Buffer.from(image.data, 'base64')),
    mediaType: image.mediaType as ImageMediaType,
    ...image.name === undefined ? {} : { name: image.name },
  }))

  try {
    const refs = await attachments.saveImages(inputs)
    return { refs: [...refs], notes }
  } catch {
    // The batch was refused as a whole — most often its aggregate byte or
    // count bound. Retry one at a time so a single bad member cannot take the
    // good ones down with it.
  }

  const refs: ImageAttachmentRef[] = []
  for (const [index, input] of inputs.entries()) {
    signal?.throwIfAborted()
    try {
      refs.push(await attachments.saveImage(input))
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : String(error)
      notes.push(`${imageLabel(accepted[index] as KernelCellImage)} was not stored: ${reason}`)
    }
  }
  return { refs, notes }
}

/** Project one stored attachment plus its caption into the declared output shape. */
function valueImageFrom(
  ref: ImageAttachmentRef,
  note: string | undefined,
): KernelValueImage {
  return {
    attachmentId: ref.attachmentId,
    mediaType: ref.mediaType,
    bytes: ref.bytes,
    width: ref.width,
    height: ref.height,
    ...ref.name === undefined ? {} : { name: ref.name },
    ...ref.originalDimensions === undefined ? {} : {
      originalDimensions: { ...ref.originalDimensions },
    },
    ...note === undefined ? {} : { note },
  }
}

/**
 * Re-brand one structured image outcome into the reference an image block carries.
 * @param image - the image metadata from the output schema.
 * @returns the branded attachment reference.
 */
export function imageRefFromValue(image: KernelValueImage): ImageAttachmentRef {
  return {
    attachmentId: AttachmentId(image.attachmentId),
    mediaType: image.mediaType,
    bytes: image.bytes,
    width: image.width,
    height: image.height,
    ...image.name === undefined ? {} : { name: image.name },
    ...image.originalDimensions === undefined ? {} : {
      originalDimensions: { ...image.originalDimensions },
    },
  }
}

/**
 * Format one stored cell image as the envelope line beside its picture.
 *
 * The envelope carries the stored dimensions and the caption the cell attached,
 * so the model can tell what it is looking at without spending a call to ask.
 * @param image - the image metadata from the output schema.
 * @returns the model-facing envelope.
 */
export function formatImageNote(image: KernelValueImage): string {
  const name = image.name === undefined ? 'image' : `"${image.name}"`
  const scaled = image.originalDimensions === undefined
    ? ''
    : ` (downscaled from ${image.originalDimensions.width}x${image.originalDimensions.height} px)`
  const caption = image.note === undefined ? '' : ` \u2014 ${image.note}`
  return `[${name}: ${image.mediaType}, ${image.width}x${image.height} px, ${image.bytes} bytes${scaled}${caption}]`
}

/**
 * Project one cell outcome into the content blocks the model receives: the
 * captured output, then each stored image beside its envelope.
 *
 * Shared by the native render and the nested-dispatch path, so an image
 * returned through either route arrives as the same pair of blocks.
 * @param value - the kernel outcome after image admission.
 * @returns the ordered content blocks.
 */
export function kernelContent(value: KernelOutcomeValue): ContentBlock[] {
  const blocks: ContentBlock[] = [{ type: 'text', text: formatKernelOutput(value.output) }]
  for (const note of value.imageNotes) {
    blocks.push({ type: 'text', text: note })
  }
  for (const image of value.images) {
    blocks.push({ type: 'text', text: formatImageNote(image) })
    blocks.push({ type: 'image', attachment: imageRefFromValue(image) })
  }
  return blocks
}

/** The canonical outcome the `kernel` output schema declares. */
export interface KernelOutcomeValue {
  output: string
  outcome: string
  restarted: boolean
  images: KernelValueImage[]
  imageNotes: string[]
}

/**
 * Validate what the schema DSL cannot: a non-blank cell. An empty cell is
 * rejected rather than run, because running it would return empty output that
 * looks exactly like a cell whose code produced nothing.
 * @param args - the schema-validated `kernel` arguments.
 * @returns the accepted arguments, unchanged.
 */
export interface KernelArgs {
  code: string
  timeoutMs?: number
}

export function parseKernelArgs(args: KernelArgs): KernelArgs {
  if (args.code.trim().length === 0) throw new Error('code must be a non-empty string')
  const timeoutMs = args.timeoutMs
  if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
    throw new Error('timeoutMs must be a positive finite number')
  }
  return { code: args.code, ...timeoutMs !== undefined ? { timeoutMs } : {} }
}

/**
 * Cut output to the cap, keeping the head and the tail.
 *
 * The tail matters as much as the head: a traceback is the last thing a cell
 * prints, and a head-only truncation would drop precisely the part explaining
 * why the cell failed.
 * The elision notice is overhead on top of the kept text, so a cap smaller than
 * the notice itself still yields the notice. That only matters for caps in the
 * tens of characters; real ones are in the tens of thousands.
 * @param output - the captured cell output.
 * @param maxChars - the cap.
 * @returns the output, with an elision notice when it was cut.
 */
export function capOutput(output: string, maxChars: number): string {
  if (output.length <= maxChars) return output
  const half = Math.floor((maxChars - 1) / 2)
  // A zero-width half would make the tail slice `output.slice(-0)`, which is
  // `slice(0)` — the WHOLE string, so a tiny cap would return more than an
  // untruncated one. Below two characters there is no head/tail to keep.
  if (half === 0) return `[... ${output.length} characters elided ...]`
  const dropped = output.length - half * 2
  return `${output.slice(0, half)}\n\n[... ${dropped} characters elided ...]\n\n${output.slice(output.length - half)}`
}

/**
 * Format a cell result as the model-facing text block.
 *
 * An empty output is reported as such in words. This is the single most
 * load-bearing line in the package: an empty result means the cell genuinely
 * printed and evaluated nothing, and a model handed silence will otherwise
 * invent a plausible result rather than notice it forgot to print.
 * @param output - the cell's captured output.
 * @returns the text the model reads.
 */
export function formatKernelOutput(output: string): string {
  if (output.length === 0) {
    return 'OUTPUT: (empty — the cell produced no output. If you expected a value,'
      + ' print it or put the bare expression on its own line; do not describe a'
      + ' result you did not see.)'
  }
  return output
}

/** Pending-call presentation: a generic card holding the cell source. */
export function presentKernelCall(args: { code: string }): GenericCallView {
  const [first = ''] = args.code.split('\n')
  return { card: 'generic', title: first, kind: 'execute', rawInput: args.code }
}

/**
 * Completed-call presentation: a generic card carrying the captured cell
 * output. The output is Python interpreter text, not a shell command, so it
 * must not declare the terminal render intent (a command-less terminal card
 * would draw an empty `$` prompt and mislabel the cell as a shell run).
 * @param result - the final model-facing tool result.
 * @returns the generic result view, or undefined (raw result) on failure.
 */
export function presentKernelResult(result: ToolResult): GenericResultView | undefined {
  if (result.isError) return undefined
  const text = result.content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map(block => block.text)
    .join('\n')
  // Image blocks are carried through as-is. Dropping them here would make the
  // card disagree with the model-facing result: the transcript would show a
  // cell that returned a picture while the card claimed it returned only text.
  const images = result.content.filter(block => block.type === 'image')
  return { card: 'generic', content: [{ type: 'text', text }, ...images] }
}

/**
 * Register the `kernel` tool and its system-prompt guidance.
 *
 * The tool is deliberately NOT concurrency-safe (`isConcurrencySafe` is
 * omitted, which the registry reads as exclusive): the namespace is shared
 * mutable state, so two cells running in parallel would interleave their
 * assignments and their captured output.
 */
export function apply(ctx: Context, config: Config): void {
  // schemastery (Config) has already filled every defaulted field.
  const resolved = config as ResolvedConfig

  ctx.systemPrompt.section({
    name: 'tool:kernel',
    order: 100,
    text: [
      'You have one tool for acting on this machine: `kernel`, which runs Python in a',
      'persistent namespace. To learn every preloaded helper and how each one behaves,',
      'call `tool_help()` — with no argument it lists every tool and a one-line summary;',
      'pass a name to get its full documentation.',
      '',
      'Begin every cell with a single-line `#` comment stating what the script does.',
      'That first line titles the call in the transcript, so make it a short, concrete',
      'summary of the intent — `# Count the files under packages/`, not `# code` or a bare',
      'restatement of the line below it. The cell body follows.',
    ].join('\n'),
  })

  ctx.tools.register(defineTool({
    name: 'kernel',
    description: 'Run Python in a persistent kernel namespace. Returns the cell\'s captured output:'
      + ' printed text plus the value of every top-level bare expression. Variables and imports'
      + ' persist across calls. Shell commands run via sh("..."); files are read and written with'
      + ' the preloaded helpers. Start every cell with a one-line `#` comment stating what the'
      + ' script does; that line titles the call in the transcript.',
    parameters: {
      code: { type: 'string', required: true, description: 'The Python source to execute in the persistent namespace. Its first line must be a `#` comment stating what the cell does.' },
      timeoutMs: { type: 'integer', description: 'Optional per-cell timeout in milliseconds. Defaults to the configured timeoutMs and is capped by maxTimeoutMs.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          output: { type: 'string', required: true },
          outcome: { type: 'string', required: true },
          restarted: { type: 'boolean', required: true },
          images: { type: 'array', items: IMAGE_VALUE_SCHEMA, required: true },
          imageNotes: { type: 'array', items: { type: 'string' }, required: true },
        },
      },
      render: (_args, value) => kernelContent(value),
    },
    timeoutMs: resolved.maxTimeoutMs + TOOL_TIMEOUT_GRACE_MS,
    async execute(args, exec) {
      const input = parseKernelArgs(args)
      const cellTimeoutMs = input.timeoutMs ?? resolved.timeoutMs
      const boundedTimeoutMs = Math.min(cellTimeoutMs, resolved.maxTimeoutMs)
      // The kernel process is shared across chats, so the cell must name the
      // directory it runs in: the calling agent's own session workspace. A call
      // with no agent (a direct or synthetic dispatch) sends no cwd and runs
      // wherever the kernel already is.
      const cwd = exec.agent?.session.header.cwd
      // Secondary budget never below the primary: a cell backgrounds at the
      // primary and is force-stopped at this generous deadline.
      const backgroundTimeoutMs = Math.max(resolved.backgroundTimeoutMs, boundedTimeoutMs)
      const result = await ctx.kernel.execute(
        {
          code: input.code,
          timeoutMs: boundedTimeoutMs,
          backgroundTimeoutMs,
          ...cwd !== undefined ? { cwd } : {},
          // Both halves of the agent identity travel: the scoped Context reaches
          // the capability seams, and the Agent itself is the domain subject the
          // kernel's Python seam needs (subagent parentage, goals, tool ownership).
          ...exec.agent !== undefined ? { agentCtx: exec.agent.ctx, agent: exec.agent } : {},
        },
        exec.signal,
      )
      // Commit any returned images BEFORE returning, because the canonical
      // value must already cite durable references by the time the tool result
      // is appended: an image block naming bytes that were never stored would
      // replay as a broken picture for the rest of the session.
      const { refs, notes } = await admitCellImages(ctx.attachments, result.images ?? [], exec.signal)
      const images = refs.map((ref, index) => valueImageFrom(ref, result.images?.[index]?.note))
      return {
        output: capOutput(result.output, resolved.maxOutputChars),
        outcome: result.outcome,
        restarted: result.restarted,
        images,
        imageNotes: notes,
      }
    },
    presentCall: presentKernelCall,
    presentResult: (_args, result) => presentKernelResult(result),
  }))
}
