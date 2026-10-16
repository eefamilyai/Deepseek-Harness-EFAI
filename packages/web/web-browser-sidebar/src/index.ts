/**
 * The `agentBrowser` service: carries the agent's browser pages in the Desktop window's
 * right sidebar instead of a headless browser.
 *
 * The Host cannot drive an Electron `<webview>` itself; the window that owns it can. So
 * the window subscribes to {@link AgentBrowser.commands}, performs each low-level page
 * operation on the page it keeps for that agent, and settles it with
 * {@link AgentBrowser.respond}. A Host caller — the `browser` tool — sees one awaitable
 * {@link AgentBrowser.run} per operation and {@link AgentBrowser.available} to decide
 * whether a window is there to carry the page at all.
 *
 * The newest subscribed window carries every page. A window that disconnects fails the
 * operations it still holds, because the page they addressed went with it.
 *
 * ```yaml
 * - id: web-browser-sidebar
 *   name: '@deepseek-ai/dsh-web-browser-sidebar'
 * ```
 *
 * @module @deepseek-ai/dsh-web-browser-sidebar
 */

import { randomUUID } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { AgentBrowserReply, AgentBrowserRequest } from './types.ts'

export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    agentBrowser: AgentBrowser
  }
}

/** One operation a Host caller asks for; the service mints its identity. */
export type AgentBrowserCall = Omit<AgentBrowserRequest, 'id'>

/** Thrown when no Desktop window is subscribed, or the one holding the operation went away. */
export class AgentBrowserUnavailableError extends Error {
  override readonly name = 'AgentBrowserUnavailableError'
}

/** One subscribed window: its undelivered requests and the operations it holds. */
interface Subscriber {
  readonly queue: AgentBrowserRequest[]
  wake: (() => void) | undefined
  readonly held: Set<string>
}

/** One operation waiting for its reply. */
interface Pending {
  readonly subscriber: Subscriber
  readonly resolve: (reply: AgentBrowserReply) => void
  readonly reject: (error: Error) => void
}

/** The service's own configuration. */
export interface AgentBrowserConfig {
  /** Milliseconds a reply may take beyond the operation's own `timeoutMs` before the operation fails. */
  replyGraceMs: number
}

/** The `ctx.agentBrowser` service. The name is the literal the Typert analyzer binds the namespace to. */
export class AgentBrowser extends TypertRemoteService {
  static readonly Config: z<AgentBrowserConfig> = z.object({
    replyGraceMs: z.number().min(0).default(5000)
      .description('Milliseconds a window reply may take beyond the operation timeout before the operation fails.'),
  })

  private readonly subscribers: Subscriber[] = []
  private readonly pending = new Map<string, Pending>()

  /**
   * @param ctx - the Host context this service is mounted on.
   * @param config - the resolved service configuration.
   */
  constructor(ctx: Context, private readonly config: AgentBrowserConfig) {
    super(ctx, 'agentBrowser')
  }

  /**
   * Whether a Desktop window is subscribed to carry agent pages.
   * @returns true while at least one window holds the command stream.
   */
  available(): boolean {
    return this.subscribers.length > 0
  }

  /**
   * Perform one page operation in the newest subscribed window.
   * @param call - the operation and the page it addresses.
   * @param signal - abandons the wait; the window may still finish the operation.
   * @returns the window's successful reply.
   * @throws {AgentBrowserUnavailableError} when no window is subscribed or the holding window disconnects.
   * @throws Error with the window's reason when the operation fails, or when no reply arrives in time.
   */
  run(call: AgentBrowserCall, signal?: AbortSignal): Promise<AgentBrowserReply> {
    const subscriber = this.subscribers.at(-1)
    if (subscriber === undefined) {
      return Promise.reject(new AgentBrowserUnavailableError('no Desktop window is connected to show the browser'))
    }
    signal?.throwIfAborted()
    const id = randomUUID()
    return new Promise<AgentBrowserReply>((resolve, reject) => {
      const deadline = setTimeout(() => {
        settle()
        reject(new Error(`the browser did not answer "${call.op}" within ${String(call.timeoutMs + this.config.replyGraceMs)} ms`))
      }, call.timeoutMs + this.config.replyGraceMs)
      const abort = (): void => {
        settle()
        reject(signal?.reason instanceof Error ? signal.reason : new Error('browser operation aborted'))
      }
      const settle = (): void => {
        clearTimeout(deadline)
        signal?.removeEventListener('abort', abort)
        this.pending.delete(id)
        subscriber.held.delete(id)
      }
      signal?.addEventListener('abort', abort, { once: true })
      this.pending.set(id, {
        subscriber,
        resolve: (reply) => {
          settle()
          if (reply.ok) resolve(reply)
          else reject(new Error(reply.error ?? `the browser could not perform "${call.op}"`))
        },
        reject: (error) => { settle(); reject(error) },
      })
      subscriber.held.add(id)
      subscriber.queue.push({ ...call, id })
      subscriber.wake?.()
    })
  }

  /**
   * Carry agent pages in this window: receive every operation addressed to them.
   * The first item is a `hello` with no operation, so the window can accept the stream.
   * @param signal - stream lifetime; it ends when the window disconnects.
   * @returns the operations, in the order the Host issued them.
   */
  @Remote({ mode: 'stream' })
  async *commands(signal: AbortSignal): AsyncIterable<AgentBrowserRequest> {
    const subscriber: Subscriber = { queue: [], wake: undefined, held: new Set() }
    this.subscribers.push(subscriber)
    const wake = (): void => { subscriber.wake?.() }
    signal.addEventListener('abort', wake, { once: true })
    try {
      yield { id: '', op: 'hello', pageId: '', displaySessionId: '', viewportWidth: 0, viewportHeight: 0, timeoutMs: 0 }
      while (!signal.aborted) {
        const next = subscriber.queue.shift()
        if (next !== undefined) { yield next; continue }
        await new Promise<void>((resolve) => { subscriber.wake = resolve })
        subscriber.wake = undefined
      }
    } finally {
      signal.removeEventListener('abort', wake)
      const index = this.subscribers.indexOf(subscriber)
      if (index >= 0) this.subscribers.splice(index, 1)
      for (const id of [...subscriber.held]) {
        this.pending.get(id)?.reject(new AgentBrowserUnavailableError('the Desktop window showing the browser disconnected'))
      }
    }
  }

  /**
   * Settle one operation this window performed.
   * @param reply - the outcome, naming the operation it settles.
   * @returns whether an operation was waiting for this reply; false for a late or unknown one.
   */
  @Remote
  respond(reply: AgentBrowserReply): boolean {
    const pending = this.pending.get(reply.id)
    if (pending === undefined) return false
    pending.resolve(reply)
    return true
  }
}

export default AgentBrowser
