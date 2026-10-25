/**
 * The Kiln-backed {@link KernelProvider}: one persistent `kernel_child.py`
 * process, restarted on every outcome that loses the namespace.
 * @module @deepseek-ai/dsh-kernel-python/provider
 */

import type {
  KernelBackgroundPoll, KernelCellImage, KernelExecuteRequest, KernelExecuteResult, KernelOutcome,
  KernelProvider,
} from '@deepseek-ai/dsh-kernel'
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
 * The owning agent's shared session id.
 *
 * Read from the request's explicit `agent` field. It is NOT recoverable from
 * `agentCtx`: `Context` carries no reverse Agent property, and a property read
 * that resolves in no fiber's store throws rather than returning undefined.
 * Absence means the cell was dispatched without an owning agent, and the Python
 * side falls back to standalone behavior (no durable conversation key).
 */
function conversationOf(agent: KernelExecuteRequest['agent']): string | undefined {
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

/** How one cell attempt ended: its result, or the reason the kernel was replaced. */
type CellOutcome =
  | { kind: 'ok'; output: string; images: readonly KernelCellImage[]; background?: { id: number; timeoutMs: number } }
  | { kind: Exclude<KernelOutcome, 'ok'> }

/** Launch facts plus the id this backend registers under. */
export interface KilnKernelProviderOptions extends KernelChildOptions {
  /** Registry key on `ctx.kernel`. */
  readonly id: string
  /**
   * Kernels kept alive at once, one per conversation. The least recently idle
   * conversation is reaped first, and a conversation running a cell never is.
   * Defaults to 4.
   */
  readonly maxKernels?: number
  /** Reap a conversation's kernel after this long without work (ms). Defaults to 30 minutes; 0 disables. */
  readonly idleKernelMs?: number
  /** Clock for the idle sweep, injectable for tests. Defaults to `Date.now`. */
  readonly clock?: () => number
}

/** Kernels kept alive at once when the composition names no limit. */
const DEFAULT_MAX_KERNELS = 4

/** Reap a conversation's kernel after this long without work (ms); 0 disables. */
const DEFAULT_IDLE_KERNEL_MS = 30 * 60 * 1000

/**
 * One conversation's kernel: its process, its serialization chain, and how much
 * work is in flight on it.
 *
 * A slot is the unit of isolation. Everything shared and mutable that this
 * provider owns — the Python namespace above all — belongs to exactly one slot,
 * so a cell in one conversation can neither see nor delay another's. The single
 * process this provider used to keep was shared by every chat, which meant one
 * wedged cell stopped all of them and every chat's variables were visible to
 * every other.
 */
interface KernelSlot {
  /** The live child, started on first use and after every restart. */
  child: KernelChild | undefined
  /** Tail of this conversation's chain; each of its cells links onto it. */
  queue: Promise<unknown>
  /** Cells queued or running on this conversation. */
  pending: number
  /** When this conversation last had no work; the idle sweep measures from here. */
  idleSince: number
}

/**
 * A persistent Python kernel over the vendored Kiln runtime, one per conversation.
 *
 * Cells within a conversation are serialized, because that conversation's
 * namespace is shared mutable state. Cells in different conversations are not,
 * and do not share a process at all.
 */
export class KilnKernelProvider implements KernelProvider {
  readonly id: string
  private readonly launch: KernelChildOptions
  /** One slot per conversation; the empty key serves an agent-less dispatch. */
  private readonly slots = new Map<string, KernelSlot>()
  /**
   * Provider-level handles for detached cells, and the kernel that owns each.
   *
   * A child numbers its own background cells from 1, so two conversations both
   * hold a cell 1. The tool keeps whatever number this map handed it, which is
   * how a poll reaches the kernel actually running that cell.
   */
  private readonly backgrounds = new Map<number, { key: string; cellId: number }>()
  private nextBackgroundHandle = 1
  private readonly maxKernels: number
  private readonly idleKernelMs: number
  private readonly clock: () => number
  private disposed = false

  constructor(options: KilnKernelProviderOptions) {
    this.id = options.id
    this.launch = options
    this.maxKernels = Math.max(1, options.maxKernels ?? DEFAULT_MAX_KERNELS)
    this.idleKernelMs = Math.max(0, options.idleKernelMs ?? DEFAULT_IDLE_KERNEL_MS)
    this.clock = options.clock ?? Date.now
  }

  available(): boolean {
    return !this.disposed
  }

  /** True while any conversation has a cell queued or running. */
  busy(): boolean {
    for (const slot of this.slots.values()) if (slot.pending > 0) return true
    return false
  }

  /** The slot for one conversation, created on first use. */
  private slotFor(key: string): KernelSlot {
    const existing = this.slots.get(key)
    if (existing !== undefined) {
      existing.idleSince = this.clock()
      return existing
    }
    this.makeRoom()
    const slot: KernelSlot = { child: undefined, queue: Promise.resolve(), pending: 0, idleSince: this.clock() }
    this.slots.set(key, slot)
    return slot
  }

  /**
   * Keep the number of live kernels bounded, without ever interrupting work.
   *
   * The least recently idle conversation gives up its process first. A
   * conversation that is running a cell is never evicted: keeping a cap by
   * killing someone's run would be the cross-conversation interference this
   * exists to remove, so the cap is a target rather than a hard limit.
   */
  private makeRoom(): void {
    while (this.slots.size >= this.maxKernels) {
      const victim = [...this.slots.entries()]
        .filter(([, slot]) => slot.pending === 0 && slot.child !== undefined)
        .sort((a, b) => a[1].idleSince - b[1].idleSince)[0]
      if (victim === undefined) return
      this.slots.delete(victim[0])
      void victim[1].child?.kill()
    }
  }

  /**
   * Reap kernels that have sat idle past the configured window.
   *
   * A reaped conversation keeps its `remember()` entries — that tier is durable —
   * but loses its namespace, so the next cell there starts clean.
   */
  private sweepIdle(): void {
    if (this.idleKernelMs === 0) return
    const cutoff = this.clock() - this.idleKernelMs
    for (const [key, slot] of [...this.slots.entries()]) {
      if (slot.pending > 0 || slot.child === undefined || slot.idleSince > cutoff) continue
      this.slots.delete(key)
      void slot.child.kill()
    }
  }

  /** The live child for one conversation, started on first use and after a restart. */
  private ensureChild(slot: KernelSlot): KernelChild {
    if (slot.child === undefined || slot.child.dead) slot.child = new KernelChild(this.launch)
    return slot.child
  }

  /** Run `task` after this conversation's previously queued cells, whatever their outcome. */
  private serialize<T>(slot: KernelSlot, task: () => Promise<T>): Promise<T> {
    slot.pending += 1
    const finish = (): void => {
      slot.pending -= 1
      if (slot.pending === 0) slot.idleSince = this.clock()
    }
    const run = slot.queue.then(task, task)
    // Swallow on the chain only: the returned promise still rejects. Without
    // this a failed cell would mark the shared tail rejected and take the next
    // caller in this conversation down with an error that was never theirs.
    slot.queue = run.then(() => undefined, () => undefined)
    // Decrement on BOTH completion paths so busy() returns to false even when
    // the cell rejects; the queue tail already swallows the rejection separately.
    void run.then(finish, finish)
    return run
  }

  async execute(request: KernelExecuteRequest, signal?: AbortSignal): Promise<KernelExecuteResult> {
    // The owning agent's shared session id is the conversation key: one kernel
    // per conversation is what keeps one chat's wedged cell from stopping
    // another's, and what keeps its variables out of another's namespace.
    // Absence means the cell was dispatched without an owning agent, and every
    // such dispatch shares one slot, the way the Python side treats it as
    // standalone.
    const key = conversationOf(request.agent) ?? ''
    this.sweepIdle()
    const slot = this.slotFor(key)
    return this.serialize(slot, async () => {
      const attempt = async (): Promise<{ child: KernelChild; outcome: CellOutcome }> => {
        const child = this.ensureChild(slot)
        const id = child.send(request.code, request.timeoutMs, request.cwd, request.backgroundTimeoutMs, key === '' ? undefined : key)
        return { child, outcome: await this.awaitCell(child, id, request, signal, request.agentCtx, request.agent) }
      }
      let { child, outcome } = await attempt()
      // A kernel that never reached its ready frame never ran the cell —
      // the interpreter could not start, so nothing was executed and re-sending
      // cannot repeat a side effect. Retrying once turns a failed launch into a
      // working call instead of reporting a lost namespace the cell never used.
      if (outcome.kind === 'crashed' && !child.everReady && signal?.aborted !== true) {
        await this.replace(slot, child)
        ;({ child, outcome } = await attempt())
      }
      if (outcome.kind === 'ok') {
        return {
          output: outcome.output,
          outcome: 'ok' as const,
          restarted: false,
          // Absent rather than empty when the cell showed nothing: a caller
          // checking "did this cell return a picture" reads the field, and an
          // always-present empty array would make that check meaningless.
          ...outcome.images.length > 0 ? { images: outcome.images } : {},
          // Also absent rather than empty: the field is what tells a caller the
          // work is still running somewhere it can still be reached.
          ...outcome.background !== undefined
            ? { background: { ...outcome.background, id: this.trackBackground(key, outcome.background.id) } }
            : {},
        }
      }
      await this.replace(slot, child)
      return {
        output: RESTART_NOTICE[outcome.kind](request) + LOST_NOTICE,
        outcome: outcome.kind,
        restarted: true,
      }
    })
  }

  /**
   * Give one detached cell a provider-wide handle, so a poll reaches the kernel
   * running it. Child ids restart at 1 in every kernel, so they collide across
   * conversations and cannot be handed to the tool unchanged.
   * @param key - the conversation whose kernel detached the cell.
   * @param cellId - the child's own id for that cell.
   * @returns the handle to report to the caller.
   */
  private trackBackground(key: string, cellId: number): number {
    const handle = this.nextBackgroundHandle++
    this.backgrounds.set(handle, { key, cellId })
    return handle
  }

  /**
   * Wait for the cell's frame, bounded by the request budget and the caller's
   * signal, and classify what came back.
   */
  private async awaitCell(
    child: KernelChild,
    id: number,
    request: KernelExecuteRequest,
    signal?: AbortSignal,
    agentCtx?: KernelExecuteRequest['agentCtx'],
    agent?: KernelExecuteRequest['agent'],
  ): Promise<CellOutcome> {
    const prevHandler = child.seamHandler
    child.seamHandler = (seam: SeamRequest): void => {
      void dispatchSeam(agentCtx, agent, seam, signal).then(
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
      const frame = await child.nextFrame(id, budget.signal)
      // A dead child resolves waiters with a `dead` frame rather than hanging.
      // It carries its own marker because an empty frame from a live child is
      // a cell that genuinely printed nothing, and reporting a dead kernel as
      // "the cell produced no output" is the worst available reading of it.
      if (frame.dead === true || child.dead) return { kind: 'crashed' }
      return {
        kind: 'ok',
        output: joinCellOutput(frame.out ?? '', frame.error ?? null),
        // A crashed or timed-out cell's images never arrive — those paths
        // restart the kernel and report the loss, so a picture the model was
        // promised is gone along with the namespace that produced it.
        images: frame.images ?? [],
        // A frame is untrusted input, so the id is only a handle when the same
        // frame also says the cell detached; a stray number on an ordinary
        // result must not become a followable job. The secondary budget is the
        // cell's own stop deadline, so the caller learns how long it has.
        ...frame.backgrounded === true && typeof frame.backgroundId === 'number'
          ? { background: { id: frame.backgroundId, timeoutMs: secondaryOf(request) } }
          : {},
      }
    } catch (reason) {
      return { kind: reason instanceof KernelAbortError ? reason.kind : 'cancelled' }
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      child.seamHandler = prevHandler
    }
  }

  /** Kill `child` and drop it from its conversation, so that conversation starts a fresh namespace. */
  private async replace(slot: KernelSlot, child: KernelChild): Promise<void> {
    await child.kill()
    if (slot.child === child) slot.child = undefined
  }

  /** Replace every conversation's kernel. */
  async restart(): Promise<void> {
    await Promise.all([...this.slots.values()].map(slot => this.serialize(slot, async () => {
      const child = slot.child
      if (child !== undefined) await this.replace(slot, child)
    })))
  }

  /**
   * Poll one detached cell through the kernel that owns it.
   *
   * The reply is whatever the child last wrote, so every field is checked
   * before it is believed: a `running` that is not `true` and a `text` that is
   * not a string both mean the frame did not carry what the caller needs, and
   * an unrecognized shape is reported as an unknown cell rather than as empty
   * output — the two are opposite facts about the work.
   * @param id - the handle this provider issued when the cell detached.
   * @returns whether the cell is known, still running, and its drained output.
   */
  async pollBackground(id: number): Promise<KernelBackgroundPoll> {
    const owner = this.backgrounds.get(id)
    if (owner === undefined) return { known: false }
    const slot = this.slots.get(owner.key)
    if (slot === undefined) {
      this.backgrounds.delete(id)
      return { known: false }
    }
    const result = await this.control(slot, { cmd: 'bg_poll', bg_id: owner.cellId })
    if (typeof result !== 'object' || result === null) return { known: false }
    const { known, running, status, text } = result as Record<string, unknown>
    if (known !== true) {
      this.backgrounds.delete(id)
      return { known: false }
    }
    if (running === true) return { known: true, running: true }
    // Settled: the handle will never name a live cell again.
    this.backgrounds.delete(id)
    return {
      known: true,
      running: false,
      ...typeof status === 'string' ? { status } : {},
      ...typeof text === 'string' ? { text } : {},
    }
  }

  /**
   * Ask one detached cell to stop. Best-effort by contract: the child raises
   * the interrupt at a bytecode boundary, so a thread parked in an
   * uninterruptible call may not stop until its own secondary deadline.
   * @param id - the handle this provider issued when the cell detached.
   */
  async stopBackground(id: number): Promise<void> {
    const owner = this.backgrounds.get(id)
    if (owner === undefined) return
    const slot = this.slots.get(owner.key)
    if (slot === undefined) {
      this.backgrounds.delete(id)
      return
    }
    await this.control(slot, { cmd: 'bg_stop', bg_id: owner.cellId })
  }

  /**
   * Send one control request to one conversation's kernel and return its decoded payload.
   *
   * Deliberately NOT serialized itself: every caller wraps the call in
   * {@link serialize}, and nesting the two would queue this request behind the
   * very task that is awaiting it.
   */
  private async control(slot: KernelSlot, request: object): Promise<unknown> {
    return this.serialize(slot, async () => {
      const child = this.ensureChild(slot)
      const id = child.sendControl(request)
      return parseControlResult(await child.nextFrame(id))
    })
  }

  /**
   * Every name any live conversation's kernel defines.
   *
   * With one kernel per conversation there is no single namespace to report, so
   * this is the union: the seam's question is what the model can reach, and a
   * name reachable in some conversation is reachable.
   * @returns the sorted names.
   */
  async names(): Promise<readonly string[]> {
    const found = new Set<string>()
    for (const slot of [...this.slots.values()]) {
      const child = slot.child
      if (child === undefined || child.dead) continue
      try {
        const result = await this.control(slot, { cmd: 'list_names' })
        if (typeof result !== 'object' || result === null) continue
        const { names } = result as { names?: unknown }
        if (!Array.isArray(names)) continue
        for (const name of names) if (typeof name === 'string') found.add(name)
      } catch {
        // One unresponsive kernel must not answer for the others.
      }
    }
    return [...found].sort()
  }

  /** Stop every conversation's kernel and refuse further work. Called on plugin dispose. */
  async dispose(): Promise<void> {
    this.disposed = true
    const children = [...this.slots.values()]
      .map(slot => slot.child)
      .filter((child): child is KernelChild => child !== undefined)
    this.slots.clear()
    this.backgrounds.clear()
    await Promise.all(children.map(child => child.kill()))
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
