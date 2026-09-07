/**
 * Vocabulary for the persistent-kernel capability seam (`ctx.kernel`): one
 * long-lived Python namespace per agent, into which the model executes cells.
 *
 * A cell is not a shell command. The namespace survives between calls, so
 * variables, imports, and helper functions the model defines in one cell are
 * still there in the next — that persistence is the whole capability, and it is
 * why the seam has no stateless `run(code)` shape.
 * @module @deepseek-ai/dsh-kernel/types
 */

import type { Context } from '@deepseek-ai/cordis'
import { HarnessError } from '@deepseek-ai/dsh-llm'

/** One cell submitted to the kernel. */
export interface KernelExecuteRequest {
  /** The Python source of the cell. Executed in the persistent namespace. */
  readonly code: string
  /**
   * PRIMARY budget for this cell. On expiry the cell is NOT killed: the kernel
   * moves it to the background (the namespace survives) and returns a notice, so
   * the model can keep working while the cell runs on. See
   * {@link backgroundTimeoutMs} for the deadline that finally stops it.
   */
  readonly timeoutMs?: number
  /**
   * SECONDARY, much more generous budget: how long a backgrounded cell may keep
   * running before the kernel force-stops it. Backgrounded cells run
   * concurrently with new foreground cells, so a long job never blocks the next
   * command. Omitted lets the kernel pick a multiple of {@link timeoutMs}.
   */
  readonly backgroundTimeoutMs?: number
  /**
   * Working directory for THIS cell — the owning chat's assigned workspace. One
   * kernel process serves every chat (the namespace is per agent, but the
   * process and its OS cwd are shared), so the directory travels with each cell
   * rather than being fixed once at spawn. Omitted leaves the kernel wherever it
   * currently is: the launch cwd, or where a prior cell's `set_cwd()` left it.
   */
  readonly cwd?: string
  /**
   * The calling agent's scoped Cordis context, threaded through so a backend
   * can reach the harness's real capability seams (`ctx.fs`, `ctx.shell`, …)
   * that live on the agent scope. Absent for a direct or synthetic dispatch
   * with no owning agent.
   */
  readonly agentCtx?: Context
}

/**
 * How a cell ended. Every outcome other than `ok` means the namespace was lost,
 * which the model must be told plainly — see {@link KernelExecuteResult.restarted}.
 */
export type KernelOutcome = 'ok' | 'timeout' | 'cancelled' | 'crashed'

/**
 * A cell's result: exactly what the kernel captured, never a synthesized
 * summary. An empty `output` means the code genuinely printed and evaluated
 * nothing — consumers must not fill that silence with a plausible-looking
 * result, and the tool layer's prompt guidance says so to the model.
 */
export interface KernelExecuteResult {
  /**
   * Captured stdout and stderr, plus the value of every top-level bare
   * expression in the cell (not merely the last one). Tracebacks arrive here
   * too; a failed cell is a result, not a throw.
   */
  readonly output: string
  /** How the cell ended. */
  readonly outcome: KernelOutcome
  /** True when the kernel was restarted, meaning the namespace is now empty. */
  readonly restarted: boolean
}

/**
 * One backend able to host a persistent kernel. Implementations own process
 * lifetime, the wire protocol, and restart semantics; the seam owns only
 * selection.
 */
export interface KernelProvider {
  /** Registry key, unique across registered kernel providers. */
  readonly id: string
  /** Whether this backend can currently host a kernel (e.g. a usable interpreter exists). */
  available(): boolean
  /**
   * Execute one cell in the persistent namespace, serialized against every
   * other cell for the same kernel.
   * @param request - the cell and its budget.
   * @param signal - cancellation; an aborted cell restarts the kernel.
   * @returns the captured result, including a failed cell's traceback.
   */
  execute(request: KernelExecuteRequest, signal?: AbortSignal): Promise<KernelExecuteResult>
  /** Discard the namespace and start a fresh kernel. */
  restart(): Promise<void>
  /** Names currently bound in the namespace, for context and diagnostics. */
  names(): Promise<readonly string[]>
  /**
   * Whether a cell is currently queued or running. Optional so providers that
   * cannot cheaply report it simply leave it unset; callers gate re-entrant
   * reads (e.g. an RLM context dump during an in-flight fan-out) on `false`.
   */
  busy?(): boolean
}

/** Error codes raised by the kernel seam. */
export type KernelErrorCode =
  | 'KERNEL_DUPLICATE_PROVIDER'
  | 'KERNEL_PROVIDER_CONFIGURED_MISSING'
  | 'KERNEL_PROVIDER_CONFIGURED_UNAVAILABLE'
  | 'KERNEL_PROVIDER_UNAVAILABLE'
  | 'KERNEL_PROVIDER_AMBIGUOUS'
  | 'KERNEL_START_FAILED'
  | 'KERNEL_PROTOCOL_ERROR'

/**
 * Failure of the kernel capability itself, as opposed to a cell that raised.
 *
 * The constructor exists only to narrow `code` from `string` to
 * {@link KernelErrorCode}, so a typo cannot become a code nothing routes on.
 */
export class KernelError extends HarnessError {
  // oxlint-disable-next-line no-useless-constructor -- the narrowed `code` parameter IS the point
  constructor(message: string, code: KernelErrorCode, options?: ErrorOptions) {
    super(message, code, options)
  }
}
