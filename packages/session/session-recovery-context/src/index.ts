/**
 * Context initialization after compaction.
 *
 * Compaction keeps a summary and drops the transcript. What it drops includes
 * the operator's own words — the prompt the work was commissioned with, and every
 * correction since — so the turn after a compaction is the turn most likely to
 * resume the wrong task, confidently.
 *
 * This plugin answers that turn with a dedicated initialization step instead of
 * an extra paragraph inside a normal one. During compaction, CODE — never a
 * model — extracts the record into `compaction-[id]-[session-id].md`. On the
 * next step the harness sends that document and nothing else: no system prompt,
 * no other injections, and one instruction to reply with nothing but `OK`. Once
 * that acknowledgement is absorbed, the operator's own prompt and the normal
 * initialization injections proceed as they would have.
 *
 * Later turns carry the record too, as the `Context file:` runtime context: the
 * path it is stored at, then its contents, re-read whenever a compaction
 * replaces it.
 *
 * Nothing here scans history. A Session projection folds the prompts, the event
 * tail, and the latest compaction as they commit, exactly as the
 * [synchronous-read rule](../../../../.agents/notes/implemented/architecture/2026-09-09-deprecate-synchronous-session-event-reads.md)
 * prescribes, so the state survives resume and costs one pure fold per event.
 * @module @deepseek-ai/dsh-session-recovery-context
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { z as zod } from 'zod'
import type { Context } from '@deepseek-ai/cordis'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
// Type-only: resolves the `compaction/*` events this plugin folds on.
import type {} from '@deepseek-ai/dsh-compaction'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-system-prompt'
import {
  DEFAULT_COMPACTION_EVENTS,
  compactionLogFilename,
  renderCompactionLog,
  type CompactionLogEvent,
} from './compaction-log.ts'
import { sessionDir, sessionLogPath } from './log-path.ts'
import type { LogCompression } from './log-path.ts'

export { encodeSegment, projectDir, projectKey, sessionDir, sessionLogPath } from './log-path.ts'
export type { LogCompression } from './log-path.ts'
export {
  COMPACTION_LOG_PREFIX,
  DEFAULT_COMPACTION_EVENTS,
  compactionLogFilename,
  renderCompactionLog,
  selectCompactionEvents,
} from './compaction-log.ts'
export type {
  CompactionLogEvent,
  CompactionLogInput,
  CompactionLogPrompt,
} from './compaction-log.ts'

/** Cordis plugin name used by loader diagnostics, and this plugin's message source. */
export const name = 'session-recovery-context'

/** Services required before the projection and the pre-step listener can register. */
export const inject = ['agents', 'sessionProjections']

/**
 * Runtime-context position for the log-path fact.
 *
 * Just past the `CONTEXT_ORDERS` band (110/115/120) that `dsh-system-prompt`
 * allocates centrally. A literal is correct here rather than a map entry:
 * `systemPrompt.context()` takes any finite order, and only `getContextOrder()`
 * reads the map, so a fork-owned position costs no upstream edit.
 */
const LOG_CONTEXT_ORDER = 125

/**
 * Runtime-context position for the compaction-record path fact.
 *
 * One past {@link LOG_CONTEXT_ORDER}, for the same reason: both sit outside the
 * `CONTEXT_ORDERS` band that `dsh-system-prompt` allocates centrally, so a
 * fork-owned position costs no upstream edit.
 */
const CONTEXT_FILE_ORDER = LOG_CONTEXT_ORDER + 1

/** The single instruction the initialization step carries. */
export const DEFAULT_INSTRUCTION = 'Read the compaction record above and reply with nothing but "OK".'
  + ' Do not summarize it, do not act on it, and do not add anything else.'

/** Marker `form` this plugin stamps on the two messages it owns. */
const RECOVERY_FORM = 'snapshot'

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** Folded operator prompts, event tail, and compaction watermark. */
    sessionRecovery: SessionRecoveryProjection
  }
}

const promptSchema = zod.object({
  /** Sequence number of the `user/message` event. */
  seq: zod.number(),
  /** The operator's text, truncated to the configured budget. */
  text: zod.string(),
})

const digestSchema = zod.object({
  /** Sequence number of the committed event. */
  seq: zod.number(),
  /** The event type. */
  type: zod.string(),
  /** A short label read out of the event's own payload, or `''` when it has none. */
  label: zod.string(),
})

const stateSchema = zod.object({
  /** Every turn-starting operator prompt, oldest first. */
  prompts: zod.array(promptSchema),
  /** The most recent events, oldest first, bounded by `tailEvents`. */
  tail: zod.array(digestSchema),
  /** Sequence number of the newest `compaction/summary`, or null. */
  compactionSeq: zod.number().nullable(),
  /** The compaction id of the newest `compaction/summary`, or null. */
  compactionId: zod.string().nullable(),
  /** The summary text of the newest `compaction/summary`. */
  summary: zod.string(),
  /** The compaction whose recovery step this session has already emitted, or null. */
  recoverySentSeq: zod.number().nullable(),
  /** The compaction whose acknowledgement has been absorbed, or null. */
  absorbedSeq: zod.number().nullable(),
})

/** Folded recovery state for one session. */
export type SessionRecoveryProjection = zod.infer<typeof stateSchema>

/** One operator prompt as the projection keeps it. */
export type RecoveryPrompt = zod.infer<typeof promptSchema>

/** One event as the tail keeps it. */
export type RecoveryDigest = zod.infer<typeof digestSchema>

/** Trailing events the digest carries when the deployment states no bound. */
export const DEFAULT_TAIL_EVENTS = 200

/** Per-prompt character budget when the deployment states none. */
export const DEFAULT_PROMPT_CHARS = 1200

/** Per-event label budget when the deployment states none. */
export const DEFAULT_EVENT_CHARS = 120

/** Plugin config. Every field bounds state or wording; none is required. */
export interface Config {
  /** The session root directory; defaults to the harness home's `sessions`. */
  root?: string
  /** Per-prompt character budget. */
  promptChars?: number
  /** Per-event label budget. */
  eventChars?: number
  /** Trailing events the fold keeps. */
  tailEvents?: number
  /** Events the written record carries. */
  compactionEvents?: number
  /** The instruction the initialization step carries. */
  instruction?: string
  /** The artifact encoding the session writer uses. */
  logCompression?: LogCompression
}

export const Config: z<Config> = z.object({
  root: z.string().description('The session root directory.'),
  promptChars: z.number().description('Per-prompt character budget.'),
  eventChars: z.number().description('Per-event label budget.'),
  tailEvents: z.number().description('Trailing events the fold keeps.'),
  compactionEvents: z.number().description('Events the written record carries.'),
  instruction: z.string().description('The instruction the initialization step carries.'),
  logCompression: z.union([z.const('zstd'), z.const('none')]).description('The artifact encoding the session writer uses.'),
})

/** The text of a content-block array, when the value has that shape. */
function blockText(value: unknown): string {
  if (!Array.isArray(value)) return ''
  const parts: string[] = []
  for (const block of value as readonly unknown[]) {
    if (typeof block !== 'object' || block === null) continue
    const text = (block as { text?: unknown }).text
    if (typeof text === 'string') parts.push(text)
  }
  return parts.join(' ')
}

/** Clip one string to a budget, marking the cut. */
function clip(text: string, budget: number): string {
  if (budget <= 0 || text.length <= budget) return text
  return `${text.slice(0, Math.max(0, budget - 1))}…`
}

/**
 * A short label for one event, read out of whatever payload it turns out to
 * carry.
 *
 * Structural rather than per-type on purpose: the tail's job is to be legible
 * for every event the log holds, including types added after this file, and a
 * switch over known types would silently render those as bare type names.
 * @param event - the committed event.
 * @param budget - the label's character budget.
 * @returns the label, or `''` when the payload offers none.
 */
export function eventLabel(event: SessionEvent, budget: number): string {
  const data: unknown = event.data
  if (typeof data !== 'object' || data === null) return ''
  const record = data as Record<string, unknown>
  const text = blockText(record.content)
  if (text.length > 0) return clip(text, budget)
  for (const key of ['name', 'summary', 'reason', 'mode', 'title', 'error'] as const) {
    const value = record[key]
    if (typeof value === 'string' && value.length > 0) return clip(value, budget)
  }
  return ''
}

/** Append one digest to the rolling tail, dropping from the front at the bound. */
function appendDigest(
  tail: readonly RecoveryDigest[],
  event: SessionEvent,
  limit: number,
  labelChars: number,
): RecoveryDigest[] {
  const next = [...tail, { seq: Number(event.seq), type: event.type, label: eventLabel(event, labelChars) }]
  return next.length > limit ? next.slice(next.length - limit) : next
}

/**
 * Append one operator prompt, dropping from the MIDDLE at the bound.
 *
 * The first prompt is the brief the work was commissioned with and the last ones
 * are the current intent; what a bound has to give up is the steering in
 * between. Dropping the oldest instead would discard the task statement itself,
 * which is the one line this whole plugin exists to preserve.
 */
function appendPrompt(
  prompts: readonly RecoveryPrompt[],
  entry: RecoveryPrompt,
  limit: number,
): RecoveryPrompt[] {
  const next = [...prompts, entry]
  if (limit <= 0 || next.length <= limit) return next
  return [next[0] as RecoveryPrompt, ...next.slice(next.length - (limit - 1))]
}

/**
 * Whether one `user/message` event starts a turn rather than steering one.
 *
 * Only an instructional prompt restates the task, and only a turn-starting one
 * survives as an operator instruction; a steering message is a mid-turn nudge
 * whose meaning depends on the step it interrupted.
 * @param event - the committed `user/message`.
 * @returns true when the message opened a turn.
 */
export function startsTurn(event: SessionEvent<'user/message'>): boolean {
  const data = event.data as { steering?: unknown; turn?: unknown }
  if (data.steering === true) return false
  if (typeof data.turn === 'number') return true
  return true
}

/** Whether one `user/message` event is this plugin's own injection. */
function isOwnInjection(event: SessionEvent<'user/message'>): boolean {
  const source = event.data.source as { kind?: unknown; plugin?: unknown; form?: unknown }
  return source.kind === 'plugin' && source.plugin === name && source.form === RECOVERY_FORM
}

/**
 * Messages a session has claimed for a real turn but not yet admitted, held
 * between the initialization step and the step that follows it.
 *
 * Process-local on purpose: the acknowledgement is absorbed within one process,
 * and a resumed session simply has nothing stashed.
 */
const deferred = new WeakMap<Session, UserMessage[]>()

/** Compactions whose record file has already been written in this process. */
const written = new WeakSet<Session>()

/**
 * The record text an assembly renders, per session.
 *
 * The context provider that surfaces the record is synchronous, so it can only
 * render what an earlier async step has already read. Keyed by path so a newer
 * compaction's record replaces the one before it.
 */
const recordText = new WeakMap<Session, { path: string; text: string }>()

/**
 * The absolute path of one compaction's record.
 * @param root - the session root directory.
 * @param session - the session the record belongs to.
 * @param compactionId - the compaction id.
 * @returns the record's path.
 */
export function compactionLogPath(
  root: string,
  session: Session,
  compactionId: string,
): string {
  return join(sessionDir(root, session.header.cwd, session.id), compactionLogFilename(compactionId, session.id))
}

/**
 * The record path a session's latest compaction named, or undefined before any.
 *
 * Read from the fold rather than captured, because the path changes as
 * compactions happen.
 * @param ctx - the plugin context, for the session projection.
 * @param root - the session root directory.
 * @param session - the session to resolve for.
 * @returns the current record's path, or undefined when none exists yet.
 */
function recordPathOf(ctx: Context, root: string, session: Session): string | undefined {
  const state = ctx.sessionProjections.stateOf(session, 'sessionRecovery') as SessionRecoveryProjection
  return state.compactionId === null ? undefined : compactionLogPath(root, session, state.compactionId)
}

/**
 * Write one compaction's record, exactly once per session.
 * @param root - the session root directory.
 * @param session - the session the record belongs to.
 * @param state - the folded recovery state.
 * @param eventLimit - events the record carries.
 * @returns the record's path, or undefined when there is nothing to write.
 */
async function writeCompactionLog(
  root: string,
  session: Session,
  state: SessionRecoveryProjection,
  eventLimit: number,
): Promise<string | undefined> {
  if (state.compactionSeq === null || state.compactionId === null) return undefined
  if (written.has(session)) return undefined
  const events: CompactionLogEvent[] = state.tail.map(entry => ({ ...entry }))
  const text = renderCompactionLog({
    compactionId: state.compactionId,
    sessionId: session.id,
    summary: state.summary,
    prompts: state.prompts.map(prompt => ({ ...prompt })),
    events,
    eventLimit,
  })
  const path = compactionLogPath(root, session, state.compactionId)
  await mkdir(sessionDir(root, session.header.cwd, session.id), { recursive: true })
  await writeFile(path, text, 'utf8')
  written.add(session)
  recordText.set(session, { path, text })
  return path
}

/**
 * Whether this session's next step is the initialization step.
 * @param state - the folded recovery state.
 * @returns true when a compaction awaits its acknowledgement.
 */
export function awaitingAcknowledgement(state: SessionRecoveryProjection): boolean {
  return state.compactionSeq !== null && state.compactionSeq !== state.absorbedSeq
}

/** Render the initialization message: the record, then the one instruction. */
function renderRecovery(record: string, instruction: string): string {
  return [record, '', '---', '', instruction].join('\n')
}

/**
 * Install the projection, the initialization step, and the log-path facts.
 * @param ctx - the plugin context.
 * @param config - the deployment's bounds and wording.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const promptChars = config.promptChars ?? DEFAULT_PROMPT_CHARS
  const eventChars = config.eventChars ?? DEFAULT_EVENT_CHARS
  const tailEvents = config.tailEvents ?? DEFAULT_TAIL_EVENTS
  const compactionEvents = config.compactionEvents ?? DEFAULT_COMPACTION_EVENTS
  const instruction = config.instruction ?? DEFAULT_INSTRUCTION
  const compression: LogCompression = config.logCompression ?? 'zstd'
  const root = config.root ?? dshHomePath('sessions')

  ctx.sessionProjections.register({
    key: 'sessionRecovery',
    stateVersion: 2,
    stateSchema,
    init: () => ({
      prompts: [],
      tail: [],
      compactionSeq: null,
      compactionId: null,
      summary: '',
      recoverySentSeq: null,
      absorbedSeq: null,
    }),
    apply: (state, event) => {
      let next = state
      if (event.type === 'compaction/summary') {
        const data = event.data as { compactionId?: unknown; summary?: unknown }
        next = {
          ...next,
          compactionSeq: Number(event.seq),
          compactionId: typeof data.compactionId === 'string' ? data.compactionId : null,
          summary: blockText(data.summary),
          recoverySentSeq: null,
        }
      }
      if (event.type === 'user/message') {
        if (isOwnInjection(event)) {
          next = { ...next, absorbedSeq: next.compactionSeq, recoverySentSeq: next.compactionSeq }
        } else if (startsTurn(event) && !isOwnInjection(event)) {
          const text = blockText((event.data as { content?: unknown }).content)
          if (text.length > 0) {
            next = {
              ...next,
              prompts: appendPrompt(next.prompts, { seq: Number(event.seq), text: clip(text, promptChars) }, 0),
            }
          }
        }
      }
      return { ...next, tail: appendDigest(next.tail, event, tailEvents, eventChars) }
    },
  })

  ctx.on('agent/pre-step', async (
    { agent, messages, signal },
    next,
  ): Promise<PreStepDecision> => {
    const base = await next()
    if (base.kind === 'reject') return base
    const session = agent.session
    const state = ctx.sessionProjections.stateOf(session, 'sessionRecovery') as SessionRecoveryProjection

    // The system prompt's context provider is synchronous, and assembly reads it
    // before any prompt waterfall runs, so the record must be on hand by the time
    // this step is decided. A compaction replaces the record, and the path it is
    // stored under changes with it. The step that closes a compaction writes the
    // file below, so an unreadable path here means "not written yet" and is left
    // for that write to fill in.
    const recordPath = recordPathOf(ctx, root, session)
    if (recordPath !== undefined && recordText.get(session)?.path !== recordPath) {
      const text = await readRecordIfPresent(recordPath)
      if (text !== undefined) recordText.set(session, { path: recordPath, text })
    }

    // Past the acknowledgement: admit the messages this plugin deferred for the
    // real turn, then let the ordinary injections run.
    const stashed = deferred.get(session)
    if (stashed !== undefined && !awaitingAcknowledgement(state)) {
      deferred.delete(session)
      return { ...base, messages: [...stashed, ...base.messages] }
    }
    // Nothing to answer: no compaction yet, or this compaction already answered.
    if (state.compactionSeq === null || state.recoverySentSeq === state.compactionSeq) return base

    await writeCompactionLog(root, session, state, compactionEvents)
    const path = compactionLogPath(root, session, state.compactionId ?? String(state.compactionSeq))
    const record = await readRecord(path)
    // The initialization step owns the exchange. The operator's claimed messages
    // wait for the step that follows the acknowledgement, so this step carries
    // the record and its instruction and nothing else.
    deferred.set(session, [...messages])
    signal.throwIfAborted()
    return {
      kind: 'enter',
      startsRequestSeries: true,
      messages: [
        createUserMessage({
          content: [{ type: 'text', text: renderRecovery(record, instruction) }],
          source: { kind: 'plugin', plugin: name, form: RECOVERY_FORM, sections: [{ name, text: record }] },
        }),
      ],
    }
  }, { prepend: true })

  // The initialization step carries no system prompt and no other injections.
  ctx.on('system-prompt/assemble', async (assembly: PromptAssembly, context, next) => {
    const agent = context.agent
    if (agent === undefined) return next()
    const state = ctx.sessionProjections.stateOf(agent.session, 'sessionRecovery') as SessionRecoveryProjection
    if (!awaitingAcknowledgement(state)) return next()
    return { sections: [], contexts: [], tools: assembly.tools, variables: assembly.variables }
  }, { prepend: true })

  // The prompt facts are optional: a composition without a system prompt still
  // gets the initialization step, which is the part that changes behavior.
  ctx.inject(['systemPrompt'], (scope: Context) => {
    const logOf = (session: Session | undefined): string | undefined => {
      if (session === undefined) return undefined
      return sessionLogPath(root, session.header.cwd, session.id, compression)
    }
    scope.systemPrompt.variable('session_id', context => context.agent?.session.id)
    scope.systemPrompt.variable('session_log', context => logOf(context.agent?.session))
    scope.systemPrompt.variable('session_dir', (context) => {
      const session = context.agent?.session
      return session === undefined ? undefined : sessionDir(root, session.header.cwd, session.id)
    })
    scope.systemPrompt.context({
      name: 'session:log',
      order: LOG_CONTEXT_ORDER,
      text: (context) => {
        const path = logOf(context.agent?.session)
        return path === undefined ? '' : `This session is logged to ${path}`
      },
    })
    // The record a compaction leaves behind is named for that compaction, so the
    // fact is resolved from the fold on every assembly rather than captured: as
    // compactions happen, the path this names changes with them. Before the
    // first compaction there is no record, and the fact renders empty.
    const recordOf = (session: Session | undefined): string | undefined =>
      session === undefined ? undefined : recordPathOf(ctx, root, session)
    scope.systemPrompt.context({
      name: 'session:context-file',
      order: CONTEXT_FILE_ORDER,
      text: (context) => {
        const session = context.agent?.session
        const path = recordOf(session)
        if (path === undefined) return ''
        const record = session === undefined ? undefined : recordText.get(session)
        return record === undefined || record.path !== path
          ? `Context file: ${path}`
          : `Context file: ${path}\n\n${record.text}`
      },
    })
  })
}

/**
 * Read the record back, or nothing when it is not there yet.
 *
 * A record is named before it is written — the path is known from the fold as
 * soon as the compaction commits — so callers that warm a cache must be able to
 * tell "absent" from "empty".
 * @param path - the record's path.
 * @returns its text, or undefined when the file does not exist.
 */
async function readRecordIfPresent(path: string): Promise<string | undefined> {
  const { readFile } = await import('node:fs/promises')
  try {
    return await readFile(path, 'utf8')
  } catch {
    return undefined
  }
}

/** Read the record back, tolerating a missing file by rendering nothing. */
async function readRecord(path: string): Promise<string> {
  const { readFile } = await import('node:fs/promises')
  try {
    return await readFile(path, 'utf8')
  } catch {
    return `(the compaction record at ${path} could not be read)`
  }
}
