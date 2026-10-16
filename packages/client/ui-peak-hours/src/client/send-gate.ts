/**
 * The wrapper around the composer's default send that stops a DeepSeek API
 * message during peak pricing and acts on the user's answer.
 *
 * The composer clears its draft as soon as a message is sent and puts it back,
 * with its reference chips and attachments, when the send settles as an error.
 * So "keep editing" settles the send as an error without text (no notice), a
 * scheduled message settles as a success whose text the composer shows as a
 * notice, and "send anyway" hands the call to the original send untouched.
 */
import type { GateChoice, GatedSession, GateQuestion, PendingSend, SendGate, SendOutcome, SendSession } from './gate.ts'
import { gateEnd, isGated, selectionOf, type Selection } from './gate.ts'
import type { PeakHoursSettings } from './view.ts'

/** A Remote call's answer. */
export type RemoteAnswer<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly message: string } }

/** The `peakSend` Remote namespace as the gate calls it. */
export interface PeakSendRemote {
  pending(sessionId: string): Promise<RemoteAnswer<PendingSend[]>>
  defer(request: {
    sessionId: string
    text: string
    at: string
    placement: 'alone' | 'after' | 'together'
    earlierId?: string
  }): Promise<RemoteAnswer<{ id: string; at: string }>>
}

/** The parts of the model catalog the gate reads: the default selection and display names. */
export interface CatalogView {
  readonly default: Selection
  readonly groups: readonly {
    readonly id: string
    readonly name: string
    readonly models: readonly { readonly id: string; readonly name: string }[]
  }[]
}

/** What the wrapper reads at each send. */
export interface SendGateDeps {
  /** The model catalog, read only for a send during peak; undefined when unavailable. */
  catalog: () => Promise<CatalogView | undefined>
  /** The accepted `ui-peak-hours` section. */
  settings: () => PeakHoursSettings
  /** The dialog controller. */
  gate: SendGate
  /** The `peakSend` namespace, or undefined when the deployment does not mount it. */
  remote: () => PeakSendRemote | undefined
  /** Translate a `peakHours` key. */
  t: (key: 'gate.scheduled' | 'gate.merged' | 'gate.queued' | 'gate.failed', params: Record<string, string>) => string
  /** Format an instant for the notice. */
  clock: (at: number, now: number) => string
  /** The clock. */
  now?: () => number
}

/**
 * Wrap a send so a peak-hour DeepSeek API message asks first.
 * @param original - the conversation service's own send, bound to it.
 * @param deps - settings, dialog, Remote, and copy.
 * @returns the gated send.
 */
export function gatedSend(original: SendSession, deps: SendGateDeps): SendSession {
  const now = deps.now ?? Date.now
  return async (session, text, attachmentIds, mode, signal) => {
    const settings = deps.settings()
    const endsAt = gateEnd(settings, now())
    if (endsAt === null) return await original(session, text, attachmentIds, mode, signal)
    // A Session that has not sent yet has no selection of its own and uses the catalog default.
    const catalog = await catalogOf(deps)
    const selection = selectionOf(session) ?? catalog?.default
    if (selection === undefined || !isGated(settings, selection.provider)) return await original(session, text, attachmentIds, mode, signal)
    // A new Session is already a Host entity with its id, so it can receive a deferred message too.
    const sessionId = session.getSnapshot().sessionId
    const remote = deps.remote()
    const pending = await pendingOf(remote, sessionId)
    const question: GateQuestion = {
      model: modelName(catalog, selection),
      endsAt,
      pending: pending ?? [],
      blocked: attachmentIds.length > 0 ? 'attachments' : pending === null || text.trim() === '' ? 'unavailable' : null,
    }
    const choice: GateChoice = await deps.gate.ask(question, signal)
    if (choice.kind === 'send') return await original(session, text, attachmentIds, mode, signal)
    if (choice.kind === 'edit' || remote === undefined || sessionId === undefined) return { kind: 'error' }
    return await schedule(remote, deps, { sessionId, text, endsAt, choice }, now())
  }
}

/**
 * Read the catalog, treating a failure as no catalog.
 * @param deps - the catalog reader.
 * @returns the catalog, or undefined.
 */
async function catalogOf(deps: SendGateDeps): Promise<CatalogView | undefined> {
  try {
    return await deps.catalog()
  } catch {
    return undefined
  }
}

/**
 * The model's display name, falling back to its id.
 * @param catalog - the catalog, if read.
 * @param selection - the route and model.
 * @returns the name to show.
 */
export function modelName(catalog: CatalogView | undefined, selection: Selection): string {
  const group = catalog?.groups.find(entry => entry.id === selection.provider)
  return group?.models.find(model => model.id === selection.model)?.name ?? selection.model
}

/**
 * The Session's deferred messages.
 * @param remote - the namespace, if mounted.
 * @param sessionId - the Session, if it exists on the Host.
 * @returns the messages, or null when the Session cannot schedule.
 */
async function pendingOf(remote: PeakSendRemote | undefined, sessionId: string | undefined): Promise<readonly PendingSend[] | null> {
  if (remote === undefined || sessionId === undefined) return null
  try {
    const answer = await remote.pending(sessionId)
    return answer.ok ? answer.value : null
  } catch {
    return null
  }
}

/**
 * Hand the message to the schedule and report where it went.
 * @param remote - the namespace.
 * @param deps - copy and clock formatting.
 * @param request - the Session, text, peak end, and the chosen placement.
 * @param now - epoch ms.
 * @returns success with a notice, or an error that returns the draft with the reason.
 */
async function schedule(
  remote: PeakSendRemote,
  deps: SendGateDeps,
  request: { sessionId: string; text: string; endsAt: number; choice: Extract<GateChoice, { kind: 'schedule' }> },
  now: number,
): Promise<SendOutcome> {
  const { choice } = request
  let answer: RemoteAnswer<{ id: string; at: string }>
  try {
    answer = await remote.defer({
      sessionId: request.sessionId,
      text: request.text,
      at: new Date(request.endsAt).toISOString(),
      placement: choice.placement,
      ...choice.earlierId === undefined ? {} : { earlierId: choice.earlierId },
    })
  } catch (error: unknown) {
    answer = { ok: false, error: { message: error instanceof Error ? error.message : String(error) } }
  }
  if (!answer.ok) return { kind: 'error', text: deps.t('gate.failed', { message: answer.error.message }) }
  const time = deps.clock(Date.parse(answer.value.at), now)
  const key = choice.placement === 'together' ? 'gate.merged' : choice.placement === 'after' ? 'gate.queued' : 'gate.scheduled'
  return { kind: 'success', text: deps.t(key, { time }) }
}

/**
 * The conversation service as the gate patches it. `sendSession` is declared as
 * a method so the service's own, more specific signature is assignable here.
 */
export interface Sender {
  sendSession(
    session: GatedSession, text: string, attachmentIds: readonly unknown[], mode: unknown, signal?: AbortSignal,
  ): Promise<SendOutcome>
}

/**
 * The conversation service's send method, which the composer's default send
 * calls but the public conversation face does not declare.
 * @param service - the conversation service.
 * @returns the service as a sender, or undefined when it has no such method.
 */
export function senderOf(service: object): Sender | undefined {
  return 'sendSession' in service && typeof service.sendSession === 'function' ? service as Sender : undefined
}

/**
 * Install the gate on a conversation service for as long as the returned function is not called.
 * @param conversation - the service whose send the composer calls.
 * @param deps - settings, dialog, Remote, and copy.
 * @returns the function that restores the original send.
 */
export function installSendGate(conversation: Sender, deps: SendGateDeps): () => void {
  const own = Object.getOwnPropertyDescriptor(conversation, 'sendSession')
  conversation.sendSession = gatedSend(conversation.sendSession.bind(conversation), deps)
  return () => {
    if (own === undefined) delete (conversation as Partial<Sender>).sendSession
    else Object.defineProperty(conversation, 'sendSession', own)
  }
}

export type { GatedSession }
