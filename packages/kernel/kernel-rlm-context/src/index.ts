/**
 * RLM "context-as-variable" agent-loop seam (LOCAL OVERLAY).
 *
 * This package closes the loop for the Kiln RLM facet shipped in
 * `python/kiln/runtime/rlm_context.py` and the `rlm.*` seam in
 * `@deepseek-ai/dsh-kernel-python`:
 *
 *   - Python side: the model writes `ctx_write(name, value)` and a terminal
 *     `answer` dict; `rlm_dump()` emits one machine-readable marker line.
 *   - This side: a `KernelContextService` reads that dump back through
 *     `ctx.kernel.execute(...)` and an async `system-prompt/assemble`
 *     waterfall listener appends it as a runtime-context section, so the
 *     agent loop's EXISTING `renderContextSections()` path (agent.ts)
 *     consults kernel binds/answer without any core-file edit.
 *
 * Hardening (see the RLM audit):
 *   - #1 deadlock: the read-back is skipped while `ctx.kernel.busy()` reports a
 *     queued/running cell, so a re-entrant `rlm_dump()` can never queue behind
 *     an in-flight `llm_batch` fan-out on the serialized kernel.
 *   - #2 clean-context leak: `ownerAgentId` pins the contribution to one agent,
 *     so an in-process child (clean-context) agent does not inherit the parent
 *     kernel binds. Omitted = broad (the legacy behavior, retained for
 *     single-agent compositions).
 *   - #3 terminal amplification: a READY `answer` is terminal — the agent
 *     already received it via `llm_batch`'s return value — so the listener
 *     contributes nothing for it. `sub_*` fan-out results are likewise filtered
 *     from binds (the parent already consumed them).
 *   - #6 duplicate section: the listener replaces any existing `kernel:rlm`
 *     context instead of appending a same-named entry.
 *   - #4 hard stop on ready: the actual "stop driving once `answer.ready`"
 *     decision belongs to core agent-loop tool-result handling, which this
 *     overlay deliberately does not edit. This package only suppresses the
 *     settled answer's re-injection (fix #3); a true hard-stop still needs a
 *     core patch outside the update-safe surface.
 *   - #5 namespace collisions: the Python facet (`rlm_context.py`) now refuses
 *     `ctx_write` of any pre-installed callable or facet primitive, so a bind
 *     cannot silently clobber a harness helper (remember/recall/llm_batch/…).
 *
 * Update safety: this whole package is a new local file (does not exist
 * upstream), and it plugs into public seams (`ctx.kernel.execute`,
 * `ctx.kernel.busy`, the `system-prompt/assemble` waterfall). Nothing under
 * `packages/core/agent-loop` or `packages/core/system-prompt` is modified.
 *
 * @module @deepseek-ai/dsh-kernel-rlm-context
 */

import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-kernel'
import type { AssembleContext, PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import z from '@deepseek-ai/schemastery'

/** Marker printed by `rlm_dump()`; must stay in sync with `rlm_context.py`. */
const RLM_MARKER = '__KILN_RLM_STATE__'

/** Runtime-context section name, attributed in the durable snapshot. */
export const RLM_CONTEXT_SECTION = 'kernel:rlm'

/** Read timeout for the `rlm_dump()` query cell (fast; must not stall assembly). */
const READ_TIMEOUT_MS = 30_000

/** Plugin name used by loader diagnostics. */
export const name = 'kernel-rlm-context'

/** Services this plugin requires before it may load. */
export const inject = ['kernel', 'systemPrompt']

/** Plugin config. */
export interface Config {
  /** Skip the read-back and contribute nothing (defaults to false). */
  disabled?: boolean
  /**
   * When set, contribute ONLY for this agent id. Children (in-process
   * subagents) have different ids and are therefore skipped, preserving their
   * clean context. Omitted = contribute for every agent (legacy, single-agent).
   */
  ownerAgentId?: string
  /** Cap on rendered answer text, to keep the runtime snapshot bounded. */
  maxAnswerChars?: number
  /** Cap on rendered bind text per value. */
  maxBindChars?: number
}

export const Config: z<Config> = z.object({
  disabled: z.boolean().default(false),
  ownerAgentId: z.string(),
  maxAnswerChars: z.number().step(1).min(0).default(4000),
  maxBindChars: z.number().step(1).min(0).default(2000),
})

/** Fully-resolved config after schemastery defaults. */
export interface ResolvedConfig {
  disabled: boolean
  ownerAgentId: string | undefined
  maxAnswerChars: number
  maxBindChars: number
}

/** The parsed `rlm_dump()` payload. */
export interface RlmSnapshot {
  readonly answer: { readonly content: string; readonly ready: boolean }
  readonly binds: Readonly<Record<string, unknown>>
}

export function parseRlmDump(output: string): RlmSnapshot | undefined {
  for (const line of output.split('\n')) {
    const at = line.indexOf(RLM_MARKER)
    if (at === -1) continue
    const raw = line.slice(at + RLM_MARKER.length).trim()
    if (raw.length === 0) continue
    try {
      const value: unknown = JSON.parse(raw)
      if (typeof value !== 'object' || value === null) continue
      const record = value as { answer?: unknown; binds?: unknown }
      const answer = record.answer
      const answerRecord = (typeof answer === 'object' && answer !== null ? answer : {}) as {
        content?: unknown
        ready?: unknown
      }
      return {
        answer: {
          content: typeof answerRecord.content === 'string' ? answerRecord.content : '',
          ready: answerRecord.ready === true,
        },
        binds: (typeof record.binds === 'object' && record.binds !== null ? record.binds : {}) as Readonly<Record<string, unknown>>,
      }
    } catch {
      continue
    }
  }
  return undefined
}

function stringifyBind(value: unknown, maxChars: number): string {
  let text: string
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  } catch {
    try { text = String(value) } catch { text = '<unserializable>' }
  }
  if (text.length <= maxChars) return text
  const half = Math.floor(maxChars / 2)
  return half <= 1 ? text.slice(0, maxChars) + '…' : `${text.slice(0, half)}…\n…${text.slice(text.length - half)}`
}

/**
 * Terminal fan-out result keys are NOT live runtime state. `answer` is already
 * rendered separately; `sub_*` results were already consumed by `llm_batch`'s
 * return value. Neither may be re-injected across turns (fix #3).
 */
function isTerminalKey(key: string): boolean {
  return key === 'answer' || key.startsWith('sub_')
}

/**
 * Renders one RLM snapshot into the model-facing runtime-context prose.
 *
 * This is a PURE formatter: it always renders live binds plus the answer, in
 * the stable diagnostic shape tests assert against. Terminal suppression
 * (skipping a READY answer, which the agent already received via `llm_batch`)
 * is the LISTENER's policy, applied before this formatter is called — see
 * {@link apply}. `sub_*` fan-out keys are filtered from binds here because they
 * are never live variables.
 *
 * Returns `''` when there is nothing to contribute.
 */
export function renderRlmContext(snapshot: RlmSnapshot, config: ResolvedConfig): string {
  const parts: string[] = []
  for (const [key, value] of Object.entries(snapshot.binds).sort(([a], [b]) => a.localeCompare(b))) {
    if (isTerminalKey(key)) continue
    parts.push(`${key} = ${stringifyBind(value, config.maxBindChars)}`)
  }
  const hasAnswer = snapshot.answer.content.length > 0 || snapshot.answer.ready
  if (hasAnswer) {
    const ready = snapshot.answer.ready ? 'ready' : 'not-ready'
    parts.push(`answer (${ready}): ${stringifyBind(snapshot.answer.content, config.maxAnswerChars)}`)
  }
  if (parts.length === 0) return ''
  return `Kernel RLM context variables. These are live program values, not transcript.\n${parts.join('\n')}`
}

/**
 * Minimal structural view of the agent carried on `AssembleContext.agent`.
 *
 * The full `agent?: Agent` augmentation lives in `@deepseek-ai/dsh-agent`; this
 * package deliberately does NOT depend on that package, so it reads only the
 * `id` it needs through a local structural cast. A branded `SessionId` is a
 * subtype of `string`, so the assignment is compatible whenever the
 * augmentation is loaded, and the cast is a safe no-op when it is not.
 */
interface AssemblyAgentLike { readonly id: string }

function assemblyAgent(context: AssembleContext): AssemblyAgentLike | undefined {
  return (context as AssembleContext & { agent?: AssemblyAgentLike }).agent
}

/**
 * Scoped `ctx.kernelContext` service: reads the live kernel RLM snapshot.
 *
 * Registered on the same context that owns the kernel backend. The
 * `system-prompt/assemble` listener consults this service during assembly.
 */
export class KernelContextService extends Service<Config> {
  constructor(ctx: Context, config: ResolvedConfig) {
    super(ctx, 'kernelContext')
    this.config = config
  }

  private readonly config: ResolvedConfig

  /** True when the read-back is enabled. */
  enabled(): boolean {
    return !this.config.disabled
  }

  /**
   * Whether this assembly's agent may receive the read-back (fix #2). With no
   * `ownerAgentId` every agent is allowed (legacy); with one, only that exact
   * id is allowed. A diagnostic assembly with no `agent` is allowed so the
   * legacy single-agent path keeps working.
   */
  allowedAgent(context: AssembleContext): boolean {
    if (this.config.ownerAgentId === undefined) return true
    const agent = assemblyAgent(context)
    if (agent === undefined) return true
    return agent.id === this.config.ownerAgentId
  }

  /**
   * Query the kernel for its live RLM snapshot. Returns `undefined` when the
   * kernel is unavailable, the facet is not mounted, parsing fails, or the
   * kernel reports `busy()` (fix #1: never queue a read behind an in-flight
   * fan-out cell on the serialized kernel).
   */
  async read(signal?: AbortSignal, owner?: AssemblyAgentLike): Promise<RlmSnapshot | undefined> {
    if (this.config.disabled) return undefined
    try {
      if (this.ctx.kernel.busy()) return undefined
      // Thread the owning agent as `agentCtx` so the provider scopes the cell's
      // conversation key: rlm_dump() then rehydrates THIS conversation's durable
      // ctx binds (kind="ctx") instead of returning a store-less empty dump.
      const agentCtx = owner === undefined ? undefined : ({ agent: owner } as unknown as Context)
      const result = await this.ctx.kernel.execute(
        agentCtx === undefined
          ? { code: 'rlm_dump()', timeoutMs: READ_TIMEOUT_MS }
          : { code: 'rlm_dump()', timeoutMs: READ_TIMEOUT_MS, agentCtx },
        signal,
      )
      if (result.outcome !== 'ok') return undefined
      return parseRlmDump(result.output)
    } catch {
      return undefined
    }
  }
}

export function apply(ctx: Context, config: Config): void {
  const resolved: ResolvedConfig = {
    disabled: config.disabled ?? false,
    ownerAgentId: config.ownerAgentId !== undefined && config.ownerAgentId.length > 0 ? config.ownerAgentId : undefined,
    maxAnswerChars: config.maxAnswerChars ?? 4000,
    maxBindChars: config.maxBindChars ?? 2000,
  }
  const service = new KernelContextService(ctx, resolved)

  const dispose = ctx.on('system-prompt/assemble', async (_assembly: PromptAssembly, context: AssembleContext, next) => {
    const assembled = await next()
    if (resolved.disabled) return assembled
    if (!service.allowedAgent(context)) return assembled
    const snapshot = await service.read(context.signal, assemblyAgent(context))
    if (snapshot === undefined) return assembled
    // Fix #3: a READY answer is terminal — the agent already received it via
    // `llm_batch`'s return value. Re-injecting it every turn would only amplify
    // a settled result. Contribute nothing for it.
    if (snapshot.answer.ready) return assembled
    const text = renderRlmContext(snapshot, resolved)
    if (text.length === 0) return assembled
    // Fix #6: replace-not-append, so there is never a second `kernel:rlm` entry.
    const contexts = assembled.contexts.filter(entry => entry.name !== RLM_CONTEXT_SECTION)
    return {
      ...assembled,
      contexts: [...contexts, { name: RLM_CONTEXT_SECTION, text }],
    }
  })

  ctx.effect(function* () {
    yield dispose
  }, 'kernel-rlm-context system-prompt/assemble')
}

