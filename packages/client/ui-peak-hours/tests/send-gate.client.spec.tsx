// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { apply, inject } from '../src/client/index.ts'
import { en } from '../src/client/locales.ts'
import { gateEnd, isGated, selectionOf, SendGate, type GatedSession, type GateQuestion, type GateView } from '../src/client/gate.ts'
import { gatedSend, installSendGate, modelName, senderOf, type PeakSendRemote, type SendGateDeps } from '../src/client/send-gate.ts'
import type { SendSession } from '../src/client/gate.ts'
import { SendGateDialog, type SendGateDialogProps } from '../src/client/SendGateDialog.tsx'
import { DEFAULT_SETTINGS, type PeakHoursSettings } from '../src/client/view.ts'

/** Monday 2026-10-12 02:00 UTC: inside the 01:00-04:00 window. */
const PEAK = Date.parse('2026-10-12T02:00:00Z')
/** Same Monday 05:00 UTC: between windows. */
const OFF = Date.parse('2026-10-12T05:00:00Z')
const PEAK_END = Date.parse('2026-10-12T04:00:00Z')

const t = ((key: keyof typeof en, params?: Record<string, unknown>) =>
  en[key].replace(/\{(\w+)\}/g, (_, name: string) => {
    const value = params?.[name]
    return typeof value === 'string' || typeof value === 'number' ? String(value) : ''
  })) as SendGateDialogProps['t']

afterEach(() => { cleanup() })

/** A Session face with an optional model selection. */
function sessionOf(selection: { provider: string; model: string } | null | 'throws', snapshot: { sessionId?: string; blank?: boolean } = { sessionId: 's1' }): GatedSession {
  return {
    getSnapshot: () => snapshot,
    projections: {
      faceOf: () => ({
        getSnapshot: () => {
          if (selection === 'throws') throw new Error('no projection')
          return { next: null, lastUsed: selection }
        },
      }),
    },
  }
}

describe('when the gate applies', () => {
  it('stops sends only while on, peak, and with routes to guard', () => {
    expect(gateEnd(DEFAULT_SETTINGS, PEAK)).toBe(PEAK_END)
    expect(gateEnd(DEFAULT_SETTINGS, OFF)).toBeNull()
    expect(gateEnd({ ...DEFAULT_SETTINGS, sendGate: false }, PEAK)).toBeNull()
    expect(gateEnd({ ...DEFAULT_SETTINGS, gatedRoutes: [] }, PEAK)).toBeNull()
    // An unusable schedule never blocks sending.
    expect(gateEnd({ ...DEFAULT_SETTINGS, windows: [{ start: 'x', end: 'y' }] }, PEAK)).toBeNull()
  })

  it('guards DeepSeek API routes and nothing else by default', () => {
    expect(isGated(DEFAULT_SETTINGS, 'deepseek-official')).toBe(true)
    expect(isGated(DEFAULT_SETTINGS, 'kiln-deepseek-api')).toBe(true)
    for (const route of ['deepseek-account', 'kiln-deepseek', 'deepseekfree', 'anthropic']) expect(isGated(DEFAULT_SETTINGS, route)).toBe(false)
  })

  it('reads the next selection, then the last used one, and nothing from an empty or failing projection', () => {
    const face = (value: unknown): GatedSession => ({
      getSnapshot: () => ({}), projections: { faceOf: () => ({ getSnapshot: () => value }) },
    })
    expect(selectionOf(face({ next: { provider: 'a', model: 'm' }, lastUsed: { provider: 'b', model: 'n' } }))).toEqual({ provider: 'a', model: 'm' })
    expect(selectionOf(face({ next: null, lastUsed: { provider: 'b' } }))).toEqual({ provider: 'b', model: 'b' })
    expect(selectionOf(face(undefined))).toBeUndefined()
    expect(selectionOf(sessionOf('throws'))).toBeUndefined()
  })

  it('names the model from the catalog, falling back to its id', () => {
    const catalog = { default: { provider: 'p', model: 'm' }, groups: [{ id: 'p', name: 'P', models: [{ id: 'm', name: 'Model M' }] }] }
    expect(modelName(catalog, { provider: 'p', model: 'm' })).toBe('Model M')
    expect(modelName(catalog, { provider: 'p', model: 'x' })).toBe('x')
    expect(modelName(undefined, { provider: 'p', model: 'm' })).toBe('m')
  })
})

describe('the question queue', () => {
  const question = (model: string): GateQuestion => ({ model, endsAt: PEAK_END, pending: [], blocked: null })

  it('shows one question at a time and answers them in order', async () => {
    const gate = new SendGate()
    const first = gate.ask(question('a'))
    const second = gate.ask(question('b'))
    expect(gate.view.getSnapshot()?.model).toBe('a')
    gate.choose({ kind: 'send' })
    await expect(first).resolves.toEqual({ kind: 'send' })
    expect(gate.view.getSnapshot()?.model).toBe('b')
    gate.choose({ kind: 'edit' })
    await expect(second).resolves.toEqual({ kind: 'edit' })
    expect(gate.view.getSnapshot()).toBeNull()
    gate.choose({ kind: 'send' })
  })

  it('returns an aborted or already aborted send to the composer, and every send on dispose', async () => {
    const gate = new SendGate()
    const aborted = new AbortController()
    aborted.abort()
    await expect(gate.ask(question('a'), aborted.signal)).resolves.toEqual({ kind: 'edit' })
    const later = new AbortController()
    const held = gate.ask(question('b'), later.signal)
    const queued = gate.ask(question('c'))
    later.abort()
    await expect(held).resolves.toEqual({ kind: 'edit' })
    expect(gate.view.getSnapshot()?.model).toBe('c')
    gate.dispose()
    await expect(queued).resolves.toEqual({ kind: 'edit' })
    expect(gate.view.getSnapshot()).toBeNull()
  })
})

/** Deps over a fixed clock, a scripted Remote, and an auto-answering gate. */
function depsOf(options: {
  now?: number
  settings?: Partial<PeakHoursSettings>
  remote?: PeakSendRemote | undefined
  answer?: Parameters<SendGate['choose']>[0]
  catalog?: () => Promise<unknown>
}) {
  const gate = new SendGate()
  const asked: GateQuestion[] = []
  const ask = gate.ask.bind(gate)
  gate.ask = (question, signal) => {
    asked.push(question)
    const pending = ask(question, signal)
    if (options.answer !== undefined) gate.choose(options.answer)
    return pending
  }
  const deps: SendGateDeps = {
    settings: () => ({ ...DEFAULT_SETTINGS, ...options.settings }),
    gate,
    remote: () => options.remote,
    catalog: (options.catalog ?? (() => Promise.resolve({
      default: { provider: 'deepseek-official', model: 'deepseek-chat' },
      groups: [{ id: 'deepseek-official', name: 'DeepSeek', models: [{ id: 'deepseek-chat', name: 'DeepSeek V4' }] }],
    }))) as SendGateDeps['catalog'],
    t: (key, params) => t(key, params),
    clock: at => new Date(at).toISOString().slice(11, 16),
    now: () => options.now ?? PEAK,
  }
  return { deps, asked, gate }
}

function remoteOf(pending: unknown = { ok: true, value: [] }, deferred: unknown = { ok: true, value: { id: 't1', at: '2026-10-12T04:00:00.000Z' } }) {
  const remote: PeakSendRemote & { pending: ReturnType<typeof vi.fn>; defer: ReturnType<typeof vi.fn> } = {
    pending: vi.fn(() => Promise.resolve(pending)),
    defer: vi.fn(() => Promise.resolve(deferred)),
  } as never
  return remote
}

describe('the guarded send', () => {
  const original = () => vi.fn(() => Promise.resolve({ kind: 'success' as const }))
  const deepseek = { provider: 'deepseek-official', model: 'deepseek-chat' }

  it('passes straight through off-peak, on an unguarded route, and with no selection or catalog', async () => {
    for (const [now, selection, catalog] of [
      [OFF, deepseek, undefined],
      [PEAK, { provider: 'anthropic', model: 'claude' }, undefined],
      [PEAK, null, () => Promise.resolve(undefined)],
      [PEAK, null, () => Promise.reject(new Error('down'))],
    ] as const) {
      const send = original()
      const { deps, asked } = depsOf({ now, ...catalog === undefined ? {} : { catalog } })
      await expect(gatedSend(send, deps)(sessionOf(selection), 'hi', [], 'queue')).resolves.toEqual({ kind: 'success' })
      expect(send).toHaveBeenCalledOnce()
      expect(asked).toHaveLength(0)
    }
  })

  it('asks about a new Session through the catalog default, and sends anyway when told to', async () => {
    const send = original()
    const remote = remoteOf()
    const { deps, asked } = depsOf({ remote, answer: { kind: 'send' } })
    await gatedSend(send, deps)(sessionOf(null, { sessionId: 'new', blank: true }), 'hi', [], 'queue')
    expect(asked[0]).toEqual({ model: 'DeepSeek V4', endsAt: PEAK_END, pending: [], blocked: null })
    expect(remote.pending).toHaveBeenCalledWith('new')
    expect(send).toHaveBeenCalledWith(expect.anything(), 'hi', [], 'queue', undefined)
  })

  it('returns the draft for keep editing, without a notice', async () => {
    const send = original()
    const { deps } = depsOf({ remote: remoteOf(), answer: { kind: 'edit' } })
    await expect(gatedSend(send, deps)(sessionOf(deepseek), 'hi', [], 'queue')).resolves.toEqual({ kind: 'error' })
    expect(send).not.toHaveBeenCalled()
  })

  it('blocks scheduling for attachments, an empty text, a missing namespace, and a failed lookup', async () => {
    const cases: [PeakSendRemote | undefined, string, unknown[], GateQuestion['blocked'], { sessionId?: string }][] = [
      [remoteOf(), 'hi', ['file'], 'attachments', { sessionId: 's1' }],
      [remoteOf(), '  ', [], 'unavailable', { sessionId: 's1' }],
      [undefined, 'hi', [], 'unavailable', { sessionId: 's1' }],
      [remoteOf({ ok: false, error: { message: 'x' } }), 'hi', [], 'unavailable', { sessionId: 's1' }],
      [{ pending: () => Promise.reject(new Error('gone')) } as never, 'hi', [], 'unavailable', { sessionId: 's1' }],
      [remoteOf(), 'hi', [], 'unavailable', {}],
    ]
    for (const [remote, text, attachments, blocked, snapshot] of cases) {
      const { deps, asked } = depsOf({ remote, answer: { kind: 'schedule', placement: 'alone' } })
      // A schedule answer that slipped past the dialog still never sends.
      const result = await gatedSend(original(), deps)(sessionOf(deepseek, snapshot), text, attachments, 'queue')
      if (remote === undefined || snapshot.sessionId === undefined) expect(result.kind).toBe('error')
      expect(asked[0]?.blocked).toBe(blocked)
    }
  })

  it('schedules at peak end and reports where each placement went', async () => {
    for (const [placement, notice] of [
      ['alone', 'Scheduled for 04:00. See or cancel it in Automation tasks.'],
      ['after', 'Queued after the message sending at 04:00.'],
      ['together', 'Added to the message sending at 04:00.'],
    ] as const) {
      const remote = remoteOf({ ok: true, value: [{ id: 'e1', at: '2026-10-12T04:00:00.000Z', text: 'first' }] })
      const { deps, asked } = depsOf({ remote, answer: placement === 'alone' ? { kind: 'schedule', placement } : { kind: 'schedule', placement, earlierId: 'e1' } })
      await expect(gatedSend(original(), deps)(sessionOf(deepseek), 'second', [], 'queue')).resolves.toEqual({ kind: 'success', text: notice })
      expect(asked[0]?.pending).toEqual([{ id: 'e1', at: '2026-10-12T04:00:00.000Z', text: 'first' }])
      expect(remote.defer).toHaveBeenCalledWith({
        sessionId: 's1', text: 'second', at: '2026-10-12T04:00:00.000Z', placement,
        ...placement === 'alone' ? {} : { earlierId: 'e1' },
      })
    }
  })

  it('returns the draft with the reason when scheduling fails or throws', async () => {
    const refused = remoteOf(undefined, { ok: false, error: { message: 'no' } })
    const { deps } = depsOf({ remote: refused, answer: { kind: 'schedule', placement: 'alone' } })
    await expect(gatedSend(original(), deps)(sessionOf(deepseek), 'hi', [], 'queue'))
      .resolves.toEqual({ kind: 'error', text: 'Could not schedule the message: no' })
    for (const thrown of [new Error('boom'), 'plain']) {
      const remote = remoteOf()
      remote.defer.mockRejectedValueOnce(thrown)
      const next = depsOf({ remote, answer: { kind: 'schedule', placement: 'alone' } })
      await expect(gatedSend(original(), next.deps)(sessionOf(deepseek), 'hi', [], 'queue'))
        .resolves.toEqual({ kind: 'error', text: `Could not schedule the message: ${thrown instanceof Error ? thrown.message : thrown}` })
    }
  })

  it('guards only a service that has the send method', () => {
    expect(senderOf({})).toBeUndefined()
    expect(senderOf({ sendSession: 'no' })).toBeUndefined()
    const service = { sendSession: () => Promise.resolve({ kind: 'success' as const }) }
    expect(senderOf(service)).toBe(service)
  })

  it('patches a service and restores an own or a prototype method', async () => {
    const { deps } = depsOf({ now: OFF })
    const own = { sendSession: vi.fn(() => Promise.resolve({ kind: 'success' as const })) }
    const ownOriginal = own.sendSession
    const restoreOwn = installSendGate(own, deps)
    expect(own.sendSession).not.toBe(ownOriginal)
    await (own.sendSession as unknown as SendSession)(sessionOf(deepseek), 'hi', [], 'queue')
    expect(ownOriginal).toHaveBeenCalledOnce()
    restoreOwn()
    expect(own.sendSession).toBe(ownOriginal)
    class Service { sendSession() { return Promise.resolve({ kind: 'success' as const }) } }
    const shared = new Service()
    const restoreShared = installSendGate(shared, deps)
    expect(Object.prototype.hasOwnProperty.call(shared, 'sendSession')).toBe(true)
    restoreShared()
    expect(Object.prototype.hasOwnProperty.call(shared, 'sendSession')).toBe(false)
  })
})

describe('the dialog', () => {
  function show(view: GateView, choose = vi.fn()) {
    const props: SendGateDialogProps = { t, useGate: <R,>(select: (value: GateView) => R): R => select(view), choose } as never
    render(<SendGateDialog {...props} />)
    return choose
  }

  it('renders nothing without a question', () => {
    show(null)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('offers sending, scheduling at peak end, and keeping the draft', () => {
    const choose = show({ model: 'DeepSeek V4', endsAt: Date.now() + 3_600_000, pending: [], blocked: null })
    expect(screen.getByRole('dialog', { name: en['gate.title'] })).toBeTruthy()
    expect(screen.getByText(/DeepSeek V4 is billing peak rates/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /^Schedule for / }))
    fireEvent.click(screen.getByRole('button', { name: en['gate.send'] }))
    // The footer button and the close control both keep the draft.
    for (const button of screen.getAllByRole('button', { name: en['gate.edit'] })) fireEvent.click(button)
    expect(choose.mock.calls).toEqual([
      [{ kind: 'schedule', placement: 'alone' }], [{ kind: 'send' }], [{ kind: 'edit' }], [{ kind: 'edit' }],
    ])
  })

  it('follows or joins the last waiting message, cutting long previews', () => {
    const long = 'x'.repeat(200)
    const choose = show({
      model: 'm', endsAt: Date.now() + 60_000, blocked: null,
      pending: [{ id: 'a', at: new Date().toISOString(), text: 'first' }, { id: 'b', at: new Date().toISOString(), text: long }],
    })
    expect(screen.getByText('first')).toBeTruthy()
    expect(screen.getByText(`${'x'.repeat(140)}…`)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^Schedule for / })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: new RegExp(en['gate.after']) }))
    fireEvent.click(screen.getByRole('button', { name: new RegExp(en['gate.together']) }))
    expect(choose.mock.calls).toEqual([
      [{ kind: 'schedule', placement: 'after', earlierId: 'b' }],
      [{ kind: 'schedule', placement: 'together', earlierId: 'b' }],
    ])
  })

  it('explains why a message cannot be scheduled', () => {
    show({ model: 'm', endsAt: Date.now() + 60_000, pending: [{ id: 'a', at: new Date().toISOString(), text: 'w' }], blocked: 'attachments' })
    expect(screen.getByText(en['gate.noAttachments'])).toBeTruthy()
    expect(screen.queryByRole('button', { name: new RegExp(en['gate.after']) })).toBeNull()
    cleanup()
    show({ model: 'm', endsAt: Date.now() + 60_000, pending: [], blocked: 'unavailable' })
    expect(screen.getByText(en['gate.noSchedule'])).toBeTruthy()
  })
})

describe('plugin wiring', () => {
  async function bench(withPeakSend: boolean, section: Partial<PeakHoursSettings> = { sendGate: true }) {
    const ctx = new Context()
    await ctx.plugin(SlotRegistry).await()
    const slots = ctx.get('slots') as SlotRegistry
    slots.register({ name: 'root', children: {
      'conversation.composer.dock': { kind: 'list', scope: 'session' }, 'shell.overlay': { kind: 'list', scope: 'root' },
    } } as never, () => null)
    ctx.provide('locale', { register: () => () => {}, bind: () => t })
    ctx.provide('configForms', { get: () => ({ getSnapshot: () => ({ value: section }), subscribe: () => () => {} }) })
    const session = { modelCatalog: vi.fn(() => Promise.resolve({ ok: true, value: { default: { provider: 'anthropic', model: 'c' }, groups: [] } })) }
    const peakSend = remoteOf()
    ctx.provide('remote.session', session)
    if (withPeakSend) ctx.provide('remote.peakSend', peakSend)
    ctx.provide('remote', withPeakSend ? { session, peakSend } : { session })
    const conversation = { sendSession: vi.fn(() => Promise.resolve({ kind: 'success' as const })) }
    const original = conversation.sendSession
    ctx.provide('conversation', conversation)
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    return { ctx, slots, fiber, conversation, original, session, peakSend }
  }

  it('guards the conversation send, registers the dialog, and restores both on teardown', async () => {
    const subject = await bench(true)
    expect(subject.conversation.sendSession).not.toBe(subject.original)
    expect(subject.slots.entries('shell.overlay').map(entry => (entry.options as { id: string }).id)).toEqual(['peak-hours.send-gate'])
    const face = (subject.slots.entries('shell.overlay')[0]!.inject as () => { hooks: { gate: { getSnapshot(): GateView } }; choose: (choice: unknown) => void })()
    expect(face.hooks.gate.getSnapshot()).toBeNull()
    face.choose({ kind: 'send' })
    // Off-peak or not, an unguarded default route goes straight through after one catalog read at most.
    await (subject.conversation.sendSession as unknown as SendSession)(sessionOf(null), 'hi', [], 'queue')
    expect(subject.original).toHaveBeenCalledOnce()
    await subject.fiber.dispose()
    expect(subject.conversation.sendSession).toBe(subject.original)
    expect(subject.slots.entries('shell.overlay')).toHaveLength(0)
  })

  it('leaves a conversation service without the send method alone', async () => {
    const ctx = new Context()
    await ctx.plugin(SlotRegistry).await()
    const slots = ctx.get('slots') as SlotRegistry
    slots.register({ name: 'root', children: {
      'conversation.composer.dock': { kind: 'list', scope: 'session' }, 'shell.overlay': { kind: 'list', scope: 'root' },
    } } as never, () => null)
    ctx.provide('locale', { register: () => () => {}, bind: () => t })
    ctx.provide('configForms', { get: () => ({ getSnapshot: () => ({ value: {} }), subscribe: () => () => {} }) })
    ctx.provide('remote.session', {})
    ctx.provide('remote', { session: {} })
    const conversation = { other: 1 }
    ctx.provide('conversation', conversation)
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(conversation).toEqual({ other: 1 })
    await fiber.dispose()
  })

  it('reads the model catalog through the session Remote', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(PEAK)
    try {
      const subject = await bench(false)
      await (subject.conversation.sendSession as unknown as SendSession)(sessionOf(null), 'hi', [], 'queue')
      expect(subject.session.modelCatalog).toHaveBeenCalledOnce()
      subject.session.modelCatalog.mockImplementationOnce(() => Promise.resolve({ ok: false, error: { message: 'x' } }) as never)
      await (subject.conversation.sendSession as unknown as SendSession)(sessionOf(null), 'hi', [], 'queue')
      expect(subject.original).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('schedules a guarded send through the dialog and the mounted namespace', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(PEAK)
    try {
      const subject = await bench(true, { gatedRoutes: ['anthropic'] })
      const sent = (subject.conversation.sendSession as unknown as SendSession)(sessionOf(null), 'later please', [], 'queue')
      const face = () => (subject.slots.entries('shell.overlay')[0]!.inject as () => { hooks: { gate: { getSnapshot(): GateView } }; choose: (choice: unknown) => void })()
      await vi.waitFor(() => { expect(face().hooks.gate.getSnapshot()?.blocked).toBeNull() })
      face().choose({ kind: 'schedule', placement: 'alone' })
      const answer = await sent
      expect(answer.kind).toBe('success')
      expect((answer as { text?: string }).text).toMatch(/^Scheduled for /)
      expect(subject.peakSend.defer).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 's1', text: 'later please', placement: 'alone' }))
      expect(subject.original).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})
