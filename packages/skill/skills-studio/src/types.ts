/**
 * The vocabulary the `skillsStudio` service speaks: the skill roots it reads,
 * one listed skill, one opened skill, a save request, and its Remote failure
 * code.
 *
 * A Remote method's parameter and result types must be exported from a public
 * non-root subpath for the Typert generator, which is why this module exists
 * separately from `./index.ts`.
 *
 * @module @deepseek-ai/dsh-skills-studio/types
 */

/**
 * Where a skill root sits, in the order the skill loader ranks them: a project's
 * `.dsh/skills` and `.agents/skills`, then the user's `~/.dsh/skills` and
 * `~/.agents/skills`, then the skills bundled with the app.
 */
export type SkillRootSource = 'project-dsh' | 'project-agents' | 'user-dsh' | 'user-agents' | 'bundled'

/** One directory the skill loader scans. */
export interface SkillRootView {
  /** Absolute directory. */
  readonly path: string
  readonly source: SkillRootSource
  /** Whether the studio writes here; bundled skills are read-only. */
  readonly writable: boolean
  /** The workspace directory a project root belongs to. */
  readonly project?: string
}

/** One skill directory as listed. */
export interface SkillEntry {
  /** The frontmatter name, or the directory name when the file does not parse. */
  readonly name: string
  /** The frontmatter description; empty when the file does not parse. */
  readonly description: string
  /** Absolute path of the `SKILL.md` file. */
  readonly file: string
  /** The root it was found in. */
  readonly root: string
  readonly source: SkillRootSource
  readonly writable: boolean
  /** Whether users can run it as `/name`. */
  readonly userInvocable: boolean
  /** Whether the model may load it on its own. */
  readonly modelInvocable: boolean
  /** Why the loader ignores this file, when it does. */
  readonly problem?: string
  /** The file of the same-named skill that wins over this one, when another root ranks higher. */
  readonly shadowedBy?: string
}

/** Every skill the studio can see. */
export interface SkillsCatalog {
  /** The roots scanned, highest rank first. */
  readonly roots: readonly SkillRootView[]
  /** Skills, in root order and then by name. */
  readonly skills: readonly SkillEntry[]
}

/** One skill opened for editing. */
export interface SkillDocument {
  readonly file: string
  readonly root: string
  readonly writable: boolean
  readonly name: string
  readonly description: string
  /** Optional `whenToUse` frontmatter. */
  readonly whenToUse: string
  readonly userInvocable: boolean
  readonly modelInvocable: boolean
  /** The Markdown after the frontmatter. */
  readonly body: string
  /** Why the loader ignores this file, when it does. */
  readonly problem?: string
}

/** A create or update of one skill. */
export interface SkillSaveRequest {
  /** The writable root the skill lives in. */
  readonly root: string
  /** The skill's current file, when updating; absent creates a new skill. */
  readonly file?: string
  readonly name: string
  readonly description: string
  readonly whenToUse: string
  readonly userInvocable: boolean
  readonly modelInvocable: boolean
  readonly body: string
}

/** What a save wrote. */
export interface SkillSaved {
  /** The skill's `SKILL.md`, which moves with the directory on a rename. */
  readonly file: string
}

/** What a removal did with the skill directory. */
export interface SkillRemoved {
  /** Where the directory was moved, so it can be restored by hand. */
  readonly trashedTo: string
}

/** Where a Skill Builder session works, and how to start it. */
export interface SkillBuilderStart {
  /** The directory the session opens in: the user's `~/.dsh/skills`. */
  readonly cwd: string
  /** The first draft placed in the session's composer. */
  readonly draft: string
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** A skill read, save, or removal was refused: an invalid skill, a path outside the known roots, or a clash. */
    'skillsStudio/rejected': {
      readonly path?: string
    }
  }
}
