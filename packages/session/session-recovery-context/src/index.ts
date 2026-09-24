/**
 * Recovery after compaction: a code-maintained ledger of the session, and a
 * handoff message that restates it in the same step the compaction happened.
 *
 * Compaction keeps a model-written summary and drops the transcript. What a
 * summary drops first is exactly what code can know for certain — the
 * operator's own words, the files touched, the commands run, the errors still
 * open, the todo list — so this plugin folds those facts from the log as it
 * commits (see `ledger.ts`) and, on the first step after a compaction, adds ONE
 * message to that step: the handoff (see `handoff.ts`). The turn carries on.
 *
 * Two things this deliberately does not do, because an earlier design did and
 * they broke recovery:
 *
 * - It never spends a step of its own. A step whose reply calls no tool ends
 *   the turn, so an "acknowledge the record" step stopped every task that was
 *   compacted mid-run and held the operator's message until the next turn.
 * - It never suppresses the system prompt, and never restates the checkpoint
 *   summary, which is already in the history one message up.
 *
 * After the first compaction a one-line focus note rides the runtime context,
 * pushing the in-progress todo and the next step back into the model's most
 * recent attention.
 *
 * Nothing here scans history: a Session projection folds each event once, as
 * the [synchronous-read rule](../../../../.agents/notes/implemented/architecture/2026-09-09-deprecate-synchronous-session-event-reads.md)
 * prescribes, so the ledger survives resume.
 * @module @deepseek-ai/dsh-session-recovery-context
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import z from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
// Type-only: resolves the `compaction/*` events the ledger folds.
import type {} from '@deepseek-ai/dsh-compaction'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-system-prompt'
import {
  DEFAULT_LEDGER_LIMITS,
  HANDOFF_SOURCE_KIND,
  awaitingHandoff,
  emptyLedger,
  foldLedger,
  ledgerSchema,
} from './ledger.ts'
import type { Ledger, LedgerLimits } from './ledger.ts'
import { renderFocus, renderHandoff } from './handoff.ts'
import { DEFAULT_REHYDRATE_LIMITS, gitSnapshot, rehydrateFiles } from './workspace.ts'
import type { RehydrateLimits } from './workspace.ts'
import { sessionDir, sessionLogPath } from './log-path.ts'
import type { LogCompression } from './log-path.ts'

export { encodeSegment, projectDir, projectKey, sessionDir, sessionLogPath } from './log-path.ts'
export type { LogCompression } from './log-path.ts'
export {
  DEFAULT_LEDGER_LIMITS,
  HANDOFF_SOURCE_KIND,
  LEGACY_HANDOFF_SOURCE_KIND,
  awaitingHandoff,
  blockText,
  classifyCall,
  emptyLedger,
  foldLedger,
  resultSucceeded,
} from './ledger.ts'
export type { Ledger, LedgerCommand, LedgerError, LedgerFile, LedgerLimits, LedgerPrompt } from './ledger.ts'
export { HANDOFF_PREAMBLE, extractSection, fenceFor, renderContinue, renderFocus, renderHandoff } from './handoff.ts'
export type { HandoffInput, RehydratedFile } from './handoff.ts'
export { DEFAULT_REHYDRATE_LIMITS, gitSnapshot, rehydrateFiles } from './workspace.ts'
export type { RehydrateLimits } from './workspace.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'session-recovery-context'

/** Services required before the projection and the pre-step listener can register. */
export const inject = ['agents', 'sessionProjections']

/** The projection key the ledger is folded under. */
export const LEDGER_PROJECTION = 'sessionLedger'

/**
 * Runtime-context positions. Just past the `CONTEXT_ORDERS` band (110/115/120)
 * that `dsh-system-prompt` allocates centrally; `systemPrompt.context()` takes
 * any finite order, so a fork-owned position costs no upstream edit.
 */
const LOG_CONTEXT_ORDER = 125
const FOCUS_CONTEXT_ORDER = LOG_CONTEXT_ORDER + 1

/** Filename prefix of the plain-text record each compaction leaves behind. */
export const COMPACTION_RECORD_PREFIX = 'compaction-'

/** The durable source of the handoff message. */
export interface SessionRecoverySource {
  kind: typeof HANDOFF_SOURCE_KIND
  form: 'handoff'
  /** The compaction this handoff answers. */
  compactionId: string
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'session-recovery': SessionRecoverySource
  }
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** The code-maintained ledger of this session. */
    sessionLedger: Ledger
  }
}

/** Plugin config. Every field bounds state or size; none is required. */
export interface Config {
  /** The session root directory; defaults to the harness home's `sessions`. */
  root?: string
  /** The artifact encoding the session writer uses. */
  logCompression?: LogCompression
  /** Bounds on what the ledger keeps. */
  ledger?: Partial<LedgerLimits>
  /** Bounds on the file contents a handoff re-attaches. */
  rehydrate?: Partial<RehydrateLimits>
  /** Share of the routed model's context window the handoff may use. */
  handoffShare?: number
  /** Smallest handoff budget, in characters. */
  handoffMinChars?: number
  /** Largest handoff budget, in characters. */
  handoffMaxChars?: number
  /** Whether to snapshot `git status` into the handoff. */
  git?: boolean
}

export const Config: z<Config> = z.object({
  root: z.string().description('The session root directory.'),
  logCompression: z.union([z.const('zstd'), z.const('none')]).description('The artifact encoding the session writer uses.'),
  ledger: z.object({
    prompts: z.number().step(1).min(2),
    promptChars: z.number().step(1).min(200),
    files: z.number().step(1).min(1),
    commands: z.number().step(1).min(1),
    errors: z.number().step(1).min(1),
    errorChars: z.number().step(1).min(80),
  }).description('Bounds on what the ledger keeps.'),
  rehydrate: z.object({
    files: z.number().step(1).min(0),
    perFileChars: z.number().step(1).min(200),
    maxBytes: z.number().step(1).min(1024),
  }).description('Bounds on the file contents a handoff re-attaches.'),
  handoffShare: z.number().min(0.01).max(0.5).description("Share of the routed model's context window the handoff may use."),
  handoffMinChars: z.number().step(1).min(1000).description('Smallest handoff budget, in characters.'),
  handoffMaxChars: z.number().step(1).min(1000).description('Largest handoff budget, in characters.'),
  git: z.boolean().description('Snapshot `git status` into the handoff.'),
})

/** Share of the routed window a handoff may use when the deployment states none. */
export const DEFAULT_HANDOFF_SHARE = 0.08
/** Smallest handoff budget when the deployment states none. */
export const DEFAULT_HANDOFF_MIN_CHARS = 6000
/** Largest handoff budget when the deployment states none. */
export const DEFAULT_HANDOFF_MAX_CHARS = 24000

/** Characters per token the budget estimates with; conservative for code and prose. */
const CHARS_PER_TOKEN = 4

/**
 * The handoff's character budget for a routed model.
 * @param contextWindow - the model's window in tokens, when known.
 * @param share - share of the window the handoff may use.
 * @param min - floor in characters.
 * @param max - ceiling in characters.
 * @returns the budget.
 */
export function handoffBudget(contextWindow: number | undefined, share: number, min: number, max: number): number {
  if (contextWindow === undefined || contextWindow <= 0) return max
  return Math.min(max, Math.max(min, Math.floor(contextWindow * CHARS_PER_TOKEN * share)))
}

/**
 * The filename one compaction's record is written under.
 * @param compactionId - the compaction id.
 * @param sessionId - the session id.
 * @returns the file's basename.
 */
export function compactionRecordFilename(compactionId: string, sessionId: string): string {
  return `${COMPACTION_RECORD_PREFIX}${compactionId}-${sessionId}.md`
}

/**
 * The record a compaction leaves on disk: the handoff, then the checkpoint.
 * @param handoff - the rendered handoff.
 * @param summary - the checkpoint summary.
 * @returns the record text.
 */
export function renderRecord(handoff: string, summary: string): string {
  const body = summary.trim().length === 0 ? '_(none recorded)_' : summary.trim()
  return [handoff, '', '---', '', '# Checkpoint summary', '', body, ''].join('\n')
}

/**
 * Install the ledger, the in-step handoff, the focus note, and the log facts.
 * @param ctx - the plugin context.
 * @param config - the deployment's bounds.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const root = config.root ?? dshHomePath('sessions')
  const compression: LogCompression = config.logCompression ?? 'zstd'
  const limits: LedgerLimits = { ...DEFAULT_LEDGER_LIMITS, ...config.ledger }
  const rehydrateLimits: RehydrateLimits = { ...DEFAULT_REHYDRATE_LIMITS, ...config.rehydrate }
  const share = config.handoffShare ?? DEFAULT_HANDOFF_SHARE
  const minChars = config.handoffMinChars ?? DEFAULT_HANDOFF_MIN_CHARS
  const maxChars = Math.max(minChars, config.handoffMaxChars ?? DEFAULT_HANDOFF_MAX_CHARS)
  const withGit = config.git ?? true

  ctx.sessionProjections.register({
    key: LEDGER_PROJECTION,
    stateVersion: 1,
    stateSchema: ledgerSchema,
    init: emptyLedger,
    apply: (state, event) => foldLedger(state, event, limits),
  })

  const ledgerOf = (session: Session): Ledger =>
    ctx.sessionProjections.stateOf(session, LEDGER_PROJECTION) as Ledger

  /** Sessions whose handoff is being built right now, so one compaction gets one handoff. */
  const building = new WeakSet<Session>()

  /** The routed model's context window, when the LLM runtime can say. */
  const contextWindowOf = async (session: Session, signal: AbortSignal): Promise<number | undefined> => {
    const routed = session.requestHeader()?.config
    const llm = ctx.get('llm')
    if (routed === undefined || llm === undefined || routed.provider.length === 0) return undefined
    try {
      const info = await llm.resolveModelInfo(routed.provider, routed.model, signal)
      return info.context?.contextWindow
    } catch {
      return undefined
    }
  }

  ctx.on('agent/pre-step', async ({ agent, signal }, next): Promise<PreStepDecision> => {
    // Compaction runs inside the chain this listener wraps, so the ledger is
    // read only after it: a compaction that happens in this very step is
    // answered in this very step.
    const base = await next()
    if (base.kind === 'reject') return base
    const session = agent.session
    const ledger = ledgerOf(session)
    const compaction = ledger.compaction
    if (!awaitingHandoff(ledger) || compaction === null || building.has(session)) return base
    building.add(session)
    try {
      const cwd = session.header.cwd
      const local = cwd !== undefined && cwd.length > 0
      const [window, git, files] = await Promise.all([
        contextWindowOf(session, signal),
        withGit && local ? gitSnapshot(cwd) : Promise.resolve(''),
        rehydrateLimits.files > 0 && local ? rehydrateFiles(ledger, cwd, rehydrateLimits) : Promise.resolve([]),
      ])
      signal.throwIfAborted()
      const dir = sessionDir(root, cwd, session.id)
      const recordPath = join(dir, compactionRecordFilename(compaction.id, session.id))
      const handoff = renderHandoff({
        ledger,
        git,
        files,
        recordPath,
        logPath: sessionLogPath(root, cwd, session.id, compression),
        budgetChars: handoffBudget(window, share, minChars, maxChars),
      })
      // The record is a convenience for a reader who needs more than the
      // handoff carries; failing to write it must not cost the handoff.
      try {
        await mkdir(dir, { recursive: true })
        await writeFile(recordPath, renderRecord(handoff, compaction.summary), 'utf8')
      } catch (error: unknown) {
        const reason = error instanceof Error ? error.message : String(error)
        ctx.logger.warn(`session-recovery-context: could not write ${recordPath}: ${reason}`)
      }
      signal.throwIfAborted()
      const message = createUserMessage({
        content: [{ type: 'text', text: handoff }],
        source: { kind: HANDOFF_SOURCE_KIND, form: 'handoff', compactionId: compaction.id },
      })
      // First in the step, so the operator's own message and the runtime
      // context still come last, nearest the next generation.
      return { ...base, messages: [message, ...base.messages] }
    } finally {
      building.delete(session)
    }
  }, { prepend: true })

  // The prompt facts are optional: a composition without a system prompt still
  // gets the ledger and the handoff, which are the parts that change behavior.
  ctx.inject(['systemPrompt'], (scope: Context) => {
    const logOf = (session: Session | undefined): string | undefined =>
      session === undefined ? undefined : sessionLogPath(root, session.header.cwd, session.id, compression)
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
    scope.systemPrompt.context({
      name: 'session:focus',
      order: FOCUS_CONTEXT_ORDER,
      text: (context) => {
        const session = context.agent?.session
        return session === undefined ? '' : renderFocus(ledgerOf(session))
      },
    })
  })
}
