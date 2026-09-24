// @vitest-environment jsdom
// DSH-FORK(browser): fork edit on an upstream-owned file. EXIT: follows packages/client/ui-model-selection/src/client/ModelSelect.tsx.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RemoteError } from '@deepseek-ai/dsh-client-test-runtime'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ModelSelection } from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ComponentProps } from 'react'
import type { ModelDirectoryState } from '../src/client/directory.ts'
import { ModelSelect } from '../src/client/ModelSelect.tsx'
import { zh } from '../src/client/locales.ts'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'

// The seat's key domain is model ∪ common; the stub mirrors the real lookup
// chain: package dictionary, then common vocabulary, then the key.
const t: ComponentProps<typeof ModelSelect>['t'] = (key, params) => {
  const template = (zh as Record<string, string>)[key]
    ?? (commonZh as Record<string, string>)[key]
    ?? key
  return params === undefined
    ? template
    : template.replace(/\{(\w+)\}/g, (match, name: string) => name in params ? String(params[name]) : match)
}

const reasoning = {
  efforts: [
    { id: 'off', name: 'Off' },
    { id: 'high', name: 'High' },
    { id: 'max', name: 'Max', description: 'Largest budget' },
  ],
  defaultEffort: 'high',
}

function state(overrides: Partial<ModelDirectoryState> = {}): ModelDirectoryState {
  return {
    current: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    routable: true,
    groups: [{
      id: 'deepseek-official',
      name: 'DeepSeek',
      models: [{
        id: 'deepseek-v4-flash',
        name: 'DeepSeek-V4-Flash',
        description: 'Fast catalog description',
        reasoning,
      }],
    }],
    failures: [],
    status: 'ready',
    error: null,
    ...overrides,
  }
}

function mountModelSelect(directory: ReturnType<typeof createSnapshotStore<ModelDirectoryState>>) {
  render(<ModelSelect
    locked={false}
    available
    directory={directory}
    load={vi.fn()}
    select={vi.fn().mockResolvedValue(true)}
    t={t}
  />)
  fireEvent.click(screen.getByRole('button', { name: /选择模型|当前/ }))
  fireEvent.click(screen.getByRole('menuitem', { name: /模型/ }))
}

afterEach(cleanup)

describe('ModelSelect reasoning effort', () => {
  it('renders effort names without descriptions and submits the effort as part of the session selection', async () => {
    const directory = createSnapshotStore<ModelDirectoryState>(state())
    const select = vi.fn(async (selection: ModelSelection) => {
      directory.set(state({ current: selection }))
      return { ok: true as const, value: undefined }
    })
    render(<ModelSelect
      locked={false}
      available
      directory={directory}
      load={vi.fn()}
      select={select}
      t={t}
    />)

    const trigger = screen.getByRole('button', {
      name: '选择模型，当前 DeepSeek-V4-Flash，推理等级 High',
    })
    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('menuitem', { name: /推理等级/ }))
    expect(screen.getAllByRole('menuitemradio').map(item => item.textContent))
      .toEqual(['Off', 'High', 'Max'])
    expect(screen.queryByText('Largest budget')).toBeNull()

    fireEvent.click(screen.getByRole('menuitemradio', { name: /Max/ }))
    await waitFor(() => {
      expect(select).toHaveBeenCalledWith({
        provider: 'deepseek-official',
        model: 'deepseek-v4-flash',
        reasoningEffort: 'max',
      })
      expect(trigger.getAttribute('aria-label')).toBe('选择模型，当前 DeepSeek-V4-Flash，推理等级 Max')
    })
  })

  it('offers provider default only when the adapter does not configure a model default', () => {
    const directory = createSnapshotStore(state({
      groups: [{
        id: 'provider',
        name: 'Provider',
        models: [{
          id: 'model',
          name: 'Model',
          reasoning: { efforts: [{ id: 'standard', name: 'Standard' }] },
        }],
      }],
      current: { provider: 'provider', model: 'model' },
    }))
    render(<ModelSelect
      locked={false}
      available
      directory={directory}
      load={vi.fn()}
      select={vi.fn().mockResolvedValue({ ok: true, value: undefined })}
      t={t}
    />)

    fireEvent.click(screen.getByRole('button', {
      name: '选择模型，当前 Model，推理等级 Default',
    }))
    fireEvent.click(screen.getByRole('menuitem', { name: /推理等级/ }))
    expect(screen.getAllByRole('menuitemradio').map(item => item.textContent))
      .toEqual(['Default', 'Standard'])
  })

  it('shows the durable model id when the catalog has no matching display name', () => {
    const directory = createSnapshotStore(state({
      current: { provider: 'deepseek-official', model: 'removed-model' },
    }))
    const select = vi.fn().mockResolvedValue({ ok: true, value: undefined })
    render(<ModelSelect
      locked={false}
      available
      directory={directory}
      load={vi.fn()}
      select={select}
      t={t}
    />)

    const trigger = screen.getByRole('button', { name: '选择模型，当前 deepseek-official/removed-model' })
    expect(trigger.textContent).toContain('deepseek-official/removed-model')
    fireEvent.click(trigger)
    expect(screen.queryByRole('menuitem', { name: /推理等级/ })).toBeNull()
    fireEvent.click(screen.getByRole('menuitem', { name: /模型/ }))
    expect(screen.queryByRole('menuitemradio', { name: 'removed-model' })).toBeNull()
    expect(screen.getByRole('menuitemradio', { name: 'DeepSeek-V4-Flash' })).toBeTruthy()
    expect(screen.queryByText('Fast catalog description')).toBeNull()
  })

  it('shows loading until the catalog and Session projection are both ready', async () => {
    const directory = createSnapshotStore<ModelDirectoryState>(state({
      current: null,
      routable: null,
      groups: [],
      status: 'loading',
    }))
    render(<ModelSelect
      locked={false}
      available
      directory={directory}
      load={vi.fn()}
      select={vi.fn().mockResolvedValue({ ok: true, value: undefined })}
      t={t}
    />)

    expect(screen.getByRole('button', { name: '正在加载模型…' }).textContent)
      .toContain('正在加载模型…')
    directory.set(state())
    await waitFor(() => {
      expect(screen.getByRole('button', {
        name: '选择模型，当前 DeepSeek-V4-Flash，推理等级 High',
      })).toBeTruthy()
    })
  })

  it.each([false, true])('announces rejected selections with ownership guidance only for held writers (%s)', async (sessionInUse) => {
    const groups = [{
      id: 'deepseek-official',
      name: 'DeepSeek',
      models: [
        { id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash', reasoning },
        { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro' },
      ],
    }]
    const directory = createSnapshotStore<ModelDirectoryState>(state({ groups }))
    const select = vi.fn(async () => {
      const error = sessionInUse
        ? new RemoteError('session/writer-held', 'writer held', { sessionId: SessionId('owned') })
        : new RemoteError('session/model-unavailable', 'session already contains images', { provider: 'deepseek-official', model: 'deepseek-v4-pro' })
      directory.set(state({ groups, status: 'error', error: 'unrelated catalog refresh' }))
      return { ok: false as const, error }
    })
    render(<ModelSelect
      locked={false}
      available
      directory={directory}
      load={vi.fn()}
      select={select}
      t={t}
    />)

    fireEvent.click(screen.getByRole('button', { name: /选择模型|当前/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: /模型/ }))
    fireEvent.click(screen.getByRole('menuitemradio', { name: /DeepSeek-V4-Pro/ }))
    const toast = await screen.findByRole('alert')
    expect(toast.textContent).toBe(sessionInUse
      ? zh['error.sessionInUse']
      : '模型操作失败：session/model-unavailable: session already contains images')
    // The selection failure does not render the in-menu load strip (no Retry).
    expect(screen.queryByRole('button', { name: '重试' })).toBeNull()
  })

  it('portals the placed menu card to body and closes only on truly-outside mousedown', () => {
    const offsetWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth')!
    const offsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight')!
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => 200 })
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => 300 })
    try {
      const { container } = render(<ModelSelect
        locked={false}
        available
        directory={createSnapshotStore(state())}
        load={vi.fn()}
        select={vi.fn().mockResolvedValue({ ok: true, value: undefined })}
        t={t}
      />)
      const trigger = screen.getByRole('button', { name: /选择模型/ })
      fireEvent.click(trigger)
      const menu = screen.getByRole('menu')
      // Outside the composer subtree — column overflow clips cannot crop it.
      expect(container.contains(menu)).toBe(false)
      expect(menu.parentElement).toBe(document.body)
      // jsdom anchor rects are all zero, so the measured 200x300 card clamps
      // to the 12px viewport margin on both axes.
      expect(menu.style.left).toBe('12px')
      expect(menu.style.top).toBe('12px')
      // Interactions inside the trigger subtree or the portaled card stay open.
      fireEvent.mouseDown(menu)
      fireEvent.mouseDown(trigger)
      fireEvent.blur(trigger, { relatedTarget: menu })
      expect(screen.getByRole('menu')).toBeTruthy()
      fireEvent.mouseDown(document.body)
      expect(screen.queryByRole('menu')).toBeNull()
    } finally {
      Object.defineProperty(HTMLElement.prototype, 'offsetWidth', offsetWidth)
      Object.defineProperty(HTMLElement.prototype, 'offsetHeight', offsetHeight)
    }
  })

  it('renders no Agent-bound control for an addressed subagent session', () => {
    const load = vi.fn()
    render(<ModelSelect
      locked={false}
      available={false}
      directory={createSnapshotStore(state())}
      load={load}
      select={vi.fn().mockResolvedValue(undefined)}
      t={t}
    />)

    expect(screen.queryByRole('button')).toBeNull()
    expect(load).not.toHaveBeenCalled()
  })
})

describe('ModelSelect provider group collapse', () => {
  const twoGroups = [
    {
      id: 'provider-a',
      name: 'Provider A',
      models: [{ id: 'a-flash', name: 'A Flash', reasoning }],
    },
    {
      id: 'provider-b',
      name: 'Provider B',
      models: [{ id: 'b-pro', name: 'B Pro' }],
    },
  ]


  it('expands only the provider owning the current selection by default', () => {
    const directory = createSnapshotStore<ModelDirectoryState>(state({
      groups: twoGroups,
      current: { provider: 'provider-a', model: 'a-flash' },
    }))
    mountModelSelect(directory)

    const a = screen.getByRole('button', { name: 'Provider A' })
    const b = screen.getByRole('button', { name: 'Provider B' })
    // The provider holding the current selection is expanded; the rest are minimized.
    expect(a.getAttribute('aria-expanded')).toBe('true')
    expect(b.getAttribute('aria-expanded')).toBe('false')
    expect(screen.getByRole('menuitemradio', { name: /A Flash/ })).toBeTruthy()
    expect(screen.queryByRole('menuitemradio', { name: /B Pro/ })).toBeNull()
  })

  it('keeps only the first provider open when none owns the current selection', () => {
    // The pane never opens empty: the keyboard walk lands on the first row.
    const directory = createSnapshotStore<ModelDirectoryState>(state({
      groups: twoGroups,
      current: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    }))
    mountModelSelect(directory)

    expect(screen.getByRole('button', { name: 'Provider A' }).getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByRole('button', { name: 'Provider B' }).getAttribute('aria-expanded')).toBe('false')
    expect(screen.getAllByRole('menuitemradio').map(row => row.textContent)).toEqual(['A Flash'])
  })

  it('collapses and re-expands one provider group without touching the others', () => {
    const directory = createSnapshotStore<ModelDirectoryState>(state({
      groups: twoGroups,
      current: { provider: 'provider-a', model: 'a-flash' },
    }))
    mountModelSelect(directory)

    const a = screen.getByRole('button', { name: 'Provider A' })
    const b = screen.getByRole('button', { name: 'Provider B' })

    // Collapse provider A: its models leave the tree, provider B stays minimized.
    fireEvent.click(a)
    expect(a.getAttribute('aria-expanded')).toBe('false')
    expect(b.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByRole('menuitemradio', { name: /A Flash/ })).toBeNull()
    expect(screen.queryByRole('menuitemradio', { name: /B Pro/ })).toBeNull()

    // Toggling provider A again restores its models; provider B remains minimized.
    fireEvent.click(a)
    expect(a.getAttribute('aria-expanded')).toBe('true')
    expect(b.getAttribute('aria-expanded')).toBe('false')
    expect(screen.getByRole('menuitemradio', { name: /A Flash/ })).toBeTruthy()
    expect(screen.queryByRole('menuitemradio', { name: /B Pro/ })).toBeNull()

    // Expanding provider B leaves provider A untouched.
    fireEvent.click(b)
    expect(a.getAttribute('aria-expanded')).toBe('true')
    expect(b.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByRole('menuitemradio', { name: /A Flash/ })).toBeTruthy()
    expect(screen.getByRole('menuitemradio', { name: /B Pro/ })).toBeTruthy()
  })

  it('keeps a manual collapse across a catalog reload while the pane stays open', () => {
    const directory = createSnapshotStore<ModelDirectoryState>(state({
      groups: twoGroups,
      current: { provider: 'provider-a', model: 'a-flash' },
    }))
    mountModelSelect(directory)

    const b = screen.getByRole('button', { name: 'Provider B' })
    fireEvent.click(b) // expand B manually
    expect(b.getAttribute('aria-expanded')).toBe('true')

    // A late catalog refresh must not overwrite the user's explicit choice.
    directory.set(state({
      groups: twoGroups,
      current: { provider: 'provider-a', model: 'a-flash' },
    }))
    expect(screen.getByRole('button', { name: 'Provider B' }).getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByRole('button', { name: 'Provider A' }).getAttribute('aria-expanded')).toBe('true')
  })
})

describe('ModelSelect account grouping', () => {
  const deepseekModels = [
    { id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash', reasoning },
    { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro' },
  ]


  it('merges account routes under one provider header and targets the picked account', () => {
    const select = vi.fn().mockResolvedValue(true)
    const directory = createSnapshotStore<ModelDirectoryState>(state({
      current: { provider: 'kiln-deepseek', model: 'deepseek-v4-flash' },
      groups: [
        { id: 'kiln-deepseek', name: 'DeepSeek', models: deepseekModels },
        { id: 'kiln-deepseek@one', name: 'DeepSeek', models: deepseekModels },
        { id: 'kiln-deepseek@two', name: 'DeepSeek', models: deepseekModels },
      ],
    }))
    render(<ModelSelect
      locked={false}
      available
      directory={directory}
      load={vi.fn()}
      select={select}
      t={t}
    />)
    fireEvent.click(screen.getByRole('button', { name: /选择模型|当前/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: /模型/ }))

    // Exactly one provider header.
    expect(screen.getAllByRole('button', { name: 'DeepSeek' })).toHaveLength(1)

    // Account picker holds the base route plus both accounts.
    const picker = screen.getByRole('group', { name: 'DeepSeek accounts' })
    expect(picker).toBeTruthy()
    const accountButtons = within(picker).getAllByRole('menuitemradio')
    expect(accountButtons.map(button => button.textContent)).toEqual(['DeepSeek', 'one', 'two'])

    // Pick account `one`; the base-route model pick must then submit the bound route.
    fireEvent.click(within(picker).getByRole('menuitemradio', { name: 'one' }))
    fireEvent.click(screen.getByRole('menuitemradio', { name: /DeepSeek-V4-Flash/ }))
    expect(select).toHaveBeenCalledWith({ provider: 'kiln-deepseek@one', model: 'deepseek-v4-flash' })
  })

  it('defaults the selected account to the account owning the current provider', () => {
    const directory = createSnapshotStore<ModelDirectoryState>(state({
      current: { provider: 'kiln-deepseek@two', model: 'deepseek-v4-pro' },
      groups: [
        { id: 'kiln-deepseek', name: 'DeepSeek', models: deepseekModels },
        { id: 'kiln-deepseek@one', name: 'DeepSeek', models: deepseekModels },
        { id: 'kiln-deepseek@two', name: 'DeepSeek', models: deepseekModels },
      ],
    }))
    mountModelSelect(directory)

    const picker = screen.getByRole('group', { name: 'DeepSeek accounts' })
    expect(within(picker).getByRole('menuitemradio', { name: 'two' }).getAttribute('aria-checked')).toBe('true')
    expect(screen.getByRole('menuitemradio', { name: /DeepSeek-V4-Pro/ }).getAttribute('aria-checked')).toBe('true')
  })

  it('keeps non-account providers rendering as before', () => {
    const directory = createSnapshotStore<ModelDirectoryState>(state({
      current: { provider: 'provider-b', model: 'b-pro' },
      groups: [
        { id: 'provider-b', name: 'Provider B', models: [{ id: 'b-pro', name: 'B Pro' }] },
      ],
    }))
    mountModelSelect(directory)

    expect(screen.getByRole('button', { name: 'Provider B' })).toBeTruthy()
    expect(screen.queryByRole('group', { name: /accounts/ })).toBeNull()
    expect(screen.getByRole('menuitemradio', { name: /B Pro/ })).toBeTruthy()
  })
})

describe('ModelSelect keyboard walk', () => {
  function mountOpen() {
    const select = vi.fn().mockResolvedValue({ ok: true, value: undefined })
    render(<ModelSelect
      locked={false}
      available
      directory={createSnapshotStore(state())}
      load={vi.fn()}
      select={select}
      t={t}
    />)
    fireEvent.click(screen.getByRole('button', { name: /选择模型/ }))
    return select
  }

  it('↑↓ walk the rows of the shown pane, wrapping, and stay open', () => {
    mountOpen()
    // The trigger holds focus while the menu opens: the first forward step
    // enters at the first cell instead of skipping it. false = preventDefault ran.
    const cells = screen.getAllByRole('menuitem')
    expect(fireEvent.keyDown(cells[0]!, { key: 'ArrowDown' })).toBe(false)
    expect(document.activeElement).toBe(cells[0])

    fireEvent.click(screen.getByRole('menuitem', { name: /推理等级/ }))
    const rows = screen.getAllByRole('menuitemradio')
    expect(rows.map(row => row.textContent)).toEqual(['Off', 'High', 'Max'])
    // The pane opens on its checked row, so walking starts from High.
    fireEvent.keyDown(rows[1]!, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(rows[2])
    fireEvent.keyDown(rows[2]!, { key: 'ArrowDown' }) // wraps to the top
    expect(document.activeElement).toBe(rows[0])
    fireEvent.keyDown(rows[0]!, { key: 'ArrowUp' }) // wraps to the bottom
    expect(document.activeElement).toBe(rows[2])
    expect(screen.getByRole('menu')).toBeTruthy()
  })

  it('Tab settles the focused row like Enter and closes the menu', async () => {
    const select = mountOpen()
    fireEvent.click(screen.getByRole('menuitem', { name: /推理等级/ }))
    const rows = screen.getAllByRole('menuitemradio')
    fireEvent.keyDown(rows[1]!, { key: 'ArrowDown' }) // High → Max
    expect(fireEvent.keyDown(rows[2]!, { key: 'Tab' })).toBe(false)
    expect(select).toHaveBeenCalledWith({
      provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'max',
    })
    await waitFor(() => { expect(screen.queryByRole('menu')).toBeNull() })
  })

  it('Shift+Tab leaves a drilled pane and then closes, like Escape', () => {
    mountOpen()
    fireEvent.click(screen.getByRole('menuitem', { name: /推理等级/ }))
    const rows = screen.getAllByRole('menuitemradio')
    expect(fireEvent.keyDown(rows[0]!, { key: 'Tab', shiftKey: true })).toBe(false)
    // Back on the drilled cell, then closed on the second press.
    const cells = screen.getAllByRole('menuitem')
    expect(document.activeElement).toBe(cells[1])
    expect(screen.getByRole('menu')).toBeTruthy()
    fireEvent.keyDown(cells[1]!, { key: 'Tab', shiftKey: true })
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('Tab with the keyboard still on the trigger enters the menu at the value in use', () => {
    render(<ModelSelect
      locked={false}
      available
      directory={createSnapshotStore(state())}
      load={vi.fn()}
      select={vi.fn().mockResolvedValue({ ok: true, value: undefined })}
      t={t}
    />)
    const trigger = screen.getByRole('button', { name: /选择模型/ })
    // A real click focuses the trigger first; jsdom's does not.
    trigger.focus()
    fireEvent.click(trigger)
    expect(fireEvent.keyDown(trigger, { key: 'Tab' })).toBe(false)
    // The root pane's first cell carries the current selection.
    const cells = screen.getAllByRole('menuitem')
    expect(document.activeElement).toBe(cells[0])
    expect(screen.getByRole('menu')).toBeTruthy()
  })

  it('a backward step from outside the list enters at the last row, and a closed menu leaves Tab native', () => {
    mountOpen()
    const [modelRow, effortRow] = screen.getAllByRole('menuitem')
    expect(fireEvent.keyDown(modelRow!, { key: 'ArrowUp' })).toBe(false)
    expect(document.activeElement).toBe(effortRow)
    const trigger = screen.getByRole('button', { name: /选择模型/ })
    fireEvent.keyDown(trigger, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(fireEvent.keyDown(trigger, { key: 'Tab' })).toBe(true)
  })

  it('hands a drilled pane the focus its unmounted cell left behind, on the value in use', () => {
    mountOpen()
    fireEvent.click(screen.getByRole('menuitem', { name: /推理等级/ }))
    const rows = screen.getAllByRole('menuitemradio')
    // The fixture's model defaults to the High effort: the checked row is where
    // the keyboard lands, not the top of the list.
    expect(rows[1]!.getAttribute('aria-checked')).toBe('true')
    expect(document.activeElement).toBe(rows[1])
    // The walk continues from there.
    fireEvent.keyDown(rows[1]!, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(rows[2])
  })

  it('keeps the card navigable when a pane has no rows, and leaves a retry its Tab', () => {
    const directory = createSnapshotStore<ModelDirectoryState>(state({
      groups: [], failures: [], status: 'error', error: 'catalog down',
    }))
    render(<ModelSelect
      locked={false}
      available
      directory={directory}
      load={vi.fn()}
      select={vi.fn().mockResolvedValue({ ok: true, value: undefined })}
      t={t}
    />)
    const trigger = screen.getByRole('button', { name: /选择模型/ })
    // A real click focuses the trigger first; jsdom's does not.
    trigger.focus()
    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('menuitem', { name: /^模型/ }))
    // No rows to hand the keyboard to: the trigger keeps it, so the card's
    // keys still reach the menu.
    expect(document.activeElement).toBe(trigger)

    const retry = screen.getByRole('button', { name: '重试' })
    retry.focus()
    // A control that is not a row keeps the browser's traversal.
    expect(fireEvent.keyDown(retry, { key: 'Tab' })).toBe(true)
    // Escape still backs out of the pane and then closes the card.
    fireEvent.keyDown(retry, { key: 'Escape' })
    // Back on the root pane, whose only cell remains (no model means no effort row).
    const cell = screen.getAllByRole('menuitem')[0]!
    fireEvent.keyDown(cell, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('drills into the model list on the selected model', () => {
    mountOpen()
    fireEvent.click(screen.getByRole('menuitem', { name: /^模型/ }))
    const rows = screen.getAllByRole('menuitemradio')
    expect(rows[0]!.getAttribute('aria-checked')).toBe('true')
    expect(document.activeElement).toBe(rows[0])
  })

  it('Escape returns to the root pane with the keyboard on the cell that drilled in', () => {
    mountOpen()
    fireEvent.click(screen.getByRole('menuitem', { name: /推理等级/ }))
    const rows = screen.getAllByRole('menuitemradio')
    fireEvent.keyDown(rows[0]!, { key: 'Escape' })
    // The root pane is back with its two cells.
    const cells = screen.getAllByRole('menuitem')
    // Back on the drilled cell, so the next keystroke still reaches the menu.
    expect(document.activeElement).toBe(cells[1])
    expect(screen.getByRole('menu')).toBeTruthy()
    // A second Escape closes back to the trigger.
    fireEvent.keyDown(cells[1]!, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('Escape from the model list lands back on the model cell', () => {
    mountOpen()
    fireEvent.click(screen.getByRole('menuitem', { name: /^模型/ }))
    fireEvent.keyDown(screen.getAllByRole('menuitemradio')[0]!, { key: 'Escape' })
    const cells = screen.getAllByRole('menuitem')
    expect(document.activeElement).toBe(cells[0])
  })

  it('a pane whose rows mark no current value opens on its first row', () => {
    // The session runs a model the catalog no longer lists: no row is checked.
    render(<ModelSelect
      locked={false}
      available
      directory={createSnapshotStore(state({ current: { provider: 'gone', model: 'gone' } }))}
      load={vi.fn()}
      select={vi.fn().mockResolvedValue({ ok: true, value: undefined })}
      t={t}
    />)
    fireEvent.click(screen.getByRole('button', { name: /选择模型/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: /^模型/ }))
    const rows = screen.getAllByRole('menuitemradio')
    expect(rows.every(row => row.getAttribute('aria-checked') === 'false')).toBe(true)
    expect(document.activeElement).toBe(rows[0])
  })
})
