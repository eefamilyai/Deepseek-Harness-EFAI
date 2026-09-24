/**
 * The model-visible surface as the masking pass needs it, folded from the log.
 *
 * Masking replaces an old tool result with a stub naming what it was, so the
 * pass needs each current surface node's price and, for a tool result, what
 * produced it and how large it is — never its text. Keeping the text here
 * would hold every tool output twice; the stub is written from the shape.
 *
 * The fold mirrors the token meter's: a node is priced by the same fixed
 * estimator on the same derived message, so the shadow price a replacement
 * declares is exactly what the meter subtracts.
 * @module @deepseek-ai/dsh-output-masking/surface
 */

import { z as zod } from 'zod'
import { deriveEventMessage, isSurfaceEvent } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { estimateMessage } from '@deepseek-ai/dsh-token-meter/estimate'
// Type-only: the `compaction/*` SessionEventMap merges.
import type {} from '@deepseek-ai/dsh-compaction'

/** Every stub opens with this, which is how a masked result is recognised on replay. */
export const MASK_MARKER = '[output masked'

/** Characters kept of a result's first and last lines in its stub. */
const LINE_CHARS = 160

/** Characters kept of a call's target. */
const TARGET_CHARS = 120

/** Calls awaiting their results; beyond this the oldest are forgotten. */
const MAX_PENDING_CALLS = 128

/** What a stub says about the call that produced a result. */
const callSchema = zod.object({
  tool: zod.string(),
  target: zod.string(),
})

/** One tool result on the surface, described without its text. */
const resultSchema = zod.object({
  callId: zod.string(),
  tool: zod.string(),
  target: zod.string(),
  chars: zod.number(),
  lines: zod.number(),
  head: zod.string(),
  tail: zod.string(),
  isError: zod.boolean(),
  textOnly: zod.boolean(),
  masked: zod.boolean(),
  /** The event's data with the message content emptied: the replacement's template. */
  data: zod.record(zod.string(), zod.unknown()),
})

/** One current surface node and its heuristic price. */
const nodeSchema = zod.object({
  seq: zod.number(),
  tokens: zod.number(),
  result: resultSchema.nullable(),
})

/** The projected state. */
export const maskingSurfaceSchema = zod.object({
  nodes: zod.array(nodeSchema),
  calls: zod.record(zod.string(), callSchema),
  compacting: zod.boolean(),
})

export type MaskingSurface = zod.infer<typeof maskingSurfaceSchema>
export type SurfaceNode = zod.infer<typeof nodeSchema>
export type ResultShape = zod.infer<typeof resultSchema>

/** A surface with nothing on it. */
export function emptyMaskingSurface(): MaskingSurface {
  return { nodes: [], calls: {}, compacting: false }
}

/** Which results a pass may mask. */
export interface MaskingPolicy {
  /** The newest this-many tool results are never masked. */
  readonly keepRecent: number
  /** A result shorter than this many characters is not worth a stub. */
  readonly minChars: number
}

/**
 * Clip one line of text for a stub.
 * @param text - the text.
 * @param limit - the most characters to keep.
 * @returns the text, cut with an ellipsis when longer.
 */
function clip(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`
}

/**
 * What a call acted on, from its arguments: a path, a command, a pattern.
 * @param args - the call's JSON arguments.
 * @returns the target, or `''` when the arguments name none.
 */
export function callTarget(args: string): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(args)
  } catch {
    return ''
  }
  if (parsed === null || typeof parsed !== 'object') return ''
  const record = parsed as Record<string, unknown>
  for (const key of ['file_path', 'path', 'notebook_path', 'command', 'code', 'pattern', 'url', 'query']) {
    const value = record[key]
    if (typeof value !== 'string' || value.trim().length === 0) continue
    const line = value.trim().split('\n')[0] ?? ''
    return clip(line, TARGET_CHARS)
  }
  return ''
}

/** The first and last non-blank lines of a text. */
function edgeLines(text: string): { head: string; tail: string; lines: number } {
  const all = text.split('\n')
  const filled = all.filter(line => line.trim().length > 0)
  const head = filled[0]?.trim() ?? ''
  const tail = filled.length > 1 ? filled.at(-1)?.trim() ?? '' : ''
  return { head: clip(head, LINE_CHARS), tail: clip(tail, LINE_CHARS), lines: all.length }
}

/**
 * Describe one tool-result event without keeping its text.
 * @param event - the tool-result event.
 * @param call - the call that produced it, when known.
 * @returns the result's shape.
 */
function describeResult(event: SessionEvent<'tool/result'>, call: { tool: string; target: string } | undefined): ResultShape {
  const message = event.data.message
  const text = message.content.map(block => block.type === 'text' ? block.text : '').join('\n')
  const edges = edgeLines(text)
  return {
    callId: String(message.toolCallId),
    tool: call?.tool ?? '',
    target: call?.target ?? '',
    chars: text.length,
    lines: edges.lines,
    head: edges.head,
    tail: edges.tail,
    isError: message.isError === true || event.data.error !== undefined,
    textOnly: message.content.every(block => block.type === 'text'),
    masked: text.startsWith(MASK_MARKER),
    data: { ...event.data, message: { ...message, content: [] } },
  }
}

/**
 * Fold one committed event onto the surface.
 *
 * A replacement whose range this fold does not hold leaves the state as it
 * was: the log was validated when it was appended, so the only way to miss a
 * range is a surface this fold never saw, and masking nothing is safe.
 * @param state - the surface before the event.
 * @param event - the next committed event.
 * @returns the surface after it.
 */
export function foldMaskingSurface(state: MaskingSurface, event: SessionEvent): MaskingSurface {
  if (event.type === 'tool/call') {
    const calls = { ...state.calls, [event.data.callId]: { tool: event.data.name, target: callTarget(event.data.arguments) } }
    const ids = Object.keys(calls)
    for (const id of ids.slice(0, Math.max(0, ids.length - MAX_PENDING_CALLS))) Reflect.deleteProperty(calls, id)
    return { ...state, calls }
  }
  if (event.type === 'compaction/start') return { ...state, compacting: true }
  if (event.type === 'compaction/end') return { ...state, compacting: false }
  if (!isSurfaceEvent(event)) return state

  const message = deriveEventMessage(event)
  const tokens = message === null ? 0 : estimateMessage(message)
  let calls = state.calls
  let result: ResultShape | null = null
  if (event.type === 'tool/result') {
    const callId = String(event.data.message.toolCallId)
    result = describeResult(event, calls[callId])
    if (calls[callId] !== undefined) {
      calls = { ...calls }
      Reflect.deleteProperty(calls, callId)
    }
  }
  const op = event.surfaceOp
  if (op === 'append') {
    return { ...state, calls, nodes: [...state.nodes, { seq: event.seq, tokens, result }] }
  }
  const start = state.nodes.findIndex(node => node.seq === op.startSeq)
  const end = state.nodes.findIndex(node => node.seq === op.endSeq)
  if (start === -1 || end === -1 || start > end) return { ...state, calls }
  // A replacement of one result by another (a prune, a mask) keeps naming the
  // call that produced it: the call itself was consumed by the original.
  const replaced = state.nodes[start]?.result
  if (result !== null && start === end && replaced !== null && replaced !== undefined && replaced.callId === result.callId) {
    result = { ...result, tool: result.tool || replaced.tool, target: result.target || replaced.target }
  }
  return {
    ...state,
    calls,
    nodes: [...state.nodes.slice(0, start), { seq: event.seq, tokens, result }, ...state.nodes.slice(end + 1)],
  }
}

/**
 * The results a pass may mask, oldest first: everything but the newest
 * `keepRecent` results, and of those only large, successful, text-only ones
 * not already masked. An error is kept whole because it is what stops the
 * model repeating the mistake; a result carrying an image is left to the
 * image offload.
 * @param state - the surface.
 * @param policy - the pass's policy.
 * @returns the nodes to mask.
 */
export function maskCandidates(state: MaskingSurface, policy: MaskingPolicy): SurfaceNode[] {
  const results = state.nodes.filter(node => node.result !== null)
  const older = results.slice(0, Math.max(0, results.length - policy.keepRecent))
  return older.filter((node) => {
    const result = node.result
    return result !== null && !result.masked && !result.isError && result.textOnly && result.chars >= policy.minChars
  })
}

/**
 * The stub that replaces a masked result: what ran, how large the output was,
 * its first and last lines, and how to see it again.
 * @param result - the result's shape.
 * @returns the stub text.
 */
export function renderStub(result: ResultShape): string {
  const call = [result.tool || 'tool', result.target].filter(part => part.length > 0).join(' ')
  const lines = [`${MASK_MARKER} to keep the context small — ${call}: ${result.chars} characters over ${result.lines} lines.`]
  if (result.head.length > 0) lines.push(`It began: ${result.head}`)
  if (result.tail.length > 0) lines.push(`It ended: ${result.tail}`)
  lines.push('Run the call again if you need the full output.]')
  return lines.join('\n')
}
