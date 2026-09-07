/**
 * Service Definition for the persistent-kernel capability seam (`ctx.kernel`):
 * backend registration and provider-selecting execution for a long-lived Python
 * namespace. Duplicate ids are rejected. At execution time a configured backend
 * must exist and be usable; without one, exactly one usable backend is required,
 * so selection never depends on registration order.
 *
 * The seam deliberately mirrors `@deepseek-ai/dsh-web`: the same selection
 * rules, the same effect-scoped registration, the same split between a seam
 * that owns policy and providers that own transport.
 * @module @deepseek-ai/dsh-kernel
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { KernelExecuteRequest, KernelExecuteResult, KernelProvider } from './types.ts'
import { KernelError } from './types.ts'

export { KernelError } from './types.ts'
export type {
  KernelErrorCode,
  KernelExecuteRequest,
  KernelExecuteResult,
  KernelOutcome,
  KernelProvider,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    kernel: KernelRuntime
  }
}

/**
 * Config for the kernel seam. `provider` pins which backend wins; it is optional
 * (a single registered usable backend auto-selects). An operational override
 * must feed this same field rather than introduce a hidden priority chain.
 */
export interface KernelRuntimeConfig {
  /** Explicit kernel provider id. Omitted = auto-select when exactly one usable. */
  readonly provider?: string
  /** Default wall-clock budget (ms) for a cell that does not carry its own. */
  readonly defaultTimeoutMs?: number
}

/** Default per-cell budget, matching the Kiln kernel's own 180s default. */
export const DEFAULT_CELL_TIMEOUT_MS = 180_000

/**
 * The persistent-kernel service, registered as `ctx.kernel` (one instance per
 * context).
 *
 * Selection semantics (resolved at execution time, never order-dependent):
 * - A configured id that is registered and `available()` → that backend.
 * - A configured id not registered → `KERNEL_PROVIDER_CONFIGURED_MISSING`.
 * - A configured id registered but unavailable → `KERNEL_PROVIDER_CONFIGURED_UNAVAILABLE`.
 * - No id configured, exactly one registered usable backend → that backend.
 * - No id configured, multiple usable backends → `KERNEL_PROVIDER_AMBIGUOUS`.
 * - No id configured, no usable backend → `KERNEL_PROVIDER_UNAVAILABLE`.
 */
export class KernelRuntime extends Service {
  static Config: z<KernelRuntimeConfig> = z.object({
    provider: z.string(),
    defaultTimeoutMs: z.number().step(1).min(1).default(DEFAULT_CELL_TIMEOUT_MS),
  })

  private providers = new Map<string, KernelProvider>()
  private readonly providerId: string | undefined
  private readonly defaultTimeoutMs: number

  constructor(ctx: Context, config: KernelRuntimeConfig = {}) {
    super(ctx, 'kernel')
    this.providerId = config.provider ?? process.env.DSH_KERNEL_PROVIDER
    this.defaultTimeoutMs = config.defaultTimeoutMs ?? DEFAULT_CELL_TIMEOUT_MS
  }

  /**
   * Register a kernel backend. Throws {@link KernelError}
   * `KERNEL_DUPLICATE_PROVIDER` if its id is already registered. Returns a
   * disposer; disposed with the calling fiber.
   * @param provider - the backend; its `id` is the registry key.
   * @returns the disposer that unregisters the backend.
   */
  registerProvider(provider: KernelProvider): () => void {
    if (this.providers.has(provider.id)) {
      throw new KernelError(
        `a kernel provider with id "${provider.id}" is already registered`,
        'KERNEL_DUPLICATE_PROVIDER',
      )
    }
    const providers = this.providers
    const dispose = this.ctx.effect(function* () {
      providers.set(provider.id, provider)
      yield () => providers.delete(provider.id)
    }, 'kernel.registerProvider()')
    // ctx.effect's disposer returns Promise<void>; our disposer API is
    // synchronous fire-and-forget — discard the (always-resolved) promise.
    return () => void dispose()
  }

  /**
   * Execute one cell in the persistent namespace. Resolves the backend at call
   * time with the selection rules above; throws {@link KernelError} when the
   * capability itself cannot run. A cell that raises is a *result* carrying the
   * traceback, never a throw — the model is expected to read it and fix the code.
   * @param request - the cell and its optional budget.
   * @param signal - optional cancellation; an aborted cell restarts the kernel.
   * @returns the captured output and how the cell ended.
   */
  async execute(request: KernelExecuteRequest, signal?: AbortSignal): Promise<KernelExecuteResult> {
    const provider = this.resolve()
    return provider.execute({
      code: request.code,
      timeoutMs: request.timeoutMs ?? this.defaultTimeoutMs,
      // Secondary budget is only forwarded when the caller set one; an absent
      // value lets the backend pick its own generous multiple of the primary.
      ...request.backgroundTimeoutMs !== undefined ? { backgroundTimeoutMs: request.backgroundTimeoutMs } : {},
      // The caller's cwd is the owning chat's workspace; the seam only forwards
      // it, never defaults it — an absent cwd means "wherever the kernel is".
      ...request.cwd !== undefined ? { cwd: request.cwd } : {},
      // The calling agent's scoped context reaches capability-aware backends
      // (fs/shell/web/…) through the same request the tool layer already fills.
      ...request.agentCtx !== undefined ? { agentCtx: request.agentCtx } : {},
    }, signal)
  }

  /**
   * Discard the namespace and start a fresh kernel.
   * @returns once the replacement kernel is ready.
   */
  async restart(): Promise<void> {
    return this.resolve().restart()
  }

  /**
   * List the names currently bound in the namespace.
   * @returns the bound names, in the backend's order.
   */
  async names(): Promise<readonly string[]> {
    return this.resolve().names()
  }

  /**
   * Whether the resolved backend currently has a cell queued or running.
   * Returns `false` when no backend is resolvable (no usable provider), which
   * is the correct reading for a re-entrant guard: without a backend there is
   * nothing to deadlock against.
   */
  busy(): boolean {
    try {
      return this.resolve().busy?.() ?? false
    } catch {
      return false
    }
  }

  /** Resolve the selected backend or throw the matching {@link KernelError}. */
  private resolve(): KernelProvider {
    const configuredId = this.providerId
    if (configuredId !== undefined) {
      const provider = this.providers.get(configuredId)
      if (!provider) {
        throw new KernelError(
          `configured kernel provider "${configuredId}" is not registered`,
          'KERNEL_PROVIDER_CONFIGURED_MISSING',
        )
      }
      if (!provider.available()) {
        throw new KernelError(
          `configured kernel provider "${configuredId}" is registered but unavailable`,
          'KERNEL_PROVIDER_CONFIGURED_UNAVAILABLE',
        )
      }
      return provider
    }
    const usable = [...this.providers.values()].filter(provider => provider.available())
    const [single] = usable
    if (single === undefined) {
      throw new KernelError('no usable kernel provider is registered', 'KERNEL_PROVIDER_UNAVAILABLE')
    }
    if (usable.length > 1) {
      const ids = usable.map(provider => provider.id).join(', ')
      throw new KernelError(
        `multiple usable kernel providers are registered (${ids}); configure one explicitly`,
        'KERNEL_PROVIDER_AMBIGUOUS',
      )
    }
    return single
  }
}

export default KernelRuntime
