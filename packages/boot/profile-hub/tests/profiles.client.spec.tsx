// @vitest-environment jsdom
/**
 * The profiles surfaces: what the page lists, which gesture reaches which Host
 * call, the two ways to enter a profile, and when the landing page opens by
 * itself.
 *
 * The two surfaces answer the same question, so the page cases and the landing
 * cases drive one shared body; what differs is that the landing opens only on
 * the launcher profile and can be dismissed.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProfileHubState, ProfileSummary } from '@deepseek-ai/dsh-profile-hub/types'
import { ProfilesLanding, ProfilesPanel } from '../src/client/ProfilesSurface.tsx'
import type { ProfilesPanelProps } from '../src/client/ProfilesSurface.tsx'
import { en } from '../src/client/locales.ts'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

/** The dictionary seat, with the same `{name}` interpolation the locale service performs. */
const t = ((key: string, params?: Record<string, unknown>) => {
  const template = en[key as keyof typeof en]
  return params === undefined ? template : template.replace(/\{(\w+)\}/g, (_, name: string) => String(params[name]))
}) as ProfilesPanelProps['t']

/** One row's overrides: the two absent-able fields accept an explicit absence. */
type RowOverrides = Omit<Partial<ProfileSummary>, 'chats' | 'workdir'> & {
  readonly name: string
  readonly chats?: number | undefined
  readonly workdir?: string | undefined
}

/** One profile row, overridden per case. */
function profile(overrides: RowOverrides): ProfileSummary {
  const { chats, workdir, ...rest } = overrides
  return {
    title: overrides.name,
    bundles: ['@deepseek-ai/dsh-base'],
    isolated: true,
    locked: false,
    current: false,
    launcher: false,
    running: false,
    ...rest,
    ...chats === undefined ? {} : { chats },
    ...workdir === undefined ? {} : { workdir },
  }
}

/** A machine state over the given rows. */
function state(profiles: ProfileSummary[], overrides: Partial<ProfileHubState> = {}): ProfileHubState {
  return {
    home: 'C:\\Users\\me\\.dsh',
    profilesDir: 'C:\\Users\\me\\.dsh\\profiles',
    current: 'harness',
    launcher: 'desktop',
    landing: false,
    canLaunch: true,
    canOpenDesktop: true,
    profiles,
    ...overrides,
  }
}

/** The spies each case asserts against. */
interface Face {
  readonly load: ReturnType<typeof vi.fn>
  readonly create: ReturnType<typeof vi.fn>
  readonly remove: ReturnType<typeof vi.fn>
  readonly stop: ReturnType<typeof vi.fn>
  readonly makeLauncher: ReturnType<typeof vi.fn>
  readonly openInApp: ReturnType<typeof vi.fn>
  readonly openInBrowser: ReturnType<typeof vi.fn>
}

/**
 * Render one surface with inert Host calls.
 * @param subject - which surface to render.
 * @param initial - the state its first load answers with.
 * @returns the spies each case asserts against.
 */
function renderSurface(subject: 'panel' | 'landing', initial: ProfileHubState): Face {
  const face: Face = {
    load: vi.fn(async () => ({ ok: true as const, state: initial })),
    create: vi.fn(async () => ({ ok: true as const, state: initial })),
    remove: vi.fn(async () => ({ ok: true as const, state: initial })),
    stop: vi.fn(async () => ({ ok: true as const, state: initial })),
    makeLauncher: vi.fn(async () => ({ ok: true as const, state: initial })),
    openInApp: vi.fn(async () => ({ ok: true as const, opened: 'app' as const })),
    openInBrowser: vi.fn(async () => ({ ok: true as const, opened: 'browser' as const })),
  }
  const props = { t, ...face } as unknown as ProfilesPanelProps
  render(subject === 'panel'
    ? <ProfilesPanel {...(props)} />
    : <ProfilesLanding {...(props)} />)
  return face
}

describe('the profiles page', () => {
  it('lists every profile with what it holds, under its own section', async () => {
    renderSurface('panel', state([
      profile({ name: 'harness', title: 'DeepSeek Harness', current: true, launcher: true, chats: 12, workdir: 'D:\\repo', bundles: ['a', 'b', 'c'] }),
      profile({ name: 'school', title: 'School', chats: 3, workdir: 'C:\\School' }),
      profile({ name: 'desktop', title: 'Reserved one', locked: true }),
    ]))
    expect(await screen.findByText('DeepSeek Harness')).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Your profiles' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Reserved' })).toBeTruthy()
    expect(screen.getByText('12 chats')).toBeTruthy()
    expect(screen.getByText('3 bundles')).toBeTruthy()
    expect(screen.getByText('D:\\repo')).toBeTruthy()
    expect(screen.getByText('Current')).toBeTruthy()
    expect(screen.getByText('Opens first')).toBeTruthy()
  })

  it('reports a shared chat list rather than a count a profile does not have', async () => {
    renderSurface('panel', state([profile({ name: 'web', isolated: false, chats: undefined })]))
    expect(await screen.findByText('Shares the home chat list')).toBeTruthy()
  })

  it('shows the reason a failed call gives instead of an empty list', async () => {
    const face = {
      load: vi.fn(async () => ({ ok: false as const, message: 'no such host' })),
      create: vi.fn(), remove: vi.fn(), stop: vi.fn(), makeLauncher: vi.fn(), openInApp: vi.fn(), openInBrowser: vi.fn(),
    }
    render(<ProfilesPanel {...({ t, ...face } as unknown as ProfilesPanelProps)} />)
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'no such host')
  })

  it('says so when the machine holds no profiles', async () => {
    renderSurface('panel', state([]))
    expect(await screen.findByText('No profiles on this machine yet.')).toBeTruthy()
  })
})

describe('the two ways to enter a profile', () => {
  it('opens the Desktop window the row was asked for', async () => {
    const face = renderSurface('panel', state([profile({ name: 'school', title: 'School' })]))
    fireEvent.click(await screen.findByRole('button', { name: 'Open in app' }))
    await waitFor(() => { expect(face.openInApp).toHaveBeenCalledWith('school') })
    expect(await screen.findByRole('status')).toHaveProperty('textContent', 'Opened "school" in the Desktop app.')
    expect(face.openInBrowser, 'only the target that was asked for is used').not.toHaveBeenCalled()
  })

  it('opens the browser host the row was asked for', async () => {
    const face = renderSurface('panel', state([profile({ name: 'school', title: 'School' })]))
    fireEvent.click(await screen.findByRole('button', { name: 'Browser' }))
    await waitFor(() => { expect(face.openInBrowser).toHaveBeenCalledWith('school') })
    expect(face.openInApp).not.toHaveBeenCalled()
  })

  it('offers no second window for the profile this window already runs', async () => {
    const face = renderSurface('panel', state([profile({ name: 'general', title: 'General', current: true })]))
    const appButton = await screen.findByRole('button', { name: 'Open in app' })
    expect(appButton.hasAttribute('disabled')).toBe(true)
    expect(appButton.getAttribute('title')).toBe('This window already runs this profile.')
    fireEvent.click(appButton)
    expect(face.openInApp, 'a second owner of the same profile directory would fight over its lock')
      .not.toHaveBeenCalled()
  })

  it('offers no Desktop target when this host cannot open one', async () => {
    const face = renderSurface('panel', state([profile({ name: 'school' })], { canOpenDesktop: false }))
    const appButton = await screen.findByRole('button', { name: 'Open in app' })
    expect(appButton.hasAttribute('disabled')).toBe(true)
    expect(appButton.getAttribute('title')).toBe('A Desktop window needs the Desktop app to be running this page.')
    fireEvent.click(appButton)
    expect(face.openInApp).not.toHaveBeenCalled()
  })

  it('shows the refusal instead of a status when a launch fails', async () => {
    const face: Face = {
      load: vi.fn(async () => ({ ok: true as const, state: state([profile({ name: 'school' })]) })),
      create: vi.fn(), remove: vi.fn(), stop: vi.fn(), makeLauncher: vi.fn(),
      openInApp: vi.fn(async () => ({ ok: false as const, message: 'the profile is gone' })),
      openInBrowser: vi.fn(),
    }
    render(<ProfilesPanel {...({ t, ...face } as unknown as ProfilesPanelProps)} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Open in app' }))
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'the profile is gone')
  })
})

describe('profile actions', () => {
  /** Open one row's overflow menu. */
  async function openMenu(): Promise<void> {
    fireEvent.click(await screen.findByRole('button', { name: 'More actions' }))
    await screen.findByRole('menuitem', { name: 'Delete' })
  }

  it('deletes only after the row asks again', async () => {
    const face = renderSurface('panel', state([profile({ name: 'school' })]))
    await openMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }))
    expect(face.remove, 'the first gesture only asks').not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    await waitFor(() => { expect(face.remove).toHaveBeenCalledWith('school') })
  })

  it('keeps a row when the second gesture is declined', async () => {
    const face = renderSurface('panel', state([profile({ name: 'school' })]))
    await openMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }))
    fireEvent.click(screen.getByRole('button', { name: 'Keep' }))
    expect(face.remove).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Open in app' })).toBeTruthy()
  })

  it('stops a running profile and can make another one the launcher', async () => {
    const face = renderSurface('panel', state([profile({ name: 'school', title: 'School', running: true })]))
    await openMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Stop' }))
    await waitFor(() => { expect(face.stop).toHaveBeenCalledWith('school') })
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Open on startup' }))
    await waitFor(() => { expect(face.makeLauncher).toHaveBeenCalledWith('school') })
  })

  it('offers no management for a reserved profile that is already the launcher', async () => {
    renderSurface('panel', state([profile({ name: 'desktop', title: 'Theirs', locked: true, launcher: true })]))
    await screen.findByText('Theirs')
    expect(screen.queryByRole('button', { name: 'More actions' })).toBeNull()
  })

  it('offers a reserved profile no way to be removed, but can still stop it', async () => {
    renderSurface('panel', state([profile({ name: 'web', title: 'Theirs', locked: true, running: true })]))
    fireEvent.click(await screen.findByRole('button', { name: 'More actions' }))
    expect(await screen.findByRole('menuitem', { name: 'Stop' })).toBeTruthy()
    expect(screen.queryByRole('menuitem', { name: 'Delete' })).toBeNull()
  })
})

describe('creating a profile', () => {
  it('keeps the form closed until it is asked for, then requires a name', async () => {
    const face = renderSurface('panel', state([]))
    expect(screen.queryByLabelText('Name')).toBeNull()
    fireEvent.click(await screen.findByRole('button', { name: 'New profile' }))
    const create = screen.getByRole('button', { name: 'Create' })
    expect(create.hasAttribute('disabled')).toBe(true)
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'school' } })
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'School' } })
    fireEvent.change(screen.getByLabelText('Working folder'), { target: { value: 'C:\\School' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    await waitFor(() => {
      expect(face.create).toHaveBeenCalledWith({ name: 'school', title: 'School', workdir: 'C:\\School', clone: true })
    })
  })

  it('closes the form again when it is abandoned', async () => {
    renderSurface('panel', state([]))
    fireEvent.click(await screen.findByRole('button', { name: 'New profile' }))
    fireEvent.click(screen.getByRole('button', { name: 'Keep' }))
    expect(screen.queryByLabelText('Name')).toBeNull()
    expect(screen.getByRole('button', { name: 'New profile' })).toBeTruthy()
  })

  it('sends no title or folder the operator left empty, and honours the clone switch', async () => {
    const face = renderSurface('panel', state([]))
    fireEvent.click(await screen.findByRole('button', { name: 'New profile' }))
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'plain' } })
    fireEvent.click(screen.getByLabelText("Start from this profile's settings"))
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    await waitFor(() => { expect(face.create).toHaveBeenCalledWith({ name: 'plain', clone: false }) })
  })
})

describe('the landing page', () => {
  it('opens on the launcher profile', async () => {
    renderSurface('landing', state([profile({ name: 'desktop', launcher: true })], { launcher: 'desktop', landing: true }))
    expect(await screen.findByRole('dialog')).toBeTruthy()
    expect(screen.getAllByText('desktop').length).toBeGreaterThan(0)
  })

  it('stays closed on every other profile', async () => {
    renderSurface('landing', state([profile({ name: 'school' })]))
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
  })

  it('dismisses itself without touching the Host', async () => {
    const face = renderSurface('landing', state([profile({ name: 'desktop' })], { landing: true }))
    fireEvent.click(await screen.findByRole('button', { name: 'Close' }))
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
    expect(face.load).toHaveBeenCalledTimes(1)
  })
})
