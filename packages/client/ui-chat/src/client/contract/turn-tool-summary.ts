/**
 * Compact per-Turn tool activity summary for the collapsed process row.
 *
 * A folded Turn describes itself in one line. Raw counts ("7 tool calls") say
 * how much happened but not what, which is the part a reader scanning the
 * transcript actually needs. This module derives an ordered list of action
 * descriptors from the Turn's root Tool calls, plus the aggregate line delta of
 * its file mutations, so the row can read
 * "Created diagnose-session.mjs, ran a command +53 -0".
 *
 * Pure and locale-free: descriptors carry no wording, the renderer maps each
 * one through the locale dictionary, and a model-authored leading comment is
 * passed through verbatim.
 */
import type { ToolCallBlock, ToolResultNode } from './snapshot.ts'
import { isSubagentDelegationTool } from './turn-process.ts'

/** One recognizable thing a Turn's tool calls did. */
export type TurnToolAction =
  | { readonly kind: 'created'; readonly name: string }
  | { readonly kind: 'edited'; readonly name: string }
  | { readonly kind: 'read'; readonly name: string }
  | { readonly kind: 'command' }
  | { readonly kind: 'script'; readonly label?: string | undefined }
  | { readonly kind: 'search' }
  | { readonly kind: 'web' }
  | { readonly kind: 'fetch' }
  | { readonly kind: 'plan' }
  | { readonly kind: 'delegated'; readonly name: string }
  | { readonly kind: 'other'; readonly name: string }

/** One action plus how many times the Turn repeated it. */
export interface TurnToolActionCount {
  readonly action: TurnToolAction
  readonly count: number
}

/** Aggregated tool activity of one completed Turn. */
export interface TurnToolSummary {
  /** Distinct actions in first-seen order, capped at {@link MAX_ACTIONS}. */
  readonly actions: readonly TurnToolActionCount[]
  /** Distinct actions that did not fit in the cap. */
  readonly omitted: number
  /** Added lines across every file mutation in the Turn. */
  readonly added: number
  /** Removed lines across every file mutation in the Turn. */
  readonly removed: number
}

/** Distinct actions a collapsed row lists before summarizing the rest. */
const MAX_ACTIONS = 5

/** Longest file name or script label a row prints before clipping. */
const MAX_LABEL = 64

/**
 * Characters the collapsed row may print, excluding its line delta.
 *
 * The row elides whatever overflows, which cuts mid-word and hides how much was
 * dropped. Budgeting here keeps every printed phrase whole instead, so the row
 * shows one clean ellipsis rather than the residue of two.
 */
export const MAX_SUMMARY_LABEL = 88

/** Parse a Tool call's raw argument JSON, tolerating a truncated stream. */
function parseArgs(raw: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(raw)
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {}
  } catch {
    return {}
  }
}

/** Last path segment, for a name a row can print in a few characters. */
function basename(path: string): string {
  const parts = path.split(/[/\\]/)
  const last = parts[parts.length - 1]
  return last === undefined || last === '' ? path : last
}

/**
 * Clip a label to the row's budget, at a word boundary where one is in reach.
 *
 * A mid-word cut reads as corruption rather than as abbreviation, so a label
 * with a space before the cut loses whole trailing words instead. A label with
 * no space before the cut is a single long token and is cut anyway.
 * @param text - the label to shorten.
 * @returns the label, or its leading words plus an ellipsis.
 */
function clip(text: string): string {
  if (text.length <= MAX_LABEL) return text
  const head = text.slice(0, MAX_LABEL - 1)
  const boundary = head.lastIndexOf(' ')
  return `${boundary > 0 ? head.slice(0, boundary) : head}…`
}

/** Count content lines the way the diff card does: no trailing empty line. */
function contentLines(text: string): number {
  if (text === '') return 0
  const body = text.endsWith('\n') ? text.slice(0, -1) : text
  return body.split('\n').length
}

function stringArg(args: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = args[key]
    if (typeof value === 'string' && value !== '') return value
  }
  return undefined
}

/**
 * First `#` comment line of a kernel cell.
 *
 * The kernel tool guidance makes that line the cell's stated purpose, so it is
 * already a human phrase and needs no translation.
 * @param code - the cell source.
 * @returns the comment text without its marker, or undefined when absent.
 */
function leadingComment(code: string): string | undefined {
  for (const line of code.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    if (!trimmed.startsWith('#')) return undefined
    const text = trimmed.replace(/^#+\s*/, '').trim()
    return text === '' ? undefined : clip(text)
  }
  return undefined
}

/** One root Tool call's identity, arguments, and settled result. */
interface CallArgs {
  readonly name: string
  readonly args: Record<string, unknown>
  readonly settled: ToolResultNode | null
}

function callArgs(block: ToolCallBlock): CallArgs {
  if ('kind' in block) {
    const raw = block.call?.argsRaw ?? ''
    return { name: block.call?.name ?? '', args: parseArgs(raw), settled: block }
  }
  return { name: block.name, args: parseArgs(block.argsRaw), settled: null }
}

/** Validated applied hunks from a settled result's opaque metadata. */
function appliedDiffs(settled: ToolResultNode | null): readonly { oldText: string | null; newText: string }[] | null {
  const meta = settled?.meta
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return null
  const diffs = (meta as Record<string, unknown>).diffs
  if (!Array.isArray(diffs) || diffs.length === 0) return null
  const hunks: { oldText: string | null; newText: string }[] = []
  for (const hunk of diffs) {
    if (typeof hunk !== 'object' || hunk === null) return null
    const { oldText, newText } = hunk as Record<string, unknown>
    if (typeof newText !== 'string') return null
    if (oldText !== null && typeof oldText !== 'string') return null
    hunks.push({ oldText, newText })
  }
  return hunks
}

/** Aggregate line delta of one file-mutation call. */
function statOf(name: string, args: Record<string, unknown>, settled: ToolResultNode | null): { added: number; removed: number } {
  const applied = appliedDiffs(settled)
  if (applied !== null) {
    let added = 0
    let removed = 0
    for (const hunk of applied) {
      if (hunk.oldText !== null) removed += contentLines(hunk.oldText)
      added += contentLines(hunk.newText)
    }
    return { added, removed }
  }
  if (name === 'str_replace_editor') {
    const command = stringArg(args, ['command'])
    if (command === 'create') return { added: contentLines(stringArg(args, ['file_text']) ?? ''), removed: 0 }
    if (command === 'str_replace') {
      return {
        added: contentLines(stringArg(args, ['new_str']) ?? ''),
        removed: contentLines(stringArg(args, ['old_str']) ?? ''),
      }
    }
    return { added: 0, removed: 0 }
  }
  if (name === 'write') return { added: contentLines(stringArg(args, ['content']) ?? ''), removed: 0 }
  if (name === 'edit') {
    return {
      added: contentLines(stringArg(args, ['new_string']) ?? ''),
      removed: contentLines(stringArg(args, ['old_string']) ?? ''),
    }
  }
  return { added: 0, removed: 0 }
}

/** Stable identity for de-duplicating repeated actions. */
function actionKey(action: TurnToolAction): string {
  switch (action.kind) {
    case 'created':
    case 'edited':
    case 'read':
    case 'delegated':
    case 'other':
      return `${action.kind}:${action.name}`
    case 'script':
      return `script:${action.label ?? ''}`
    default:
      return action.kind
  }
}

/**
 * Classify one root Tool call into the action a collapsed row prints.
 * @param block - root Tool block, running or settled.
 * @returns the action descriptor and the call's line delta.
 */
export function summarizeToolCall(block: ToolCallBlock): { action: TurnToolAction; added: number; removed: number } {
  const { name, args, settled } = callArgs(block)
  const path = stringArg(args, ['file_path', 'path'])
  const file = path === undefined ? undefined : clip(basename(path))
  const stat = statOf(name, args, settled)

  if (name === 'str_replace_editor') {
    const command = stringArg(args, ['command'])
    if (file !== undefined && (command === 'create' || command === 'str_replace')) {
      return { action: { kind: command === 'create' ? 'created' : 'edited', name: file }, ...stat }
    }
    return { action: { kind: 'other', name }, ...stat }
  }
  if (name === 'write' && file !== undefined) return { action: { kind: 'created', name: file }, ...stat }
  if (name === 'edit' && file !== undefined) return { action: { kind: 'edited', name: file }, ...stat }
  if (name === 'read') return { action: file === undefined ? { kind: 'read', name: 'a file' } : { kind: 'read', name: file }, ...stat }
  if (name === 'bash' || name === 'pwsh') return { action: { kind: 'command' }, ...stat }
  if (name === 'kernel') {
    const code = stringArg(args, ['code'])
    const label = code === undefined ? undefined : leadingComment(code)
    return { action: label === undefined ? { kind: 'script' } : { kind: 'script', label }, ...stat }
  }
  if (name === 'web_search') return { action: { kind: 'web' }, ...stat }
  if (name === 'web_fetch') return { action: { kind: 'fetch' }, ...stat }
  if (name === 'grep' || name === 'glob') return { action: { kind: 'search' }, ...stat }
  if (name === 'todo_write') return { action: { kind: 'plan' }, ...stat }
  if (isSubagentDelegationTool(name)) return { action: { kind: 'delegated', name: clip(name) }, ...stat }
  return { action: { kind: 'other', name: name === '' ? 'a tool' : name }, ...stat }
}

/**
 * Summarize a completed Turn's root Tool calls.
 * @param blocks - the Turn's root Tool blocks, in transcript order.
 * @returns distinct actions in first-seen order plus the aggregate line delta.
 */
export function summarizeToolCalls(blocks: readonly ToolCallBlock[]): TurnToolSummary {
  const order: string[] = []
  const counts = new Map<string, TurnToolActionCount>()
  let added = 0
  let removed = 0
  for (const block of blocks) {
    const { action, added: plus, removed: minus } = summarizeToolCall(block)
    added += plus
    removed += minus
    const key = actionKey(action)
    const seen = counts.get(key)
    if (seen === undefined) {
      order.push(key)
      counts.set(key, { action, count: 1 })
    } else {
      counts.set(key, { action: seen.action, count: seen.count + 1 })
    }
  }
  const kept: TurnToolActionCount[] = []
  for (const key of order.slice(0, MAX_ACTIONS)) {
    const entry = counts.get(key)
    if (entry !== undefined) kept.push(entry)
  }
  return { actions: kept, omitted: Math.max(0, order.length - kept.length), added, removed }
}

/**
 * Keep the leading phrases that fit the collapsed row's character budget.
 *
 * The first phrase is always kept, however long it is: a row that prints
 * nothing explains nothing, and a single over-long phrase is better read than
 * dropped.
 * @param parts - rendered phrases in first-seen order.
 * @param separator - the string the renderer joins them with.
 * @param budget - characters the row may print, excluding the line delta.
 * @returns the phrases to print and how many were left out.
 */
export function fitLabelParts(
  parts: readonly string[],
  separator: string,
  budget: number = MAX_SUMMARY_LABEL,
): { readonly parts: readonly string[]; readonly omitted: number } {
  const kept: string[] = []
  let width = 0
  for (const part of parts) {
    const grown = kept.length === 0 ? part.length : width + separator.length + part.length
    if (kept.length > 0 && grown > budget) break
    kept.push(part)
    width = grown
  }
  return { parts: kept, omitted: parts.length - kept.length }
}
