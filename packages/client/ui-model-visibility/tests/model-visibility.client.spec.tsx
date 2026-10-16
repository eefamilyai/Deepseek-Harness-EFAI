// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { Config as HostConfig, apply as hostApply, inject as hostInject } from '../src/index.ts'
import { apply, inject } from '../src/client/index.ts'
import { en, NS, zh } from '../src/client/locales.ts'
import { providerRows, toggled, type VisibilityView } from '../src/client/model.ts'
import { VisibilityList, type VisibilityListProps } from '../src/client/VisibilityList.tsx'
import { ProviderCardSwitch, type CardVisibility, type ProviderCardSwitchProps } from '../src/client/ProviderCardSwitch.tsx'

const FOOTER = 'settings.models.footer'
const CARD = 'settings.models.provider-card'

const t = ((key: keyof typeof en, params?: Record<string, unknown>) =>
  en[key].replace(/\{(\w+)\}/g, (_, name: string) => {
    const value = params?.[name]
    return typeof value === 'string' ? value : ''
  })) as VisibilityListProps['t']

afterEach(() => { cleanup() })

describe('the host half', () => {
  const llm = () => ({
    providers: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }],
    listProviders() { return this.providers.map(provider => ({ ...provider })) },
  })

  it('leaves hidden providers out of the list while mounted, reading the hidden set on every call', async () => {
    const ctx = new Context()
    const service = llm()
    ctx.provide('llm', service as never)
    const fiber = ctx.plugin({ name: 'model-visibility', inject: hostInject, Config: HostConfig, apply: hostApply }, { hidden: [{ id: 'b', name: 'B' }] })
    await fiber.await()
    expect(service.listProviders().map(provider => provider.id)).toEqual(['a'])
    await fiber.dispose()
    expect(service.listProviders().map(provider => provider.id)).toEqual(['a', 'b'])
    expect(Object.prototype.hasOwnProperty.call(service, 'listProviders')).toBe(true)
  })

  it('restores a prototype method by removing its own override', async () => {
    class Registry {
      listProviders() { return [{ id: 'a', name: 'A' }] }
    }
    const ctx = new Context()
    const service = new Registry()
    ctx.provide('llm', service as never)
    const fiber = ctx.plugin({ name: 'model-visibility', inject: hostInject, Config: HostConfig, apply: hostApply }, { hidden: [{ id: 'a' }] })
    await fiber.await()
    expect(service.listProviders()).toEqual([])
    await fiber.dispose()
    expect(Object.prototype.hasOwnProperty.call(service, 'listProviders')).toBe(false)
    expect(service.listProviders()).toEqual([{ id: 'a', name: 'A' }])
  })
})

describe('the list model', () => {
  it('merges catalog providers with hidden ones and marks each', () => {
    expect(providerRows([{ id: 'a', name: 'A' }, { id: 'a', name: 'A' }, { id: 'c', name: 'C' }],
      [{ id: 'b', name: 'B' }, { id: 'c', name: 'C' }, { id: 'd', name: '' }, { id: 'b', name: 'B' }])).toEqual([
      { id: 'a', name: 'A', hidden: false },
      { id: 'c', name: 'C', hidden: true },
      { id: 'b', name: 'B', hidden: true },
      { id: 'd', name: 'd', hidden: true },
    ])
  })

  it('adds or removes one provider from the hidden list', () => {
    expect(toggled([{ id: 'x', name: 'X' }], { id: 'a', name: 'A' }, false)).toEqual([{ id: 'x', name: 'X' }, { id: 'a', name: 'A' }])
    expect(toggled([{ id: 'a', name: 'A' }, { id: 'x', name: 'X' }], { id: 'a', name: 'A' }, true)).toEqual([{ id: 'x', name: 'X' }])
  })

  it('ships complete dictionaries', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
  })
})

/** Render the list over fixed values. */
function show(view: VisibilityView, saveFailed = false, setVisible = vi.fn()) {
  const props = {
    t,
    useVisibility: <R,>(select: (value: VisibilityView) => R): R => select(view),
    useSaveFailed: <R,>(select: (value: boolean) => R): R => select(saveFailed),
    setVisible,
  } as VisibilityListProps
  render(<VisibilityList {...props} />)
  return setVisible
}

describe('the list', () => {
  it('shows a switch per provider, on when visible, and reports a switch', () => {
    const setVisible = show({ kind: 'ready', writable: true, rows: [{ id: 'a', name: 'A', hidden: false }, { id: 'b', name: 'B', hidden: true }] })
    const a = screen.getByRole('switch', { name: 'Show A in the model picker' })
    const b = screen.getByRole('switch', { name: 'Show B in the model picker' })
    expect(a.getAttribute('aria-checked')).toBe('true')
    expect(b.getAttribute('aria-checked')).toBe('false')
    expect(screen.getByText('Hidden')).toBeTruthy()
    fireEvent.click(a)
    expect(setVisible).toHaveBeenCalledWith({ id: 'a', name: 'A', hidden: false }, false)
  })

  it('locks the switches of a read-only row and reports each other state', () => {
    show({ kind: 'ready', writable: false, rows: [{ id: 'a', name: 'A', hidden: false }] }, true)
    expect(screen.getByRole('switch').hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('alert').textContent).toBe(en.saveFailed)
    cleanup()
    for (const [view, text] of [
      [{ kind: 'loading' }, en.loading],
      [{ kind: 'unavailable' }, en.unavailable],
      [{ kind: 'error', message: 'down' }, 'Could not read providers: down'],
      [{ kind: 'ready', writable: true, rows: [] }, en.empty],
    ] as const) {
      show(view)
      expect(screen.getByText(text)).toBeTruthy()
      cleanup()
    }
  })
})

/** A settings form over a mutable section. */
function form(status: 'loading' | 'ready' | 'unavailable', hidden: { id: string; name: string }[] = []) {
  let snapshot = { status, value: { hidden }, writable: true }
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    set: vi.fn((field: string, value: unknown) => {
      snapshot = { ...snapshot, status: 'ready', value: { ...snapshot.value, [field]: value } }
      for (const listener of listeners) listener()
      return Promise.resolve(field !== 'refuse')
    }),
    settle(next: typeof status) { snapshot = { ...snapshot, status: next }; for (const listener of listeners) listener() },
  }
}

type Directory = () => Promise<unknown>
const directoryOf = (...namespaces: string[]): Directory =>
  () => Promise.resolve({ ok: true, value: namespaces.map(settingsNs => ({ settingsNs })) })

async function bench(settings: ReturnType<typeof form>, catalog: () => Promise<unknown>, directory: Directory = directoryOf('llm-pi-ai')) {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const slots = ctx.get('slots') as SlotRegistry
  slots.register({ name: 'root', children: {
    [FOOTER]: { kind: 'list', scope: 'root' }, [CARD]: { kind: 'keyed', scope: 'root' },
  } } as never, () => null)
  const listeners = new Map<string, Set<() => void>>()
  const handlers = {
    get: (event: string) => () => { for (const handler of listeners.get(event) ?? []) handler() },
    get size() { return [...listeners.values()].reduce((sum, set) => sum + set.size, 0) },
  }
  ctx.provide('locale', { register: () => () => {}, bind: () => t })
  ctx.provide('configForms', { get: () => settings })
  ctx.provide('remote.session', { modelCatalog: catalog })
  ctx.provide('remote.llm', { listConfigurableProviders: directory })
  ctx.provide('remote', {
    session: { modelCatalog: catalog },
    llm: { listConfigurableProviders: directory },
    $on: (event: string, handler: () => void) => {
      const set = listeners.get(event) ?? new Set()
      listeners.set(event, set.add(handler))
      return () => { set.delete(handler) }
    },
  })
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  type Face = {
    hooks: { visibility: { getSnapshot(): VisibilityView }; saveFailed: { getSnapshot(): boolean } }
    setVisible: (row: { id: string; name: string }, visible: boolean) => void
  }
  type CardFace = {
    hooks: { cardVisibility: { getSnapshot(): CardVisibility } }
    carded: (id: string) => () => void
  }
  const face = () => (slots.entries(FOOTER)[0]!.inject as () => Face)()
  const card = () => (slots.entries(CARD)[0]!.inject as () => CardFace)()
  const keys = () => slots.entries(CARD).map(entry => (entry.options as { key: string }).key)
  return { fiber, slots, handlers, face, card, keys, view: () => face().hooks.visibility.getSnapshot() }
}

const catalogOf = (groups: { id: string; name: string }[], failures: { id: string; name: string }[] = []) =>
  () => Promise.resolve({ ok: true, value: { groups, failures } })

describe('the browser plugin', () => {
  it('declares its services', () => {
    expect(inject).toEqual(['slots', 'locale', 'configForms', 'remote', 'remote.session', 'remote.llm'])
  })

  it('lists catalog and hidden providers, writes a switch, and reloads on settings and provider events', async () => {
    const settings = form('ready', [{ id: 'hidden', name: 'Hidden one' }])
    const catalog = vi.fn(catalogOf([{ id: 'a', name: 'A' }], [{ id: 'broken', name: 'Broken' }]))
    const subject = await bench(settings, catalog)
    await vi.waitFor(() => { expect(subject.view().kind).toBe('ready') })
    expect(subject.view()).toEqual({ kind: 'ready', writable: true, rows: [
      { id: 'a', name: 'A', hidden: false },
      { id: 'broken', name: 'Broken', hidden: false },
      { id: 'hidden', name: 'Hidden one', hidden: true },
    ] })
    subject.face().setVisible({ id: 'a', name: 'A' }, false)
    expect(settings.set).toHaveBeenCalledWith('hidden', [{ id: 'hidden', name: 'Hidden one' }, { id: 'a', name: 'A' }])
    await vi.waitFor(() => { expect(subject.face().hooks.saveFailed.getSnapshot()).toBe(false) })
    subject.handlers.get('settings/document-updated')()
    subject.handlers.get('llm/adapters-updated')()
    await vi.waitFor(() => { expect(catalog).toHaveBeenCalledTimes(3) })
    await subject.fiber.dispose()
    expect(subject.slots.entries(FOOTER)).toHaveLength(0)
    expect(subject.slots.entries(CARD)).toHaveLength(0)
    expect(subject.handlers.size).toBe(0)
  })

  it('reports a refused write, an unavailable row, a loading row, and a catalog failure', async () => {
    const settings = form('loading')
    const subject = await bench(settings, () => Promise.resolve({ ok: false, error: { code: 'X', message: 'down' } }))
    await vi.waitFor(() => { expect(subject.view()).toEqual({ kind: 'error', message: 'down' }) })
    settings.settle('unavailable')
    expect(subject.view()).toEqual({ kind: 'unavailable' })

    const loading = form('loading')
    const pending = await bench(loading, catalogOf([{ id: 'a', name: 'A' }]))
    await vi.waitFor(() => { expect(pending.view()).toEqual({ kind: 'loading' }) })
    pending.face().setVisible({ id: 'refuse', name: 'R' }, true)
    loading.set.mockImplementationOnce(() => Promise.resolve(false))
    pending.face().setVisible({ id: 'a', name: 'A' }, false)
    await vi.waitFor(() => { expect(pending.face().hooks.saveFailed.getSnapshot()).toBe(true) })
  })

  it('keeps only the newest catalog answer and works without a stored section', async () => {
    const answers: ((value: unknown) => void)[] = []
    const settings = form('ready')
    Object.assign(settings, { getSnapshot: () => ({ status: 'ready', value: undefined, writable: true }) })
    const subject = await bench(settings, () => new Promise((resolve) => { answers.push(resolve) }))
    subject.handlers.get('settings/document-updated')()
    answers[0]!({ ok: true, value: { groups: [{ id: 'old', name: 'Old' }], failures: [] } })
    answers[1]!({ ok: true, value: { groups: [{ id: 'new', name: 'New' }], failures: [] } })
    await vi.waitFor(() => { expect(subject.view()).toEqual({ kind: 'ready', writable: true, rows: [{ id: 'new', name: 'New', hidden: false }] }) })
    subject.face().setVisible({ id: 'new', name: 'New' }, false)
    expect(settings.set).toHaveBeenCalledWith('hidden', [{ id: 'new', name: 'New' }])
  })
})

describe('the provider card switch', () => {
  it('registers under every declared namespace and the empty key, again when providers change', async () => {
    let namespaces = ['llm-pi-ai', 'llm-deepseek', 'llm-pi-ai']
    const subject = await bench(form('ready'), catalogOf([]), () => Promise.resolve({ ok: true, value: namespaces.map(settingsNs => ({ settingsNs })) }))
    await vi.waitFor(() => { expect(subject.keys()).toEqual(['', 'llm-pi-ai', 'llm-deepseek']) })
    namespaces = ['llm-kiln']
    subject.handlers.get('llm/adapters-updated')()
    await vi.waitFor(() => { expect(subject.keys()).toEqual(['', 'llm-pi-ai', 'llm-deepseek', 'llm-kiln']) })
    expect(subject.slots.entries(CARD).every(entry => (entry.options as { priority?: number }).priority === 100)).toBe(true)
  })

  it('ignores a failed directory and an answer that lands after disposal', async () => {
    const failed = await bench(form('ready'), catalogOf([]), () => Promise.resolve({ ok: false, error: { message: 'x' } }))
    await vi.waitFor(() => { expect(failed.keys()).toEqual(['']) })
    let answer: (value: unknown) => void = () => {}
    const late = await bench(form('ready'), catalogOf([]), () => new Promise((resolve) => { answer = resolve }))
    await late.fiber.dispose()
    answer({ ok: true, value: [{ settingsNs: 'llm-x' }] })
    await Promise.resolve()
    expect(late.slots.entries(CARD)).toHaveLength(0)
  })

  it('leaves carded providers out of the footer until their last card unmounts', async () => {
    const subject = await bench(form('ready', [{ id: 'gone', name: 'Gone' }]), catalogOf([{ id: 'a', name: 'A' }, { id: 'pool', name: 'Pool' }]))
    await vi.waitFor(() => { expect(subject.view().kind).toBe('ready') })
    const ids = () => (subject.view() as unknown as { rows: { id: string }[] }).rows.map(row => row.id)
    expect(ids()).toEqual(['a', 'pool', 'gone'])
    const first = subject.card().carded('a')
    const second = subject.card().carded('a')
    expect(ids()).toEqual(['pool', 'gone'])
    first()
    expect(ids()).toEqual(['pool', 'gone'])
    second()
    expect(ids()).toEqual(['a', 'pool', 'gone'])
    expect(subject.card().hooks.cardVisibility.getSnapshot()).toEqual({ hidden: [{ id: 'gone', name: 'Gone' }], writable: true })
  })

  it('reads no hidden list while the row loads or is unavailable, and an empty one without a stored section', async () => {
    const settings = form('loading')
    const subject = await bench(settings, catalogOf([]))
    expect(subject.card().hooks.cardVisibility.getSnapshot().hidden).toBeNull()
    settings.settle('unavailable')
    expect(subject.card().hooks.cardVisibility.getSnapshot().hidden).toBeNull()
    Object.assign(settings, { getSnapshot: () => ({ status: 'ready', value: undefined, writable: false }) })
    settings.settle('ready')
    expect(subject.card().hooks.cardVisibility.getSnapshot()).toEqual({ hidden: [], writable: false })
  })

  it('renders a switch on when shown, off when hidden, reports itself carded, and writes a change', () => {
    const setVisible = vi.fn()
    const release = vi.fn()
    const carded = vi.fn(() => release)
    const draw = (visibility: CardVisibility) => {
      const props: ProviderCardSwitchProps = {
        t,
        provider: { provider: 'nvidia', displayName: 'NVIDIA', settingsNs: 'llm-pi-ai', settingsPath: [], active: true },
        configured: true,
        keyConfigured: true,
        useCardVisibility: <R,>(select: (value: CardVisibility) => R): R => select(visibility),
        setVisible,
        carded,
      } as never
      return render(<ProviderCardSwitch {...props} />)
    }
    const shown = draw({ hidden: [], writable: true })
    const control = screen.getByRole('switch', { name: 'Show NVIDIA in the model picker' })
    expect(control.getAttribute('aria-checked')).toBe('true')
    expect(screen.getByText(en.cardShown)).toBeTruthy()
    expect(carded).toHaveBeenCalledWith('nvidia')
    fireEvent.click(control)
    expect(setVisible).toHaveBeenCalledWith({ id: 'nvidia', name: 'NVIDIA' }, false)
    shown.unmount()
    expect(release).toHaveBeenCalled()
    draw({ hidden: [{ id: 'nvidia', name: 'NVIDIA' }], writable: false })
    expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('false')
    expect(screen.getByRole('switch').hasAttribute('disabled')).toBe(true)
    expect(screen.getByText(en.cardHidden)).toBeTruthy()
    cleanup()
    const { container } = draw({ hidden: null, writable: true })
    expect(container.innerHTML).toBe('')
  })
})

describe('dictionary namespace', () => {
  it('is modelVisibility', () => { expect(NS).toBe('modelVisibility') })
})
