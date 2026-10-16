/**
 * The Skill Builder's session handling: reopening the remembered chat,
 * replacing it, the main-column launcher, and every failure path.
 */
import { describe, expect, it, vi } from 'vitest'
import { SkillBuilder, type BuilderDeps, type BuilderReference } from '../src/client/builder.ts'
import { blankDraft, changed, copyDraft, defaultRoot, draftOf, groupSkills, NEW_BODY, saveRequest } from '../src/client/model.ts'
import type { SkillDocument, SkillEntry, SkillRootView } from '../src/types.ts'

type Ref = BuilderReference<string> & { release: ReturnType<typeof vi.fn> }

function refOf(sessionId: string, ready: Promise<string> = Promise.resolve(`binding-${sessionId}`)): Ref {
  return { sessionId, ready, release: vi.fn() } as Ref
}

function depsOf(overrides: Partial<BuilderDeps<string, Ref>> = {}) {
  let stored: string | null = null
  const refs: Ref[] = []
  const deps = {
    start: vi.fn(async () => ({ cwd: 'C:/skills', draft: '@skill skill-builder ' })),
    create: vi.fn(async () => `s${String(refs.length + 1)}`),
    retain: vi.fn((sessionId: string) => {
      const ref = refOf(sessionId)
      refs.push(ref)
      return ref
    }),
    setDraft: vi.fn(),
    show: vi.fn(),
    remembered: vi.fn(() => stored),
    remember: vi.fn((sessionId: string | null) => { stored = sessionId }),
    ...overrides,
  }
  return { deps, refs, stored: () => stored, store: (id: string | null) => { stored = id } }
}

const settle = () => new Promise(resolve => setTimeout(resolve, 0))

describe('the embedded Skill Builder', () => {
  it('creates a session in the skills folder with the builder draft, then reopens it on the next visit', async () => {
    const { deps, refs, stored } = depsOf()
    const builder = new SkillBuilder(deps)
    builder.open()
    expect(builder.view.getSnapshot()).toEqual({ kind: 'starting' })
    builder.open()
    await settle()
    expect(deps.create).toHaveBeenCalledWith('C:/skills')
    expect(deps.setDraft).toHaveBeenCalledWith('binding-s1', '@skill skill-builder ')
    expect(builder.view.getSnapshot()).toEqual({ kind: 'open', reference: refs[0] })
    expect(stored()).toBe('s1')
    builder.open()
    expect(deps.start).toHaveBeenCalledOnce()
    builder.close()
    expect(refs[0]!.release).toHaveBeenCalledOnce()
    expect(builder.view.getSnapshot()).toEqual({ kind: 'closed' })
    builder.open()
    await settle()
    expect(deps.create).toHaveBeenCalledOnce()
    expect(deps.setDraft).toHaveBeenCalledOnce()
    expect(builder.view.getSnapshot()).toMatchObject({ kind: 'open', reference: { sessionId: 's1' } })
    builder.dispose()
    expect(refs[1]!.release).toHaveBeenCalledOnce()
  })

  it('starts over when the remembered session cannot open', async () => {
    const failing = refOf('old', Promise.reject(new Error('archived')))
    const { deps, store, stored } = depsOf()
    store('old')
    const retain = deps.retain
    deps.retain = vi.fn((sessionId: string) => sessionId === 'old' ? failing : retain(sessionId))
    const builder = new SkillBuilder(deps)
    builder.open()
    await settle()
    expect(failing.release).toHaveBeenCalledOnce()
    expect(deps.remember).toHaveBeenCalledWith(null)
    expect(stored()).toBe('s1')
    expect(builder.view.getSnapshot()).toMatchObject({ kind: 'open', reference: { sessionId: 's1' } })
  })

  it('replaces the chat with a fresh session', async () => {
    const { deps, refs } = depsOf()
    const builder = new SkillBuilder(deps)
    builder.open()
    await settle()
    builder.fresh()
    await settle()
    expect(refs[0]!.release).toHaveBeenCalledOnce()
    expect(deps.create).toHaveBeenCalledTimes(2)
    expect(builder.view.getSnapshot()).toMatchObject({ kind: 'open', reference: { sessionId: 's2' } })
  })

  it('drops a session that arrives after the panel closed', async () => {
    let answer: (value: { cwd: string; draft: string }) => void = () => {}
    const { deps, refs } = depsOf({ start: vi.fn(() => new Promise<{ cwd: string; draft: string }>((resolve) => { answer = resolve })) })
    const builder = new SkillBuilder(deps)
    builder.open()
    builder.close()
    answer({ cwd: 'C:/skills', draft: 'd' })
    await settle()
    expect(refs[0]!.release).toHaveBeenCalledOnce()
    expect(builder.view.getSnapshot()).toEqual({ kind: 'closed' })
  })

  it('reports a failure, releasing a new session that cannot open, and ignores a failure after closing', async () => {
    const broken = refOf('s1', Promise.reject(new Error('no binding')))
    const { deps } = depsOf({ retain: vi.fn(() => broken) })
    const builder = new SkillBuilder(deps)
    builder.open()
    await settle()
    expect(broken.release).toHaveBeenCalledOnce()
    expect(builder.view.getSnapshot()).toEqual({ kind: 'failed', message: 'no binding' })
    let fail: (reason: unknown) => void = () => {}
    const late = depsOf({ start: vi.fn(() => new Promise<{ cwd: string; draft: string }>((_, reject) => { fail = reject })) })
    const closing = new SkillBuilder(late.deps)
    closing.open()
    closing.close()
    fail('offline')
    await settle()
    expect(closing.view.getSnapshot()).toEqual({ kind: 'closed' })
  })
})

describe('the main-column launcher', () => {
  it('creates a session with the draft, shows it, and lets go of its own reference', async () => {
    const { deps, refs } = depsOf()
    await expect(new SkillBuilder(deps).launch()).resolves.toBeNull()
    expect(deps.setDraft).toHaveBeenCalledWith('binding-s1', '@skill skill-builder ')
    expect(deps.show).toHaveBeenCalledWith('s1')
    expect(refs[0]!.release).toHaveBeenCalledOnce()
    expect(deps.remember).not.toHaveBeenCalled()
  })

  it('answers why it failed', async () => {
    const { deps } = depsOf({ create: vi.fn<() => Promise<string>>().mockRejectedValue('refused') })
    await expect(new SkillBuilder(deps).launch()).resolves.toBe('refused')
    const broken = refOf('s1', Promise.reject(new Error('gone')))
    const second = depsOf({ retain: vi.fn(() => broken) })
    await expect(new SkillBuilder(second.deps).launch()).resolves.toBe('gone')
    expect(broken.release).toHaveBeenCalledOnce()
  })
})

const root = (path: string, source: SkillRootView['source'], writable = true): SkillRootView => ({ path, source, writable })
const entry = (name: string, rootPath: string, description = ''): SkillEntry => ({
  name, description, file: `${rootPath}/${name}/SKILL.md`, root: rootPath, source: 'user-dsh', writable: true, userInvocable: true, modelInvocable: true,
})
const document: SkillDocument = {
  file: 'u/a/SKILL.md', root: 'u', writable: false, name: 'a', description: 'd', whenToUse: '', userInvocable: true, modelInvocable: false, body: 'b',
}

describe('the page model', () => {
  it('builds drafts for a new, an opened, and a copied skill', () => {
    expect(blankDraft('u')).toEqual({ root: 'u', name: '', description: '', whenToUse: '', userInvocable: true, modelInvocable: true, body: NEW_BODY })
    expect(draftOf(document)).toEqual({ root: 'u', file: 'u/a/SKILL.md', name: 'a', description: 'd', whenToUse: '', userInvocable: true, modelInvocable: false, body: 'b' })
    expect(copyDraft(document, 'mine')).toEqual({ root: 'mine', name: 'a', description: 'd', whenToUse: '', userInvocable: true, modelInvocable: false, body: 'b' })
    expect(saveRequest({ ...blankDraft('u'), name: ' x ' }).name).toBe('x')
  })

  it('tells a changed draft from its baseline', () => {
    const base = draftOf(document)
    expect(changed(base, null)).toBe(true)
    expect(changed(base, base)).toBe(false)
    for (const patch of [{ root: 'x' }, { name: 'x' }, { description: 'x' }, { whenToUse: 'x' }, { userInvocable: false }, { modelInvocable: true }, { body: 'x' }]) {
      expect(changed({ ...base, ...patch }, base)).toBe(true)
    }
  })

  it('groups and filters skills, keeping the user folder visible while not searching', () => {
    const roots = [root('p', 'project-dsh'), root('u', 'user-dsh'), root('b', 'bundled', false)]
    const skills = [entry('alpha', 'p', 'first'), entry('beta', 'b', 'has ALPHA inside')]
    expect(groupSkills(roots, skills, '').map(group => [group.root.path, group.skills.length])).toEqual([['p', 1], ['u', 0], ['b', 1]])
    expect(groupSkills(roots, skills, ' alpha ').map(group => group.skills.map(skill => skill.name))).toEqual([['alpha'], ['beta']])
    expect(groupSkills(roots, skills, 'zzz')).toEqual([])
  })

  it('defaults new skills to the user folder, then any writable one', () => {
    expect(defaultRoot([root('p', 'project-dsh'), root('u', 'user-dsh')])).toBe('u')
    expect(defaultRoot([root('b', 'bundled', false), root('a', 'user-agents')])).toBe('a')
    expect(defaultRoot([root('b', 'bundled', false)])).toBeUndefined()
  })
})
