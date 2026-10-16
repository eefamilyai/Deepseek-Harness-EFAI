/**
 * The `skillsStudio` service: the Remote surface the Skills tab uses to list,
 * read, create, change, and remove skills in the folders the skill loader
 * scans, and to install the `skill-builder` skill a Skill Builder session loads.
 *
 * The roots and their order follow `@deepseek-ai/dsh-skill-filesystem`: each
 * workspace's `.dsh/skills` and `.agents/skills`, then `~/.dsh/skills` and
 * `~/.agents/skills`, then the bundled skills, which are read-only. The loader
 * watches those folders, so a save reaches new turns without a restart.
 *
 * Every path a request names is checked against the roots, so the Remote
 * surface cannot read or write outside them. A removed skill is moved to
 * `~/.dsh/skills-trash` rather than deleted.
 *
 * ```yaml
 * - id: skills-studio
 *   name: '@deepseek-ai/dsh-skills-studio'
 * ```
 *
 * @module @deepseek-ai/dsh-skills-studio
 */

import { cp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { BUILDER_NAME, BUILDER_OWNER, BUILDER_SKILL, BUILDER_VERSION } from './builder-skill.ts'
import { fieldsProblem, readSkill, writeSkill } from './document.ts'
import type {
  SkillBuilderStart, SkillDocument, SkillEntry, SkillRemoved, SkillRootView, SkillSaved,
  SkillSaveRequest, SkillsCatalog,
} from './types.ts'

export * from './types.ts'
export { BUILDER_NAME } from './builder-skill.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    skillsStudio: SkillsStudio
  }
}

/** Where the service looks; every field defaults the way the skill loader's does. */
export interface Config {
  /** DeepSeek Harness home. Defaults to `$DSH_HOME` or `~/.dsh`. */
  dshHome?: string
  /** Shared agent home. Defaults to `$DSH_AGENTS_HOME` or `~/.agents`. */
  agentsHome?: string
  /** Bundled skill folder. Defaults to `$DSH_BUNDLED_SKILL_DIR`; absent lists none. */
  bundledSkillDir?: string
}

/** The skill file every skill folder holds. */
const SKILL_FILE = 'SKILL.md'

/** The folder removed skills are moved into, under the DSH home. */
const TRASH = 'skills-trash'

/**
 * Whether a path exists.
 * @param path - the path.
 * @returns true when something is there.
 */
async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/**
 * Move a folder, copying it when the target is on another volume (a junctioned skill folder is).
 * @param from - the folder.
 * @param to - where it goes; must not exist.
 */
export async function move(from: string, to: string): Promise<void> {
  try {
    await rename(from, to)
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error
    await cp(from, to, { recursive: true, errorOnExist: true, force: false })
    await rm(from, { recursive: true, force: true })
  }
}

/**
 * A timestamp for a trash folder name.
 * @param now - the instant.
 * @returns `YYYYMMDD-HHmmss` in UTC.
 */
function stamp(now: Date): string {
  return now.toISOString().replace(/[-:]/gu, '').replace('T', '-').slice(0, 15)
}

/** The `ctx.skillsStudio` service; the name is the literal the Typert analyzer binds. */
export class SkillsStudio extends TypertRemoteService {
  private readonly dshHome: string
  private readonly agentsHome: string
  private readonly bundled: string | undefined
  /** Project folders the client has listed, whose skill roots requests may then name. */
  private readonly projects = new Set<string>()

  /**
   * @param ctx - the Host context.
   * @param config - home folder overrides.
   */
  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'skillsStudio')
    this.dshHome = resolve(config.dshHome ?? process.env.DSH_HOME ?? join(homedir(), '.dsh'))
    this.agentsHome = resolve(config.agentsHome ?? process.env.DSH_AGENTS_HOME ?? join(homedir(), '.agents'))
    const bundled = config.bundledSkillDir ?? process.env.DSH_BUNDLED_SKILL_DIR
    this.bundled = bundled === undefined || bundled === '' ? undefined : resolve(bundled)
  }

  /**
   * Every skill in the loader's roots, for the given workspace folders.
   * @param projects - absolute workspace folders whose project skills to include.
   * @returns the roots and the skills found in them.
   */
  @Remote
  async listSkills(projects: string[]): Promise<SkillsCatalog> {
    for (const project of projects) if (isAbsolute(project)) this.projects.add(resolve(project))
    const roots = this.roots(projects.filter(project => isAbsolute(project)).map(project => resolve(project)))
    const skills: SkillEntry[] = []
    const winners = new Map<string, string>()
    for (const root of roots) {
      for (const entry of await this.scan(root)) {
        const winner = winners.get(entry.name)
        if (winner === undefined && entry.problem === undefined) winners.set(entry.name, entry.file)
        skills.push(winner === undefined ? entry : { ...entry, shadowedBy: winner })
      }
    }
    return { roots, skills }
  }

  /**
   * Open one skill for editing.
   * @param file - its `SKILL.md`.
   * @returns the parsed fields and body.
   * @throws RemoteError `skillsStudio/rejected` for a path outside the roots or an unreadable file.
   */
  @Remote
  async readSkill(file: string): Promise<SkillDocument> {
    return await this.guard(file, async () => {
      const root = this.rootOf(file)
      const { fields, problem } = readSkill(await readFile(file, 'utf8'), basename(dirname(file)))
      return { file, root: root.path, writable: root.writable, ...fields, ...problem === undefined ? {} : { problem } }
    })
  }

  /**
   * Create a skill, or change one, renaming its folder when its name changes.
   * @param request - the root, the current file when updating, and the fields.
   * @returns the skill's file after the save.
   * @throws RemoteError `skillsStudio/rejected` for invalid fields, a read-only or unknown root, or a name already taken.
   */
  @Remote
  async saveSkill(request: SkillSaveRequest): Promise<SkillSaved> {
    return await this.guard(request.file ?? request.root, async () => {
      const problem = fieldsProblem(request)
      if (problem !== undefined) throw new Error(problem)
      const root = this.writableRoot(request.root)
      const target = join(root, request.name)
      const file = join(target, SKILL_FILE)
      let previous: string | undefined
      if (request.file !== undefined) {
        const current = this.rootOf(request.file)
        if (!current.writable || resolve(current.path) !== root) throw new Error('a skill is saved in the folder it lives in')
        previous = await readFile(request.file, 'utf8')
        const folder = dirname(resolve(request.file))
        if (folder !== target) {
          if (await exists(target)) throw new Error(`a skill folder named "${request.name}" already exists here`)
          await move(folder, target)
        }
      } else if (await exists(target)) {
        throw new Error(`a skill folder named "${request.name}" already exists here`)
      }
      await mkdir(target, { recursive: true })
      await writeFile(file, writeSkill(request, previous), 'utf8')
      return { file }
    })
  }

  /**
   * Move a skill's folder to `~/.dsh/skills-trash`.
   * @param file - its `SKILL.md`.
   * @returns where the folder went.
   * @throws RemoteError `skillsStudio/rejected` for a read-only or unknown skill.
   */
  @Remote
  async trashSkill(file: string): Promise<SkillRemoved> {
    return await this.guard(file, async () => {
      const root = this.rootOf(file)
      if (!root.writable) throw new Error('bundled skills cannot be removed')
      const folder = dirname(resolve(file))
      const trash = join(this.dshHome, TRASH)
      await mkdir(trash, { recursive: true })
      const trashedTo = join(trash, `${basename(folder)}-${stamp(new Date())}`)
      await move(folder, trashedTo)
      return { trashedTo }
    })
  }

  /**
   * Install or refresh the `skill-builder` skill, and say where a Skill Builder session works.
   * A copy the user changed (one without this package's owner marker, or with a newer version) is kept.
   * @returns the session folder and its first draft.
   */
  @Remote
  async startBuilder(): Promise<SkillBuilderStart> {
    const root = join(this.dshHome, 'skills')
    const file = join(root, BUILDER_NAME, SKILL_FILE)
    let current: string | undefined
    try {
      current = await readFile(file, 'utf8')
    } catch {
      current = undefined
    }
    if (current === undefined || ownedOlder(current)) {
      await mkdir(dirname(file), { recursive: true })
      await writeFile(file, BUILDER_SKILL, 'utf8')
    }
    return { cwd: root, draft: `@skill ${BUILDER_NAME} ` }
  }

  /**
   * The roots in the loader's order.
   * @param projects - resolved workspace folders.
   * @returns the roots.
   */
  private roots(projects: readonly string[]): SkillRootView[] {
    const roots: SkillRootView[] = []
    for (const project of new Set(projects)) {
      roots.push(
        { path: join(project, '.dsh', 'skills'), source: 'project-dsh', writable: true, project },
        { path: join(project, '.agents', 'skills'), source: 'project-agents', writable: true, project },
      )
    }
    roots.push(
      { path: join(this.dshHome, 'skills'), source: 'user-dsh', writable: true },
      { path: join(this.agentsHome, 'skills'), source: 'user-agents', writable: true },
    )
    if (this.bundled !== undefined) roots.push({ path: this.bundled, source: 'bundled', writable: false })
    return roots
  }

  /**
   * The skills in one root, by name; a missing root holds none.
   * @param root - the root.
   * @returns its skills.
   */
  private async scan(root: SkillRootView): Promise<SkillEntry[]> {
    let names: string[]
    try {
      names = (await readdir(root.path)).filter(name => !name.startsWith('.'))
    } catch {
      return []
    }
    const entries: SkillEntry[] = []
    for (const folder of names.toSorted()) {
      const file = join(root.path, folder, SKILL_FILE)
      let raw: string
      try {
        raw = await readFile(file, 'utf8')
      } catch {
        continue
      }
      const { fields, problem } = readSkill(raw, folder)
      entries.push({
        name: fields.name,
        description: fields.description,
        file,
        root: root.path,
        source: root.source,
        writable: root.writable,
        userInvocable: fields.userInvocable,
        modelInvocable: fields.modelInvocable,
        ...problem === undefined ? {} : { problem },
      })
    }
    return entries
  }

  /**
   * The root holding a skill file: it must be a `SKILL.md` one folder below a known root.
   * @param file - the path a request named.
   * @returns the root.
   */
  private rootOf(file: string): SkillRootView {
    const path = resolve(file)
    if (basename(path) !== SKILL_FILE) throw new Error('not a SKILL.md file')
    const root = this.roots([...this.projects]).find(candidate => resolve(dirname(dirname(path))) === resolve(candidate.path))
    if (root === undefined) throw new Error('the file is not in a skill folder the loader reads')
    return root
  }

  /**
   * A writable root by path.
   * @param path - the root a request named.
   * @returns the resolved root path.
   */
  private writableRoot(path: string): string {
    const root = this.roots([...this.projects]).find(candidate => resolve(candidate.path) === resolve(path))
    if (root === undefined || !root.writable) throw new Error('skills are saved only in a writable skill folder')
    return resolve(root.path)
  }

  /**
   * Run one request, reporting any failure as the Remote refusal.
   * @param path - the path the refusal names.
   * @param work - the request.
   * @returns the request's answer.
   */
  private async guard<T>(path: string, work: () => Promise<T>): Promise<T> {
    try {
      return await work()
    } catch (error: unknown) {
      throw new RemoteError('skillsStudio/rejected', error instanceof Error ? error.message : String(error), { path }, { cause: error })
    }
  }
}

/**
 * Whether an installed `skill-builder` is this package's own copy at an older version.
 * @param text - the installed file.
 * @returns true when the studio should replace it.
 */
function ownedOlder(text: string): boolean {
  const owner = /^\s+owner:\s*['"]?([^'"\n]+)['"]?\s*$/mu.exec(text)?.[1]?.trim()
  const version = Number(/^\s+version:\s*(\d+)\s*$/mu.exec(text)?.[1] ?? '0')
  return owner === BUILDER_OWNER && version < BUILDER_VERSION
}

export default SkillsStudio
