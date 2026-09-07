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
 * Update safety: this whole package is a new local file (does not exist
 * upstream), and it plugs into public seams (`ctx.kernel.execute`, the
 * `system-prompt/assemble` waterfall). Nothing under
 * `packages/core/agent-loop` or `packages/core/system-prompt` is modified.
 *
 * @module @deepseek-ai/dsh-kernel-rlm-context
 */

import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-kernel'
import type { PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-system-prompt'
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
  /** Cap on rendered answer text, to keep the runtime snapshot bounded. */
  maxAnswerChars?: number
  /** Cap on rendered bind text per value. */
  maxBindChars?: number
}

export const Config: z<Config> = z.object({
  disabled: z.boolean().default(false),
  maxAnswerChars: z.number().step(1).min(0).default(4000),
  maxBindChars: z.number().step(1).min(0).default(2000),
})

/** Fully-resolved config after schemastery defaults. */
type ResolvedConfig = { disabled: boolean; maxAnswerChars: number; maxBindChars: number }

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
 * Renders one RLM snapshot into the model-facing runtime-context prose.
 * Returns `''` when there is nothing to contribute (no binds and no answer).
 */
export function renderRlmContext(snapshot: RlmSnapshot, config: ResolvedConfig): string {
  const parts: string[] = []
  for (const [key, value] of Object.entries(snapshot.binds).sort(([a], [b]) => a.localeCompare(b))) {
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

  /** True when the read-back is enabled and a kernel is registered. */
  enabled(): boolean {
    return !this.config.disabled
  }

  /**
   * Query the kernel for its live RLM snapshot. Returns `undefined` when the
   * kernel is unavailable, the facet is not mounted, or parsing fails.
   */
  async read(signal?: AbortSignal): Promise<RlmSnapshot | undefined> {
    if (this.config.disabled) return undefined
    try {
      const result = await this.ctx.kernel.execute(
        { code: 'rlm_dump()', timeoutMs: READ_TIMEOUT_MS },
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
    maxAnswerChars: config.maxAnswerChars ?? 4000,
    maxBindChars: config.maxBindChars ?? 2000,
  }
  const service = new KernelContextService(ctx, resolved)

  const dispose = ctx.on('system-prompt/assemble', async (_assembly: PromptAssembly, _context, next) => {
    const assembled = await next()
    if (resolved.disabled) return assembled
    const snapshot = await service.read()
    if (snapshot === undefined) return assembled
    const text = renderRlmContext(snapshot, resolved)
    if (text.length === 0) return assembled
    return {
      ...assembled,
      contexts: [...assembled.contexts, { name: RLM_CONTEXT_SECTION, text }],
    }
  })

  ctx.effect(function* () {
    yield dispose
  }, 'kernel-rlm-context system-prompt/assemble')
}

export default apply
