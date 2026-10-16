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
import { APPEARANCE_DEFAULTS, type AppearanceValues } from '../src/options.ts'
import { AppearancePolicy } from '../src/client/appearance-store.ts'

type Fields = Partial<AppearanceValues>

/** A stand-in row form: records writes, and can answer with a value of its own. */
function rowForm(value: Fields = {}, status: 'loading' | 'ready' | 'unavailable' = 'ready') {
  const listeners = new Set<() => void>()
  const set = vi.fn(async (field: string, next: unknown) => {
    value = { ...value, [field]: next }
    for (const listener of listeners) listener()
    return true
  })
  return {
    set,
    handle: {
      getSnapshot: () => ({ status, value, base: undefined, user: value, revision: 1, writable: true, mode: 'host' as const }),
      subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
      set,
      mutate: vi.fn(async () => true),
      unset: vi.fn(async () => true),
    },
    answer(next: Fields): void {
      value = next
      for (const listener of listeners) listener()
    },
    settle(next: 'ready' | 'unavailable'): void {
      status = next
      for (const listener of listeners) listener()
    },
  }
}

describe('the appearance policy', () => {
  it('follows whether the Host serves the row', () => {
    // The regression: the section decided this from whether a form object existed,
    // which it always does, so a deployment without the row showed dead controls.
    const form = rowForm({}, 'loading')
    const policy = new AppearancePolicy(form.handle)
    expect(policy.rowStatus.getSnapshot()).toBe('loading')
    form.settle('unavailable')
    expect(policy.rowStatus.getSnapshot()).toBe('unavailable')
    form.settle('ready')
    expect(policy.rowStatus.getSnapshot()).toBe('ready')
    expect(new AppearancePolicy(undefined).rowStatus.getSnapshot()).toBe('unavailable')
  })

  it('moves its own store the moment a control writes', () => {
    // The regression: this used to update only after the row echoed, so clicking a preset
    // changed the profile and nothing else.
    const form = rowForm()
    const policy = new AppearancePolicy(form.handle)
    policy.set('surfaceOpacity', 65)
    expect(policy.values().surfaceOpacity).toBe(65)
    expect(policy.values().surfaceOpacity).toBe(65)
    // And it still tells the row, so the choice is durable.
    expect(form.set).toHaveBeenCalledWith('surfaceOpacity', 65)
  })

  it('paints from its own store even when the row never answers', () => {
    const policy = new AppearancePolicy(undefined)
    const seen: number[] = []
    policy.subscribe(() => { seen.push(policy.values().shellOpacity) })
    policy.set('shellOpacity', 35)
    policy.set('shellOpacity', 45)
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
    const policy = new AppearancePolicy(refusing)
    // The row throws, and the gesture still lands here first: that ordering is the fix.
    expect(() => { policy.set('panelOpacity', 65) }).toThrow('the row rejected the field')
    expect(policy.values().panelOpacity).toBe(65)
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
    const policy = new AppearancePolicy(row)
    expect(policy.values().panelOpacity).toBe(100)
    policy.set('panelOpacity', 65)
    await Promise.resolve()
    // The row published its own document again; the pending field keeps the operator's value.
    for (const listener of listeners) listener()
    expect(policy.values().panelOpacity).toBe(65)
  })

  it('publishes the value when the write fails asynchronously', () => {
    const rejecting = {
      getSnapshot: () => ({ status: 'ready' as const, value: undefined, base: undefined, user: undefined, revision: 1, writable: true, mode: 'host' as const }),
      subscribe: () => () => {},
      set: () => Promise.reject(new Error('transport unavailable')),
      mutate: async () => true,
      unset: async () => true,
    }
    const policy = new AppearancePolicy(rejecting)
    policy.set('shellOpacity', 35)
    expect(policy.values().shellOpacity).toBe(35)
  })

  it('does not repaint when a control writes the value it already has', () => {
    const policy = new AppearancePolicy(rowForm({ shellOpacity: 35 }).handle)
    let invalidations = 0
    policy.subscribe(() => { invalidations += 1 })
    policy.set('shellOpacity', 35)
    expect(invalidations).toBe(0)
  })

  it('adopts the row, including a value the first build stored as a fraction', () => {
    const form = rowForm({ shellOpacity: 0.65, fontFamily: 'Inter, sans-serif' })
    const policy = new AppearancePolicy(form.handle)
    expect(policy.values().shellOpacity).toBe(65)
    expect(policy.values().fontFamily).toBe('Inter, sans-serif')
    // A change made elsewhere reaches this window too.
    form.answer({ shellOpacity: 80 })
    expect(policy.values().shellOpacity).toBe(80)
  })

  it('restores every default at once', () => {
    const policy = new AppearancePolicy(rowForm().handle)
    policy.set('shellOpacity', 35)
    policy.set('panelOpacity', 45)
    policy.reset()
    expect(policy.values()).toEqual(APPEARANCE_DEFAULTS)
  })

  it('stops following the row once disposed', () => {
    const form = rowForm()
    const policy = new AppearancePolicy(form.handle)
    policy.dispose()
    form.answer({ shellOpacity: 20 })
    expect(policy.values().shellOpacity).toBe(100)
  })
})

describe('the save state and the coupled choices', () => {
  it('reports a field the row refused, and clears it once a later write is accepted', async () => {
    let accept = false
    const row = {
      getSnapshot: () => ({ status: 'ready' as const, value: {}, base: undefined, user: {}, revision: 1, writable: true, mode: 'host' as const }),
      subscribe: () => () => {},
      set: vi.fn(async () => accept),
      mutate: async () => true,
      unset: async () => true,
    }
    const policy = new AppearancePolicy(row)
    policy.set('backdropImage', 'https://example.com/a.jpg')
    await Promise.resolve()
    await Promise.resolve()
    expect(policy.saveState.getSnapshot().refused).toEqual(['backdropImage'])
    accept = true
    policy.set('backdropImage', 'https://example.com/b.jpg')
    await Promise.resolve()
    await Promise.resolve()
    expect(policy.saveState.getSnapshot().refused).toEqual([])
  })

  it('settles a field by its latest write only', async () => {
    const answers: ((accepted: boolean) => void)[] = []
    const row = {
      getSnapshot: () => ({ status: 'ready' as const, value: {}, base: undefined, user: {}, revision: 1, writable: true, mode: 'host' as const }),
      subscribe: () => () => {},
      set: vi.fn(() => new Promise<boolean>((resolve) => { answers.push(resolve) })),
      mutate: async () => true,
      unset: async () => true,
    }
    const policy = new AppearancePolicy(row)
    policy.set('glassBlur', 16)
    policy.set('glassBlur', 64)
    answers[1]?.(true)
    answers[0]?.(false)
    await Promise.resolve()
    await Promise.resolve()
    // The older write's refusal arrives last and does not speak for the field.
    expect(policy.saveState.getSnapshot().refused).toEqual([])
    expect(policy.values().glassBlur).toBe(64)
  })

  it('lowers solid layers when a backdrop is chosen, so the backdrop can be seen', () => {
    const form = rowForm()
    const policy = new AppearancePolicy(form.handle)
    policy.set('backdrop', 'aurora')
    expect(policy.values()).toMatchObject({ backdrop: 'aurora', shellOpacity: 80, surfaceOpacity: 80 })
    expect(form.set).toHaveBeenCalledWith('shellOpacity', 80)
    expect(form.set).toHaveBeenCalledWith('surfaceOpacity', 80)
  })

  it('keeps the layers the operator already made translucent', () => {
    const policy = new AppearancePolicy(rowForm({ surfaceOpacity: 65 }).handle)
    policy.set('backdrop', 'ocean')
    expect(policy.values()).toMatchObject({ backdrop: 'ocean', shellOpacity: 100, surfaceOpacity: 65 })
    policy.set('backdrop', 'none')
    expect(policy.values().surfaceOpacity).toBe(65)
  })

  it('rounds percentage fields to whole numbers', () => {
    const policy = new AppearancePolicy(undefined)
    policy.set('fontScale', 112.4)
    policy.set('lineHeight', 119.6)
    expect(policy.values()).toMatchObject({ fontScale: 112, lineHeight: 120 })
  })
})
