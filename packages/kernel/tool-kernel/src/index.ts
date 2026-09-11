/**
 * The model-facing `kernel` tool: run Python in a persistent namespace.
 *
 * In a composition built around this package the kernel is not one tool among
 * many — it is the model's entire hands. Reading a file, editing it, searching
 * the disk, running a command, driving a browser: all of it is Python, written
 * against the helpers the Kiln runtime preloads into the namespace. That is why
 * the roster this package expects to sit in has web access and nothing else
 * beside it. Where a conventional harness gives the model twenty narrow verbs,
 * this one gives it a programming language and a live interpreter.
 *
 * Execution goes through `ctx.kernel`; this module owns only the model-facing
 * schema, prompt guidance, and result presentation — never process lifetime or
 * the wire protocol.
 * @module @deepseek-ai/dsh-tool-kernel
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView, GenericResultView, ToolResult } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-kernel'
import type {} from '@deepseek-ai/dsh-system-prompt'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'tool-kernel'

/** Services required by the kernel tool. */
export const inject = ['tools', 'kernel', 'systemPrompt']

/** Default cooperative tool-call budget (ms), matching the Kiln kernel's own default. */
export const DEFAULT_KERNEL_TIMEOUT_MS = 180_000

/**
 * Extra time the TOOL gets on top of the cell budget.
 *
 * Two timeouts race over one call: the harness's tool-call policy and the
 * kernel's own cell budget. Given equal deadlines the harness usually wins, and
 * the model gets a bare "tool timed out" — losing the fact that matters most,
 * that the kernel restarted and the namespace is empty. The grace period makes
 * the kernel's own path win, so the model is told what it actually lost.
 */
export const TOOL_TIMEOUT_GRACE_MS = 15_000

/** Upper bound on the output characters returned for one cell. */
export const DEFAULT_MAX_OUTPUT_CHARS = 200_000
/** Upper bound on an AI-chosen per-cell timeout (ms). */
export const DEFAULT_MAX_TIMEOUT_MS = 600_000
/**
 * Default SECONDARY budget (ms): how long a cell that overran its primary budget
 * may keep running in the background before the kernel force-stops it. Much more
 * generous than the primary — the point of backgrounding is to let a long job
 * finish while the model works on, so the stop deadline is measured in tens of
 * minutes, not the primary's few.
 */
export const DEFAULT_BACKGROUND_TIMEOUT_MS = 1_800_000

/** Plugin config: the per-cell budget and the output cap. */
export interface Config {
  /** PRIMARY cooperative budget (ms) for one cell; on expiry the cell backgrounds. Defaults to 180000. */
  timeoutMs?: number
  /** Cap on returned output characters for one cell. Defaults to 200000. */
  maxOutputChars?: number
  /** Upper bound on a model-chosen per-cell (primary) timeout (ms). Defaults to 600000. */
  maxTimeoutMs?: number
  /** SECONDARY budget (ms): when a backgrounded cell is force-stopped. Defaults to 1800000. */
  backgroundTimeoutMs?: number
}

export const Config: z<Config> = z.object({
  timeoutMs: z.number().step(1).min(1).default(DEFAULT_KERNEL_TIMEOUT_MS),
  maxOutputChars: z.number().step(1).min(1).default(DEFAULT_MAX_OUTPUT_CHARS),
  maxTimeoutMs: z.number().step(1).min(1).default(DEFAULT_MAX_TIMEOUT_MS),
  backgroundTimeoutMs: z.number().step(1).min(1).default(DEFAULT_BACKGROUND_TIMEOUT_MS),
})

/** Complete config after schemastery applies every field default. */
type ResolvedConfig = Required<Config>

/**
 * Validate what the schema DSL cannot: a non-blank cell. An empty cell is
 * rejected rather than run, because running it would return empty output that
 * looks exactly like a cell whose code produced nothing.
 * @param args - the schema-validated `kernel` arguments.
 * @returns the accepted arguments, unchanged.
 */
export interface KernelArgs {
  code: string
  timeoutMs?: number
}

export function parseKernelArgs(args: KernelArgs): KernelArgs {
  if (args.code.trim().length === 0) throw new Error('code must be a non-empty string')
  const timeoutMs = args.timeoutMs
  if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
    throw new Error('timeoutMs must be a positive finite number')
  }
  return { code: args.code, ...timeoutMs !== undefined ? { timeoutMs } : {} }
}

/**
 * Cut output to the cap, keeping the head and the tail.
 *
 * The tail matters as much as the head: a traceback is the last thing a cell
 * prints, and a head-only truncation would drop precisely the part explaining
 * why the cell failed.
 * The elision notice is overhead on top of the kept text, so a cap smaller than
 * the notice itself still yields the notice. That only matters for caps in the
 * tens of characters; real ones are in the tens of thousands.
 * @param output - the captured cell output.
 * @param maxChars - the cap.
 * @returns the output, with an elision notice when it was cut.
 */
export function capOutput(output: string, maxChars: number): string {
  if (output.length <= maxChars) return output
  const half = Math.floor((maxChars - 1) / 2)
  // A zero-width half would make the tail slice `output.slice(-0)`, which is
  // `slice(0)` — the WHOLE string, so a tiny cap would return more than an
  // untruncated one. Below two characters there is no head/tail to keep.
  if (half === 0) return `[... ${output.length} characters elided ...]`
  const dropped = output.length - half * 2
  return `${output.slice(0, half)}\n\n[... ${dropped} characters elided ...]\n\n${output.slice(output.length - half)}`
}

/**
 * Format a cell result as the model-facing text block.
 *
 * An empty output is reported as such in words. This is the single most
 * load-bearing line in the package: an empty result means the cell genuinely
 * printed and evaluated nothing, and a model handed silence will otherwise
 * invent a plausible result rather than notice it forgot to print.
 * @param output - the cell's captured output.
 * @returns the text the model reads.
 */
export function formatKernelOutput(output: string): string {
  if (output.length === 0) {
    return 'OUTPUT: (empty — the cell produced no output. If you expected a value,'
      + ' print it or put the bare expression on its own line; do not describe a'
      + ' result you did not see.)'
  }
  return output
}

/** Pending-call presentation: a generic card holding the cell source. */
export function presentKernelCall(args: { code: string }): GenericCallView {
  const [first = ''] = args.code.split('\n')
  return { card: 'generic', title: first, kind: 'execute', rawInput: args.code }
}

/**
 * Completed-call presentation: a generic card carrying the captured cell
 * output. The output is Python interpreter text, not a shell command, so it
 * must not declare the terminal render intent (a command-less terminal card
 * would draw an empty `$` prompt and mislabel the cell as a shell run).
 * @param result - the final model-facing tool result.
 * @returns the generic result view, or undefined (raw result) on failure.
 */
export function presentKernelResult(result: ToolResult): GenericResultView | undefined {
  if (result.isError) return undefined
  const text = result.content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map(block => block.text)
    .join('\n')
  return { card: 'generic', content: [{ type: 'text', text }] }
}

/**
 * Register the `kernel` tool and its system-prompt guidance.
 *
 * The tool is deliberately NOT concurrency-safe (`isConcurrencySafe` is
 * omitted, which the registry reads as exclusive): the namespace is shared
 * mutable state, so two cells running in parallel would interleave their
 * assignments and their captured output.
 */
export function apply(ctx: Context, config: Config): void {
  // schemastery (Config) has already filled every defaulted field.
  const resolved = config as ResolvedConfig

  ctx.systemPrompt.section({
    name: 'tool:kernel',
    order: 100,
    text: [
      'You have one tool for acting on this machine: `kernel`, which runs Python in a',
      'persistent namespace. To learn every preloaded helper and how each one behaves,',
      'call `tool_help()` — with no argument it lists every tool and a one-line summary;',
      'pass a name to get its full documentation.',
      '',
      'Begin every cell with a single-line `#` comment stating what the script does.',
      'That first line titles the call in the transcript, so make it a short, concrete',
      'summary of the intent — `# Count the files under packages/`, not `# code` or a bare',
      'restatement of the line below it. The cell body follows.',
    ].join('\n'),
  })

  ctx.tools.register(defineTool({
    name: 'kernel',
    description: 'Run Python in a persistent kernel namespace. Returns the cell\'s captured output:'
      + ' printed text plus the value of every top-level bare expression. Variables and imports'
      + ' persist across calls. Shell commands run via sh("..."); files are read and written with'
      + ' the preloaded helpers. Start every cell with a one-line `#` comment stating what the'
      + ' script does; that line titles the call in the transcript.',
    parameters: {
      code: { type: 'string', required: true, description: 'The Python source to execute in the persistent namespace. Its first line must be a `#` comment stating what the cell does.' },
      timeoutMs: { type: 'integer', description: 'Optional per-cell timeout in milliseconds. Defaults to the configured timeoutMs and is capped by maxTimeoutMs.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          output: { type: 'string', required: true },
          outcome: { type: 'string', required: true },
          restarted: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: formatKernelOutput(value.output) }],
    },
    timeoutMs: resolved.maxTimeoutMs + TOOL_TIMEOUT_GRACE_MS,
    async execute(args, exec) {
      const input = parseKernelArgs(args)
      const cellTimeoutMs = input.timeoutMs ?? resolved.timeoutMs
      const boundedTimeoutMs = Math.min(cellTimeoutMs, resolved.maxTimeoutMs)
      // The kernel process is shared across chats, so the cell must name the
      // directory it runs in: the calling agent's own session workspace. A call
      // with no agent (a direct or synthetic dispatch) sends no cwd and runs
      // wherever the kernel already is.
      const cwd = exec.agent?.session.header.cwd
      // Secondary budget never below the primary: a cell backgrounds at the
      // primary and is force-stopped at this generous deadline.
      const backgroundTimeoutMs = Math.max(resolved.backgroundTimeoutMs, boundedTimeoutMs)
      const result = await ctx.kernel.execute(
        {
          code: input.code,
          timeoutMs: boundedTimeoutMs,
          backgroundTimeoutMs,
          ...cwd !== undefined ? { cwd } : {},
          // Both halves of the agent identity travel: the scoped Context reaches
          // the capability seams, and the Agent itself is the domain subject the
          // kernel's Python seam needs (subagent parentage, goals, tool ownership).
          ...exec.agent !== undefined ? { agentCtx: exec.agent.ctx, agent: exec.agent } : {},
        },
        exec.signal,
      )
      return {
        output: capOutput(result.output, resolved.maxOutputChars),
        outcome: result.outcome,
        restarted: result.restarted,
      }
    },
    presentCall: presentKernelCall,
    presentResult: (_args, result) => presentKernelResult(result),
  }))
}
