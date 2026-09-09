/**
 * The RLM capability plugin.
 *
 * This module is the ONLY part of the package with runtime harness imports. It
 * adapts the pure {@link runRlm} engine to the live seams:
 *
 *   - `ctx.llm.stream`  → the streaming LLM boundary,
 *   - `ctx.kernel.execute` → the persistent Kiln Python REPL,
 *   - `ctx.systemPrompt`   → the model-facing REPL contract,
 *   - `ctx.tools`          → the `rlm` one-shot tool,
 *   - `ctx.rlm` (provided) → the service other plugins and tools call.
 *
 * Every side effect (service registration, tool registration, prompt section)
 * is owned by this fiber and disposed when the plugin is stopped.
 *
 * @module @deepseek-ai/dsh-rlm
 */

import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView, GenericResultView, ToolResult } from '@deepseek-ai/dsh-tools'
import {
  createUserMessage,
  createAssistantMessage,
  createToolResultMessage,
} from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { KernelExecuteResult } from '@deepseek-ai/dsh-kernel'
import { parseRlmDump } from '@deepseek-ai/dsh-kernel-rlm-context'
import type {} from '@deepseek-ai/dsh-kernel'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'

import { runRlm, RLM_SYSTEM_PROMPT, RLM_DEFAULT_MAX_STEPS } from './engine.ts'
import type { RlmDeps, RlmExecuteOptions, RlmResult } from './engine.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'rlm'

/** Services this plugin needs before it may load. */
export const inject = ['llm', 'kernel', 'systemPrompt', 'tools']

/** The settings path the bundle's composition row writes through (see packages/bundle/efai-rlm). */
export const RLM_ENABLED_PATH = 'rlm.enabled'

/** Plugin config (resolved under schemastery defaults). */
export interface Config {
  /** Cap on recursive turns when the tool does not say. */
  maxSteps?: number
  /** Cap on a tool-supplied max_steps (safety bound). */
  maxMaxSteps?: number
}

export const Config: z<Config> = z.object({
  maxSteps: z.number().step(1).min(1).default(RLM_DEFAULT_MAX_STEPS),
  maxMaxSteps: z.number().step(1).min(1).default(128),
})

type ResolvedConfig = Required<Config>

/** Structural view of the optional default-model selection. */
interface DefaultModelService {
  currentSelection?: () => { provider?: string; model?: string }
}

/** Structural view of the executing agent (only the leaves the tool needs). */
interface RlmExecAgent {
  ctx?: unknown
  session?: { header?: { cwd?: string } }
}

/** Resolve the provider/model for an RLM call, preferring the tool argument, then the default model. */
function resolveSelection(
  ctx: Context,
  explicitProvider: string | undefined,
  explicitModel: string | undefined,
): { provider: string; model: string } {
  if (explicitModel !== undefined && explicitModel.trim().length > 0) {
    return { provider: explicitProvider ?? '', model: explicitModel }
  }
  const defaultModel = ctx.get('agentDefaultModel') as DefaultModelService | undefined
  const selection = defaultModel?.currentSelection?.()
  if (selection?.model) return { provider: selection.provider ?? '', model: selection.model }
  throw new Error('rlm: no model selected; pass `model` to the rlm tool or select a model in the picker')
}

/**
 * The service published as `ctx.rlm`. One instance lives for this fiber.
 */
export class RlmService extends Service {
  constructor(ctx: Context, private readonly config: ResolvedConfig) {
    super(ctx, 'rlm')
  }

  /**
   * Run one recursive RLM completion against the live LLM and kernel.
   * @param prompt - the task.
   * @param opts - provider/model override and loop bounds.
   * @param signal - cancellation threaded to the LLM stream and every cell.
   */
  async completion(
    prompt: string,
    opts: { model?: string; provider?: string; maxSteps?: number; cwd?: string; agentCtx?: unknown } = {},
    signal?: AbortSignal,
  ): Promise<RlmResult> {
    const { provider, model } = resolveSelection(this.ctx, opts.provider, opts.model)
    const deps: RlmDeps = {
      stream: options => this.ctx.llm.stream(options),
      execute: (code, executeOpts?: RlmExecuteOptions) => this.executeCell(code, executeOpts),
      parseDump: parseRlmDump,
      messages: {
        createUserMessage: text => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }),
        createAssistantMessage: (content: ContentBlock[], prov: string, mdl: string) =>
          createAssistantMessage({ content, source: { provider: prov, model: mdl } }),
        createToolResultMessage: (callId, text, isError) =>
          createToolResultMessage({ callId, content: [{ type: 'text', text }], isError }),
      },
    }
    const maxSteps = opts.maxSteps === undefined
      ? this.config.maxSteps
      : Math.min(Math.max(1, Math.floor(opts.maxSteps)), this.config.maxMaxSteps)
    return runRlm({
      prompt,
      provider,
      model,
      maxSteps,
      ...(opts.cwd === undefined ? {} : { cwd: opts.cwd }),
      ...(signal === undefined ? {} : { signal }),
    }, deps)
  }

  private executeCell(code: string, opts?: RlmExecuteOptions): Promise<KernelExecuteResult> {
    return this.ctx.kernel.execute({
      code,
      ...(opts?.cwd !== undefined ? { cwd: opts.cwd } : {}),
      ...(opts?.agentCtx !== undefined ? { agentCtx: opts.agentCtx as Context } : {}),
    }, opts?.signal)
  }
}

/** Pending-call presentation for the `rlm` tool. */
export function presentRlmCall(args: { prompt: string }): GenericCallView {
  const title = args.prompt.length > 80 ? `${args.prompt.slice(0, 80)}…` : args.prompt
  return { card: 'generic', title, kind: 'execute', rawInput: args.prompt }
}

/** Completed-call presentation for the `rlm` tool. */
export function presentRlmResult(result: ToolResult): GenericResultView | undefined {
  if (result.isError) return undefined
  const text = result.content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map(block => block.text)
    .join('\n')
  return { card: 'generic', content: [{ type: 'text', text }] }
}

/** Validate what the schema DSL cannot: a non-blank prompt. */
export function parseRlmArgs(args: { prompt: string }): { prompt: string } {
  if (args.prompt.trim().length === 0) throw new Error('prompt must be a non-empty string')
  return { prompt: args.prompt }
}

export function apply(ctx: Context, config: Config): void {
  const resolved = config as ResolvedConfig
  const service = new RlmService(ctx, resolved)

  ctx.systemPrompt.section({
    name: 'tool:rlm',
    order: 90,
    text: [
      'You have a `rlm` tool: run a Recursive Language Model completion. This is your',
      'Python/kernel execution path while RLM is enabled — the standalone `kernel` tool',
      'is not mounted. Inside an `rlm` completion the inner model has a persistent Python',
      'REPL with live variables, can call `llm_batch` for sub-results, and manages durable',
      'context variables with `ctx_write`/`ctx_read`; `ctx_write` values are automatically',
      're-injected every turn (including after restarts) without a fetch. Prefer `rlm` for',
      'long-context or programmatic reasoning tasks that decompose into code plus sub-results.',
    ].join('\n'),
  })

  ctx.tools.register(defineTool({
    name: 'rlm',
    description: 'Run one Recursive Language Model completion: a code-in-REPL recursive loop over'
      + ' the harness LLM and persistent Python kernel, returning the ready answer.',
    parameters: {
      prompt: { type: 'string', required: true, description: 'The task the recursive model must solve.' },
      model: { type: 'string', description: 'Model id to dispatch (defaults to the current model selection).' },
      provider: { type: 'string', description: 'Provider route to dispatch (defaults to the current selection).' },
      max_steps: { type: 'integer', description: `Maximum recursive turns (default ${RLM_DEFAULT_MAX_STEPS}, capped by config).` },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          answer: { type: 'string', required: true },
          steps: { type: 'integer', required: true },
          stop_reason: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.answer || '(no answer was set)' }],
    },
    timeoutMs: (resolved.maxMaxSteps + 1) * 180_000,
    async execute(args, exec) {
      const input = parseRlmArgs(args)
      const agent = exec.agent as RlmExecAgent | undefined
      const result = await service.completion(
        input.prompt,
        {
          ...(args.model !== undefined ? { model: args.model } : {}),
          ...(args.provider !== undefined ? { provider: args.provider } : {}),
          ...(args.max_steps !== undefined ? { maxSteps: args.max_steps } : {}),
          ...(agent?.session?.header?.cwd !== undefined ? { cwd: agent.session.header.cwd } : {}),
          ...(agent?.ctx !== undefined ? { agentCtx: agent.ctx } : {}),
        },
        exec.signal,
      )
      return {
        answer: result.answer,
        steps: result.steps,
        stop_reason: result.stopReason,
      }
    },
    presentCall: presentRlmCall,
    presentResult: (_args, result) => presentRlmResult(result),
  }))
}

export { RLM_SYSTEM_PROMPT, RLM_DEFAULT_MAX_STEPS, runRlm }
