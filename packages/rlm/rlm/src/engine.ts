/**
 * The recursive RLM driver loop.
 *
 * PURE: every harness object arrives through {@link RlmDeps}, so this module
 * has no runtime workspace imports (all `dsh-*` imports below are type-only and
 * erased). It unit-tests against fakes; `index.ts` is the only adapter to the
 * real `ctx.llm` / `ctx.kernel` / `ctx.systemPrompt`.
 *
 * The loop is the RLM idea made concrete:
 *
 *   1. stream the LLM with the conversation history and the `python` tool,
 *   2. assemble the assistant message,
 *   3. run every emitted `python` tool call through the persistent kernel,
 *   4. feed each captured cell result back as a tool-result message,
 *   5. read the kernel `rlm_dump()` snapshot (shared protocol), and
 *   6. terminate as soon as the model marks its answer ready.
 *
 * @module @deepseek-ai/dsh-rlm/engine
 */

import type { GenerateOptions, Message, StreamChunk, ContentBlock, ToolCallBlock, AssistantMessage } from '@deepseek-ai/dsh-llm'
import type { KernelExecuteResult } from '@deepseek-ai/dsh-kernel'
import type { RlmSnapshot } from '@deepseek-ai/dsh-kernel-rlm-context'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'

import { RLM_SYSTEM_PROMPT } from './protocol.ts'

/** Default number of recursive turns before the loop gives up on an answer. */
export const RLM_DEFAULT_MAX_STEPS = 32

/** The tool name the engine offers the model; everything else is rejected. */
export const RLM_PYTHON_TOOL_NAME = 'python'

/** Tool schema offered in RLM mode: one persistent Python cell at a time. */
export const RLM_PYTHON_TOOL_SCHEMA = {
  name: RLM_PYTHON_TOOL_NAME,
  description: 'Execute one Python cell in the persistent RLM namespace. Variables and imports persist across calls.',
  parameters: {
    code: { type: 'string', required: true, description: 'Python source to execute in the persistent namespace.' },
  },
}

/** Why the loop stopped. */
export type RlmStopReason = 'ready' | 'max-steps' | 'no-tool-call' | 'aborted'

/** The completed run, owned and JSON-safe (no live harness objects). */
export interface RlmResult {
  /** Final answer text; empty when the model never set one. */
  readonly answer: string
  /** Number of recursive LLM turns actually taken. */
  readonly steps: number
  /** Why the loop stopped. */
  readonly stopReason: RlmStopReason
  /** Final live context binds the model wrote, as parsed from `rlm_dump()`. */
  readonly binds: Readonly<Record<string, unknown>>
}

/** One-shot RLM completion options. */
export interface RlmCompletionOptions {
  /** The task prompt. */
  prompt: string
  /** Model id dispatched through {@link GenerateOptions.model}. */
  model: string
  /** Provider route dispatched through {@link GenerateOptions.provider}. Defaults to the registry's own resolution. */
  provider?: string
  /** System text. Defaults to {@link RLM_SYSTEM_PROMPT}. */
  system?: string
  /** Maximum recursive turns. Defaults to {@link RLM_DEFAULT_MAX_STEPS}. */
  maxSteps?: number
  /** Tool schemas offered to the model. Defaults to the single `python` tool. */
  tools?: GenerateOptions['tools']
  /** Cancellation propagated to both the LLM stream and each kernel cell. */
  signal?: AbortSignal
  /** Working directory passed to every kernel cell. */
  cwd?: string
}

/** Message factories keeping this module independent of the harness message constructor. */
export interface RlmMessageFactory {
  createUserMessage(text: string): Message
  createAssistantMessage(content: ContentBlock[], provider: string, model: string): AssistantMessage
  createToolResultMessage(callId: ToolCallId, text: string, isError: boolean): Message
}

/** The harness capabilities the engine drives. */
export interface RlmExecuteOptions {
  readonly signal?: AbortSignal
  readonly cwd?: string
  readonly agentCtx?: unknown
}
/** The harness capabilities the engine drives. */
export interface RlmDeps {
  /** Streaming LLM call. */
  stream(options: GenerateOptions): AsyncIterable<StreamChunk>
  /** One persistent-kernel cell. */
  execute(code: string, opts?: RlmExecuteOptions): Promise<KernelExecuteResult>
  /** The shared `__KILN_RLM_STATE__` parser. */
  parseDump(output: string): RlmSnapshot | undefined
  /** Immutable message factories. */
  messages: RlmMessageFactory
}

/** Minimal chunk→content assembler (the engine cannot import the harness assembler and stay pure). */
class Assembler {
  private partials = new Map<number, { type: string; text: string; id?: string; name?: string; args: string }>()
  private order: number[] = []
  private closed = new Set<number>()
  private closedBlocks: (ContentBlock | undefined)[] = []
  finished = false
  aborted = false

  push(chunk: StreamChunk): void {
    switch (chunk.type) {
      case 'block-start': {
        if (!this.partials.has(chunk.index)) {
          this.partials.set(chunk.index, { type: chunk.blockType, text: '', args: '' })
          this.order.push(chunk.index)
          this.closedBlocks[chunk.index] = undefined
        }
        return
      }
      case 'text-delta': this.partial(chunk.index, 'text').text += chunk.text; return
      case 'reasoning-delta': this.partial(chunk.index, 'reasoning').text += chunk.text; return
      case 'tool-call-delta': {
        const p = this.partial(chunk.index, 'tool-call')
        p.id = chunk.id
        if (chunk.name) p.name = chunk.name
        p.args += chunk.argumentsDelta
        return
      }
      case 'block-end': {
        this.closed.add(chunk.index)
        this.closedBlocks[chunk.index] = chunk.block
        return
      }
      case 'usage': return
      case 'finish': {
        this.finished = true
        if (chunk.reason.kind === 'aborted' || chunk.reason.kind === 'error') this.aborted = true
        return
      }
      default: return
    }
  }

  private partial(index: number, type: string): { type: string; text: string; id?: string; name?: string; args: string } {
    let p = this.partials.get(index)
    if (!p) { p = { type, text: '', args: '' }; this.partials.set(index, p); this.order.push(index) }
    return p
  }

  blocks(): ContentBlock[] {
    const out: ContentBlock[] = []
    for (const index of this.order) {
      const closed = this.closedBlocks[index]
      if (closed) { out.push(closed); continue }
      const p = this.partials.get(index)
      if (!p) continue
      if (p.type === 'text') out.push({ type: 'text', text: p.text })
      else if (p.type === 'reasoning') out.push({ type: 'reasoning', text: p.text })
      else if (p.type === 'tool-call') {
        const call: ToolCallBlock = {
          type: 'tool-call',
          id: p.id as ToolCallId ?? (('call-' + index) as unknown as ToolCallId),
          name: p.name ?? '',
          arguments: p.args,
        }
        out.push(call)
      }
    }
    return out
  }
}

/** Parse a `python` tool call's arguments into a code string or throw a plain error. */
export function parsePythonArguments(raw: string): string {
  let value: unknown
  try { value = JSON.parse(raw) } catch { throw new Error('python tool arguments must be valid JSON') }
  if (typeof value !== 'object' || value === null) throw new Error('python tool arguments must be a JSON object')
  const code = (value as { code?: unknown }).code
  if (typeof code !== 'string' || code.trim().length === 0) throw new Error('python tool requires a non-empty "code" string')
  return code
}

/** Read the kernel snapshot once, defensively. */
async function readSnapshot(deps: RlmDeps, cwd?: string): Promise<RlmSnapshot | undefined> {
  try {
    const result = await deps.execute('rlm_dump()', cwd === undefined ? undefined : { cwd })
    if (result.outcome !== 'ok') return undefined
    return deps.parseDump(result.output)
  } catch {
    return undefined
  }
}

/** Format one kernel cell result as the model-facing tool-result text. */
export function formatCellResult(result: KernelExecuteResult): { text: string; isError: boolean } {
  if (result.outcome === 'ok') {
    return result.output.length === 0
      ? { text: '(empty — the cell produced no output; print a value to see it)', isError: false }
      : { text: result.output, isError: false }
  }
  const restarted = result.restarted ? ' the namespace was lost and restarted;' : ''
  return {
    text: `cell ${result.outcome}:${restarted} ${result.output}`.trim(),
    isError: true,
  }
}

/**
 * Drive one recursive RLM completion to a ready answer (or a bound).
 * @param options - prompt, model, and loop bounds.
 * @param deps - the injected harness capabilities.
 * @returns the owned, JSON-safe result.
 */
export async function runRlm(options: RlmCompletionOptions, deps: RlmDeps): Promise<RlmResult> {
  const maxSteps = options.maxSteps ?? RLM_DEFAULT_MAX_STEPS
  const system = options.system ?? RLM_SYSTEM_PROMPT
  const tools = options.tools ?? [RLM_PYTHON_TOOL_SCHEMA]

  const history: Message[] = [deps.messages.createUserMessage(options.prompt)]
  let binds: Readonly<Record<string, unknown>> = {}
  let answer = ''
  let stop: RlmStopReason = 'max-steps'
  let steps = 0

  for (let turn = 0; turn < maxSteps; turn++) {
    steps = turn + 1
    const assembler = new Assembler()
    const stream = deps.stream({
      provider: options.provider as GenerateOptions['provider'],
      model: options.model,
      system,
      messages: history,
      tools,
      ...options.signal ? { signal: options.signal } : {},
    })

    for await (const chunk of stream) {
      assembler.push(chunk)
      if (options.signal?.aborted) { stop = 'aborted'; break }
    }
    if (stop === 'aborted') break
    if (assembler.aborted) { stop = 'aborted'; break }

    const content = assembler.blocks()
    const assistant = deps.messages.createAssistantMessage(
      content,
      options.provider ?? '',
      options.model,
    )
    history.push(assistant)

    const toolCalls = content.filter((b): b is ToolCallBlock => b.type === 'tool-call')
    if (toolCalls.length === 0) {
      const snap = await readSnapshot(deps, options.cwd)
      if (snap?.answer.ready) { answer = snap.answer.content; stop = 'ready' }
      else stop = 'no-tool-call'
      break
    }

    for (const call of toolCalls) {
      if (call.name !== RLM_PYTHON_TOOL_NAME) {
        history.push(deps.messages.createToolResultMessage(
          call.id,
          `unknown tool "${call.name}"; only the "${RLM_PYTHON_TOOL_NAME}" tool is available in RLM mode`,
          true,
        ))
        continue
      }
      let code: string
      try { code = parsePythonArguments(call.arguments) } catch (error) {
        history.push(deps.messages.createToolResultMessage(call.id, `invalid arguments: ${(error as Error).message}`, true))
        continue
      }
      const executeOpts: RlmExecuteOptions | undefined =
        options.signal === undefined && options.cwd === undefined
          ? undefined
          : {
            ...(options.signal === undefined ? {} : { signal: options.signal }),
            ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
          }
      const result = await deps.execute(code, executeOpts)
      const { text, isError } = formatCellResult(result)
      history.push(deps.messages.createToolResultMessage(call.id, text, isError))
    }

    const snap = await readSnapshot(deps, options.cwd)
    if (snap) {
      binds = snap.binds
      if (snap.answer.content) answer = snap.answer.content
      if (snap.answer.ready) { stop = 'ready'; break }
    }
  }

  return { answer, steps, stopReason: stop, binds }
}

export { RLM_SYSTEM_PROMPT }
