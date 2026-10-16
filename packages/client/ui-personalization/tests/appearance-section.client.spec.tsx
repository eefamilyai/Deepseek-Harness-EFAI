// @vitest-environment jsdom
/**
 * The Personalization section's form.
 *
 * The engine has its own specs and so does the policy, but neither would notice a control
 * wired to the wrong field or to none at all - which is the failure mode an operator sees
 * as "this control does nothing" or "that number will not change". Every control here is
 * driven the way a person drives it, and asserted through the record the display follows.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useSyncExternalStore } from 'react'
import { afterEach, expect, it } from 'vitest'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import { APPEARANCE_DEFAULTS, type AppearanceValues } from '../src/options.ts'
import { AppearancePolicy, type AppearanceRowStatus } from '../src/client/appearance-store.ts'
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
function view(initial: Partial<AppearanceValues> = {}, status: AppearanceRowStatus = 'ready') {
  const policy = new AppearancePolicy(undefined)
  policy.appearance.set({ ...policy.values(), ...initial })
  policy.rowStatus.set(status)
  const props = {
    t,
    close: () => {},
    hooks: { appearance: policy.appearance, saveState: policy.saveState, rowStatus: policy.rowStatus },
    useAppearance: bind(policy.appearance),
    useSaveState: bind(policy.saveState),
    useRowStatus: bind(policy.rowStatus),
    set: (field: keyof AppearanceValues, value: never) => { policy.set(field, value) },
    reset: () => { policy.reset() },
  } as unknown as AppearanceSectionComponentProps
  render(<AppearanceSection {...props} />)
  return policy
}

/** One numeric control by its accessible name. */
function numberField(label: string): HTMLInputElement {
  return screen.getByRole('spinbutton', { name: label }) as HTMLInputElement
}

/** Type a number and commit it the way a person does. */
function commitNumber(label: string, value: string): void {
  fireEvent.change(numberField(t(label)), { target: { value } })
  fireEvent.keyDown(numberField(t(label)), { key: 'Enter' })
}

it('renders every group and one control per appearance field', () => {
  view()
  for (const group of ['typography', 'colour', 'layout', 'opacity', 'effects']) {
    expect(screen.getByRole('region', { name: t(`appearance.group.${group}`) })).toBeTruthy()
  }
  for (const label of ['appearance.font.label', 'appearance.codeFont.label', 'appearance.fontScale.label',
    'appearance.lineHeight.label', 'appearance.accent.label', 'appearance.accentEverywhere.label',
    'appearance.contentWidth.label', 'appearance.settingsWidth.label', 'appearance.radius.label',
    'appearance.scrollbars.label', 'appearance.shell.label', 'appearance.surface.label', 'appearance.panel.label',
    'appearance.blur.label', 'appearance.backdrop.label', 'appearance.shadows.label', 'appearance.reduceMotion.label']) {
    expect(screen.getAllByText(t(label)).length, label).toBeGreaterThan(0)
  }
})

it('writes a preset to its own field, and the number follows in the same step', () => {
  const policy = view()
  const glass = screen.getAllByText(t('appearance.opacity.glass'))
  expect(glass).toHaveLength(3)
  // The second Glass pill is the surface row's.
  fireEvent.click(glass[1] as HTMLElement)
  expect(policy.values().surfaceOpacity).toBe(65)
  expect(numberField(t('appearance.surface.label')).value).toBe('65')
  // The other two levels are untouched.
  expect(policy.values().shellOpacity).toBe(100)
  expect(policy.values().panelOpacity).toBe(100)
})

it('writes each numeric field from its own number control, inside its range', () => {
  const policy = view()
  commitNumber('appearance.shell.label', '35')
  commitNumber('appearance.panel.label', '55')
  commitNumber('appearance.lineHeight.label', '130')
  commitNumber('appearance.blur.label', '12')
  commitNumber('appearance.fontScale.label', '400')
  expect(policy.values()).toMatchObject({ shellOpacity: 35, panelOpacity: 55, lineHeight: 130, glassBlur: 12, fontScale: 150 })
  expect(numberField(t('appearance.panel.label')).value).toBe('55')
})

it('writes the font stacks, the accent, and the corner scale', () => {
  const policy = view()
  const font = screen.getByRole('textbox', { name: t('appearance.font.label') })
  fireEvent.change(font, { target: { value: 'Inter, system-ui, sans-serif' } })
  fireEvent.keyDown(font, { key: 'Enter' })
  expect(policy.values().fontFamily).toBe('Inter, system-ui, sans-serif')

  fireEvent.click(screen.getByRole('button', { name: t('appearance.codeFontPreset.consolas') }))
  expect(policy.values().codeFontFamily).toBe('"Consolas", "Courier New"')

  fireEvent.click(screen.getByRole('button', { name: t('appearance.accentPreset.violet') }))
  expect(policy.values().accent).toBe('#7c5cff')
  expect(screen.getByRole('button', { name: t('appearance.accentPreset.violet') }).getAttribute('aria-pressed')).toBe('true')

  fireEvent.change(screen.getByLabelText(t('appearance.accent.picker')), { target: { value: '#123456' } })
  expect(policy.values().accent).toBe('#123456')

  fireEvent.click(screen.getByRole('button', { name: t('appearance.radius.square') }))
  expect(policy.values().radiusScale).toBe(0)
})

it('writes the layout and effect choices', () => {
  const policy = view()
  fireEvent.click(screen.getByRole('button', { name: t('appearance.contentWidth.full') }))
  // Both width rows offer "Wider"; the second is the settings panel's.
  fireEvent.click(screen.getAllByRole('button', { name: t('appearance.settingsWidth.wider') })[1] as HTMLElement)
  fireEvent.click(screen.getByRole('button', { name: t('appearance.scrollbars.thin') }))
  fireEvent.click(screen.getByRole('button', { name: t('appearance.shadows.strong') }))
  fireEvent.click(screen.getByRole('switch', { name: t('appearance.reduceMotion.label') }))
  fireEvent.click(screen.getByRole('switch', { name: t('appearance.accentEverywhere.label') }))
  expect(policy.values()).toMatchObject({
    contentWidth: 'full', settingsWidth: 'wider', scrollbars: 'thin', shadows: 'strong',
    reduceMotion: true, accentEverywhere: true,
  })
})

it('chooses a backdrop, and asks for an address only when the backdrop is an image', () => {
  const policy = view()
  expect(screen.queryByRole('textbox', { name: t('appearance.backdropImage.label') })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: t('appearance.backdrop.sunset') }))
  expect(policy.values()).toMatchObject({ backdrop: 'sunset', shellOpacity: 80, surfaceOpacity: 80 })

  fireEvent.click(screen.getByRole('button', { name: t('appearance.backdrop.image') }))
  const address = screen.getByRole('textbox', { name: t('appearance.backdropImage.label') })
  fireEvent.change(address, { target: { value: 'not a url' } })
  fireEvent.keyDown(address, { key: 'Enter' })
  expect(screen.getByRole('alert').textContent).toBe(t('appearance.backdropImage.invalid'))
  fireEvent.change(address, { target: { value: 'https://example.com/w.jpg' } })
  fireEvent.keyDown(address, { key: 'Enter' })
  expect(policy.values().backdropImage).toBe('https://example.com/w.jpg')
  expect(screen.queryByRole('alert')).toBeNull()
})

it('resets every field at once', () => {
  const policy = view({ shellOpacity: 35, panelOpacity: 40, backdrop: 'ocean', reduceMotion: true })
  fireEvent.click(screen.getByRole('button', { name: t('appearance.reset.action') }))
  expect(policy.values()).toEqual(APPEARANCE_DEFAULTS)
})

it('says when a choice could not be saved', () => {
  const policy = view()
  expect(screen.queryByRole('status')).toBeNull()
  act(() => { policy.saveState.set({ refused: ['backdrop'] }) })
  expect(screen.getByRole('status').textContent).toBe(t('appearance.refused'))
})

it('reports a deployment that composes no row', () => {
  view({}, 'unavailable')
  expect(screen.getByText(t('appearance.unavailable'))).toBeTruthy()
})

it('keeps the controls while the Host has not answered yet', () => {
  view({}, 'loading')
  expect(screen.queryByText(t('appearance.unavailable'))).toBeNull()
})
