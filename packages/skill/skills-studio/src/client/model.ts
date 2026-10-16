/**
 * The Skills page's pure state: grouping and filtering the catalog, the editor
 * draft, and whether it differs from what is saved.
 */
import type { SkillDocument, SkillEntry, SkillRootView, SkillSaveRequest } from '../types.ts'

/** The fields the editor changes. */
export interface Draft {
  readonly root: string
  /** The file being edited; absent for a new skill. */
  readonly file?: string
  readonly name: string
  readonly description: string
  readonly whenToUse: string
  readonly userInvocable: boolean
  readonly modelInvocable: boolean
  readonly body: string
}

/** The body a new skill starts with. */
export const NEW_BODY = '# Title\n\n1. First step the agent takes.\n2. Next step.\n'

/**
 * A blank draft in a root.
 * @param root - the folder the skill will be saved in.
 * @returns the draft.
 */
export function blankDraft(root: string): Draft {
  return { root, name: '', description: '', whenToUse: '', userInvocable: true, modelInvocable: true, body: NEW_BODY }
}

/**
 * The draft for an opened skill.
 * @param document - the opened skill.
 * @returns its draft.
 */
export function draftOf(document: SkillDocument): Draft {
  return {
    root: document.root,
    file: document.file,
    name: document.name,
    description: document.description,
    whenToUse: document.whenToUse,
    userInvocable: document.userInvocable,
    modelInvocable: document.modelInvocable,
    body: document.body,
  }
}

/**
 * A writable copy of a read-only skill, as a new draft.
 * @param document - the opened skill.
 * @param root - the writable folder to copy it into.
 * @returns the draft.
 */
export function copyDraft(document: SkillDocument, root: string): Draft {
  const { file: _file, ...rest } = draftOf(document)
  return { ...rest, root }
}

/**
 * Whether two drafts differ in anything a save writes.
 * @param a - one draft.
 * @param b - the other, or null.
 * @returns true when they differ.
 */
export function changed(a: Draft, b: Draft | null): boolean {
  if (b === null) return true
  return a.root !== b.root || a.name !== b.name || a.description !== b.description || a.whenToUse !== b.whenToUse
    || a.userInvocable !== b.userInvocable || a.modelInvocable !== b.modelInvocable || a.body !== b.body
}

/**
 * The save request for a draft.
 * @param draft - the draft.
 * @returns the request.
 */
export function saveRequest(draft: Draft): SkillSaveRequest {
  return { ...draft, name: draft.name.trim() }
}

/** One group of the list: a root and its matching skills. */
export interface SkillGroup {
  readonly root: SkillRootView
  readonly skills: readonly SkillEntry[]
}

/**
 * Group skills under their roots, keeping only those matching a search and dropping empty project roots.
 * @param roots - the roots, in rank order.
 * @param skills - every skill.
 * @param query - the search text.
 * @returns the non-empty groups, plus the user's own root even when empty.
 */
export function groupSkills(roots: readonly SkillRootView[], skills: readonly SkillEntry[], query: string): SkillGroup[] {
  const needle = query.trim().toLowerCase()
  const match = (skill: SkillEntry): boolean =>
    needle === '' || skill.name.toLowerCase().includes(needle) || skill.description.toLowerCase().includes(needle)
  return roots
    .map(root => ({ root, skills: skills.filter(skill => skill.root === root.path && match(skill)) }))
    .filter(group => group.skills.length > 0 || (needle === '' && group.root.source === 'user-dsh'))
}

/**
 * The folder a new skill goes into by default: the user's own skills.
 * @param roots - the roots.
 * @returns its path, or the first writable root, or undefined.
 */
export function defaultRoot(roots: readonly SkillRootView[]): string | undefined {
  return (roots.find(root => root.source === 'user-dsh') ?? roots.find(root => root.writable))?.path
}
