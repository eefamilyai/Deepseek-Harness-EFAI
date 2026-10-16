/**
 * The skills service over temporary skill folders: listing in the loader's
 * order, the loader's validity rules, saving and renaming, the trash, the
 * installed builder skill, and the refusals for paths outside the roots.
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'

const fsMock = vi.hoisted(() => ({ renameError: undefined as NodeJS.ErrnoException | undefined }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...real,
    rename: async (from: string, to: string) => {
      const error = fsMock.renameError
      if (error !== undefined) throw error
      await real.rename(from, to)
    },
  }
})

import SkillsStudio, { move } from '../src/index.ts'
import { BUILDER_NAME, BUILDER_OWNER, BUILDER_SKILL, BUILDER_VERSION } from '../src/builder-skill.ts'
import { fieldsProblem, readSkill, writeSkill, MAX_NAME_LENGTH } from '../src/document.ts'

const temps: string[] = []
const contexts: Context[] = []

afterEach(async () => {
  fsMock.renameError = undefined
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'skills-studio-'))
  temps.push(dir)
  return dir
}

function skill(root: string, folder: string, text: string): string {
  mkdirSync(join(root, folder), { recursive: true })
  const file = join(root, folder, 'SKILL.md')
  writeFileSync(file, text)
  return file
}

const valid = (name: string, extra = '') => `---\nname: ${name}\ndescription: Use when ${name}.\n${extra}---\n\n# ${name}\n`

async function harness(options: { bundled?: boolean } = {}) {
  const base = temp()
  const dshHome = join(base, 'dsh')
  const agentsHome = join(base, 'agents')
  const bundled = join(base, 'bundled')
  const project = join(base, 'project')
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SkillsStudio, { dshHome, agentsHome, ...options.bundled === false ? {} : { bundledSkillDir: bundled } })
  return { studio: ctx.skillsStudio, dshHome, agentsHome, bundled, project, user: join(dshHome, 'skills') }
}

async function rejection(call: Promise<unknown>): Promise<RemoteError> {
  try {
    await call
  } catch (error) {
    if (error instanceof RemoteError) return error
    throw error
  }
  throw new Error('expected a rejection')
}

describe('SKILL.md rules', () => {
  it('reads the fields and the invocation switches', () => {
    expect(readSkill(valid('a', 'whenToUse: soon\nuser-invocable: false\ndisable-model-invocation: true\n'), 'x')).toEqual({
      fields: { name: 'a', description: 'Use when a.', whenToUse: 'soon', userInvocable: false, modelInvocable: false, body: '# a\n' },
    })
    expect(readSkill('\uFEFF---\r\nname: b\r\ndescription: d\r\n---\r\nbody', 'x').fields.name).toBe('b')
  })

  it('names every reason the loader would ignore a file', () => {
    const problem = (raw: string) => readSkill(raw, 'folder').problem
    expect(problem('no frontmatter')).toBe('missing YAML frontmatter')
    expect(problem('---\nname: a')).toBe('missing YAML frontmatter')
    expect(problem('---\n- a\n---\n')).toBe('missing YAML frontmatter')
    expect(problem('---\nname: [\n---\n')).toMatch(/^invalid YAML frontmatter: /)
    expect(problem('---\nname: a\n---\n')).toBe('frontmatter requires name and description')
    expect(problem('---\nname: Bad_Name\ndescription: d\n---\n')).toBe('invalid skill name "Bad_Name"')
    expect(problem(valid('a', 'userInvocable: true\n'))).toBe('frontmatter field "userInvocable" is unsupported; use "user-invocable"')
    expect(problem(valid('a', 'user-invocable: "no"\n'))).toBe('frontmatter field "user-invocable" must be a boolean')
    expect(readSkill('---\nname: a\n---\n', 'folder').fields.description).toBe('')
    expect(readSkill('---\ndescription: d\n---\n', 'folder').fields.name).toBe('folder')
    expect(readSkill('no frontmatter', 'folder').fields.name).toBe('folder')
  })

  it('checks a name and a description before saving', () => {
    expect(fieldsProblem({ name: '', description: 'd' })).toBe('a skill needs a name')
    expect(fieldsProblem({ name: 'a'.repeat(MAX_NAME_LENGTH + 1), description: 'd' })).toMatch(/at most/)
    expect(fieldsProblem({ name: 'A b', description: 'd' })).toMatch(/lowercase/)
    expect(fieldsProblem({ name: 'ok', description: '  ' })).toMatch(/needs a description/)
    expect(fieldsProblem({ name: 'ok', description: 'd' })).toBeUndefined()
  })

  it('writes the fields, keeps other keys and comments, and drops legacy switches', () => {
    const previous = '---\n# keep me\nname: old\ndescription: old\nmetadata:\n  team: core\nuserInvocable: true\nwhenToUse: before\n---\nold body\n'
    const fields = { name: 'new', description: ' New. ', whenToUse: '', userInvocable: false, modelInvocable: false, body: '\r\n\nBody\r\n\n' }
    const text = writeSkill(fields, previous)
    expect(text).toContain('# keep me')
    expect(text).toContain('team: core')
    expect(text).not.toContain('userInvocable')
    expect(text).not.toContain('whenToUse')
    expect(readSkill(text, 'x')).toEqual({ fields: { ...fields, description: 'New.', body: 'Body\n' } })
    const fresh = writeSkill({ ...fields, whenToUse: 'w', userInvocable: true, modelInvocable: true })
    expect(fresh).toBe('---\nname: new\ndescription: New.\nwhenToUse: w\n---\n\nBody\n')
    expect(writeSkill(fields, '---\n[a\n---\n')).toContain('name: new')
    expect(writeSkill(fields, '---\n- a\n---\n')).toContain('name: new')
  })
})

describe('the skillsStudio service', () => {
  it('lists the roots in the loader order and marks broken and overridden skills', async () => {
    const { studio, user, agentsHome, bundled, project } = await harness()
    skill(join(project, '.dsh', 'skills'), 'shared', valid('shared'))
    skill(user, 'shared', valid('shared'))
    skill(user, 'broken', 'no frontmatter')
    skill(user, '.hidden', valid('hidden'))
    mkdirSync(join(user, 'empty'))
    skill(join(agentsHome, 'skills'), 'agent', valid('agent', 'disable-model-invocation: true\n'))
    skill(bundled, 'bundled', valid('bundled'))
    const catalog = await studio.listSkills([project, 'relative/path'])
    expect(catalog.roots.map(root => [root.source, root.writable])).toEqual([
      ['project-dsh', true], ['project-agents', true], ['user-dsh', true], ['user-agents', true], ['bundled', false],
    ])
    expect(catalog.skills.map(entry => [entry.name, entry.source, entry.problem, entry.shadowedBy !== undefined])).toEqual([
      ['shared', 'project-dsh', undefined, false],
      ['broken', 'user-dsh', 'missing YAML frontmatter', false],
      ['shared', 'user-dsh', undefined, true],
      ['agent', 'user-agents', undefined, false],
      ['bundled', 'bundled', undefined, false],
    ])
    expect(catalog.skills[3]!.modelInvocable).toBe(false)
  })

  it('reads the bundled folder from the environment, or lists none', async () => {
    const { studio } = await harness({ bundled: false })
    const original = process.env.DSH_BUNDLED_SKILL_DIR
    try {
      expect((await studio.listSkills([])).roots.map(root => root.source)).not.toContain('bundled')
      process.env.DSH_BUNDLED_SKILL_DIR = ''
      const ctx = new Context()
      contexts.push(ctx)
      await ctx.plugin(SkillsStudio)
      expect((await ctx.skillsStudio.listSkills([])).roots.map(root => root.source)).toEqual(['user-dsh', 'user-agents'])
    } finally {
      if (original === undefined) delete process.env.DSH_BUNDLED_SKILL_DIR
      else process.env.DSH_BUNDLED_SKILL_DIR = original
    }
  })

  it('opens a skill with its folder and problem', async () => {
    const { studio, user, bundled } = await harness()
    const file = skill(user, 'a', valid('a'))
    expect(await studio.readSkill(file)).toMatchObject({ file, root: user, writable: true, name: 'a', body: '# a\n' })
    expect((await studio.readSkill(skill(user, 'b', 'plain'))).problem).toBe('missing YAML frontmatter')
    expect((await studio.readSkill(skill(bundled, 'c', valid('c')))).writable).toBe(false)
  })

  it('refuses paths outside the roots', async () => {
    const { studio, user } = await harness()
    const outside = skill(temp(), 'x', valid('x'))
    for (const call of [studio.readSkill(outside), studio.readSkill(join(user, 'a', 'README.md')), studio.trashSkill(outside)]) {
      const error = await rejection(call)
      expect(error.code).toBe('skillsStudio/rejected')
    }
    expect((await rejection(studio.readSkill(join(user, 'missing', 'SKILL.md')))).details).toEqual({ path: join(user, 'missing', 'SKILL.md') })
  })

  it('creates, updates, and renames a skill, refusing clashes and foreign roots', async () => {
    const { studio, user, bundled, agentsHome } = await harness()
    const fields = { name: 'one', description: 'Use when one.', whenToUse: '', userInvocable: true, modelInvocable: true, body: '# One' }
    const { file } = await studio.saveSkill({ root: user, ...fields })
    expect(readFileSync(file, 'utf8')).toBe('---\nname: one\ndescription: Use when one.\n---\n\n# One\n')
    expect((await rejection(studio.saveSkill({ root: user, ...fields }))).message).toBe('a skill folder named "one" already exists here')
    const updated = await studio.saveSkill({ root: user, file, ...fields, body: '# Changed' })
    expect(updated.file).toBe(file)
    skill(user, 'taken', valid('taken'))
    expect((await rejection(studio.saveSkill({ root: user, file, ...fields, name: 'taken' }))).message).toMatch(/already exists/)
    const renamed = await studio.saveSkill({ root: user, file, ...fields, name: 'two' })
    expect(renamed.file).toBe(join(user, 'two', 'SKILL.md'))
    expect(existsSync(join(user, 'one'))).toBe(false)
    expect((await rejection(studio.saveSkill({ root: user, ...fields, name: 'Bad' }))).message).toMatch(/lowercase/)
    expect((await rejection(studio.saveSkill({ root: bundled, ...fields, name: 'x' }))).message).toBe('skills are saved only in a writable skill folder')
    expect((await rejection(studio.saveSkill({ root: join(agentsHome, 'skills'), file: renamed.file, ...fields }))).message)
      .toBe('a skill is saved in the folder it lives in')
    const bundledFile = skill(bundled, 'b', valid('b'))
    expect((await rejection(studio.saveSkill({ root: user, file: bundledFile, ...fields, name: 'b' }))).message)
      .toBe('a skill is saved in the folder it lives in')
  })

  it('accepts a project root only after the project was listed', async () => {
    const { studio, project } = await harness()
    const root = join(project, '.dsh', 'skills')
    const fields = { name: 'p', description: 'd', whenToUse: '', userInvocable: true, modelInvocable: true, body: '' }
    expect((await rejection(studio.saveSkill({ root, ...fields }))).code).toBe('skillsStudio/rejected')
    await studio.listSkills([project])
    expect((await studio.saveSkill({ root, ...fields })).file).toBe(join(root, 'p', 'SKILL.md'))
  })

  it('moves a removed skill to the trash, refusing bundled skills and the root itself', async () => {
    const { studio, user, dshHome, bundled } = await harness()
    const file = skill(user, 'gone', valid('gone'))
    const { trashedTo } = await studio.trashSkill(file)
    expect(trashedTo.startsWith(join(dshHome, 'skills-trash', 'gone-'))).toBe(true)
    expect(readFileSync(join(trashedTo, 'SKILL.md'), 'utf8')).toBe(valid('gone'))
    expect(existsSync(join(user, 'gone'))).toBe(false)
    expect((await rejection(studio.trashSkill(skill(bundled, 'b', valid('b'))))).message).toBe('bundled skills cannot be removed')
    writeFileSync(join(user, 'SKILL.md'), valid('root'))
    expect((await rejection(studio.trashSkill(join(user, 'SKILL.md')))).code).toBe('skillsStudio/rejected')
  })

  it('copies a folder across volumes and rethrows other rename failures', async () => {
    const base = temp()
    skill(base, 'from', valid('from'))
    fsMock.renameError = Object.assign(new Error('cross-device'), { code: 'EXDEV' })
    await move(join(base, 'from'), join(base, 'to'))
    expect(readdirSync(base)).toEqual(['to'])
    fsMock.renameError = Object.assign(new Error('busy'), { code: 'EBUSY' })
    await expect(move(join(base, 'to'), join(base, 'again'))).rejects.toThrow('busy')
  })

  it('installs the builder skill, refreshes its own older copy, and keeps a user copy', async () => {
    const { studio, user } = await harness()
    const file = join(user, BUILDER_NAME, 'SKILL.md')
    expect(await studio.startBuilder()).toEqual({ cwd: user, draft: `@skill ${BUILDER_NAME} ` })
    expect(readFileSync(file, 'utf8')).toBe(BUILDER_SKILL)
    expect(readSkill(BUILDER_SKILL, BUILDER_NAME).problem).toBeUndefined()
    writeFileSync(file, BUILDER_SKILL.replace(`version: ${String(BUILDER_VERSION)}`, 'version: 0'))
    await studio.startBuilder()
    expect(readFileSync(file, 'utf8')).toBe(BUILDER_SKILL)
    const mine = BUILDER_SKILL.replace(`owner: '${BUILDER_OWNER}'`, "owner: 'me'").replace(`version: ${String(BUILDER_VERSION)}`, 'version: 0')
    writeFileSync(file, mine)
    await studio.startBuilder()
    expect(readFileSync(file, 'utf8')).toBe(mine)
    writeFileSync(file, '---\nname: skill-builder\ndescription: mine\n---\n')
    await studio.startBuilder()
    expect(readFileSync(file, 'utf8')).toContain('description: mine')
  })

  it('reports a non-Error failure as text', async () => {
    const { studio, user } = await harness()
    const file = skill(user, 'x', valid('x'))
    fsMock.renameError = 'locked' as never
    expect((await rejection(studio.trashSkill(file))).message).toBe('locked')
  })
})
