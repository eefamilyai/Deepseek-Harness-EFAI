// @vitest-environment jsdom
/**
 * The Personalization section's form.
 *
 * The engine has its own specs and so does the policy, but neither would notice a control
 * wired to the wrong field or to none at all - which is the failure mode an operator sees
 * as "this control does nothing" or "that number will not change". Every control here is
 * driven the way a person drives it, and asserted through the store the display follows.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useSyncExternalStore } from 'react'
import { afterEach, expect, it } from 'vitest'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import { APPEARANCE_DEFAULTS, type AppearanceValues } from '../src/client/appearance.ts'
import { AppearancePolicy } from '../src/client/appearance-store.ts'
import { AppearanceSection, type AppearanceSectionComponentProps } from '../src/client/AppearanceSection.tsx'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

const translations: ReadonlyMap<string, string> = new Map(Object.entries(en))
/** The locale seat: every key this section asks for, or the key itself when missing. */
const t = (key: string): string => translations.get(key) ?? key

/**
 * The framework's selector hook over one store: what the renderer binds for a `hooks`
 * entry. Subscribing here is the render machinery's job in production and its stand-in in
 * a spec.
 * @param store - the store to bind.
 * @returns the selector hook over it.
 */
function bind<T>(store: SnapshotStore<T>): (select: (value: T) => T) => T {
  return select => useSyncExternalStore(store.subscribe.bind(store), () => select(store.getSnapshot()))
}

/** Render the section over a fresh policy, and return that policy. */
function view(initial: Partial<AppearanceValues> = {}, status: 'ready' | 'unavailable' = 'ready') {
  const policy = new AppearancePolicy(undefined)
  for (const [field, value] of Object.entries(initial)) {
    (policy[field as keyof AppearancePolicy] as SnapshotStore<unknown>).set(value)
  }
  const props = {
    t,
    close: () => {},
    status,
    hooks: {
      fontFamily: policy.fontFamily,
      fontScale: policy.fontScale,
      accent: policy.accent,
      radiusScale: policy.radiusScale,
      shellOpacity: policy.shellOpacity,
      surfaceOpacity: policy.surfaceOpacity,
      panelOpacity: policy.panelOpacity,
    },
    useFontFamily: bind(policy.fontFamily),
    useFontScale: bind(policy.fontScale),
    useAccent: bind(policy.accent),
    useRadiusScale: bind(policy.radiusScale),
    useShellOpacity: bind(policy.shellOpacity),
    useSurfaceOpacity: bind(policy.surfaceOpacity),
    usePanelOpacity: bind(policy.panelOpacity),
    setFontFamily: (value: string) => { policy.setFontFamily(value) },
    setFontScale: (value: number) => { policy.setFontScale(value) },
    setAccent: (value: string) => { policy.setAccent(value) },
    setRadiusScale: (value: number) => { policy.setRadiusScale(value) },
    setShellOpacity: (value: number) => { policy.setShellOpacity(value) },
    setSurfaceOpacity: (value: number) => { policy.setSurfaceOpacity(value) },
    setPanelOpacity: (value: number) => { policy.setPanelOpacity(value) },
    reset: () => { policy.reset() },
  } as unknown as AppearanceSectionComponentProps
  render(<AppearanceSection {...props} />)
  return policy
}

/** One numeric control by its accessible name. */
function numberField(label: string): HTMLInputElement {
  return screen.getByRole('spinbutton', { name: label }) as HTMLInputElement
}

it('renders one control per appearance field, under the three groups', () => {
  view()
  for (const label of ['appearance.font.label', 'appearance.accent.label', 'appearance.radius.label',
    'appearance.shell.label', 'appearance.surface.label', 'appearance.panel.label']) {
    expect(screen.getByText(t(label)), label).toBeTruthy()
  }
  expect(screen.getByText(t('appearance.opacity.title'))).toBeTruthy()
  expect(numberField(t('appearance.shell.label'))).toBeTruthy()
  expect(numberField(t('appearance.surface.label'))).toBeTruthy()
  expect(numberField(t('appearance.panel.label'))).toBeTruthy()
})

it('writes a preset to its own field, and the number follows in the same step', () => {
  const policy = view()
  const glass = screen.getAllByText(t('appearance.opacity.glass'))
  expect(glass).toHaveLength(3)
  // The second Glass pill is the surface row's.
  fireEvent.click(glass[1] as HTMLElement)
  expect(policy.surfaceOpacity.getSnapshot()).toBe(65)
  expect(numberField(t('appearance.surface.label')).value).toBe('65')
  // The other two levels are untouched.
  expect(policy.shellOpacity.getSnapshot()).toBe(100)
  expect(policy.panelOpacity.getSnapshot()).toBe(100)
})

it('writes each opacity field from its own number control', () => {
  const policy = view()
  fireEvent.change(numberField(t('appearance.shell.label')), { target: { value: '35' } })
  fireEvent.keyDown(numberField(t('appearance.shell.label')), { key: 'Enter' })
  expect(policy.shellOpacity.getSnapshot()).toBe(35)

  fireEvent.change(numberField(t('appearance.panel.label')), { target: { value: '55' } })
  fireEvent.keyDown(numberField(t('appearance.panel.label')), { key: 'Enter' })
  expect(policy.panelOpacity.getSnapshot()).toBe(55)
  expect(numberField(t('appearance.panel.label')).value).toBe('55')
})

it('writes the font stack, the accent, and the corner scale', () => {
  const policy = view()
  const font = screen.getByRole('textbox', { name: t('appearance.font.label') })
  fireEvent.change(font, { target: { value: 'Inter, system-ui, sans-serif' } })
  fireEvent.keyDown(font, { key: 'Enter' })
  expect(policy.fontFamily.getSnapshot()).toBe('Inter, system-ui, sans-serif')

  fireEvent.click(screen.getByText(t('appearance.accentPreset.violet')))
  expect(policy.accent.getSnapshot()).toBe('#7c5cff')

  fireEvent.change(numberField(t('appearance.radius.label')), { target: { value: '0' } })
  fireEvent.keyDown(numberField(t('appearance.radius.label')), { key: 'Enter' })
  expect(policy.radiusScale.getSnapshot()).toBe(0)
})

it('resets every field at once', () => {
  const policy = view({ shellOpacity: 35, panelOpacity: 40 })
  fireEvent.click(screen.getByRole('button', { name: t('appearance.reset.action') }))
  expect(policy.values()).toEqual(APPEARANCE_DEFAULTS)
})

it('shows the stored percentages, including a fraction the first build wrote', () => {
  view({ shellOpacity: 0.65, panelOpacity: 55 })
  expect(numberField(t('appearance.shell.label')).value).toBe('65')
  expect(numberField(t('appearance.panel.label')).value).toBe('55')
})

it('reports a deployment that composes no row', () => {
  view({}, 'unavailable')
  expect(screen.getByText(t('appearance.unavailable'))).toBeTruthy()
})
