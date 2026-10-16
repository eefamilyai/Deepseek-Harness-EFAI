/**
 * The shared profile state and the pure operations over it: what is read out
 * of one profile, how it merges into the shared store, and how it is written
 * back into another profile's files.
 *
 * Shared state has three parts, each read from and written to the file that
 * owns it in every profile:
 *
 * - provider rows: the `config` of every patch row whose id is in
 *   `providerRows`, in `cordis.patch.yml`;
 * - plugin enablement: every patch row's `disabled` flag, and the
 *   `dsh.profile.bundles` list in `package.json`;
 * - credential references: the `refs` map in `credentials.yaml`, which holds the
 *   API keys provider configs name. Login grants (`records`) are account
 *   sessions bound to one profile's browser state and stay per profile.
 *
 * Every write keeps the rest of the file byte-for-byte: YAML edits go through
 * the comment-preserving document API with `!!js` scalars left verbatim.
 */
import { isMap, isScalar, isSeq, parseDocument, type Document, type YAMLSeq } from 'yaml'

/** One shared section and when it last changed, so a newer edit wins regardless of which profile made it. */
export interface Stamped<T> {
  value: T
  /** Epoch ms of the edit that produced `value`. */
  at: number
  /** The profile whose edit produced `value`. */
  from: string
}

/** The whole shared store, one stamped value per entry. */
export interface SharedState {
  version: 1
  /** Provider row id → its `config` object. */
  providers: Record<string, Stamped<unknown>>
  /** Patch row id → whether the row is disabled. */
  disabled: Record<string, Stamped<boolean>>
  /** The profile's bundle package names, in order; null until a profile records one. */
  bundles: Stamped<string[]> | null
  /** Credential reference name → its value; a null value records a deletion. */
  refs: Record<string, Stamped<string | null>>
}

/** The shared fields as one profile's files hold them right now. */
export interface ProfileSnapshot {
  providers: Record<string, unknown>
  disabled: Record<string, boolean>
  bundles: string[] | null
  refs: Record<string, string>
}

/**
 * An empty store.
 * @returns a store that shares nothing yet.
 */
export function emptyState(): SharedState {
  return { version: 1, providers: {}, disabled: {}, bundles: null, refs: {} }
}

/** YAML parse options shared by every read and write: `!!js` scalars stay text. */
const YAML_OPTIONS = { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => value }] }

/**
 * Parse a profile patch document.
 * @param text - `cordis.patch.yml` content.
 * @returns the document; an empty text is an empty sequence.
 * @throws Error when the YAML is malformed or not a sequence.
 */
export function parsePatch(text: string): { document: Document; items: YAMLSeq['items'] } {
  const document = parseDocument(text.trim() === '' ? '[]\n' : text, YAML_OPTIONS)
  const error = document.errors[0]
  if (error !== undefined) throw error
  if (!isSeq(document.contents)) throw new Error('profile patch must be a YAML sequence')
  return { document, items: document.contents.items }
}

/**
 * Index of the last plain override row for an id (not an `insert` row), which is the row an edit changes.
 * @param document - a parsed patch.
 * @param items - the patch's rows.
 * @param id - the row id.
 * @returns the index, or -1.
 */
function overrideIndex(document: Document, items: YAMLSeq['items'], id: string): number {
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index]
    if (isMap(item) && document.getIn([index, 'id']) === id && !item.has('insert')) return index
  }
  return -1
}

/**
 * Read the shared fields from one profile's patch text.
 * @param text - `cordis.patch.yml` content.
 * @param providerRows - the ids of provider rows.
 * @returns provider configs and disabled flags; rows without the field are absent.
 */
export function readPatch(text: string, providerRows: readonly string[]): Pick<ProfileSnapshot, 'providers' | 'disabled'> {
  const { document, items } = parsePatch(text)
  const providers: Record<string, unknown> = {}
  const disabled: Record<string, boolean> = {}
  items.forEach((item, index) => {
    if (!isMap(item) || item.has('insert')) return
    const id = document.getIn([index, 'id'])
    if (typeof id !== 'string') return
    if (providerRows.includes(id) && item.has('config')) providers[id] = (item.get('config', true) as { toJSON(): unknown }).toJSON()
    const flag = document.getIn([index, 'disabled'])
    if (typeof flag === 'boolean') disabled[id] = flag
    else if (item.has('disabled')) disabled[id] = false
  })
  return { providers, disabled }
}

/**
 * Write shared provider configs and disabled flags into one profile's patch text.
 * @param text - the profile's current `cordis.patch.yml`.
 * @param providers - provider row id → config to install.
 * @param disabled - row id → disabled flag to install.
 * @returns the new text, or the input unchanged when nothing differs.
 */
export function writePatch(text: string, providers: Record<string, unknown>, disabled: Record<string, boolean>): string {
  const { document, items } = parsePatch(text)
  const current = readPatch(text, Object.keys(providers))
  let changed = false
  for (const [id, config] of Object.entries(providers)) {
    if (sameJson(current.providers[id], config)) continue
    const index = overrideIndex(document, items, id)
    if (index < 0) document.add({ id, config })
    else document.setIn([index, 'config'], document.createNode(config))
    changed = true
  }
  for (const [id, flag] of Object.entries(disabled)) {
    const index = overrideIndex(document, items, id)
    const present = index < 0 ? undefined : document.getIn([index, 'disabled'])
    if (present === flag || (present === undefined && !flag)) continue
    if (index < 0) document.add({ id, disabled: flag })
    else document.setIn([index, 'disabled'], flag)
    changed = true
  }
  return changed ? String(document) : text
}

/**
 * Read the bundle list from a profile manifest.
 * @param text - `package.json` content.
 * @returns the bundle package names, or null when the manifest declares none.
 */
export function readBundles(text: string): string[] | null {
  const manifest = JSON.parse(text) as { dsh?: { profile?: { bundles?: unknown } } }
  const bundles = manifest.dsh?.profile?.bundles
  return Array.isArray(bundles) && bundles.every((name): name is string => typeof name === 'string') ? bundles : null
}

/**
 * Write the bundle list into a profile manifest, keeping every other field and the file's indentation.
 * @param text - `package.json` content.
 * @param bundles - the bundle package names.
 * @returns the new text, or the input unchanged when the list already matches.
 */
export function writeBundles(text: string, bundles: readonly string[]): string {
  const manifest = JSON.parse(text) as { dsh?: { profile?: { bundles?: string[] } } }
  if (sameJson(manifest.dsh?.profile?.bundles, bundles)) return text
  manifest.dsh ??= {}
  manifest.dsh.profile ??= {}
  manifest.dsh.profile.bundles = [...bundles]
  const indent = /^[{[]\r?\n([ \t]+)/.exec(text)?.[1] ?? '  '
  return `${JSON.stringify(manifest, null, indent)}\n`
}

/**
 * Read the credential references from a credentials file.
 * @param text - `credentials.yaml` content, possibly empty.
 * @returns reference name → value; non-string values are skipped.
 */
export function readRefs(text: string): Record<string, string> {
  if (text.trim() === '') return {}
  const document = parseDocument(text, YAML_OPTIONS)
  const refs = document.get('refs', true)
  const out: Record<string, string> = {}
  if (!isMap(refs)) return out
  for (const pair of refs.items) {
    const key = isScalar(pair.key) ? pair.key.value : pair.key
    const value = isScalar(pair.value) ? pair.value.value : pair.value
    if (typeof key === 'string' && typeof value === 'string') out[key] = value
  }
  return out
}

/**
 * Write credential references into a credentials file, keeping `records` and every other field.
 * @param text - `credentials.yaml` content, possibly empty.
 * @param refs - reference name → value, or null to remove the reference.
 * @returns the new text, or the input unchanged when nothing differs.
 */
export function writeRefs(text: string, refs: Record<string, string | null>): string {
  const document = parseDocument(text.trim() === '' ? 'version: 1\n' : text, YAML_OPTIONS)
  const current = readRefs(text)
  let changed = false
  for (const [name, value] of Object.entries(refs)) {
    if (value === null) {
      if (!(name in current)) continue
      document.deleteIn(['refs', name])
    } else {
      if (current[name] === value) continue
      document.setIn(['refs', name], value)
    }
    changed = true
  }
  return changed ? String(document) : text
}

/**
 * Structural equality for JSON values.
 * @param a - one value.
 * @param b - the other.
 * @returns true when both serialize identically with sorted keys.
 */
export function sameJson(a: unknown, b: unknown): boolean {
  return canonical(a) === canonical(b)
}

/**
 * Serialize JSON with object keys sorted, so key order does not count as a difference.
 * @param value - a JSON value.
 * @returns the canonical text.
 */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) => {
    if (inner === null || typeof inner !== 'object' || Array.isArray(inner)) return inner
    return Object.fromEntries(Object.entries(inner as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
  })
}

/**
 * Record what one profile holds into the store: every field that differs from the store becomes
 * the store's value, stamped with the profile and time. Fields the profile lacks never delete,
 * except credential references, which the profile owns as a whole map once the store has seen it.
 * @param state - the store.
 * @param snapshot - the profile's current shared fields.
 * @param baseline - the profile's shared fields as last synchronized, so only its own edits count; null on first sight.
 * @param from - the profile's name.
 * @param at - the edit time.
 * @returns the updated store and whether it changed.
 */
export function absorb(
  state: SharedState,
  snapshot: ProfileSnapshot,
  baseline: ProfileSnapshot | null,
  from: string,
  at: number,
): { state: SharedState; changed: boolean } {
  const next: SharedState = structuredClone(state)
  let changed = false
  const stamp = <T>(value: T): Stamped<T> => ({ value, at, from })
  const edited = <T>(now: T, before: T | undefined, shared: Stamped<T> | undefined): boolean =>
    (baseline === null ? shared === undefined : !sameJson(now, before)) && !sameJson(now, shared?.value)

  for (const [id, config] of Object.entries(snapshot.providers)) {
    if (edited(config, baseline?.providers[id], next.providers[id])) { next.providers[id] = stamp(config); changed = true }
  }
  for (const [id, flag] of Object.entries(snapshot.disabled)) {
    if (edited(flag, baseline?.disabled[id], next.disabled[id])) { next.disabled[id] = stamp(flag); changed = true }
  }
  // A row whose `disabled` the profile dropped since the baseline is enabled again.
  for (const id of Object.keys(baseline?.disabled ?? {})) {
    if (id in snapshot.disabled) continue
    if (next.disabled[id]?.value !== false) { next.disabled[id] = stamp(false); changed = true }
  }
  if (snapshot.bundles !== null && edited(snapshot.bundles, baseline?.bundles ?? undefined, next.bundles ?? undefined)) {
    next.bundles = stamp(snapshot.bundles)
    changed = true
  }
  for (const [name, value] of Object.entries(snapshot.refs)) {
    if (edited<string | null>(value, baseline?.refs[name], next.refs[name])) { next.refs[name] = stamp(value); changed = true }
  }
  for (const name of Object.keys(baseline?.refs ?? {})) {
    if (name in snapshot.refs || next.refs[name]?.value === null) continue
    next.refs[name] = stamp(null)
    changed = true
  }
  return { state: next, changed }
}

/**
 * Add what `extra` has and `base` lacks: object keys recursively; where both hold a
 * non-object value, or an array, `base` wins.
 * @param base - the value that wins on conflicts.
 * @param extra - the value whose missing parts are added.
 * @returns the merged value.
 */
export function fillMissing(base: unknown, extra: unknown): unknown {
  const isObject = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value)
  if (!isObject(base) || !isObject(extra)) return base
  const out: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(extra)) out[key] = key in base ? fillMissing(base[key], value) : value
  return out
}

/**
 * Seed a store from the running profile, then add what only the other profiles have: provider
 * entries it lacks, bundles it does not list, and credential references it does not hold.
 * Plugin enablement is the running profile's alone: a row only another profile disables is enabled.
 * @param seed - the running profile's shared fields.
 * @param others - every other synchronized profile's shared fields.
 * @param from - the running profile's name.
 * @param at - the pass time.
 * @returns the seeded store.
 */
export function seedState(seed: ProfileSnapshot, others: readonly ProfileSnapshot[], from: string, at: number): SharedState {
  const stamp = <T>(value: T): Stamped<T> => ({ value, at, from })
  const state = emptyState()
  const providers: Record<string, unknown> = { ...seed.providers }
  const refs: Record<string, string> = { ...seed.refs }
  const bundles = seed.bundles === null ? null : [...seed.bundles]
  const disabled: Record<string, boolean> = { ...seed.disabled }
  for (const other of others) {
    for (const [id, config] of Object.entries(other.providers)) {
      providers[id] = id in providers ? fillMissing(providers[id], config) : config
    }
    for (const [name, value] of Object.entries(other.refs)) refs[name] ??= value
    for (const name of other.bundles ?? []) if (bundles !== null && !bundles.includes(name)) bundles.push(name)
    for (const id of Object.keys(other.disabled)) disabled[id] ??= false
  }
  for (const [id, config] of Object.entries(providers)) state.providers[id] = stamp(config)
  for (const [id, flag] of Object.entries(disabled)) state.disabled[id] = stamp(flag)
  for (const [name, value] of Object.entries(refs)) state.refs[name] = stamp(value)
  state.bundles = bundles === null ? null : stamp(bundles)
  return state
}

/**
 * The shared values a profile should hold, from the store.
 * @param state - the store.
 * @returns provider configs, disabled flags, bundles, and reference values (null = remove).
 */
export function desired(state: SharedState): {
  providers: Record<string, unknown>
  disabled: Record<string, boolean>
  bundles: string[] | null
  refs: Record<string, string | null>
} {
  const values = <T>(map: Record<string, Stamped<T>>): Record<string, T> =>
    Object.fromEntries(Object.entries(map).map(([key, entry]) => [key, entry.value]))
  return {
    providers: values(state.providers),
    disabled: values(state.disabled),
    bundles: state.bundles?.value ?? null,
    refs: values(state.refs),
  }
}
