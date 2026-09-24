/**
 * An adapter decorator that ships the system prompt as an uploaded provider file.
 *
 * The wrapped adapter sees a short instruction naming the file instead of the
 * assembled prompt, so the prompt's bytes leave the token stream while the model
 * can still read every one of them. A provider with no file route, an unset
 * system slot, or a failed upload passes through unchanged: the prompt always
 * reaches the model somehow.
 * @module dsh-llm-system-file/adapter
 */

import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SystemPromptFileStore } from './store.ts'
import type { SystemPromptConnection, SystemPromptFilePolicy } from './store.ts'

/** Resolve the upload route for one registered provider route. */
export type SystemPromptConnectionResolver = (provider: string) => SystemPromptConnection | undefined

/** Construction inputs for one decorator instance. */
export interface SystemPromptFileAdapterOptions {
  /** The adapter that ultimately serves the request. */
  inner: LlmAdapter
  /** Upload route per provider; omitted keeps every prompt inline. */
  connectionFor?: SystemPromptConnectionResolver
  /** Upload/dedup store; a default instance is created when omitted. */
  store?: SystemPromptFileStore
  /** Lifetime policy forwarded to every delivery. */
  policy?: Partial<SystemPromptFilePolicy>
}

/**
 * Deliver the system prompt as an uploaded provider file ahead of `inner`.
 *
 * Register this instance for the same provider routes as `inner`; it forwards
 * every metadata query and rewrites only the system slot of a streaming call.
 */
export class SystemPromptFileAdapter extends LlmAdapter {
  private readonly inner: LlmAdapter
  private readonly store: SystemPromptFileStore
  private readonly connectionFor: SystemPromptConnectionResolver | undefined
  private readonly policy: Partial<SystemPromptFilePolicy>

  /**
   * @param options - the wrapped adapter, its upload route, and the store.
   */
  constructor(options: SystemPromptFileAdapterOptions) {
    super()
    this.inner = options.inner
    this.store = options.store ?? new SystemPromptFileStore()
    this.connectionFor = options.connectionFor
    this.policy = options.policy ?? {}
  }

  override providerInfo(provider: string): ReturnType<LlmAdapter['providerInfo']> {
    return this.inner.providerInfo(provider)
  }

  override providerRetryPolicy(provider: string): ReturnType<LlmAdapter['providerRetryPolicy']> {
    return this.inner.providerRetryPolicy(provider)
  }

  override imageRequestPricing(provider: string, model: string): ReturnType<LlmAdapter['imageRequestPricing']> {
    return this.inner.imageRequestPricing(provider, model)
  }

  override listModels(provider: string): ReturnType<LlmAdapter['listModels']> {
    return this.inner.listModels(provider)
  }

  override resolveModel(provider: string, model: string, signal?: AbortSignal): ReturnType<LlmAdapter['resolveModel']> {
    return this.inner.resolveModel(provider, model, signal)
  }

  /**
   * Stream one call after replacing the inline system prompt with a file reference.
   * @param options - the fully-assembled request.
   * @returns the wrapped adapter's chunk stream.
   */
  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    yield* this.inner.stream(await this.rewrite(options))
  }

  /**
   * Swap the inline prompt for the file instruction, or return `options` untouched.
   * @param options - the fully-assembled request.
   * @returns a request whose system slot names the uploaded file, when reachable.
   */
  private async rewrite(options: GenerateOptions): Promise<GenerateOptions> {
    const text = options.system
    if (text === undefined || this.connectionFor === undefined) return options
    const connection = this.connectionFor(options.provider)
    if (connection === undefined) return options
    const delivery = await this.store.deliver(text, connection, this.policy)
    if (delivery.fileId === undefined) return options
    return { ...options, system: delivery.text }
  }

  /**
   * Forget a mapping the provider rejected so the next turn uploads again.
   * @param provider - the registered provider route.
   * @param text - the exact prompt text the provider rejected.
   * @param fileId - the rejected provider file id.
   * @returns whether a mapping was removed.
   */
  async invalidate(
    provider: string,
    text: string,
    fileId: Parameters<SystemPromptFileStore['invalidate']>[2],
  ): Promise<boolean> {
    const connection = this.connectionFor?.(provider)
    if (connection === undefined) return false
    return this.store.invalidate(connection, text, fileId)
  }
}
