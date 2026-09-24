/**
 * The session ledger: everything a compaction must not lose that CODE can know
 * exactly, folded from the log as it commits.
 *
 * Summaries are good at intent and reasoning and bad at artifacts: every
 * published evaluation of compaction finds the file trail, exact error text,
 * and user corrections to be what a model-written summary drops first. None of
 * those need a model. They are facts in the event stream, so this module
 * records them deterministically and the handoff restates them verbatim.
 *
 * The fold is pure and total — one event in, one state out, no I/O — which is
 * what lets it run as a Session projection that survives resume and costs one
 * small step per event.
 * @module @deepseek-ai/dsh-session-recovery-context/ledger
 */

import { z as zod } from 'zod'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
// Type-only: the `todo/write` event the ledger folds the todo list from.
import type {} from '@deepseek-ai/dsh-tool-todo'

/** The message-source kind the handoff message carries. */
export const HANDOFF_SOURCE_KIND = 'session-recovery'

/**
 * The kind a recovery message logged before message sources were producer
 * owned reads as once the session is converted (`plugin:<name>`). Recognized so
 * a session recovered before the conversion does not recover twice.
 */
export const LEGACY_HANDOFF_SOURCE_KIND = 'plugin:session-recovery-context'

/** Bounds on how much of each kind of fact the ledger keeps. */
export interface LedgerLimits {
  /** Operator messages kept verbatim: the first one plus the newest `n - 1`. */
  prompts: number
  /** Characters kept per operator message. */
  promptChars: number
  /** Distinct files remembered. */
  files: number
  /** Shell and kernel commands remembered. */
  commands: number
  /** Unresolved errors remembered. */
  errors: number
  /** Characters of output kept per error. */
  errorChars: number
}

/** The bounds used when a deployment states none. */
export const DEFAULT_LEDGER_LIMITS: LedgerLimits = {
  prompts: 24,
  promptChars: 4000,
  files: 60,
  commands: 12,
  errors: 6,
  errorChars: 400,
}

const promptSchema = zod.object({
  seq: zod.number(),
  text: zod.string(),
  /** A mid-turn correction rather than a turn-opening request. */
  steering: zod.boolean(),
})

const callSchema = zod.object({
  seq: zod.number(),
  name: zod.string(),
  /** What the call acted on: a path, a command, or a cell's title. */
  target: zod.string(),
  /** The file action the call implies, when it touches one. */
  action: zod.enum(['read', 'created', 'edited', 'none']),
})

const fileSchema = zod.object({
  path: zod.string(),
  created: zod.boolean(),
  edited: zod.boolean(),
  reads: zod.number(),
  seq: zod.number(),
})

const commandSchema = zod.object({
  seq: zod.number(),
  tool: zod.string(),
  text: zod.string(),
  ok: zod.boolean(),
})

const errorSchema = zod.object({
  seq: zod.number(),
  tool: zod.string(),
  target: zod.string(),
  text: zod.string(),
})

const todoSchema = zod.object({
  content: zod.string(),
  status: zod.string(),
})

const compactionSchema = zod.object({
  seq: zod.number(),
  id: zod.string(),
  summary: zod.string(),
})

/** The folded ledger for one session. */
export const ledgerSchema = zod.object({
  prompts: zod.array(promptSchema),
  /** Operator messages dropped from the middle to respect the bound. */
  droppedPrompts: zod.number(),
  /** Tool calls awaiting their result, by call id. */
  calls: zod.record(zod.string(), callSchema),
  files: zod.array(fileSchema),
  commands: zod.array(commandSchema),
  errors: zod.array(errorSchema),
  todos: zod.array(todoSchema),
  compaction: compactionSchema.nullable(),
  compactions: zod.number(),
  /** The compaction whose handoff has been delivered, or null. */
  handedOffSeq: zod.number().nullable(),
  /**
   * Steps ended in the open turn, or null between turns. The log has no
   * steering flag — the inbox decides that — but an operator message that
   * arrives after a step of the open turn has ended can only be a correction
   * mid-turn, so this is what tells the two apart.
   */
  turnSteps: zod.number().nullable(),
})

/** Folded ledger state. */
export type Ledger = zod.infer<typeof ledgerSchema>
/** One remembered operator message. */
export type LedgerPrompt = zod.infer<typeof promptSchema>
/** One remembered file. */
export type LedgerFile = zod.infer<typeof fileSchema>
/** One remembered command. */
export type LedgerCommand = zod.infer<typeof commandSchema>
/** One remembered unresolved error. */
export type LedgerError = zod.infer<typeof errorSchema>

/**
 * The empty ledger.
 * @returns a ledger with nothing recorded.
 */
export function emptyLedger(): Ledger {
  return {
    prompts: [],
    droppedPrompts: 0,
    calls: {},
    files: [],
    commands: [],
    errors: [],
    todos: [],
    compaction: null,
    compactions: 0,
    handedOffSeq: null,
    turnSteps: null,
  }
}

/** Tool calls kept while their result is outstanding; a bound, not a policy. */
const MAX_PENDING_CALLS = 64

/** Shell tools whose `command` argument is the thing to remember. */
const SHELL_TOOLS = new Set(['bash', 'pwsh'])

/** The kernel tool, whose cells are remembered by their title line. */
const KERNEL_TOOL = 'kernel'

/**
 * The text of a content-block array, when the value has that shape.
 * @param value - candidate content.
 * @returns the text blocks joined with newlines, or `''`.
 */
export function blockText(value: unknown): string {
  if (!Array.isArray(value)) return ''
  const parts: string[] = []
  for (const block of value as readonly unknown[]) {
    if (typeof block !== 'object' || block === null) continue
    const text = (block as { text?: unknown }).text
    if (typeof text === 'string') parts.push(text)
  }
  return parts.join('\n')
}

/**
 * Clip one string to a budget, marking the cut.
 * @param text - the text.
 * @param budget - maximum characters; zero or less keeps everything.
 * @returns the clipped text.
 */
export function clip(text: string, budget: number): string {
  if (budget <= 0 || text.length <= budget) return text
  return `${text.slice(0, Math.max(0, budget - 1))}…`
}

/** Parse a tool call's JSON arguments, tolerating anything malformed. */
function parseArguments(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'string') return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
  } catch {
    return {}
  }
}

/** One string argument, or `''`. */
function stringArg(args: Record<string, unknown>, key: string): string {
  const value = args[key]
  return typeof value === 'string' ? value : ''
}

/**
 * What one tool call acted on, and the file action it implies.
 *
 * Only the tools whose arguments name a file or a command are classified; every
 * other call is remembered by name alone, which is enough to pair it with its
 * result and report it if it fails.
 * @param name - the tool name.
 * @param args - the parsed arguments.
 * @returns the call's target and file action.
 */
export function classifyCall(
  name: string,
  args: Record<string, unknown>,
): { target: string; action: 'read' | 'created' | 'edited' | 'none' } {
  switch (name) {
    case 'read':
      return { target: stringArg(args, 'file_path'), action: 'read' }
    case 'write':
      return { target: stringArg(args, 'file_path'), action: 'created' }
    case 'edit':
      return { target: stringArg(args, 'file_path'), action: 'edited' }
    case 'str_replace_editor':
    case 'notebook_edit': {
      const command = stringArg(args, 'command')
      const target = stringArg(args, 'path')
      if (command === 'view') return { target, action: 'read' }
      if (command === 'create') return { target, action: 'created' }
      return { target, action: 'edited' }
    }
    case KERNEL_TOOL: {
      // A cell's first line is its title by the tool's own contract.
      const code = stringArg(args, 'code')
      const first = code.split('\n', 1)[0]?.replace(/^#\s*/, '').trim() ?? ''
      return { target: first, action: 'none' }
    }
    default:
      if (SHELL_TOOLS.has(name)) return { target: stringArg(args, 'command'), action: 'none' }
      return { target: '', action: 'none' }
  }
}

/** A shell exit status a result reports, when it reports one. */
const EXIT_STATUS = /\bexit(?:ed)?(?:\s+with)?\s+(?:code|status)[:\s]+(-?\d+)/i

/** A Python traceback, which the kernel returns as ordinary output. */
const TRACEBACK = /Traceback \(most recent call last\)/

/**
 * Whether one tool result reports success.
 * @param name - the tool name.
 * @param isError - the result's own error flag.
 * @param text - the result's text.
 * @returns false when the result failed.
 */
export function resultSucceeded(name: string, isError: boolean, text: string): boolean {
  if (isError) return false
  if (SHELL_TOOLS.has(name)) {
    const status = EXIT_STATUS.exec(text)
    if (status !== null && Number(status[1]) !== 0) return false
  }
  if (name === KERNEL_TOOL && TRACEBACK.test(text)) return false
  return true
}

/**
 * Append one operator message, dropping from the MIDDLE at the bound.
 *
 * The first message is the brief the work was commissioned with and the newest
 * ones are the current intent; what a bound gives up is the steering between.
 */
function appendPrompt(ledger: Ledger, entry: LedgerPrompt, limit: number): Ledger {
  const prompts = [...ledger.prompts, entry]
  if (limit <= 1 || prompts.length <= limit) return { ...ledger, prompts }
  const first = prompts[0] as LedgerPrompt
  const kept = [first, ...prompts.slice(prompts.length - (limit - 1))]
  return { ...ledger, prompts: kept, droppedPrompts: ledger.droppedPrompts + (prompts.length - kept.length) }
}

/** Record one file action, moving the file to the newest position. */
function touchFile(
  files: readonly LedgerFile[],
  path: string,
  action: 'read' | 'created' | 'edited',
  seq: number,
  limit: number,
): LedgerFile[] {
  const previous = files.find(file => file.path === path)
  const entry: LedgerFile = {
    path,
    created: (previous?.created ?? false) || action === 'created',
    edited: (previous?.edited ?? false) || action === 'edited',
    reads: (previous?.reads ?? 0) + (action === 'read' ? 1 : 0),
    seq,
  }
  const rest = files.filter(file => file.path !== path)
  const next = [...rest, entry]
  return next.length > limit ? next.slice(next.length - limit) : next
}

/** Whether a user message is one of this plugin's handoffs. */
function isHandoff(source: unknown): boolean {
  if (typeof source !== 'object' || source === null) return false
  const kind = (source as { kind?: unknown }).kind
  return kind === HANDOFF_SOURCE_KIND || kind === LEGACY_HANDOFF_SOURCE_KIND
}

/** Whether a user message was written by the operator. */
function isOperator(source: unknown): boolean {
  return typeof source === 'object' && source !== null && (source as { kind?: unknown }).kind === 'user'
}

/**
 * Fold one committed event into the ledger.
 * @param ledger - the ledger so far.
 * @param event - the committed event.
 * @param limits - the bounds to respect.
 * @returns the next ledger; the input is never mutated.
 */
export function foldLedger(ledger: Ledger, event: SessionEvent, limits: LedgerLimits = DEFAULT_LEDGER_LIMITS): Ledger {
  const seq = Number(event.seq)
  const data: unknown = event.data
  if (typeof data !== 'object' || data === null) return ledger
  const record = data as Record<string, unknown>

  switch (event.type) {
    case 'turn/start':
      return { ...ledger, turnSteps: 0 }
    case 'step/end':
      return ledger.turnSteps === null ? ledger : { ...ledger, turnSteps: ledger.turnSteps + 1 }
    case 'turn/end':
      return { ...ledger, turnSteps: null }

    case 'user/message': {
      if (isHandoff(record.source)) {
        return { ...ledger, handedOffSeq: ledger.compaction?.seq ?? ledger.handedOffSeq }
      }
      if (!isOperator(record.source)) return ledger
      const text = blockText(record.content).trim()
      if (text.length === 0) return ledger
      return appendPrompt(ledger, {
        seq,
        text: clip(text, limits.promptChars),
        steering: ledger.turnSteps !== null && ledger.turnSteps > 0,
      }, limits.prompts)
    }

    case 'tool/call': {
      const callId = typeof record.callId === 'string' ? record.callId : ''
      const name = typeof record.name === 'string' ? record.name : ''
      if (callId.length === 0 || name.length === 0) return ledger
      const { target, action } = classifyCall(name, parseArguments(record.arguments))
      const calls = { ...ledger.calls, [callId]: { seq, name, target, action } }
      const ids = Object.keys(calls)
      if (ids.length > MAX_PENDING_CALLS) {
        const oldest = ids.sort((a, b) => (calls[a]?.seq ?? 0) - (calls[b]?.seq ?? 0))[0]
        if (oldest !== undefined) Reflect.deleteProperty(calls, oldest)
      }
      return { ...ledger, calls }
    }

    case 'tool/result': {
      const message = record.message as { toolCallId?: unknown; isError?: unknown; content?: unknown } | undefined
      const callId = typeof message?.toolCallId === 'string' ? message.toolCallId : ''
      const call = ledger.calls[callId]
      if (call === undefined) return ledger
      const calls = { ...ledger.calls }
      Reflect.deleteProperty(calls, callId)
      const text = blockText(message?.content)
      const ok = resultSucceeded(call.name, message?.isError === true || record.error !== undefined, text)
      let next: Ledger = { ...ledger, calls }

      if (call.action !== 'none' && call.target.length > 0 && ok) {
        next = { ...next, files: touchFile(next.files, call.target, call.action, seq, limits.files) }
      }
      if (SHELL_TOOLS.has(call.name) || call.name === KERNEL_TOOL) {
        const commands = [...next.commands, { seq, tool: call.name, text: clip(call.target, 240), ok }]
        next = { ...next, commands: commands.length > limits.commands ? commands.slice(commands.length - limits.commands) : commands }
      }
      // A later success on the same tool and target resolves an earlier
      // failure there; a new failure replaces the one it repeats.
      const errors = next.errors.filter(error => !(error.tool === call.name && error.target === call.target))
      if (!ok) {
        errors.push({ seq, tool: call.name, target: clip(call.target, 240), text: clip(text.trim(), limits.errorChars) })
      }
      next = { ...next, errors: errors.length > limits.errors ? errors.slice(errors.length - limits.errors) : errors }
      return next
    }

    case 'todo/write': {
      const todos = Array.isArray(record.todos) ? record.todos : []
      return {
        ...ledger,
        todos: todos.flatMap((todo: unknown) => {
          if (typeof todo !== 'object' || todo === null) return []
          const { content, status } = todo as { content?: unknown; status?: unknown }
          return typeof content === 'string' && typeof status === 'string' ? [{ content, status }] : []
        }),
      }
    }

    case 'compaction/summary': {
      const id = typeof record.compactionId === 'string' ? record.compactionId : String(seq)
      return {
        ...ledger,
        compaction: { seq, id, summary: blockText(record.summary) },
        compactions: ledger.compactions + 1,
      }
    }

    default:
      return ledger
  }
}

/**
 * Whether the latest compaction still awaits its handoff.
 * @param ledger - the folded ledger.
 * @returns true when a compaction has not been handed off yet.
 */
export function awaitingHandoff(ledger: Ledger): boolean {
  return ledger.compaction !== null && ledger.handedOffSeq !== ledger.compaction.seq
}
