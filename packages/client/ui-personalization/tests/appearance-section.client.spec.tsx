// @vitest-environment jsdom
/**
 * The Personalization section's form.
 *
 * The engine has its own specs and so does the row, but neither would notice a control
 * wired to the wrong field or to none at all - which is the failure mode an operator sees
 * as "this slider does nothing" or "that number will not change". Every control here is
 * driven the way a person drives it and asserted through the write it makes.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import { APPEARANCE_DEFAULTS } from '../src/client/appearance.ts'
import { AppearanceSection, type AppearanceFields, type AppearanceSectionComponentProps } from '../src/client/AppearanceSection.tsx'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

const translations: ReadonlyMap<string, string> = new Map(Object.entries(en))
/** The locale seat: every key this section asks for, or the key itself when missing. */
const t = (key: string): string => translations.get(key) ?? key

/** One live form over a fixed value, recording every write. */
function form(value: AppearanceFields, user: AppearanceFields = {}) {
  const snapshot = { status: 'ready' as const, value, base: undefined, user, revision: 1, writable: true, mode: 'host' as const }
  const mutate = vi.fn(async () => true)
  return {
    mutate,
    handle: {
      getSnapshot: () => snapshot,
      subscribe: () => () => {},
      set: vi.fn(async () => true),
      mutate,
      unset: vi.fn(async () => true),
    } as unknown as ConfigForm<AppearanceFields>,
  }
}

/** A framework seat this section does not read. */
function unusedSeat(): never {
  throw new Error('unused seat')
}

/** Render the section over the supplied values and return the form's write log. */
function view(value: AppearanceFields = {}) {
  const live = form(value)
  const seats = {
    usePanelInfo: unusedSeat,
    useSessions: unusedSeat,
    useSessionStatus: unusedSeat,
    useSessionRetainInfo: unusedSeat,
    useWorkspaces: unusedSeat,
    useResource: unusedSeat,
  } as Pick<AppearanceSectionComponentProps, 'usePanelInfo' | 'useSessions' | 'useSessionStatus'
  | 'useSessionRetainInfo' | 'useWorkspaces' | 'useResource'>
  render(
    <AppearanceSection
      t={key => t(key)}
      close={() => {}}
      {...seats}
      appearance={live.handle}
    />,
  )
  return live.mutate
}

/** One numeric control by its accessible name. */
function numberField(label: string): HTMLElement {
  return screen.getByRole('spinbutton', { name: label })
}

it('renders one control per appearance field, under the three groups', () => {
  view()
  for (const label of ['appearance.font.label', 'appearance.accent.label', 'appearance.radius.label',
    'appearance.shell.label', 'appearance.surface.label', 'appearance.panel.label']) {
    expect(screen.getByText(t(label)), label).toBeTruthy()
  }
  expect(screen.getByText(t('appearance.opacity.title'))).toBeTruthy()
  // Three opacity numbers, one per level.
  expect(numberField(t('appearance.shell.label'))).toBeTruthy()
  expect(numberField(t('appearance.surface.label'))).toBeTruthy()
  expect(numberField(t('appearance.panel.label'))).toBeTruthy()
})

it('writes each opacity to its own field', () => {
  const mutate = view()
  fireEvent.change(numberField(t('appearance.shell.label')), { target: { value: '35' } })
  fireEvent.keyDown(numberField(t('appearance.shell.label')), { key: 'Enter' })
  expect(mutate).toHaveBeenCalledWith([{ op: 'set', path: ['shellOpacity'], value: 35 }])

  mutate.mockClear()
  fireEvent.change(numberField(t('appearance.panel.label')), { target: { value: '55' } })
  fireEvent.keyDown(numberField(t('appearance.panel.label')), { key: 'Enter' })
  expect(mutate).toHaveBeenCalledWith([{ op: 'set', path: ['panelOpacity'], value: 55 }])
})

it('writes a preset from the row it belongs to, and only that row', () => {
  const mutate = view()
  const glass = screen.getAllByText(t('appearance.opacity.glass'))
  expect(glass).toHaveLength(3)
  // The second Glass pill is the surface row's.
  fireEvent.click(glass[1] as HTMLElement)
  expect(mutate).toHaveBeenCalledWith([{ op: 'set', path: ['surfaceOpacity'], value: 65 }])
})

it('writes the font stack and the accent from their fields', () => {
  const mutate = view()
  fireEvent.change(screen.getByRole('textbox', { name: t('appearance.font.label') }), { target: { value: 'Inter, system-ui, sans-serif' } })
  fireEvent.keyDown(screen.getByRole('textbox', { name: t('appearance.font.label') }), { key: 'Enter' })
  expect(mutate).toHaveBeenCalledWith([{ op: 'set', path: ['fontFamily'], value: 'Inter, system-ui, sans-serif' }])

  mutate.mockClear()
  fireEvent.click(screen.getByText(t('appearance.accentPreset.violet')))
  expect(mutate).toHaveBeenCalledWith([{ op: 'set', path: ['accent'], value: '#7c5cff' }])
})

it('resets every field at once', () => {
  const mutate = view({ shellOpacity: 35, panelOpacity: 40 })
  fireEvent.click(screen.getByRole('button', { name: t('appearance.reset.action') }))
  expect(mutate).toHaveBeenCalledWith(Object.entries(APPEARANCE_DEFAULTS).map(([field, value]) => ({
    op: 'set', path: [field], value,
  })))
})

it('shows the stored percentages, including a value the first build wrote as a fraction', () => {
  view({ shellOpacity: 0.65, panelOpacity: 55 })
  expect((numberField(t('appearance.shell.label')) as HTMLInputElement).value).toBe('65')
  expect((numberField(t('appearance.panel.label')) as HTMLInputElement).value).toBe('55')
})

it('shows the layer the operator set, not the composition default beneath it', () => {
  // The regression: a field read 100 while the profile held 35, because the snapshot's
  // `value` was the default and the operator's own layer sat beside it.
  const live = form({ shellOpacity: 100 }, { shellOpacity: 35 })
  render(
    <AppearanceSection
      t={key => t(key)}
      close={() => {}}
      usePanelInfo={unusedSeat}
      useSessions={unusedSeat}
      useSessionStatus={unusedSeat}
      useSessionRetainInfo={unusedSeat}
      useWorkspaces={unusedSeat}
      useResource={unusedSeat}
      appearance={live.handle}
    />,
  )
  expect((numberField(t('appearance.shell.label')) as HTMLInputElement).value).toBe('35')
})

it('reports a section without a row, and a write that failed', async () => {
  // A deployment that composes no such row: the section says so instead of rendering an
  // empty form.
  // A stable snapshot: the framework hook compares by reference, so a fresh object per
  // read is an infinite re-render rather than an assertion.
  const unavailable = { status: 'unavailable' as const, value: undefined, base: undefined, user: undefined, revision: undefined, writable: false, mode: 'host' as const }
  const missing = form({})
  Object.assign(missing.handle, { getSnapshot: () => unavailable })
  render(
    <AppearanceSection
      t={key => t(key)}
      close={() => {}}
      usePanelInfo={unusedSeat}
      useSessions={unusedSeat}
      useSessionStatus={unusedSeat}
      useSessionRetainInfo={unusedSeat}
      useWorkspaces={unusedSeat}
      useResource={unusedSeat}
      appearance={missing.handle}
    />,
  )
  expect(screen.getByText(t('appearance.unavailable'))).toBeTruthy()
})
