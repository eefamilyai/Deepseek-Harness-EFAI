// @vitest-environment jsdom
/**
 * The client half's wiring: it mounts its own namespace, registers the sidebar
 * entry, the page, and the embedded conversation, and folds Remote answers for
 * the page.
 */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import contribution from '@deepseek-ai/dsh-skills-studio/remote'
import { apply, inject } from '../src/client/index.ts'
import type { SkillsPageInjected } from '../src/client/SkillsPage.tsx'

const t = (key: string) => key

afterEach(() => { localStorage.clear() })

async function bench(studio?: Record<string, ReturnType<typeof vi.fn>>) {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const slots = ctx.get('slots') as SlotRegistry
  slots.register({ name: 'root', children: {
    main: { kind: 'keyed', scope: 'root' },
    'sidebar.panellist': { kind: 'list', scope: 'root' },
  } } as never, () => null)
  const mount = vi.fn(async () => {
    if (studio !== undefined) ctx.provide('remote.skillsStudio', studio)
    return async () => {}
  })
  const setDraft = vi.fn()
  const binding = { ctx: {} }
  const reference = { sessionId: 'b1', ready: Promise.resolve(binding), release: vi.fn() }
  ctx.provide('locale', { register: () => () => {}, bind: () => t })
  ctx.provide('remote', { $mount: mount })
  const sessions = { create: vi.fn(async () => 'b1'), retain: vi.fn(() => reference) }
  const uiWorkspace = { openSession: vi.fn() }
  const workspaces = { list: { getSnapshot: () => ({ items: [{ path: 'D:/work' }] }) }, create: vi.fn(async () => ({ workspaceId: 'w-skills' })) }
  ctx.provide('sessions', sessions)
  ctx.provide('conversation', { input: { for: () => ({ setDraft }) } })
  ctx.provide('uiWorkspace', uiWorkspace)
  ctx.provide('workspaces', workspaces)
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  const face = () => (slots.entries('main')[0]!.inject as () => SkillsPageInjected)()
  return { ctx, slots, fiber, mount, face, setDraft, reference, sessions, uiWorkspace, workspaces }
}

describe('skills-studio client half', () => {
  it('mounts its namespace and registers the entry, the page, and the embedded conversation', async () => {
    const subject = await bench()
    expect(inject).toEqual(['slots', 'locale', 'remote', 'sessions', 'conversation', 'uiWorkspace', 'workspaces'])
    expect(subject.mount).toHaveBeenCalledWith(contribution)
    expect(subject.slots.entries('sidebar.panellist').map(entry => (entry.options as { id: string }).id)).toEqual(['skills'])
    const label: () => string = (subject.slots.entries('sidebar.panellist')[0]!.options as { label?: never }).label!
    expect(label()).toBe('panel')
    expect(subject.slots.entries('main').map(entry => (entry.options as { key: string }).key)).toEqual(['skills'])
    expect(subject.slots.entries('skillsStudio.builder.conversation')).toHaveLength(1)
    await subject.fiber.dispose()
    expect(subject.slots.entries('main')).toHaveLength(0)
  })

  it('folds Remote answers, refusals, throws, and a missing namespace for the page', async () => {
    const ok = <T,>(value: T) => vi.fn(async () => ({ ok: true, value }))
    const studio = {
      listSkills: ok({ roots: [], skills: [] }),
      readSkill: vi.fn(async () => ({ ok: false, error: { message: 'gone' } })),
      saveSkill: vi.fn(async () => { throw new Error('dropped') }),
      trashSkill: vi.fn(async () => { throw 'plain' }),
      startBuilder: ok({ cwd: 'C:/skills', draft: '@skill skill-builder ' }),
    }
    const subject = await bench(studio)
    const face = subject.face()
    expect(await face.load()).toEqual({ ok: true, value: { roots: [], skills: [] } })
    expect(studio.listSkills).toHaveBeenCalledWith(['D:/work'])
    expect(await face.read('f')).toEqual({ ok: false, message: 'gone' })
    expect(await face.save({} as never)).toEqual({ ok: false, message: 'dropped' })
    expect(await face.remove('f')).toEqual({ ok: false, message: 'plain' })
    const missing = await bench()
    expect(await missing.face().load()).toEqual({ ok: false, message: 'the skills service is not loaded' })
    expect(await missing.face().launchBuilder()).toBe('the skills service is not loaded')
  })

  it('runs the builder in a workspace for the skills folder, embedded and in the main column', async () => {
    const studio = { startBuilder: vi.fn(async () => ({ ok: true, value: { cwd: 'C:/skills', draft: '@skill skill-builder ' } })) }
    const subject = await bench(studio)
    const face = subject.face()
    face.openBuilder()
    await vi.waitFor(() => { expect(face.hooks.builder.getSnapshot().kind).toBe('open') })
    expect(subject.workspaces.create).toHaveBeenCalledWith({ path: 'C:/skills' })
    expect(subject.sessions.create).toHaveBeenCalledWith({ workspaceId: 'w-skills' })
    expect(subject.sessions.retain).toHaveBeenCalledWith('b1', { source: 'skillsStudio' })
    expect(subject.setDraft).toHaveBeenCalledWith('@skill skill-builder ')
    expect(localStorage.getItem('dsh.skillsStudio.builderSession')).toBe('b1')
    face.freshBuilder()
    await vi.waitFor(() => { expect(subject.sessions.create).toHaveBeenCalledTimes(2) })
    face.closeBuilder()
    expect(face.hooks.builder.getSnapshot().kind).toBe('closed')
    expect(await face.launchBuilder()).toBeNull()
    expect(subject.uiWorkspace.openSession).toHaveBeenCalledWith('b1')
  })

  it('works without storage', async () => {
    const storage = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied') })
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied') })
    try {
      const studio = { startBuilder: vi.fn(async () => ({ ok: true, value: { cwd: 'C:/skills', draft: 'd' } })) }
      const subject = await bench(studio)
      subject.face().openBuilder()
      await vi.waitFor(() => { expect(subject.face().hooks.builder.getSnapshot().kind).toBe('open') })
      subject.face().freshBuilder()
      await vi.waitFor(() => { expect(subject.sessions.create).toHaveBeenCalledTimes(2) })
    } finally {
      storage.mockRestore()
      set.mockRestore()
    }
  })
})
