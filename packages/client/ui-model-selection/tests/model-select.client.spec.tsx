// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
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

/** Render the seat, filling the two verbs a test rarely cares about. */
function renderSelect(
  props: Partial<ComponentProps<typeof ModelSelect>>
    & Pick<ComponentProps<typeof ModelSelect>, 'directory'>,
) {
  return render(<ModelSelect
    locked={false}
    available
    load={vi.fn()}
    select={vi.fn().mockResolvedValue(true)}
    addAccount={vi.fn().mockResolvedValue({ ok: true })}
    t={t}
    {...props}
  />)
}

afterEach(cleanup)

describe('ModelSelect reasoning effort', () => {
<<<<<<< HEAD
  it('shows the efforts under the selected model and submits one as part of the selection', async () => {
=======
  it('renders effort names without descriptions and submits the effort as part of the session selection', async () => {
>>>>>>> upstream/master
    const directory = createSnapshotStore<ModelDirectoryState>(state())
    const select = vi.fn(async (selection: ModelSelection) => {
      directory.set(state({ current: selection }))
      return true
    })
    renderSelect({ directory, select })

<<<<<<< HEAD
    // The provider holding the current selection is expanded on open, so the
    // selected model's effort control is right there — no separate pane.
    fireEvent.click(screen.getByRole('button', { name: '选择模型，当前 DeepSeek-V4-Flash' }))
    expect(['Off', 'High', 'Max'].every(name => screen.getByRole('button', { name }))).toBe(true)
=======
    const trigger = screen.getByRole('button', {
      name: '选择模型，当前 DeepSeek-V4-Flash，推理等级 High',
    })
    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('menuitem', { name: /推理等级/ }))
    expect(screen.getAllByRole('menuitemradio').map(item => item.textContent))
      .toEqual(['Off', 'High', 'Max'])
    expect(screen.queryByText('Largest budget')).toBeNull()
>>>>>>> upstream/master

    fireEvent.click(screen.getByRole('button', { name: 'Max' }))
    await waitFor(() => {
      expect(select).toHaveBeenCalledWith({
        provider: 'deepseek-official',
        model: 'deepseek-v4-flash',
        reasoningEffort: 'max',
      })
    })
  })

<<<<<<< HEAD
  it('selects a different model in the same provider', async () => {
    const groups = [{
      id: 'deepseek-official',
      name: 'DeepSeek',
      models: [
        { id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash', reasoning },
        { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro' },
      ],
    }]
    const directory = createSnapshotStore<ModelDirectoryState>(state({ groups }))
=======
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
      select={vi.fn().mockResolvedValue(true)}
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
>>>>>>> upstream/master
    const select = vi.fn().mockResolvedValue(true)
    renderSelect({ directory, select })

<<<<<<< HEAD
    fireEvent.click(screen.getByRole('button', { name: /当前 DeepSeek-V4-Flash/ }))
    fireEvent.click(screen.getByRole('button', { name: 'DeepSeek-V4-Pro' }))
    await waitFor(() => {
      expect(select).toHaveBeenCalledWith({ provider: 'deepseek-official', model: 'deepseek-v4-pro' })
=======
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
      select={vi.fn().mockResolvedValue(true)}
      t={t}
    />)

    expect(screen.getByRole('button', { name: '正在加载模型…' }).textContent)
      .toContain('正在加载模型…')
    directory.set(state())
    await waitFor(() => {
      expect(screen.getByRole('button', {
        name: '选择模型，当前 DeepSeek-V4-Flash，推理等级 High',
      })).toBeTruthy()
>>>>>>> upstream/master
    })
  })

  it('announces a rejected selection as a transient toast', async () => {
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
      directory.set(state({ groups, status: 'error', error: 'session/model-unavailable: session already contains images' }))
      return false
    })
    renderSelect({ directory, select })

    fireEvent.click(screen.getByRole('button', { name: /当前 DeepSeek-V4-Flash/ }))
    fireEvent.click(screen.getByRole('button', { name: 'DeepSeek-V4-Pro' }))
    const toast = await screen.findByRole('alert')
<<<<<<< HEAD
    expect(toast.textContent).toContain('模型操作失败：model-unavailable: session already contains images')
=======
    expect(toast.textContent).toContain('模型操作失败：session/model-unavailable: session already contains images')
    // The selection failure does not render the in-menu load strip (no Retry).
    expect(screen.queryByRole('button', { name: '重试' })).toBeNull()
>>>>>>> upstream/master
  })

  it('renders no Agent-bound control for an addressed subagent session', () => {
    const load = vi.fn()
    render(<ModelSelect
      locked={false}
      available={false}
      directory={createSnapshotStore(state())}
      load={load}
      select={vi.fn().mockResolvedValue(false)}
      addAccount={vi.fn().mockResolvedValue({ ok: false })}
      t={t}
    />)

    expect(screen.queryByRole('button')).toBeNull()
    expect(load).not.toHaveBeenCalled()
  })
})

describe('ModelSelect accounts', () => {
  /** DeepSeek with one pooled login: the base route plus a `base@account` route. */
  function pooled(overrides: Partial<ModelDirectoryState> = {}): ModelDirectoryState {
    return state({
      groups: [
        { id: 'kiln-deepseek', name: 'DeepSeek', models: [{ id: 'deepseek-default', name: 'Chat' }] },
        { id: 'kiln-deepseek@a@x.com', name: 'DeepSeek (a@x.com)', models: [{ id: 'deepseek-default', name: 'Chat' }] },
      ],
      current: { provider: 'kiln-deepseek', model: 'deepseek-default' },
      ...overrides,
    })
  }

  it('shows one chip per pooled login and switches account without leaving the model', async () => {
    const directory = createSnapshotStore<ModelDirectoryState>(pooled())
    const select = vi.fn().mockResolvedValue(true)
    renderSelect({ directory, select })

    fireEvent.click(screen.getByRole('button', { name: /当前 Chat/ }))
    fireEvent.click(screen.getByRole('button', { name: 'a@x.com' }))
    await waitFor(() => {
      expect(select).toHaveBeenCalledWith({ provider: 'kiln-deepseek@a@x.com', model: 'deepseek-default' })
    })
  })

  it('tests and adds a new login through the add-account form', async () => {
    const directory = createSnapshotStore<ModelDirectoryState>(pooled())
    const addAccount = vi.fn().mockResolvedValue({ ok: true, account: 'b@x.com' })
    renderSelect({ directory, addAccount })

    fireEvent.click(screen.getByRole('button', { name: /当前 Chat/ }))
    fireEvent.click(screen.getByRole('button', { name: '+ 添加账号' }))
    fireEvent.change(screen.getByPlaceholderText('name@company.com'), { target: { value: 'b@x.com' } })
    fireEvent.change(screen.getByPlaceholderText('密码'), { target: { value: 'secret' } })
    fireEvent.click(screen.getByRole('button', { name: '测试并添加' }))

    await waitFor(() => {
      expect(addAccount).toHaveBeenCalledWith('kiln-deepseek', { email: 'b@x.com', password: 'secret', areaCode: '+86' })
    })
  })

  it('refuses to submit the add-account form without a password', () => {
    const directory = createSnapshotStore<ModelDirectoryState>(pooled())
    const addAccount = vi.fn().mockResolvedValue({ ok: true })
    renderSelect({ directory, addAccount })

    fireEvent.click(screen.getByRole('button', { name: /当前 Chat/ }))
    fireEvent.click(screen.getByRole('button', { name: '+ 添加账号' }))
    fireEvent.change(screen.getByPlaceholderText('name@company.com'), { target: { value: 'b@x.com' } })
    fireEvent.click(screen.getByRole('button', { name: '测试并添加' }))

    expect(addAccount).not.toHaveBeenCalled()
    expect(screen.getByText('请先输入密码。')).toBeTruthy()
  })
})
