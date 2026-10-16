/**
 * The `peakSend` service: the Remote surface the peak-hour send dialog uses to
 * hold a message until DeepSeek peak pricing ends.
 *
 * A deferred message is an ordinary one-shot task of the Host schedule
 * service, so it shows on the Automation tasks page, survives a restart, and
 * can be edited or deleted there. Its title starts with {@link TITLE_PREFIX},
 * which is how this service tells its own tasks from the user's other
 * reminders.
 *
 * Two messages deferred to the same instant are delivered in creation order,
 * and each delivery is a follow-up that becomes the sole message of its own
 * turn, so a second message placed `after` the first starts only once the first
 * one's turn has settled. A message placed `together` is appended to the first
 * task's text, so both go out as one message.
 *
 * ```yaml
 * - id: peak-send
 *   name: '@deepseek-ai/dsh-peak-send'
 * ```
 *
 * @module @deepseek-ai/dsh-peak-send
 */

import type { Context } from '@deepseek-ai/cordis'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { AtScheduleRecord, ScheduleRecord } from '@deepseek-ai/dsh-schedule'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { DeferRequest, DeferResult, DeferredSend } from './types.ts'

export * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    peakSend: PeakSend
  }
}

/** Title prefix of every task this service creates; the rest of the title is the message's opening. */
export const TITLE_PREFIX = 'Off-peak send: '

/** The schedule service's title limit. */
const TITLE_LIMIT = 120

/** Separator between two messages sent together. */
const JOIN = '\n\n'

/**
 * The task title for a message: the prefix and the message's first line, cut to the schedule's limit.
 * @param text - the message text.
 * @returns the title.
 */
export function titleFor(text: string): string {
  const line = text.trim().replace(/\r?\n[\s\S]*$/u, '').replace(/\s+/gu, ' ')
  const room = TITLE_LIMIT - TITLE_PREFIX.length
  return TITLE_PREFIX + (line.length > room ? `${line.slice(0, room - 1)}…` : line)
}

/**
 * Whether a task is a message this service deferred.
 * @param record - a stored task.
 * @returns true for a one-shot task carrying the prefix.
 */
export function isDeferred(record: ScheduleRecord): record is AtScheduleRecord {
  return record.kind === 'at' && record.title.startsWith(TITLE_PREFIX)
}

/**
 * The `ctx.peakSend` service. The service name is the literal the Typert
 * analyzer reads to bind the namespace, so it cannot be factored into a constant.
 */
export class PeakSend extends TypertRemoteService {
  static inject = ['schedule']

  /**
   * @param ctx - the Host context, which provides the schedule service.
   */
  constructor(ctx: Context) {
    super(ctx, 'peakSend')
  }

  /**
   * The messages a Session holds for an off-peak send, earliest first.
   * @param sessionId - the Session.
   * @returns its deferred messages.
   */
  @Remote
  async pending(sessionId: string): Promise<DeferredSend[]> {
    const records = await this.ctx.schedule.list({ sessionId: sessionId as SessionId })
    return records.filter(isDeferred)
      .map(record => ({ id: record.id, at: record.scheduledAt, text: record.prompt }))
      .toSorted((a, b) => Date.parse(a.at) - Date.parse(b.at))
  }

  /**
   * Defer one message: on its own, after an earlier deferred message, or merged into it.
   * @param request - the Session, the text, the time, and the placement.
   * @returns the task carrying the message and its send time.
   * @throws RemoteError with `peakSend/defer-rejected` for an empty message, an
   * unusable time, a missing earlier message, or a schedule refusal.
   */
  @Remote
  async defer(request: DeferRequest): Promise<DeferResult> {
    try {
      const text = request.text.trim()
      if (text === '') throw new Error('a deferred message needs text')
      const sessionId = request.sessionId as SessionId
      if (request.placement === 'alone') return await this.create(sessionId, text, request.at)
      const earlier = (await this.ctx.schedule.list({ sessionId })).filter(isDeferred)
        .find(record => record.id === request.earlierId)
      if (earlier === undefined) throw new Error('the earlier deferred message is no longer waiting')
      if (request.placement === 'after') return await this.create(sessionId, text, earlier.scheduledAt)
      const result = await this.ctx.schedule.update({
        sessionId, id: earlier.id, expected: earlier, prompt: `${earlier.prompt}${JOIN}${text}`,
      })
      if (!('record' in result)) {
        throw new Error('code' in result ? `the earlier message could not be changed (${result.code})` : 'the earlier message could not be changed')
      }
      return { id: result.record.id, at: result.record.scheduledAt }
    } catch (error: unknown) {
      throw new RemoteError(
        'peakSend/defer-rejected',
        error instanceof Error ? error.message : String(error),
        { sessionId: request.sessionId },
        { cause: error },
      )
    }
  }

  /**
   * Create one deferred task.
   * @param sessionId - the receiving Session.
   * @param text - the trimmed message.
   * @param at - the send instant.
   * @returns the new task and its canonical time.
   */
  private async create(sessionId: SessionId, text: string, at: string): Promise<DeferResult> {
    if (Number.isNaN(Date.parse(at))) throw new Error(`"${at}" is not a time`)
    const record = await this.ctx.schedule.create(sessionId, { prompt: text, title: titleFor(text), at })
    return { id: record.id, at: record.scheduledAt }
  }
}

export default PeakSend
