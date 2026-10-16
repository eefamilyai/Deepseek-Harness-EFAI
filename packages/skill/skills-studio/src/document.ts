/**
 * Reading and writing one `SKILL.md`: the YAML frontmatter the skill loader
 * requires, the fields the studio edits, and every other frontmatter key kept
 * as it was.
 *
 * The rules mirror `@deepseek-ai/dsh-skill-filesystem`, so the studio reports a
 * skill as broken exactly when the loader would ignore it.
 */
import { isMap, parseDocument, stringify, type YAMLMap } from 'yaml'

/** The skill name rule shared with the skill registry: lowercase words joined by single hyphens. */
export const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** The longest name the studio accepts, so a directory name stays reasonable. */
export const MAX_NAME_LENGTH = 64

/** The fields the studio edits. */
export interface SkillFields {
  readonly name: string
  readonly description: string
  readonly whenToUse: string
  readonly userInvocable: boolean
  readonly modelInvocable: boolean
  readonly body: string
}

/** One file split into its frontmatter source and body. */
interface Split {
  readonly yaml: string
  readonly body: string
}

/**
 * Split a file at its frontmatter fences, as the loader does.
 * @param raw - the whole file.
 * @returns the frontmatter source and body, or undefined without a fenced frontmatter.
 */
function split(raw: string): Split | undefined {
  const text = raw.replace(/^\uFEFF/u, '')
  const firstEnd = text.indexOf('\n')
  if (firstEnd < 0 || text.slice(0, firstEnd).replace(/\r$/u, '') !== '---') return undefined
  const lines = text.slice(firstEnd + 1).split('\n')
  let offset = firstEnd + 1
  for (const line of lines) {
    if (line.replace(/\r$/u, '') === '---') {
      return { yaml: text.slice(firstEnd + 1, offset), body: text.slice(offset + line.length + 1) }
    }
    offset += line.length + 1
  }
  return undefined
}

/**
 * Parse a file into the studio's fields, and say why the loader would ignore it.
 * @param raw - the whole file.
 * @param fallbackName - the name to show when the file has none: its directory name.
 * @returns the fields and the problem, if any.
 */
export function readSkill(raw: string, fallbackName: string): { fields: SkillFields; problem?: string } {
  const parts = split(raw)
  const empty: SkillFields = { name: fallbackName, description: '', whenToUse: '', userInvocable: true, modelInvocable: true, body: raw }
  if (parts === undefined) return { fields: empty, problem: 'missing YAML frontmatter' }
  // The parser records syntax errors on the document instead of throwing.
  const document = parseDocument(parts.yaml)
  const error = document.errors[0]
  if (error !== undefined) return { fields: { ...empty, body: parts.body }, problem: `invalid YAML frontmatter: ${error.message}` }
  const data: unknown = document.toJS()
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return { fields: { ...empty, body: parts.body }, problem: 'missing YAML frontmatter' }
  }
  const record = data as Record<string, unknown>
  const text = (key: string): string | undefined => typeof record[key] === 'string' ? record[key] : undefined
  const fields: SkillFields = {
    name: text('name') ?? fallbackName,
    description: text('description') ?? '',
    whenToUse: text('whenToUse') ?? '',
    userInvocable: record['user-invocable'] !== false,
    modelInvocable: record['disable-model-invocation'] !== true,
    body: parts.body.replace(/^\r?\n/u, ''),
  }
  const problem = text('name') === undefined || text('description') === undefined
    ? 'frontmatter requires name and description'
    : !SKILL_NAME.test(fields.name)
      ? `invalid skill name "${fields.name}"`
      : invocationProblem(record)
  return problem === undefined ? { fields } : { fields, problem }
}

/**
 * The loader's invocation checks: booleans only, and no legacy camelCase keys.
 * @param record - the parsed frontmatter.
 * @returns the problem, or undefined.
 */
function invocationProblem(record: Record<string, unknown>): string | undefined {
  for (const [legacy, canonical] of [
    ['disableModelInvocation', 'disable-model-invocation'],
    ['modelInvocable', 'disable-model-invocation'],
    ['userInvocable', 'user-invocable'],
  ] as const) {
    if (Object.hasOwn(record, legacy)) return `frontmatter field "${legacy}" is unsupported; use "${canonical}"`
  }
  for (const key of ['disable-model-invocation', 'user-invocable']) {
    if (Object.hasOwn(record, key) && typeof record[key] !== 'boolean') return `frontmatter field "${key}" must be a boolean`
  }
  return undefined
}

/**
 * Why a skill's edited fields cannot be saved.
 * @param fields - the edited fields.
 * @returns the problem, or undefined when the fields are valid.
 */
export function fieldsProblem(fields: Pick<SkillFields, 'name' | 'description'>): string | undefined {
  if (fields.name.length === 0) return 'a skill needs a name'
  if (fields.name.length > MAX_NAME_LENGTH) return `a skill name is at most ${String(MAX_NAME_LENGTH)} characters`
  if (!SKILL_NAME.test(fields.name)) return 'a skill name uses lowercase letters, digits, and single hyphens, like "release-notes"'
  if (fields.description.trim().length === 0) return 'a skill needs a description: it is how the model knows when to use it'
  return undefined
}

/**
 * Write the edited fields into a file, keeping every other frontmatter key and its comments.
 * @param fields - the edited fields.
 * @param previous - the file as it was, when updating.
 * @returns the new file text.
 */
export function writeSkill(fields: SkillFields, previous?: string): string {
  const parts = previous === undefined ? undefined : split(previous)
  let document = parts === undefined ? undefined : parseDocument(parts.yaml)
  if (document === undefined || document.errors.length > 0 || !isMap(document.contents)) document = parseDocument('{}')
  // A fresh document prints in block style, like a hand-written file.
  ;(document.contents as YAMLMap).flow = false
  document.set('name', fields.name)
  document.set('description', fields.description.trim())
  const whenToUse = fields.whenToUse.trim()
  if (whenToUse === '') document.delete('whenToUse')
  else document.set('whenToUse', whenToUse)
  if (fields.userInvocable) document.delete('user-invocable')
  else document.set('user-invocable', false)
  if (fields.modelInvocable) document.delete('disable-model-invocation')
  else document.set('disable-model-invocation', true)
  for (const legacy of ['disableModelInvocation', 'modelInvocable', 'userInvocable']) document.delete(legacy)
  const yaml = stringify(document, { lineWidth: 0 })
  const body = fields.body.replace(/\r\n/gu, '\n').replace(/^\n+/u, '').trimEnd()
  return `---\n${yaml}---\n\n${body}\n`
}
