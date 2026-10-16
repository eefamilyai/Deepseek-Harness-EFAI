// @vitest-environment jsdom
/**
 * The Skills page: listing, opening, creating, saving, renaming, deleting,
 * read-only copies, unsaved-change questions, the builder column, and the
 * embedded conversation seat.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { en } from '../src/client/locales.ts'
import { REFRESH_MS, SkillsPage, SkillsPanelIcon, type Answer, type SkillsPageProps } from '../src/client/SkillsPage.tsx'
import { BuilderConversation, ChatOnlyView, type BuilderConversationProps } from '../src/client/BuilderConversation.tsx'
import type { BuilderView } from '../src/client/builder.ts'
import type { SkillDocument, SkillsCatalog } from '../src/types.ts'

afterEach(() => { cleanup(); vi.useRealTimers() })

const t = ((key: keyof typeof en, params?: Record<string, string>) =>
  en[key].replace(/\{(\w+)\}/g, (_, name: string) => params?.[name] ?? '')) as SkillsPageProps['t']

const USER = 'C:/u/.dsh/skills'
const catalog: SkillsCatalog = {
  roots: [
    { path: 'D:/w/.dsh/skills', source: 'project-dsh', writable: true, project: 'D:/w' },
    { path: USER, source: 'user-dsh', writable: true },
    { path: 'C:/u/.agents/skills', source: 'user-agents', writable: true },
    { path: 'B:/bundled', source: 'bundled', writable: false },
  ],
  skills: [
    { name: 'alpha', description: 'Use when alpha.', file: `${USER}/alpha/SKILL.md`, root: USER, source: 'user-dsh', writable: true, userInvocable: false, modelInvocable: false },
    { name: 'broken', description: '', file: `${USER}/broken/SKILL.md`, root: USER, source: 'user-dsh', writable: true, userInvocable: true, modelInvocable: true, problem: 'missing YAML frontmatter', shadowedBy: 'x' },
    { name: 'proj', description: 'p', file: 'D:/w/.dsh/skills/proj/SKILL.md', root: 'D:/w/.dsh/skills', source: 'project-dsh', writable: true, userInvocable: true, modelInvocable: true },
    { name: 'shipped', description: 'Use when shipped.', file: 'B:/bundled/shipped/SKILL.md', root: 'B:/bundled', source: 'bundled', writable: false, userInvocable: true, modelInvocable: true },
  ],
}

const doc = (name: string, overrides: Partial<SkillDocument> = {}): SkillDocument => ({
  file: `${USER}/${name}/SKILL.md`, root: USER, writable: true, name, description: `Use when ${name}.`, whenToUse: '',
  userInvocable: true, modelInvocable: true, body: `# ${name}`, ...overrides,
})

function setup(options: {
  load?: () => Promise<Answer<SkillsCatalog>>
  builder?: BuilderView<never>
  read?: (file: string) => Promise<Answer<SkillDocument>>
} = {}) {
  const calls = {
    load: vi.fn(options.load ?? (async () => ({ ok: true as const, value: catalog }))),
    read: vi.fn(options.read ?? (async (file: string) => {
      const name = file.split('/').at(-2)!
      return { ok: true as const, value: name === 'shipped' ? doc('shipped', { file, root: 'B:/bundled', writable: false }) : name === 'broken' ? doc('broken', { problem: 'missing YAML frontmatter' }) : doc(name) }
    })),
    save: vi.fn(async (request: { name: string; root: string }) => ({ ok: true as const, value: { file: `${request.root}/${request.name}/SKILL.md` } })),
    remove: vi.fn(async () => ({ ok: true as const, value: { trashedTo: 'C:/u/.dsh/skills-trash/alpha-1' } })),
    openBuilder: vi.fn(),
    freshBuilder: vi.fn(),
    closeBuilder: vi.fn(),
    launchBuilder: vi.fn(async () => null as string | null),
  }
  const view = options.builder ?? { kind: 'closed' }
  const renderSlot = vi.fn(() => <div data-testid="builder-chat" />)
  const SessionProvider = ({ children }: { children: unknown }) => <div data-testid="session">{children as never}</div>
  const props: SkillsPageProps = {
    t, ...calls, useBuilder: <R,>(select: (value: BuilderView<never>) => R): R => select(view), renderSlot, SessionProvider,
  } as never
  render(<SkillsPage {...props} />)
  return { calls, renderSlot }
}

const button = (name: string | RegExp) => screen.getByRole('button', { name })
const field = (id: string) => document.querySelector<HTMLInputElement & HTMLTextAreaElement>(`#${id}`)!

describe('the Skills page', () => {
  it('lists skills by folder with their tags, and filters them', async () => {
    setup()
    expect(screen.getByText(en.loading)).toBeTruthy()
    await screen.findByText('alpha')
    expect(screen.getByText(en['source.user-dsh'])).toBeTruthy()
    expect(screen.getByText('w')).toBeTruthy()
    expect(screen.getByText(en.broken)).toBeTruthy()
    expect(screen.getByText(en.shadowed)).toBeTruthy()
    expect(screen.getByText(en.userOnly)).toBeTruthy()
    expect(screen.getByText(en.hidden)).toBeTruthy()
    expect(screen.queryByText(en['source.user-agents'])).toBeNull()
    fireEvent.change(screen.getByRole('textbox', { name: en.search }), { target: { value: 'nothing' } })
    expect(screen.getByText(en.noMatch)).toBeTruthy()
    fireEvent.change(screen.getByRole('textbox', { name: en.search }), { target: { value: '' } })
    fireEvent.click(button(en.refresh))
    await waitFor(() => { expect(screen.getAllByText('alpha')).toHaveLength(1) })
  })

  it('shows a load failure and an empty catalog', async () => {
    setup({ load: async () => ({ ok: false, message: 'offline' }) })
    expect(await screen.findByText('Could not read skills: offline')).toBeTruthy()
    cleanup()
    setup({ load: async () => ({ ok: true, value: { roots: catalog.roots, skills: [] } }) })
    expect(await screen.findByText(en.empty)).toBeTruthy()
    cleanup()
    setup({ load: async () => ({ ok: true, value: { roots: [catalog.roots[3]!], skills: [catalog.skills[3]!] } }) })
    fireEvent.change(await screen.findByRole('textbox', { name: en.search }), { target: { value: 'zzz' } })
    expect(screen.getByText(en.noMatch)).toBeTruthy()
    fireEvent.change(screen.getByRole('textbox', { name: en.search }), { target: { value: '' } })
    expect(screen.getByText('shipped')).toBeTruthy()
  })

  it('reports an empty list when only empty groups are left', async () => {
    setup({ load: async () => ({ ok: true, value: { roots: [catalog.roots[1]!], skills: [{ ...catalog.skills[0]!, root: 'elsewhere' }] } }) })
    expect(await screen.findByText(en.empty)).toBeTruthy()
  })

  it('opens a skill, edits it, saves it, and reports where it went', async () => {
    const { calls } = setup()
    fireEvent.click(await screen.findByText('alpha'))
    await waitFor(() => { expect(field('skills-studio-name').value).toBe('alpha') })
    expect((button(en.save) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(field('skills-studio-name'), { target: { value: 'Alpha Two' } })
    fireEvent.change(field('skills-studio-description'), { target: { value: 'Use when two.' } })
    fireEvent.change(field('skills-studio-when'), { target: { value: 'later' } })
    fireEvent.change(field('skills-studio-body'), { target: { value: '# Two' } })
    fireEvent.click(screen.getByRole('switch', { name: en.userInvocable }))
    fireEvent.click(screen.getByRole('switch', { name: en.modelInvocable }))
    expect(screen.getByText(en.unsaved)).toBeTruthy()
    fireEvent.click(button(en.revert))
    expect(field('skills-studio-name').value).toBe('alpha')
    fireEvent.change(field('skills-studio-name'), { target: { value: 'alpha-two' } })
    fireEvent.click(button(en.save))
    await screen.findByText(`Saved to ${USER}/alpha-two/SKILL.md`)
    expect(calls.save).toHaveBeenCalledWith(expect.objectContaining({ name: 'alpha-two', file: `${USER}/alpha/SKILL.md`, root: USER }))
    expect(calls.read).toHaveBeenLastCalledWith(`${USER}/alpha-two/SKILL.md`)
  })

  it('shows the loader problem of a broken skill and a failed open', async () => {
    let fail = false
    setup({ read: async file => fail ? { ok: false, message: 'gone' } : { ok: true, value: doc('broken', { file, problem: 'missing YAML frontmatter' }) } })
    fireEvent.click(await screen.findByText('broken'))
    expect(await screen.findByText('The loader ignores this file: missing YAML frontmatter')).toBeTruthy()
    fail = true
    fireEvent.click(screen.getByText('alpha'))
    expect(await screen.findByText('That did not work: gone')).toBeTruthy()
  })

  it('creates a skill in the chosen folder, and reports a refused save', async () => {
    const { calls } = setup()
    await screen.findByText('alpha')
    fireEvent.click(button(en.new))
    expect(field('skills-studio-root').value).toBe(USER)
    fireEvent.change(field('skills-studio-root'), { target: { value: 'C:/u/.agents/skills' } })
    fireEvent.change(field('skills-studio-name'), { target: { value: 'my skill' } })
    expect(field('skills-studio-name').value).toBe('my-skill')
    calls.save.mockResolvedValueOnce({ ok: false, message: 'exists' } as never)
    fireEvent.submit(field('skills-studio-name').closest('form')!)
    expect(await screen.findByText('That did not work: exists')).toBeTruthy()
    fireEvent.click(button(en.create))
    await screen.findByText('Saved to C:/u/.agents/skills/my-skill/SKILL.md')
  })

  it('asks before dropping unsaved changes, and keeps editing or discards', async () => {
    setup()
    fireEvent.click(await screen.findByText('alpha'))
    await waitFor(() => { expect(field('skills-studio-name').value).toBe('alpha') })
    fireEvent.change(field('skills-studio-body'), { target: { value: 'changed' } })
    fireEvent.click(screen.getByText('proj'))
    expect(screen.getByRole('dialog', { name: en.discardTitle })).toBeTruthy()
    fireEvent.click(button(en.keep))
    expect(field('skills-studio-body').value).toBe('changed')
    fireEvent.click(screen.getByText('proj'))
    fireEvent.click(button(en.discard))
    await waitFor(() => { expect(field('skills-studio-name').value).toBe('proj') })
    fireEvent.click(button(en.new))
    fireEvent.click(screen.getByText('alpha'))
    await waitFor(() => { expect(field('skills-studio-name').value).toBe('alpha') })
    fireEvent.click(button(en.new))
    fireEvent.change(field('skills-studio-description'), { target: { value: 'typed' } })
    fireEvent.click(button(en.new))
    expect(screen.getByText('The changes to New skill are not saved.')).toBeTruthy()
  })

  it('deletes a skill after confirming, and reports a refusal', async () => {
    const { calls } = setup()
    fireEvent.click(await screen.findByText('alpha'))
    await waitFor(() => { expect(field('skills-studio-name').value).toBe('alpha') })
    fireEvent.click(button(en.remove))
    expect(screen.getByRole('dialog', { name: 'Delete the skill alpha?' })).toBeTruthy()
    fireEvent.click(screen.getAllByRole('button', { name: en.cancel }).at(-1)!)
    calls.remove.mockResolvedValueOnce({ ok: false, message: 'locked' } as never)
    fireEvent.click(button(en.remove))
    fireEvent.click(screen.getAllByRole('button', { name: en.remove }).at(-1)!)
    expect(await screen.findByText('That did not work: locked')).toBeTruthy()
    fireEvent.click(button(en.remove))
    fireEvent.click(screen.getAllByRole('button', { name: en.remove }).at(-1)!)
    expect(await screen.findByText('Moved to C:/u/.dsh/skills-trash/alpha-1')).toBeTruthy()
    expect(screen.getByText(en.pick)).toBeTruthy()
  })

  it('shows a bundled skill read-only and copies it to the user folder', async () => {
    setup()
    fireEvent.click(await screen.findByText('shipped'))
    expect(await screen.findByText(en.readOnly)).toBeTruthy()
    expect(screen.queryByRole('button', { name: en.save })).toBeNull()
    fireEvent.click(button(en.duplicate))
    expect(field('skills-studio-root').value).toBe(USER)
    expect(button(en.create)).toBeTruthy()
  })

  it('shows a read-only skill without a writable folder to copy into', async () => {
    setup({ load: async () => ({ ok: true, value: { roots: [catalog.roots[3]!], skills: [catalog.skills[3]!] } }) })
    fireEvent.click(await screen.findByText('shipped'))
    expect(await screen.findByText(en.readOnly)).toBeTruthy()
    expect(screen.queryByRole('button', { name: en.duplicate })).toBeNull()
    expect((button(en.new) as HTMLButtonElement).disabled).toBe(true)
  })

  it('shows the loader problem under a read-only skill', async () => {
    setup({ read: async file => ({ ok: true, value: doc('shipped', { file, root: 'B:/bundled', writable: false, problem: 'bad' }) }) })
    fireEvent.click(await screen.findByText('shipped'))
    expect(await screen.findByText('The loader ignores this file: bad')).toBeTruthy()
  })

  it('opens the builder, starts a builder session, and reports a launch failure', async () => {
    const { calls } = setup()
    await screen.findByText('alpha')
    fireEvent.click(button(new RegExp(`^${en.builder}$`)))
    expect(calls.openBuilder).toHaveBeenCalledOnce()
    fireEvent.click(button(en.builderSession))
    await waitFor(() => { expect(calls.launchBuilder).toHaveBeenCalledOnce() })
    calls.launchBuilder.mockResolvedValueOnce('no workspace')
    fireEvent.click(button(en.builderSession))
    expect(await screen.findByText('Could not start the Skill Builder: no workspace')).toBeTruthy()
  })

  it('renders the builder column in each state, and refreshes the list while it is open', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const open = setup({ builder: { kind: 'open', reference: 'ref' as never } })
    await screen.findByText('alpha')
    expect(screen.getByTestId('builder-chat')).toBeTruthy()
    expect(open.renderSlot).toHaveBeenCalledWith('skillsStudio.builder.conversation', {})
    await act(async () => { vi.advanceTimersByTime(REFRESH_MS) })
    expect(open.calls.load).toHaveBeenCalledTimes(2)
    fireEvent.click(button(en['builder.new']))
    expect(open.calls.freshBuilder).toHaveBeenCalledOnce()
    fireEvent.click(button(en['builder.close']))
    expect(open.calls.closeBuilder).toHaveBeenCalledOnce()
    fireEvent.click(button(new RegExp(`^${en.builder}$`)))
    expect(open.calls.closeBuilder).toHaveBeenCalledTimes(2)
    cleanup()
    setup({ builder: { kind: 'starting' } })
    expect(screen.getByText(en['builder.starting'])).toBeTruthy()
    cleanup()
    const failed = setup({ builder: { kind: 'failed', message: 'boom' } })
    expect(screen.getByText('Could not start the Skill Builder: boom')).toBeTruthy()
    fireEvent.click(button(en['builder.retry']))
    expect(failed.calls.closeBuilder).toHaveBeenCalledOnce()
    expect(failed.calls.openBuilder).toHaveBeenCalledOnce()
  })

  it('draws the sidebar glyph', () => {
    const { container } = render(<>{SkillsPanelIcon({ size: 16 } as never)}</>)
    expect(container.querySelector('svg')).toBeTruthy()
  })
})

describe('the embedded conversation', () => {
  function conversation(session: Record<string, unknown>, targets = 0, summaryBlank?: boolean) {
    const renderFactorySlot = vi.fn(() => null)
    const props: BuilderConversationProps = {
      sessionId: 's1',
      useSession: (select: (value: unknown) => unknown) => select({ blank: true, awaitingFirstTurn: true, running: false, promptAttempted: false, openState: 'open', ...session }),
      useConversation: (select: (value: unknown) => unknown) =>
        select({ activeTargets: new Set(Array.from({ length: targets }, (_, i) => i)) }),
      useSessions: (select: (value: unknown) => unknown) =>
        select({ byId: summaryBlank === undefined ? {} : { s1: { blank: summaryBlank } } }),
      renderFactorySlot,
    } as never
    BuilderConversation(props)
    return renderFactorySlot.mock.calls[0]!.slice(1, 2)[0] as unknown as { phase: string; hero: boolean }
  }

  it('shows the welcome until the first turn, settles while loading, then the conversation', () => {
    expect(conversation({})).toEqual({ variant: 'embedded', phase: 'hero', hero: true })
    expect(conversation({ openState: 'loading' })).toEqual({ variant: 'embedded', phase: 'settling', hero: false })
    expect(conversation({ openState: 'loading' }, 0, true)).toEqual({ variant: 'embedded', phase: 'hero', hero: true })
    expect(conversation({ promptAttempted: true })).toEqual({ variant: 'embedded', phase: 'active', hero: false })
    expect(conversation({}, 1).phase).toBe('active')
    expect(conversation({ blank: false, awaitingFirstTurn: false }).phase).toBe('active')
    expect(conversation({ running: true }).phase).toBe('active')
  })

  it('fixes the views to chat', () => {
    const renderSlot = vi.fn(() => null)
    render(<ChatOnlyView {...({ renderSlot } as unknown as Parameters<typeof ChatOnlyView>[0])} />)
    expect(renderSlot).toHaveBeenCalledWith('conversation.session', { view: 'chat' })
  })
})
