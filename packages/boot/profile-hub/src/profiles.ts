/**
 * Profile directories on disk: metadata, isolation rows, credential seeding,
 * and creation. Everything here is filesystem work with no cordis or Remote
 * dependency, so it is unit-testable without a host.
 *
 * A profile directory is owned by `@deepseek-ai/dsh-app-boot`; this module adds
 * two files of its own (`profile.json` for display metadata, and the
 * `credentials.yaml` a profile writes its own logins into) and the three
 * isolation rows it appends to the profile's patch layer.
 *
 * @module @deepseek-ai/dsh-profile-hub/profiles
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { initProfile } from '@deepseek-ai/dsh-app-boot'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'

/** The display-metadata file this package owns inside a profile directory. */
export const PROFILE_META_FILENAME = 'profile.json'

/** The credentials document name a profile keeps inside its own directory. */
export const PROFILE_CREDENTIALS_FILENAME = 'credentials.yaml'

/** Nested state roots a self-contained profile owns. */
const PROFILE_STATE_DIRS = ['sessions', 'storages'] as const

/** Display metadata this package keeps per profile. */
export interface ProfileMeta {
  /** Display title; the name is used when absent. */
  readonly title?: string
  /** Working directory a launched host starts in. */
  readonly workdir?: string
}

/**
 * Read one profile's display metadata.
 *
 * A field written as `null` reads as absent: a profile configured without a
 * working directory carries no directory, and rendering the literal is worse
 * than rendering nothing.
 * @param dir - absolute profile directory.
 * @returns the metadata, or an empty object when the profile declares none.
 */
export function readProfileMeta(dir: string): ProfileMeta {
  const path = join(dir, PROFILE_META_FILENAME)
  if (!existsSync(path)) return {}
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as ProfileMeta | null
    if (parsed === null || typeof parsed !== 'object') return {}
    return {
      ...typeof parsed.title === 'string' && parsed.title !== '' ? { title: parsed.title } : {},
      ...typeof parsed.workdir === 'string' && parsed.workdir !== '' ? { workdir: parsed.workdir } : {},
    }
  } catch (error) {
    // Display metadata is not worth failing a listing over: a profile whose
    // metadata is unreadable is still a bootable profile, and the page shows it
    // by name. The read is bounded to this one file and its own parse.
    if (error instanceof SyntaxError) return {}
    throw error
  }
}

/**
 * Write one profile's display metadata.
 * @param dir - absolute profile directory.
 * @param meta - the metadata to persist.
 */
export function writeProfileMeta(dir: string, meta: ProfileMeta): void {
  const path = join(dir, PROFILE_META_FILENAME)
  writeFileSync(path, `${JSON.stringify({ version: 1, ...meta }, undefined, 2)}\n`)
}

/**
 * Read a profile's bundle layers.
 * @param dir - absolute profile directory.
 * @returns the declared bundle names, empty when the manifest is absent or declares none.
 */
export function readProfileBundles(dir: string): string[] {
  const path = join(dir, 'package.json')
  if (!existsSync(path)) return []
  try {
    const manifest = JSON.parse(readFileSync(path, 'utf8')) as {
      dsh?: { profile?: { bundles?: unknown } }
    }
    const bundles = manifest.dsh?.profile?.bundles
    return Array.isArray(bundles) ? bundles.filter((name): name is string => typeof name === 'string') : []
  } catch (error) {
    // A manifest this package cannot parse is the loader's diagnostic to raise
    // at boot, not this listing's: the profile still appears, with no layers.
    if (error instanceof SyntaxError) return []
    throw error
  }
}

/**
 * Read a profile's installed plugin entries.
 *
 * A bundle is *selected* by `dsh.profile.bundles` and *installed* by this
 * record. The Web Plugins page reads only the record, so a profile whose
 * layers name a bundle it does not declare here composes and runs that bundle
 * while showing nothing of it on the page it is managed from.
 * @param dir - absolute profile directory.
 * @returns the declared dependency entries, empty when the manifest is absent or declares none.
 */
export function readProfileDependencies(dir: string): Record<string, string> {
  const path = join(dir, 'package.json')
  if (!existsSync(path)) return {}
  try {
    const manifest = JSON.parse(readFileSync(path, 'utf8')) as { dependencies?: unknown }
    const dependencies = manifest.dependencies
    if (dependencies === null || typeof dependencies !== 'object' || Array.isArray(dependencies)) return {}
    return Object.fromEntries(
      Object.entries(dependencies).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
    )
  } catch (error) {
    // A manifest this package cannot parse is the loader's diagnostic to raise
    // at boot, not this listing's: the profile still appears, with no entries.
    if (error instanceof SyntaxError) return {}
    throw error
  }
}

/**
 * Count the chats one session root holds.
 *
 * The JSONL backend lays sessions out as `<root>/<project directory>/<session
 * directory>`, so one directory at depth two is one chat.
 * @param root - absolute session root.
 * @returns the number of chat directories, or 0 when the root is absent.
 */
export function countChats(root: string): number {
  if (!existsSync(root)) return 0
  let chats = 0
  for (const project of readdirSync(root, { withFileTypes: true })) {
    if (!project.isDirectory()) continue
    chats += readdirSync(join(root, project.name), { withFileTypes: true })
      .filter(entry => entry.isDirectory()).length
  }
  return chats
}

/**
 * Whether a profile keeps its own state, as this package creates them.
 * @param dir - absolute profile directory.
 * @returns true when the profile owns a session root of its own.
 */
export function isIsolated(dir: string): boolean {
  return existsSync(join(dir, 'sessions'))
}

/**
 * The patch rows that make a profile self-contained: its chats, its workspaces,
 * and its credentials all live inside its own directory, so no two profiles
 * share a session list or a signed-in DeepSeek account.
 *
 * A patch replaces the targeted row's whole `config`, which is why each row
 * restates every field its bundle layer set (`root` and `path` are the only
 * ones those rows declare).
 * @param dir - absolute profile directory.
 * @returns the patch text to append to the profile's own layer.
 */
export function isolationPatch(dir: string): string {
  return `
# ---------------------------------------------------------------------------
# Per-profile isolation (profile hub). This profile keeps its chats,
# workspaces, and credentials inside its own directory: nothing it does appears
# in another profile's session list, and the DeepSeek account signed in here
# belongs to this profile alone. Delete these three rows to share the
# harness-home state with every other profile instead.
# ---------------------------------------------------------------------------
- id: session-persistence-jsonl
  config:
    root: '${join(dir, 'sessions')}'

- id: storage-json
  config:
    root: '${join(dir, 'storages')}'

- id: credentials
  config:
    path: '${join(dir, PROFILE_CREDENTIALS_FILENAME)}'
`
}

/**
 * Write a profile's own credentials document, seeded with provider keys from
 * the harness home.
 *
 * Only the reference half is copied. A reference is an API key this machine
 * already holds, and a new profile that lacks it would report every provider as
 * unconfigured for no reason the person can see; a record is a login, and the
 * whole point of separate profiles is that each holds its own.
 * @param dir - absolute profile directory.
 * @param home - the harness home holding the shared credentials document.
 */
export function seedProfileCredentials(dir: string, home: string): void {
  const target = join(dir, PROFILE_CREDENTIALS_FILENAME)
  if (existsSync(target)) return
  const shared = join(home, '.credentials.yaml')
  let refs: Record<string, string> = {}
  if (existsSync(shared)) {
    try {
      const parsed = parseYaml(readFileSync(shared, 'utf8')) as { version?: unknown; refs?: unknown } | null
      const values = parsed?.refs
      if (values !== null && typeof values === 'object' && !Array.isArray(values)) {
        refs = Object.fromEntries(
          Object.entries(values as Record<string, unknown>)
            .filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
        )
      }
    } catch (error) {
      // A shared document this package cannot parse is reported by the profile
      // that reads it, at its own boot; here it only means no keys to seed.
      if (!(error instanceof Error)) throw error
    }
  }
  writeFileSync(target, stringifyYaml({ version: 1, refs, records: {} }), { mode: 0o600 })
}

/**
 * Create one self-contained profile directory.
 *
 * The bundle layers are the caller's choice (normally the running profile's),
 * the patch layer starts from the running profile's own text when `tuning` is
 * given, and the three isolation rows are appended last so they win over
 * anything the copied layer happens to say about those rows.
 *
 * The copied bundles come with the install entries the source profile declares
 * for them. A bundle that is composed but not installed is invisible to the
 * Web Plugins page, so a profile created without them would compose the same
 * plugins as its source and offer no way to see or switch any of them.
 * Entries for bundles outside the copied list are left behind: this profile
 * does not carry them.
 * @param dir - absolute profile directory; must not already exist.
 * @param bundles - the ordered bundle layers to declare.
 * @param dependencies - the source profile's install entries, one per installed package.
 * @param tuning - patch text to start from, or undefined for an empty layer.
 * @param home - the harness home, for the credential seed.
 * @param meta - display metadata to persist.
 */
export function createProfileDirectory(
  dir: string,
  bundles: readonly string[],
  dependencies: Readonly<Record<string, string>>,
  tuning: string | undefined,
  home: string,
  meta: ProfileMeta,
): void {
  mkdirSync(dir, { recursive: true })
  try {
    initProfile(dir, bundles)
    const manifestPath = join(dir, 'package.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>
    const installed = Object.fromEntries(Object.entries(dependencies).filter(([name]) => bundles.includes(name)))
    writeFileSync(manifestPath, `${JSON.stringify({ ...manifest, dependencies: installed }, undefined, 2)}\n`)
    // `initProfile` writes the pre-release template patch — a header and an
    // empty list — which the profile's own layer replaces wholesale here.
    writeFileSync(join(dir, 'cordis.patch.yml'), `${(tuning ?? '').trimEnd()}\n${isolationPatch(dir)}`)
    for (const name of PROFILE_STATE_DIRS) mkdirSync(join(dir, name), { recursive: true })
    seedProfileCredentials(dir, home)
    writeProfileMeta(dir, meta)
  } catch (error) {
    // A half-created profile is worse than none: it would list, boot, and be
    // missing whichever file the failure came before.
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], `profileHub: ${dir} could not be removed after a failed create`)
    }
    throw error
  }
}

/**
 * Remove one profile directory and everything it owns.
 * @param dir - absolute profile directory.
 */
export function removeProfileDirectory(dir: string): void {
  rmSync(dir, { recursive: true, force: true })
}
