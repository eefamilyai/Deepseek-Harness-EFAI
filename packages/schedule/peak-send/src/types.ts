/**
 * The deferred-send vocabulary the `peakSend` service speaks, and its Remote
 * failure code.
 *
 * A Remote method's parameter and result types must be exported from a public
 * non-root subpath for the Typert generator, which is why this module exists
 * separately from `./index.ts`.
 *
 * @module @deepseek-ai/dsh-peak-send/types
 */

/** One message waiting in a Session for its off-peak send time. */
export interface DeferredSend {
  /** The schedule task that delivers it. */
  readonly id: string
  /** When it is sent, canonical UTC. */
  readonly at: string
  /** The message text as it will be sent. */
  readonly text: string
}

/**
 * Where a newly deferred message goes relative to one already waiting.
 *
 * - `alone`: its own task at the requested time;
 * - `after`: its own task at the earlier message's time, delivered after it, so
 *   it starts its own turn only once the earlier message's turn has settled;
 * - `together`: appended to the earlier message, so both are sent as one message.
 */
export type DeferPlacement = 'alone' | 'after' | 'together'

/** A request to send one message later. */
export interface DeferRequest {
  /** The Session that receives the message. */
  readonly sessionId: string
  /** The message text. */
  readonly text: string
  /** When to send it, an RFC 3339 instant; `after` and `together` use the earlier message's time instead. */
  readonly at: string
  /** Where the message goes relative to an earlier deferred one. */
  readonly placement: DeferPlacement
  /** The earlier deferred message, required for `after` and `together`. */
  readonly earlierId?: string
}

/** The deferred message after a {@link DeferRequest}. */
export interface DeferResult {
  /** The task that now carries the message (the earlier task for `together`). */
  readonly id: string
  /** When it is sent, canonical UTC. */
  readonly at: string
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** A deferred send was refused: an empty message, a bad time, or a missing earlier message. */
    'peakSend/defer-rejected': {
      readonly sessionId: string
    }
  }
}
