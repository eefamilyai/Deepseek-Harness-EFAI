// @vitest-environment jsdom
/**
 * The Tools section's availability group.
 *
 * Two behaviours are worth pinning here, because both are invisible in the markup
 * and easy to break silently: the per-tool list comes from the roster map's own keys
 * (so a tool the host never learned is a tool the operator cannot switch), and a flip
 * writes a nested path (`tools.<name>`) rather than a field named after the tool.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import { ToolsSection, type RosterFields, type ToolsSectionComponentProps } from '../src/client/ToolsSection.tsx'
import type { BrowserFields, KernelFields } from '../src/client/ToolsSection.tsx'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

const translations: ReadonlyMap<string, string> = new Map(Object.entries(en))

/**
 * The framework seats this section does not read. A section receives all of them, so the
 * fixture carries them; calling one throws, so a component that starts depending on a seat
 * this spec has not given a value fails loudly instead of quietly reading nothing.
 */
const unusedSeats = {
  usePanelInfo: throwingSeat,
  useSessions: throwingSeat,
  useSessionStatus: throwingSeat,
  useSessionRetainInfo: throwingSeat,
  useWorkspaces: throwingSeat,
  useResource: throwingSeat,
  useRemoteAccess: throwingSeat,
  useSessionAccess: throwingSeat,
  useWorkspaceAccess: throwingSeat,
} as Pick<ToolsSectionComponentProps, 'usePanelInfo' | 'useSessions' | 'useSessionStatus'
| 'useSessionRetainInfo' | 'useWorkspaces' | 'useResource'
| 'useRemoteAccess' | 'useSessionAccess' | 'useWorkspaceAccess'>

/** Throws on call: a seat this spec deliberately leaves without a value. */
function throwingSeat(): never {
  throw new Error('unused seat')
}

/** One live form over a fixed value, recording every write. */
function form<T extends object>(value: T | undefined): ConfigForm<T> & {
  set: ReturnType<typeof vi.fn>
  mutate: ReturnType<typeof vi.fn>
} {
  const snapshot = {
    status: value === undefined ? 'loading' as const : 'ready' as const,
    value,
    base: undefined,
    user: undefined,
    revision: 1,
    writable: true,
    mode: 'host' as const,
  }
  const set = vi.fn(async () => true)
  const mutate = vi.fn(async () => true)
  return {
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
    set,
    mutate,
    unset: vi.fn(async () => true),
  }
}

/** Render the section with the supplied roster and empty sibling rows. */
function view(roster: RosterFields | undefined) {
  const rosterForm = form(roster)
  render(
    <ToolsSection
      t={key => translations.get(key) ?? key}
      close={() => {}}
      {...unusedSeats}
      roster={rosterForm}
      kernel={form<KernelFields>(undefined)}
      browser={form<BrowserFields>(undefined)}
    />,
  )
  return rosterForm
}

/** The switch that governs one tool, by its name. */
function toolSwitch(name: string): HTMLElement {
  return screen.getByRole('switch', { name })
}

it('lists one switch per tool the roster knows, and nothing else', () => {
  view({ kernel: true, enabled: true, tools: { grep: true, read: true, write: false } })
  expect(screen.getByRole('switch', { name: 'grep' })).toBeTruthy()
  expect(screen.getByRole('switch', { name: 'write' })).toBeTruthy()
  // The category switches are named by copy, not by a tool name.
  expect(screen.getByRole('switch', { name: en['tools.kernel.label'] })).toBeTruthy()
  expect(screen.getByRole('switch', { name: en['tools.category.label'] })).toBeTruthy()
  expect(screen.queryByRole('switch', { name: 'kernel' })).toBeNull()
})

it('reads a map entry as the switch state', () => {
  view({ tools: { read: false, write: true } })
  expect(toolSwitch('read').getAttribute('aria-checked')).toBe('false')
  expect(toolSwitch('write').getAttribute('aria-checked')).toBe('true')
})

it('writes a flip as a nested entry rather than a field named after the tool', async () => {
  const roster = view({ tools: { read: true } })
  fireEvent.click(toolSwitch('read'))
  expect(roster.mutate).toHaveBeenCalledWith([{ op: 'set', path: ['tools', 'read'], value: false }])
  expect(roster.set).not.toHaveBeenCalled()
})

it('re-enables a tool that is switched off', () => {
  const roster = view({ tools: { read: false } })
  fireEvent.click(toolSwitch('read'))
  expect(roster.mutate).toHaveBeenCalledWith([{ op: 'set', path: ['tools', 'read'], value: true }])
})

it('narrows the list to the names the filter matches', () => {
  view({ tools: { grep: true, read: true, write: true } })
  fireEvent.change(screen.getByRole('textbox', { name: en['tools.roster.filter'] }), { target: { value: 'wr' } })
  expect(screen.queryByRole('switch', { name: 'grep' })).toBeNull()
  expect(screen.getByRole('switch', { name: 'write' })).toBeTruthy()
})

it('says so when the filter matches nothing, and when the roster is empty', () => {
  view({ tools: { read: true } })
  fireEvent.change(screen.getByRole('textbox', { name: en['tools.roster.filter'] }), { target: { value: 'zzz' } })
  expect(screen.getByText(en['tools.roster.empty'])).toBeTruthy()
  cleanup()
  view({})
  expect(screen.queryByRole('switch', { name: 'read' })).toBeNull()
  expect(screen.getByText(en['tools.roster.empty'])).toBeTruthy()
})

it('no longer renders a preset group', () => {
  view({ tools: {} })
  expect(screen.queryByText('Presets')).toBeNull()
  expect(screen.queryByText(/preset/i)).toBeNull()
})
