// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { apply, inject } from '../src/client/index.ts'
import { en, NS, zh } from '../src/client/locales.ts'
import { PeakPill, describe as describeView, formatRemaining, type PeakPillProps } from '../src/client/PeakPill.tsx'
import { showNotification, transitionOf, type NotificationApi } from '../src/client/notify.ts'
import {
  DEFAULT_SETTINGS, peakView, sameView, settingsFrom, splitDuration, type PeakHoursSettings, type PeakView,
} from '../src/client/view.ts'

const DOCK = 'conversation.composer.dock'
const MINUTE = 60_000
const at = (iso: string): number => Date.parse(iso)

/** English translate with `{name}` interpolation, standing in for the locale service. */
const t = ((key: keyof typeof en, params?: Record<string, unknown>) =>
  en[key].replace(/\{(\w+)\}/g, (_, name: string) => {
    const value = params?.[name]
    return typeof value === 'string' || typeof value === 'number' ? String(value) : ''
  })) as PeakPillProps['t']

/** A minimal configForms entry over a mutable section. */
function form(initial: Partial<PeakHoursSettings> | undefined) {
  let value = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => ({ value }),
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    change(next: Partial<PeakHoursSettings>) {
      value = next
      for (const listener of listeners) listener()
    },
    listeners,
  }
}

async function bench(section: Partial<PeakHoursSettings> | undefined = {}) {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const slots = ctx.get('slots') as SlotRegistry
  const disposeDock = slots.register({ name: 'root', children: {
    [DOCK]: { kind: 'list', scope: 'session' }, 'shell.overlay': { kind: 'list', scope: 'root' },
  } } as never, () => null)
  const session = { modelCatalog: () => Promise.resolve({ ok: false, error: { message: 'none' } }) }
  ctx.provide('remote.session', session)
  ctx.provide('remote', { session })
  const settings = form(section)
  const registered: string[] = []
  ctx.provide('locale', {
    register(namespace: string) {
      registered.push(namespace)
      return () => { registered.splice(registered.indexOf(namespace), 1) }
    },
    bind: () => t,
  })
  ctx.provide('configForms', { get: (id: string) => (id === 'ui-peak-hours' ? settings : undefined) })
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  return { ctx, slots, fiber, settings, registered, disposeDock }
}

function pillProps(view: PeakView): PeakPillProps {
  const usePeak = <R,>(select: (value: PeakView) => R): R => select(view)
  return { usePeak, t } as PeakPillProps
}

type Permission = 'default' | 'denied' | 'granted'

/** A Notification constructor stand-in recording what it shows. */
type Shown = Array<{ title: string; body: string | undefined }>

function fakeNotifications(permission: Permission, answer: Permission, shown: Shown): NotificationApi {
  return class {
    static permission = permission
    static requestPermission = vi.fn(() => Promise.resolve(answer))
    constructor(title: string, options?: { body?: string }) {
      shown.push({ title, body: options?.body })
    }
  }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('peak view', () => {
  it('reads peak, the lead warning, off-peak, and hidden from the clock and settings', () => {
    expect(peakView(DEFAULT_SETTINGS, at('2026-10-13T02:00:00Z'))).toMatchObject({ kind: 'peak', remainingMs: 2 * 60 * MINUTE })
    expect(peakView(DEFAULT_SETTINGS, at('2026-10-13T05:50:00Z'))).toMatchObject({ kind: 'soon', remainingMs: 10 * MINUTE })
    expect(peakView(DEFAULT_SETTINGS, at('2026-10-13T05:00:00Z'))).toMatchObject({ kind: 'off-peak', reason: 'hours', holiday: null })
    expect(peakView(DEFAULT_SETTINGS, at('2026-10-05T02:00:00Z')))
      .toMatchObject({ kind: 'off-peak', reason: 'holiday', holiday: 'National Day' })
    expect(peakView({ ...DEFAULT_SETTINGS, enabled: false }, at('2026-10-13T02:00:00Z'))).toEqual({ kind: 'hidden' })
    expect(peakView({ ...DEFAULT_SETTINGS, showOffPeak: false }, at('2026-10-13T05:00:00Z'))).toEqual({ kind: 'hidden' })
    // The lead warning shows even with the off-peak reading switched off.
    expect(peakView({ ...DEFAULT_SETTINGS, showOffPeak: false }, at('2026-10-13T05:50:00Z'))).toMatchObject({ kind: 'soon' })
    expect(peakView({ ...DEFAULT_SETTINGS, warnBeforeMinutes: 0 }, at('2026-10-13T05:50:00Z'))).toMatchObject({ kind: 'off-peak' })
    expect(peakView({ ...DEFAULT_SETTINGS, weekdays: [] }, at('2026-10-13T05:50:00Z')))
      .toMatchObject({ kind: 'off-peak', nextPeakAt: null, remainingMs: null })
  })

  it('reports an unusable schedule instead of guessing', () => {
    expect(peakView({ ...DEFAULT_SETTINGS, windows: [{ start: '9', end: '10:00' }] }, 0)).toEqual({
      kind: 'invalid', problems: ['windows[0].start "9" is not HH:MM'],
    })
  })

  it('treats readings in the same countdown minute as unchanged', () => {
    const a = peakView(DEFAULT_SETTINGS, at('2026-10-13T02:00:10Z'))
    const b = peakView(DEFAULT_SETTINGS, at('2026-10-13T02:00:40Z'))
    const c = peakView(DEFAULT_SETTINGS, at('2026-10-13T02:01:10Z'))
    expect(sameView(a, b)).toBe(true)
    expect(sameView(a, c)).toBe(false)
    expect(sameView({ kind: 'hidden' }, { kind: 'hidden' })).toBe(true)
    expect(sameView({ kind: 'hidden' }, a)).toBe(false)
  })

  it('splits durations rounding up and fills missing settings from the defaults', () => {
    expect(splitDuration(1)).toEqual({ days: 0, hours: 0, minutes: 1 })
    expect(splitDuration(0)).toEqual({ days: 0, hours: 0, minutes: 1 })
    expect(splitDuration((26 * 60 + 5) * MINUTE)).toEqual({ days: 1, hours: 2, minutes: 5 })
    expect(settingsFrom(undefined)).toEqual(DEFAULT_SETTINGS)
    expect(settingsFrom({ warnBeforeMinutes: 30 }).warnBeforeMinutes).toBe(30)
  })
})

describe('peak pill', () => {
  it('formats countdowns at day, hour, and minute scale', () => {
    expect(formatRemaining(5 * MINUTE, t)).toBe('5m')
    expect(formatRemaining(80 * MINUTE, t)).toBe('1h 20m')
    expect(formatRemaining((49 * 60) * MINUTE, t)).toBe('2d 1h')
  })

  it('renders each reading with its label and state', () => {
    vi.setSystemTime(at('2026-10-13T02:00:00Z'))
    const peak = render(<PeakPill {...pillProps(peakView(DEFAULT_SETTINGS, Date.now()))} />)
    expect(screen.getByRole('status').textContent).toBe('DeepSeek peak 2× · 2h 0m left')
    expect(screen.getByRole('status').getAttribute('data-peak-hours')).toBe('peak')
    peak.unmount()

    render(<PeakPill {...pillProps(peakView(DEFAULT_SETTINGS, at('2026-10-13T05:50:00Z')))} />)
    expect(screen.getByRole('status').textContent).toBe('DeepSeek peak 2× in 10m')
    cleanup()

    render(<PeakPill {...pillProps(peakView(DEFAULT_SETTINGS, at('2026-10-13T05:00:00Z')))} />)
    expect(screen.getByRole('status').textContent).toBe('DeepSeek off-peak · peak in 1h 0m')
    cleanup()

    render(<PeakPill {...pillProps({ kind: 'invalid', problems: ['x'] })} />)
    expect(screen.getByRole('status').textContent).toBe('Peak schedule invalid')
    cleanup()

    const hidden = render(<PeakPill {...pillProps({ kind: 'hidden' })} />)
    expect(hidden.container.innerHTML).toBe('')
  })

  it('explains the reading and the schedule in the tooltip', () => {
    vi.setSystemTime(at('2026-10-13T02:00:00Z'))
    expect(describeView(peakView(DEFAULT_SETTINGS, Date.now()), t).tip)
      .toMatch(/^The DeepSeek API is billing peak rates \(2× off-peak\) until .+\. Weekday peak hours in your time: .+–.+, .+–.+\./)
    expect(describeView(peakView(DEFAULT_SETTINGS, at('2026-10-05T02:00:00Z')), t).tip)
      .toMatch(/^National Day \(Chinese public holiday\): the DeepSeek API bills off-peak rates all day\. Next peak: /)
    expect(describeView(peakView(DEFAULT_SETTINGS, at('2026-10-10T02:00:00Z')), t).tip).toMatch(/^Weekend: /)
    expect(describeView(peakView(DEFAULT_SETTINGS, at('2026-10-13T05:00:00Z')), t).tip)
      .toMatch(/^The DeepSeek API is billing off-peak rates\. Next peak: /)
    expect(describeView(peakView(DEFAULT_SETTINGS, at('2026-10-13T05:50:00Z')), t).tip)
      .toMatch(/^The DeepSeek API starts billing peak rates/)
    const none = describeView(peakView({ ...DEFAULT_SETTINGS, weekdays: [] }, 0), t)
    expect(none).toMatchObject({ label: 'DeepSeek off-peak' })
    expect(none.tip).toMatch(/^No peak period within the next month\./)
    expect(describeView({ kind: 'invalid', problems: ['a', 'b'] }, t).tip).toBe('Cannot tell peak hours apart: a; b')
  })
})

describe('notifications', () => {
  it('fires on entering the lead warning and on entering peak only', () => {
    const off: PeakView = { kind: 'off-peak', reason: 'hours', holiday: null, nextPeakAt: 0, remainingMs: 0, windows: [] }
    const soon: PeakView = { kind: 'soon', startsAt: 0, remainingMs: 0, windows: [] }
    const peak: PeakView = { kind: 'peak', endsAt: 0, remainingMs: 0, windows: [] }
    expect(transitionOf(off, soon)).toBe('soon')
    expect(transitionOf(soon, peak)).toBe('peak')
    expect(transitionOf(off, peak)).toBe('peak')
    expect(transitionOf(soon, soon)).toBeNull()
    expect(transitionOf(peak, peak)).toBeNull()
    expect(transitionOf(peak, soon)).toBeNull()
    expect(transitionOf(peak, off)).toBeNull()
  })

  it('asks for permission once undecided and shows nothing when refused or missing', async () => {
    const shown: Shown = []
    const make = (permission: Permission, answer: Permission = permission) => fakeNotifications(permission, answer, shown)
    await showNotification(undefined, 'none', '')
    await showNotification(make('denied'), 'denied', '')
    await showNotification(make('default', 'denied'), 'refused', '')
    await showNotification(make('default', 'granted'), 'asked', '')
    await showNotification(make('granted'), 'granted', '')
    expect(shown.map(entry => entry.title)).toEqual(['asked', 'granted'])
  })
})

describe('browser plugin', () => {
  it('declares the services it reads', () => {
    expect(inject).toEqual(['slots', 'locale', 'configForms', 'remote', 'remote.session'])
  })

  it('registers the pill in the composer dock with its dictionaries and removes both on teardown', async () => {
    const subject = await bench()
    expect(subject.registered).toEqual([NS])
    expect(subject.slots.entries(DOCK).map(entry => entry.options.id)).toEqual(['peak-hours'])
    expect(subject.settings.listeners.size).toBe(1)
    await subject.fiber.dispose()
    expect(subject.slots.entries(DOCK)).toHaveLength(0)
    expect(subject.registered).toEqual([])
    expect(subject.settings.listeners.size).toBe(0)
  })

  it('follows the dock declaration when it collapses and returns', async () => {
    const subject = await bench()
    subject.disposeDock()
    expect(subject.slots.entries(DOCK)).toHaveLength(0)
    subject.slots.register({ name: 'root', children: { [DOCK]: { kind: 'list', scope: 'session' } } } as never, () => null)
    await Promise.resolve()
    expect(subject.slots.entries(DOCK)).toHaveLength(1)
  })

  it('keeps the reading current with the clock and the settings, and notifies at transitions', async () => {
    const shown: Shown = []
    vi.stubGlobal('Notification', fakeNotifications('granted', 'granted', shown))
    vi.setSystemTime(at('2026-10-13T05:40:00Z'))
    const subject = await bench()
    const store = () => {
      const entry = subject.slots.entries(DOCK)[0]!
      const injected = (entry.inject as () => { hooks: { peak: { getSnapshot(): PeakView } } })()
      return injected.hooks.peak.getSnapshot()
    }
    expect(store().kind).toBe('off-peak')

    vi.setSystemTime(at('2026-10-13T05:46:00Z'))
    vi.advanceTimersByTime(15_000)
    expect(store().kind).toBe('soon')
    await Promise.resolve()
    expect(shown.map(entry => entry.title)).toEqual(['DeepSeek peak pricing soon'])

    vi.setSystemTime(at('2026-10-13T06:00:00Z'))
    vi.advanceTimersByTime(15_000)
    expect(store().kind).toBe('peak')
    await Promise.resolve()
    expect(shown.map(entry => entry.title)).toEqual(['DeepSeek peak pricing soon', 'DeepSeek peak pricing started'])

    // A same-minute tick keeps the published snapshot.
    const before = store()
    vi.advanceTimersByTime(15_000)
    expect(store()).toBe(before)

    subject.settings.change({ enabled: false })
    expect(store()).toEqual({ kind: 'hidden' })

    // Re-enabled with notifications off, still inside the same peak period.
    subject.settings.change({ notify: false })
    expect(store().kind).toBe('peak')

    // A hidden window keeps its reading; showing it again catches up with the clock.
    vi.setSystemTime(at('2026-10-13T12:00:00Z'))
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
    document.dispatchEvent(new Event('visibilitychange'))
    expect(store().kind).toBe('peak')
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
    document.dispatchEvent(new Event('visibilitychange'))
    expect(store().kind).toBe('off-peak')

    // With notifications off, the next peak updates the pill silently.
    vi.setSystemTime(at('2026-10-14T01:00:00Z'))
    vi.advanceTimersByTime(15_000)
    expect(store().kind).toBe('peak')
    await Promise.resolve()
    expect(shown).toHaveLength(2)

    await subject.fiber.dispose()
    vi.unstubAllGlobals()
  })

  it('ships complete dictionaries in both languages', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
  })
})
