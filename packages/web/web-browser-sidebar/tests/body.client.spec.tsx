// @vitest-environment jsdom
/**
 * The AI Browser tab: it reports when its viewport can be covered, shows the agent's
 * navigation state, and sends the operator's toolbar commands to the shown page.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useSyncExternalStore } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { AgentBrowserBody, AgentBrowserTitle, type AgentBrowserBodyProps, type AgentBrowserTitleProps } from '../src/client/AgentBrowserBody.tsx'
import { en } from '../src/client/locales.ts'
import type { AgentTabState } from '../src/client/pages.ts'

afterEach(cleanup)

const copy: ReadonlyMap<string, string> = new Map(Object.entries(en))
const t = (key: string): string => copy.get(key) ?? key

const EMPTY: AgentTabState = { pageId: undefined, url: '', title: '', loading: false, canGoBack: false, canGoForward: false, busy: undefined }

/** Render the tab over a live page state, as the renderer binds it. */
function view(initial: Partial<AgentTabState> = {}, visible = true) {
  const state = createSnapshotStore<AgentTabState>({ ...EMPTY, ...initial })
  const detach = vi.fn()
  const attach = vi.fn((_id: string) => detach)
  const load = vi.fn()
  const command = vi.fn()
  const bindCommands = vi.fn(() => () => {})
  const useAgentPage = <T,>(select: (value: AgentTabState) => T): T =>
    useSyncExternalStore(state.subscribe.bind(state), () => select(state.getSnapshot()))
  const props = {
    t,
    useTabInfo: () => ({ tab: { id: 'tab-1', visible, actions: { bindCommands } } }),
    useAgentPage,
    attach,
    load,
    command,
  } as unknown as AgentBrowserBodyProps
  const result = render(<AgentBrowserBody {...props} />)
  return { state, attach, detach, load, command, result }
}

describe('the AI Browser tab', () => {
  it('says the agent has not opened a page, and covers nothing', () => {
    const { attach } = view()
    expect(screen.getByText(t('empty'))).toBeTruthy()
    expect(attach).not.toHaveBeenCalled()
  })

  it('lays the page over its viewport while visible, and releases it when the page goes', () => {
    const { attach, detach, state } = view({ pageId: 'agent', url: 'https://a.test/', title: 'A' })
    expect(attach).toHaveBeenCalledTimes(1)
    const viewportId = attach.mock.calls[0]?.[0]
    expect(document.getElementById(viewportId ?? '')?.getAttribute('aria-label')).toBe('A')
    act(() => { state.set(EMPTY) })
    expect(detach).toHaveBeenCalledTimes(1)
  })

  it('leaves the page parked while the tab is hidden', () => {
    const { attach } = view({ pageId: 'agent', url: 'https://a.test/' }, false)
    expect(attach).not.toHaveBeenCalled()
  })

  it('shows what the agent is doing', () => {
    const { state } = view({ pageId: 'agent', url: 'https://a.test/', busy: 'click' })
    expect(screen.getByRole('status').textContent).toContain(t('status.click'))
    act(() => { state.set({ ...state.getSnapshot(), busy: undefined }) })
    expect(screen.getByRole('status').textContent).toContain(t('status.idle'))
  })

  it('sends history and reload commands, enabled only when they can act', () => {
    const { command } = view({ pageId: 'agent', url: 'https://a.test/', canGoBack: true })
    const forward = screen.getByRole('button', { name: t('forward') }) as HTMLButtonElement
    expect(forward.disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: t('back') }))
    fireEvent.click(screen.getByRole('button', { name: t('reload') }))
    expect(command.mock.calls).toEqual([['back'], ['reload']])
  })

  it('loads a typed address, completing the scheme, and ignores one it cannot open', () => {
    const { load } = view({ pageId: 'agent', url: 'https://a.test/' })
    const address = screen.getByRole('textbox', { name: t('address') })
    fireEvent.change(address, { target: { value: 'example.com/path' } })
    fireEvent.submit(address)
    expect(load).toHaveBeenCalledWith('https://example.com/path')
    fireEvent.change(address, { target: { value: 'javascript:alert(1)' } })
    fireEvent.submit(address)
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('titles its chip with the page title', () => {
    const state = createSnapshotStore<AgentTabState>({ ...EMPTY, title: 'Docs' })
    const props = {
      t,
      useAgentPage: <T,>(select: (value: AgentTabState) => T): T =>
        useSyncExternalStore(state.subscribe.bind(state), () => select(state.getSnapshot())),
    } as unknown as AgentBrowserTitleProps
    render(<AgentBrowserTitle {...props} />)
    expect(screen.getByText(`${t('type.label')} · Docs`)).toBeTruthy()
  })
})
