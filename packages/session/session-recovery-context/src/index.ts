/**
 * Post-compaction recovery context, and the session's own log path as a prompt
 * fact.
 *
 * Compaction keeps a summary and drops the transcript. What it drops includes
 * the operator's own words — the prompt the work was commissioned with, and every
 * correction since — so the turn after a compaction is the turn most likely to
 * resume the wrong task, confidently. This plugin answers that turn by PUTTING
 * THE RECORD BACK rather than by telling the model to go looking for it: one
 * message, injected once per compaction, carrying the operator prompts and the
 * tail of the log. An instruction to fetch it would cost a turn and can be
 * skipped; an injected message cannot.
 *
 * Nothing here scans history. A Session projection folds the prompts, the event
 * tail, and the latest compaction as they commit, exactly as the
 * [synchronous-read rule](../../../../.agents/notes/implemented/architecture/2026-09-09-deprecate-synchronous-session-event-reads.md)
 * prescribes, so the state survives resume and costs one pure fold per event.
 * The injection is idempotent through the log itself: the message it appends
 * records this plugin as its source, and the same fold reads that back as "this
 * compaction has been answered".
 *
 * The same session facts are registered as prompt variables, so a deployment can
 * write `{{session_log}}` into its own persona text and get the exact file the
 * writer is appending to.
 *
 * ```yaml
 * - id: session-recovery-context
 *   name: '@deepseek-ai/dsh-session-recovery-context'
 *   config:
 *     tailEvents: 50
 * ```
 *
 * @module @deepseek-ai/dsh-session-recovery-context
 */

import z from '@deepseek-ai/schemastery'
import { z as zod } from 'zod'
import type { Context } from '@deepseek-ai/cordis'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
// Type-only: the `compaction/*` SessionEventMap merges. Without it
// `compaction/summary` is not a member of the event union and the watermark
// comparison below is a type error, not a runtime one.
import type {} from '@deepseek-ai/dsh-compaction'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { sessionDir, sessionLogPath } from './log-path.ts'
import type { LogCompression } from './log-path.ts'

export { encodeSegment, projectDir, projectKey, sessionDir, sessionLogPath } from './log-path.ts'
export type { LogCompression } from './log-path.ts'

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
  /** Sequence number of the event. */
  seq: zod.number(),
  /** The event type, verbatim. */
  type: zod.string(),
  /** A short label read out of the event's own payload, or `''` when it has none. */
  label: zod.string(),
})

const stateSchema = zod.object({
  /** Every operator prompt, oldest first. */
  prompts: zod.array(promptSchema),
  /** The most recent events, oldest first, bounded by `tailEvents`. */
  tail: zod.array(digestSchema),
  /** Sequence number of the newest `compaction/summary`, or null. */
  compactionSeq: zod.number().nullable(),
  /** The compaction this plugin has already answered, or null. */
  answeredSeq: zod.number().nullable(),
})

/** Folded recovery state for one session. */
export type SessionRecoveryProjection = zod.infer<typeof stateSchema>

/** One operator prompt as the projection keeps it. */
export type RecoveryPrompt = zod.infer<typeof promptSchema>

/** One event as the tail keeps it. */
export type RecoveryDigest = zod.infer<typeof digestSchema>

/** The wording a deployment overrides rather than rewrites. */
export const DEFAULT_PREAMBLE = 'Context was compacted. Below is the durable record the compaction did not keep:'
  + ' every instruction the operator gave, and the tail of this session\'s log.'
  + ' Treat the operator prompts as the authority on what the task is.'

/** Trailing events the digest carries when the deployment states no bound. */
export const DEFAULT_TAIL_EVENTS = 50

/** Per-prompt character budget when the deployment states none. */
export const DEFAULT_PROMPT_CHARS = 1200

/** Per-event label budget when the deployment states none. */
export const DEFAULT_LABEL_CHARS = 120

/**
 * Plugin config. Every field bounds state or wording; none is required.
 *
 * Defaults live in {@link apply} rather than in the schema below, so an omitted
 * field is observably omitted — a schema default would make the code's fallback
 * unreachable and hide which layer chose the value.
 */
export interface Config {
  /**
   * Session root the JSONL backend writes under. Defaults to the same
   * `dshHomePath('sessions')` the shipped `session-persistence-jsonl` row uses,
   * so the two agree without being stated twice; a deployment that moves that
   * root must set the same value here or the printed path will name a file that
   * does not exist.
   */
  root?: string
  /** The backend's artifact encoding, which decides the log's suffix. Defaults to `zstd`. */
  compression?: LogCompression
  /** How many trailing events the digest carries. `0` disables the tail. Defaults to 50. */
  tailEvents?: number
  /** Per-prompt character budget; a longer prompt is clipped with a marker. Defaults to 1200. */
  promptChars?: number
  /** How many prompts to keep. Omitted or `0` keeps every one of them. */
  maxPrompts?: number
  /** Per-event label budget inside the tail. Defaults to 120. */
  labelChars?: number
  /** First line of the injected message. Defaults to {@link DEFAULT_PREAMBLE}. */
  preamble?: string
}

/** Schemastery validation for {@link Config}. Invalid values fail plugin load. */
export const Config: z<Config> = z.object({
  root: z.string(),
  compression: z.union([z.const('zstd'), z.const('none')]),
  tailEvents: z.natural(),
  promptChars: z.natural(),
  maxPrompts: z.natural(),
  labelChars: z.natural(),
  preamble: z.string(),
})

/** Collapse whitespace and clip to a budget, marking a clip rather than hiding it. */
function clip(text: string, budget: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (budget <= 0 || flat.length <= budget) return flat
  return `${flat.slice(0, budget)}… [+${flat.length - budget} chars, whole text in the session log]`
}

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
  for (const key of ['name', 'summary', 'reason', 'mode', 'title'] as const) {
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

/** Whether one `user/message` event is this plugin's own injection. */
function isOwnInjection(event: SessionEvent<'user/message'>): boolean {
  const source = event.data.source as { kind?: unknown; plugin?: unknown }
  return source.kind === 'plugin' && source.plugin === name
}

/**
 * Render the recovery message the model reads after a compaction.
 * @param state - the folded prompts and event tail.
 * @param preamble - the message's first line.
 * @param logPath - the session's log file, omitted when there is no session to name.
 * @returns the message text, without a trailing newline.
 */
export function renderRecovery(
  state: SessionRecoveryProjection,
  preamble: string,
  logPath: string | undefined,
): string {
  const sections = [preamble, '', '## Operator prompts, oldest first']
  if (state.prompts.length === 0) sections.push('(none recorded)')
  else sections.push(...state.prompts.map((prompt, index) => `${index + 1}. [seq ${prompt.seq}] ${prompt.text}`))
  if (state.tail.length > 0) {
    sections.push('', `## Last ${state.tail.length} session events, oldest first`)
    sections.push(...state.tail.map(entry => `[seq ${entry.seq}] ${entry.type}${entry.label === '' ? '' : ` — ${entry.label}`}`))
  }
  if (logPath !== undefined) {
    sections.push('', `The whole record, including everything clipped above, is in this session's log: ${logPath}`)
  }
  return sections.join('\n')
}

/**
 * Register the recovery projection, the prompt facts, and the pre-step injector.
 * @param ctx - plugin context; every registration is disposed with it.
 * @param config - state bounds, the backend's path inputs, and the message wording.
 */
export function apply(ctx: Context, config: Config): void {
  const root = config.root ?? dshHomePath('sessions')
  const compression = config.compression ?? 'zstd'
  const tailEvents = config.tailEvents ?? DEFAULT_TAIL_EVENTS
  const promptChars = config.promptChars ?? DEFAULT_PROMPT_CHARS
  const maxPrompts = config.maxPrompts ?? 0
  const labelChars = config.labelChars ?? DEFAULT_LABEL_CHARS
  const preamble = config.preamble ?? DEFAULT_PREAMBLE

  /** The log file for one session, or undefined without a session to name. */
  const logOf = (session: Session | undefined): string | undefined =>
    session === undefined ? undefined : sessionLogPath(root, session.header.cwd, session.id, compression)

  ctx.sessionProjections.register({
    key: 'sessionRecovery',
    stateVersion: 1,
    stateSchema,
    init: () => ({ prompts: [], tail: [], compactionSeq: null, answeredSeq: null }),
    // Every event advances the tail, so this fold returns a fresh state each
    // time rather than preserving the reference an uninterested unit would. The
    // unit publishes no `wire` view, so that churn reaches no client.
    apply: (state, event) => {
      let next = state
      if (event.type === 'compaction/summary') next = { ...next, compactionSeq: Number(event.seq) }
      if (event.type === 'user/message') {
        const message = event
        if (isOwnInjection(message)) next = { ...next, answeredSeq: next.compactionSeq }
        else if (message.data.source.kind === 'user') {
          const text = clip(blockText(message.data.content), promptChars)
          if (text.length > 0) {
            next = { ...next, prompts: appendPrompt(next.prompts, { seq: Number(event.seq), text }, maxPrompts) }
          }
        }
      }
      if (tailEvents === 0) return next
      return { ...next, tail: appendDigest(next.tail, event, tailEvents, labelChars) }
    },
  })

  ctx.on('agent/pre-step', async ({ agent, signal }, next): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind === 'reject' || signal.aborted) return decision
    const state = ctx.sessionProjections.stateOf(agent.session, 'sessionRecovery') as SessionRecoveryProjection
    // Nothing to answer: no compaction yet, or the log already holds this
    // plugin's answer to the newest one.
    if (state.compactionSeq === null || state.compactionSeq === state.answeredSeq) return decision
    const text = renderRecovery(state, preamble, logOf(agent.session))
    return {
      ...decision,
      messages: [
        ...decision.messages,
        createUserMessage({
          content: [{ type: 'text', text }],
          source: { kind: 'plugin', plugin: name, form: 'snapshot', sections: [{ name, text }] },
        }),
      ],
    }
  }, { prepend: true })

  // The prompt facts are optional: a composition without a system prompt still
  // gets the recovery injection, which is the part that changes behavior.
  //
  // Variable names are snake_case because the registry enforces
  // `/^[a-z][a-z0-9_]*$/` and a rejected name throws inside this fiber, where
  // the failure is swallowed: one camelCase name took the whole block —
  // every variable AND the context section — down silently.
  ctx.inject(['systemPrompt'], (scope: Context) => {
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
  })
}

export default apply
