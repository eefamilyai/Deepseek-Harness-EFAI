/**
 * The Kiln-backed {@link KernelProvider}: one persistent `kernel_child.py`
 * process, restarted on every outcome that loses the namespace.
 * @module @deepseek-ai/dsh-kernel-python/provider
 */

import type { KernelExecuteRequest, KernelExecuteResult, KernelOutcome, KernelProvider } from '@deepseek-ai/dsh-kernel'
import type { Context } from '@deepseek-ai/cordis'
import { KernelAbortError, KernelChild, parseControlResult } from './child.ts'
import type { SeamRequest } from './seam.ts'
import { dispatchSeam } from './seam.ts'
import type { KernelChildOptions } from './child.ts'

/**
 * The sentence appended to every restart notice.
 *
 * Every restart path says the same thing because the model's next move depends
 * on it: the Python namespace really is gone, but the durable store is a
 * different tier and survived. Without this the model either assumes its
 * variables are still there (and gets `NameError`s it cannot explain) or assumes
 * everything is lost (and redoes work it does not need to).
 */
const LOST_NOTICE = ' Variables in the namespace are gone; anything you saved with'
  + ' remember() survived — recall() lists what is still there.'

/**
 * Budget for a cell whose request carries none.
 *
 * The seam always fills `timeoutMs`, but this provider is a public class and a
 * direct caller may not. Without a real default here the missing value becomes
 * `setTimeout(..., 0)` — every cell timing out instantly — which is the worst
 * possible reading of "no timeout given".
 */
const FALLBACK_TIMEOUT_MS = 180_000

/**
 * The owning agent's shared session id, read structurally rather than through
 * the `Context.agent` augmentation. This package does not import
 * `@deepseek-ai/dsh-agent`, so that augmentation is outside its type program
 * and referencing it here would break an isolated typecheck. The shape matches
 * `Agent.id` (a string `SessionId`). Absence means the cell was dispatched
 * without an owning agent, and the Python side falls back to standalone
 * behavior (no durable conversation key).
 */
function conversationOf(agentCtx: Context | undefined): string | undefined {
  if (agentCtx === undefined) return undefined
  const agent = (agentCtx as Context & { agent?: { id?: unknown } }).agent
  return typeof agent?.id === 'string' ? agent.id : undefined
}

/** The PRIMARY cell budget this request runs under (background on expiry). */
function budgetOf(request: KernelExecuteRequest): number {
  return request.timeoutMs ?? FALLBACK_TIMEOUT_MS
}

/**
 * The SECONDARY budget: how long a backgrounded cell may run before the kernel
 * force-stops it. Defaults to a generous multiple of the primary, floored at 10
 * minutes — the same rule the kernel applies, so the two sides agree on when a
 * backgrounded cell should already be gone.
 */
function secondaryOf(request: KernelExecuteRequest): number {
  return request.backgroundTimeoutMs ?? Math.max(budgetOf(request) * 5, 600_000)
}

/**
 * The provider's LAST-RESORT kill deadline. The kernel owns both tiers and
 * answers within the primary budget (a result, or a "backgrounded" notice), so
 * this fires only when the kernel is genuinely hung or dead — well past the
 * secondary budget it should have honoured itself. The margin keeps a slow but
 * healthy kernel from being killed out from under a legitimate background cell.
 */
const SAFETY_MARGIN_MS = 60_000
function safetyCeilingOf(request: KernelExecuteRequest): number {
  return secondaryOf(request) + SAFETY_MARGIN_MS
}

/** How a restart-causing outcome is reported to the model. */
const RESTART_NOTICE: Readonly<Record<Exclude<KernelOutcome, 'ok'>, (request: KernelExecuteRequest) => string>> = {
  cancelled: () => 'STOPPED: Interrupted by user. Kernel restarted; state was lost.',
  timeout: request => `TIMEOUT: The kernel went unresponsive for ${Math.round(safetyCeilingOf(request) / 1000)}s (past even the background budget). Kernel restarted; state was lost.`,
  crashed: () => 'ERROR: Kernel crashed mid-run; restarted. State lost.',
}

/** Launch facts plus the id this backend registers under. */
export interface KilnKernelProviderOptions extends KernelChildOptions {
  /** Registry key on `ctx.kernel`. */
  readonly id: string
}

/**
 * A persistent Python kernel over the vendored Kiln runtime.
 *
 * Cells are serialized: the namespace is shared mutable state, so two cells in
 * flight against one process would interleave their writes and their captured
 * output. The queue is the reason a caller never has to reason about that.
 */
export class KilnKernelProvider implements KernelProvider {
  readonly id: string
  private readonly launch: KernelChildOptions
  private child: KernelChild | undefined
  /** Tail of the serialization chain; each execute links onto it. */
  private queue: Promise<unknown> = Promise.resolve()
  /** Non-zero while a cell is queued or running; incremented inside serialize. */
  private pending = 0
  private disposed = false

  constructor(options: KilnKernelProviderOptions) {
    this.id = options.id
    this.launch = options
  }

  available(): boolean {
    return !this.disposed
  }

  /** True while any cell is queued or running (serialization in flight). */
  busy(): boolean {
    return this.pending > 0
  }

  /** The live child, started on first use and after every restart. */
  private ensureChild(): KernelChild {
    if (this.child === undefined || this.child.dead) this.child = new KernelChild(this.launch)
    return this.child
  }

  /** Run `task` after every previously queued one, whatever their outcome. */
  private serialize<T>(task: () => Promise<T>): Promise<T> {
    this.pending += 1
    const finish = (): void => { this.pending -= 1 }
    const run = this.queue.then(task, task)
    // Swallow on the chain only: the returned promise still rejects. Without
    // this a failed cell would mark the shared tail rejected and take the next
    // caller down with an error that was never theirs.
    this.queue = run.then(() => undefined, () => undefined)
    // Decrement on BOTH completion paths so busy() returns to false even when
    // the cell rejects; the queue tail already swallows the rejection separately.
    void run.then(finish, finish)
    return run
  }

  async execute(request: KernelExecuteRequest, signal?: AbortSignal): Promise<KernelExecuteResult> {
    return this.serialize(async () => {
      const child = this.ensureChild()
      // The owning agent's shared session id is the durable-conversation key:
      // one kernel process serves every session, so `remember()`/`recall()`
      // (and the RLM ctx_write/ctx_read bind path) must be scoped per cell,
      // exactly like `cwd`. Without a live agent the conversation key is
      // absent and the Python side falls back to standalone behavior.
      const conv = conversationOf(request.agentCtx)
      child.send(request.code, request.timeoutMs, request.cwd, request.backgroundTimeoutMs, conv)
      const outcome = await this.awaitCell(child, request, signal, request.agentCtx)
      if (outcome.kind === 'ok') {
        return { output: outcome.output, outcome: 'ok' as const, restarted: false }
      }
      await this.replace(child)
      return {
        output: RESTART_NOTICE[outcome.kind](request) + LOST_NOTICE,
        outcome: outcome.kind,
        restarted: true,
      }
    })
  }

  /**
   * Wait for the cell's frame, bounded by the request budget and the caller's
   * signal, and classify what came back.
   */
  private async awaitCell(
    child: KernelChild,
    request: KernelExecuteRequest,
    signal?: AbortSignal,
    agentCtx?: KernelExecuteRequest['agentCtx'],
  ): Promise<{ kind: 'ok'; output: string } | { kind: Exclude<KernelOutcome, 'ok'> }> {
    const prevHandler = child.seamHandler
    child.seamHandler = (seam: SeamRequest): void => {
      void dispatchSeam(agentCtx, seam, signal).then(
        (response) => { if (!child.dead) child.sendSeamResponse(response) },
        (reason: unknown) => {
          if (!child.dead) {
            child.sendSeamResponse({ id: seam.id, ok: false, error: reason instanceof Error ? reason.message : String(reason) })
          }
        },
      )
    }
    const budget = new AbortController()
    const onAbort = (): void => { budget.abort(new KernelAbortError('cancelled')) }
    signal?.addEventListener('abort', onAbort, { once: true })
    // Not the primary budget: the kernel backgrounds at the primary and answers
    // right away, so killing here at the primary would race that notice and
    // destroy a namespace the cell is still legitimately using. Only a kernel
    // that stays silent past the whole safety ceiling is treated as hung.
    const timer = setTimeout(() => { budget.abort(new KernelAbortError('timeout')) }, safetyCeilingOf(request))
    timer.unref()
    try {
      const frame = await child.nextFrame(budget.signal)
      // A dead child resolves waiters with an empty frame rather than hanging;
      // an empty frame from a live child is a cell that genuinely printed
      // nothing, so the liveness check is what tells the two apart.
      if (child.dead) return { kind: 'crashed' }
      return { kind: 'ok', output: joinCellOutput(frame.out ?? '', frame.error ?? null) }
    } catch (reason) {
      return { kind: reason instanceof KernelAbortError ? reason.kind : 'cancelled' }
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      child.seamHandler = prevHandler
    }
  }

  /** Kill `child` and drop it, so the next cell starts a fresh namespace. */
  private async replace(child: KernelChild): Promise<void> {
    await child.kill()
    if (this.child === child) this.child = undefined
  }

  async restart(): Promise<void> {
    await this.serialize(async () => {
      const child = this.child
      if (child !== undefined) await this.replace(child)
    })
  }

  async names(): Promise<readonly string[]> {
    return this.serialize(async () => {
      const child = this.ensureChild()
      child.sendControl({ cmd: 'list_names' })
      const result = parseControlResult(await child.nextFrame())
      if (typeof result !== 'object' || result === null) return []
      const { names } = result as { names?: unknown }
      if (!Array.isArray(names)) return []
      return names.filter((name): name is string => typeof name === 'string')
    })
  }

  /** Stop the kernel and refuse further work. Called on plugin dispose. */
  async dispose(): Promise<void> {
    this.disposed = true
    const child = this.child
    this.child = undefined
    if (child !== undefined) await child.kill()
  }
}

/**
 * Join a cell's captured output with its traceback the way the Kiln kernel
 * does: the traceback follows the output, on its own line.
 * @param out - captured stdout, stderr, and echoed expression values.
 * @param error - the formatted traceback, or null.
 * @returns the model-facing cell output.
 */
export function joinCellOutput(out: string, error: string | null): string {
  if (error === null || error.length === 0) return out
  if (out.length === 0) return error
  return out.endsWith('\n') ? out + error : `${out}\n${error}`
}
