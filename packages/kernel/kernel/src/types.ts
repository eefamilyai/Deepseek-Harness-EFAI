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

import { HarnessError } from '@deepseek-ai/dsh-llm'

/** One cell submitted to the kernel. */
export interface KernelExecuteRequest {
  /** The Python source of the cell. Executed in the persistent namespace. */
  readonly code: string
  /**
   * Wall-clock budget for this cell. On expiry the backend restarts the kernel
   * and reports `timeout`: a cell that overran cannot be left running, because
   * the namespace it is still mutating is the same one the next cell reads.
   */
  readonly timeoutMs?: number
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
