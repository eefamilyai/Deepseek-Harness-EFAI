// @vitest-environment jsdom
/**
 * The appearance policy.
 *
 * This is where the operator's bug lived. A control wrote the row, the profile kept the
 * value, and the page and the field stayed as they were, because both read the row's own
 * echo - which does not arrive. The policy owns the live value instead: a setter moves its
 * store and the engine repaints in the same step, and the row's answer is adopted whenever
 * it comes.
 */
import { describe, expect, it, vi } from 'vitest'
import type { AppearanceValues } from '../src/client/appearance.ts'
import { APPEARANCE_DEFAULTS } from '../src/client/appearance.ts'
import { AppearancePolicy } from '../src/client/appearance-store.ts'

type Fields = Partial<AppearanceValues>

/** A stand-in row form: records writes, and can answer with a value of its own. */
function rowForm(value: Fields = {}) {
  const listeners = new Set<() => void>()
  const set = vi.fn(async (field: string, next: unknown) => {
    value = { ...value, [field]: next } as Fields
    for (const listener of listeners) listener()
  })
  return {
    set,
    handle: {
      getSnapshot: () => ({ status: 'ready' as const, value, base: undefined, user: value, revision: 1, writable: true, mode: 'host' as const }),
      subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
      set,
      mutate: vi.fn(async () => true),
      unset: vi.fn(async () => true),
    },
    answer(next: Fields): void {
      value = next
      for (const listener of listeners) listener()
    },
  }
}

describe('the appearance policy', () => {
  it('moves its own store the moment a control writes', () => {
    // The regression: this used to update only after the row echoed, so clicking a preset
    // changed the profile and nothing else.
    const form = rowForm()
    const policy = new AppearancePolicy(form.handle as never)
    policy.setSurfaceOpacity(65)
    expect(policy.surfaceOpacity.getSnapshot()).toBe(65)
    expect(policy.values().surfaceOpacity).toBe(65)
    // And it still tells the row, so the choice is durable.
    expect(form.set).toHaveBeenCalledWith('surfaceOpacity', 65)
  })

  it('paints from its own store even when the row never answers', () => {
    const policy = new AppearancePolicy(undefined)
    const seen: number[] = []
    policy.subscribe(() => { seen.push(policy.shellOpacity.getSnapshot()) })
    policy.setShellOpacity(35)
    policy.setShellOpacity(45)
    expect(seen).toEqual([35, 45])
  })

  it('publishes the value even when the row refuses the write', () => {
    // A field the loaded schema does not have, or a transport that is momentarily gone:
    // the gesture still changes this window, and durability follows when the row answers.
    const refusing = {
      getSnapshot: () => ({ status: 'ready' as const, value: undefined, base: undefined, user: undefined, revision: 1, writable: true, mode: 'host' as const }),
      subscribe: () => () => {},
      set: () => { throw new Error('the row rejected the field') },
      mutate: async () => true,
      unset: async () => true,
    }
    const policy = new AppearancePolicy(refusing as never)
    // The row throws, and the gesture still lands here first: that ordering is the fix.
    expect(() => { policy.setPanelOpacity(65) }).toThrow('the row rejected the field')
    expect(policy.panelOpacity.getSnapshot()).toBe(65)
    expect(policy.values().panelOpacity).toBe(65)
  })

  it('keeps a refused choice instead of letting the row undo it', async () => {
    // The row does not have the field yet (a schema loaded before it existed). The control
    // must stay where it was put, and the row's own value must not pull it back.
    const listeners = new Set<() => void>()
    const row = {
      getSnapshot: () => ({ status: 'ready' as const, value: { panelOpacity: 100 }, base: undefined, user: {}, revision: 1, writable: true, mode: 'host' as const }),
      subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
      set: () => Promise.reject(new Error('unknown field')),
      mutate: async () => true,
      unset: async () => true,
    }
    const policy = new AppearancePolicy(row as never)
    expect(policy.panelOpacity.getSnapshot()).toBe(100)
    policy.setPanelOpacity(65)
    await Promise.resolve()
    // The row published its own document again; the pending field keeps the operator's value.
    for (const listener of listeners) listener()
    expect(policy.panelOpacity.getSnapshot()).toBe(65)
  })

  it('publishes the value when the write fails asynchronously', () => {
    const rejecting = {
      getSnapshot: () => ({ status: 'ready' as const, value: undefined, base: undefined, user: undefined, revision: 1, writable: true, mode: 'host' as const }),
      subscribe: () => () => {},
      set: () => Promise.reject(new Error('transport unavailable')),
      mutate: async () => true,
      unset: async () => true,
    }
    const policy = new AppearancePolicy(rejecting as never)
    policy.setShellOpacity(35)
    expect(policy.shellOpacity.getSnapshot()).toBe(35)
  })

  it('does not repaint when a control writes the value it already has', () => {
    const policy = new AppearancePolicy(rowForm({ shellOpacity: 35 }).handle as never)
    let invalidations = 0
    policy.subscribe(() => { invalidations += 1 })
    policy.setShellOpacity(35)
    expect(invalidations).toBe(0)
  })

  it('adopts the row, including a value the first build stored as a fraction', () => {
    const form = rowForm({ shellOpacity: 0.65, fontFamily: 'Inter, sans-serif' })
    const policy = new AppearancePolicy(form.handle as never)
    expect(policy.shellOpacity.getSnapshot()).toBe(65)
    expect(policy.fontFamily.getSnapshot()).toBe('Inter, sans-serif')
    // A change made elsewhere reaches this window too.
    form.answer({ shellOpacity: 80 })
    expect(policy.shellOpacity.getSnapshot()).toBe(80)
  })

  it('restores every default at once', () => {
    const policy = new AppearancePolicy(rowForm().handle as never)
    policy.setShellOpacity(35)
    policy.setPanelOpacity(45)
    policy.reset()
    expect(policy.values()).toEqual(APPEARANCE_DEFAULTS)
  })

  it('stops following the row once disposed', () => {
    const form = rowForm()
    const policy = new AppearancePolicy(form.handle as never)
    policy.dispose()
    form.answer({ shellOpacity: 20 })
    expect(policy.shellOpacity.getSnapshot()).toBe(100)
  })
})
