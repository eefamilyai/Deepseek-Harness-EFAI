/**
 * The peak-hour send gate: which sends it stops, the question it asks, and the
 * one-question-at-a-time controller the dialog renders.
 *
 * The gate sits on the composer's default send. A stopped send is held until
 * the user answers; the answer decides whether the message goes out now, is
 * handed to the schedule for when peak pricing ends, or returns to the composer
 * unsent.
 */
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import { peakState } from '../schedule.ts'
import { scheduleOf, type PeakHoursSettings } from './view.ts'

/** A message waiting in the Session for its off-peak send time. */
export interface PendingSend {
  readonly id: string
  readonly at: string
  readonly text: string
}

/** What the dialog asks about one stopped send. */
export interface GateQuestion {
  /** The model route's display name. */
  readonly model: string
  /** When peak pricing ends, epoch ms. */
  readonly endsAt: number
  /** The deferred messages this Session already holds; empty when none. */
  readonly pending: readonly PendingSend[]
  /** Why the message cannot be scheduled, or null when it can. */
  readonly blocked: 'attachments' | 'unavailable' | null
}

/** The user's answer. */
export type GateChoice =
  | { readonly kind: 'send' }
  | { readonly kind: 'edit' }
  | { readonly kind: 'schedule'; readonly placement: 'alone' | 'after' | 'together'; readonly earlierId?: string }

/**
 * When the gate may stop a send at all: it is on and peak pricing is running.
 * Which route the send uses is checked afterwards, with {@link isGated}.
 * @param settings - the accepted `ui-peak-hours` section.
 * @param now - epoch ms.
 * @returns when peak ends, or null when every send goes straight through.
 */
export function gateEnd(settings: PeakHoursSettings, now: number): number | null {
  if (!settings.sendGate || settings.gatedRoutes.length === 0) return null
  let state
  try {
    state = peakState(scheduleOf(settings), now)
  } catch {
    // An unusable schedule is reported on the pill; it never blocks sending.
    return null
  }
  return state.kind === 'peak' ? state.endsAt : null
}

/**
 * Whether a provider route bills DeepSeek API rates.
 * @param settings - the accepted `ui-peak-hours` section.
 * @param provider - the route id.
 * @returns true for a guarded route.
 */
export function isGated(settings: PeakHoursSettings, provider: string): boolean {
  return settings.gatedRoutes.includes(provider)
}

/** The question on screen, or null. */
export type GateView = GateQuestion | null

/** One held send and how to answer it. */
interface Held {
  readonly question: GateQuestion
  readonly answer: (choice: GateChoice) => void
}

/**
 * Asks one question at a time; sends stopped while a question is open wait their turn.
 */
export class SendGate {
  /** The question the dialog shows. */
  readonly view: SnapshotStore<GateView> = createSnapshotStore<GateView>(null)
  private readonly queue: Held[] = []

  /**
   * Hold a send until the user answers.
   * @param question - what to ask.
   * @param signal - the send's cancellation; an aborted send returns to the composer.
   * @returns the answer.
   */
  ask(question: GateQuestion, signal?: AbortSignal): Promise<GateChoice> {
    if (signal?.aborted === true) return Promise.resolve({ kind: 'edit' })
    return new Promise((resolve) => {
      const held: Held = {
        question,
        answer: (choice) => {
          signal?.removeEventListener('abort', onAbort)
          resolve(choice)
        },
      }
      const onAbort = (): void => { this.drop(held, { kind: 'edit' }) }
      signal?.addEventListener('abort', onAbort, { once: true })
      this.queue.push(held)
      if (this.queue.length === 1) this.view.set(question)
    })
  }

  /**
   * Answer the question on screen.
   * @param choice - the user's answer.
   */
  choose(choice: GateChoice): void {
    const held = this.queue[0]
    if (held !== undefined) this.drop(held, choice)
  }

  /** Return every held send to the composer, as when the window goes away. */
  dispose(): void {
    for (const held of [...this.queue]) this.drop(held, { kind: 'edit' })
  }

  /**
   * Settle one held send and show the next question.
   * @param held - the send.
   * @param choice - its answer.
   */
  private drop(held: Held, choice: GateChoice): void {
    // Each held send settles once: answering removes its abort listener, and dispose walks a copy.
    this.queue.splice(this.queue.indexOf(held), 1)
    held.answer(choice)
    this.view.set(this.queue[0]?.question ?? null)
  }
}

/** The composer's send outcome: success clears the draft, error returns it to the composer. */
export interface SendOutcome {
  readonly kind: 'success' | 'error'
  readonly text?: string
}

/** The conversation service's send method as the composer calls it. */
export type SendSession = (
  session: GatedSession, text: string, attachmentIds: readonly unknown[], mode: unknown, signal?: AbortSignal,
) => Promise<SendOutcome>

/** The parts of a Session face the gate reads. */
export interface GatedSession {
  getSnapshot(): { readonly sessionId?: string; readonly blank?: boolean }
  readonly projections: { faceOf(key: string): { getSnapshot(): unknown } }
}

/** The provider route and model a Session's next request uses. */
export interface Selection {
  readonly provider: string
  readonly model: string
}

/**
 * The provider route and model a Session's next request uses.
 * @param session - the Session face.
 * @returns the selection, or undefined when the Session has none.
 */
export function selectionOf(session: GatedSession): Selection | undefined {
  try {
    const projection = session.projections.faceOf('modelSelection').getSnapshot() as
      { next?: Partial<Selection> | null; lastUsed?: Partial<Selection> | null } | undefined
    const selection = projection?.next ?? projection?.lastUsed
    if (typeof selection?.provider !== 'string') return undefined
    return { provider: selection.provider, model: typeof selection.model === 'string' ? selection.model : selection.provider }
  } catch {
    return undefined
  }
}
