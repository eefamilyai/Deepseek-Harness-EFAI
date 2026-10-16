/**
 * Profile sync: keeps providers, plugin enablement, and credential references
 * identical across the profiles under the harness home.
 *
 * Every profile that mounts this row watches its own `cordis.patch.yml`,
 * `package.json`, and `credentials.yaml`. On start and after each change it
 * runs one synchronization pass under the store lock: it reads every synced
 * profile's files, records what changed since that profile's last pass into
 * `$DSH_HOME/profile-sync/state.json`, and writes the shared values into every
 * synced profile. A running profile picks the write up through its own patch
 * and manifest watchers; a stopped profile reads it at its next start.
 *
 * The first pass on a machine seeds the store from the profile running it and
 * backs up every synced profile's three files under
 * `$DSH_HOME/profile-sync/backup-<time>/` before overwriting them.
 *
 * @module @deepseek-ai/dsh-profile-sync
 */
import { existsSync, mkdirSync, readdirSync, realpathSync, statSync, symlinkSync, watch, type FSWatcher } from 'node:fs'
import { copyFile, readFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type {} from '@deepseek-ai/dsh-app-boot'
import {
  absorb, desired, emptyState, readBundles, seedState, readPatch, readRefs, writeBundles, writePatch, writeRefs,
  type ProfileSnapshot, type SharedState,
} from './sync.ts'

export type { ProfileSnapshot, SharedState } from './sync.ts'

/** Cordis plugin name. */
export const name = 'profile-sync'

/** Synchronization switches and the set of shared rows. */
export interface Config {
  /** Synchronize at all; off leaves every profile's files as they are. */
  enabled: boolean
  /** Profile names never read or written; a profile listed here does nothing when it runs this row. */
  exclude: string[]
  /** Patch row ids whose `config` is shared: the model providers and their account services. */
  providerRows: string[]
  /** Share plugin enablement: every row's `disabled` flag and the bundle list. */
  plugins: boolean
  /** Share credential references (API keys); login grants always stay per profile. */
  credentials: boolean
  /** Quiet time after a file change before a pass runs, in milliseconds. */
  debounceMs: number
  /** Link a shared bundle installed in only one profile into the shared `profiles/node_modules`, so every profile loads it. */
  linkBundles: boolean
}

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true).description('Keep providers, plugin enablement, and API keys identical across profiles.'),
  exclude: z.array(z.string()).default(['headless', 'desktop-test-instance'])
    .description('Profiles never synchronized. A listed profile running this row does nothing.'),
  providerRows: z.array(z.string()).default([
    'llm-pi-ai', 'llm-deepseek', 'llm-deepseek-account', 'llm-kiln', 'ai-accounts', 'deepseek-account', 'model-visibility',
  ]).description('Patch rows whose config is shared across profiles.'),
  plugins: z.boolean().default(true).description('Share which plugins and bundles are enabled.'),
  credentials: z.boolean().default(true).description('Share API key references (credentials.yaml refs). Logins stay per profile.'),
  debounceMs: z.natural().default(400).description('Quiet time after a file change before synchronizing, in milliseconds.'),
  linkBundles: z.boolean().default(true)
    .description('Make a bundle installed in one profile loadable by every profile, by linking it into the shared profiles/node_modules.'),
})

/** The three files of one profile that hold shared fields. */
interface ProfileFiles {
  name: string
  patch: string
  manifest: string
  credentials: string
}

/** The store file and its per-profile baselines. */
interface StoreFile extends SharedState {
  /** Profile name → its shared fields right after its last pass. */
  baselines: Record<string, ProfileSnapshot>
}

/**
 * The three shared files of a profile directory.
 * @param dir - the profile directory.
 * @returns their paths.
 */
function filesOf(dir: string): ProfileFiles {
  return {
    name: basename(dir),
    patch: join(dir, 'cordis.patch.yml'),
    manifest: join(dir, 'package.json'),
    credentials: join(dir, 'credentials.yaml'),
  }
}

/**
 * Read a file, treating a missing one as empty.
 * @param path - the file.
 * @returns its text, or an empty string.
 */
async function readText(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
    throw error
  }
}

/**
 * Latest modification time among a profile's three files.
 * @param files - the profile's files.
 * @returns epoch ms, 0 when none exists.
 */
function mtimeOf(files: ProfileFiles): number {
  return Math.max(0, ...[files.patch, files.manifest, files.credentials]
    .filter(path => existsSync(path)).map(path => statSync(path).mtimeMs))
}

/**
 * Link each bundle that only one profile has installed into the shared `node_modules` beside the
 * profiles, which every profile's package resolution reaches. The link points at the installed
 * package's real directory, so its own dependencies resolve where its installer put them.
 * @param profilesDir - `$DSH_HOME/profiles`.
 * @param profiles - the synchronized profile names.
 * @param bundles - the shared bundle package names.
 * @returns the bundle names newly linked.
 */
export function linkSharedBundles(profilesDir: string, profiles: readonly string[], bundles: readonly string[]): string[] {
  const linked: string[] = []
  for (const bundle of bundles) {
    const shared = join(profilesDir, 'node_modules', bundle)
    if (existsSync(join(shared, 'package.json'))) continue
    const installed = profiles.map(name => join(profilesDir, name, 'node_modules', bundle))
      .find(dir => existsSync(join(dir, 'package.json')))
    if (installed === undefined) continue
    mkdirSync(dirname(shared), { recursive: true })
    symlinkSync(realpathSync(installed), shared, 'junction')
    linked.push(bundle)
  }
  return linked
}

/**
 * Synchronize every profile under a profiles directory once.
 * @param profilesDir - `$DSH_HOME/profiles`.
 * @param storeDir - `$DSH_HOME/profile-sync`.
 * @param self - the profile running the pass, which seeds the store on the first pass.
 * @param config - the resolved configuration.
 * @param now - the pass time, epoch ms.
 * @returns the profiles whose files the pass rewrote.
 */
export async function synchronize(
  profilesDir: string, storeDir: string, self: string, config: Config, now: number = Date.now(),
): Promise<string[]> {
  mkdirSync(storeDir, { recursive: true })
  const storePath = join(storeDir, 'state.json')
  return await withFileLock(storePath, async () => {
    const raw = await readText(storePath)
    const firstPass = raw === ''
    const store: StoreFile = firstPass ? { ...emptyState(), baselines: {} } : JSON.parse(raw) as StoreFile
    const profiles = readdirSync(profilesDir, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && !config.exclude.includes(entry.name))
      .map(entry => filesOf(join(profilesDir, entry.name)))
      .filter(files => existsSync(files.manifest))

    const snapshotOf = async (files: ProfileFiles): Promise<ProfileSnapshot> => {
      const patch = readPatch(await readText(files.patch), config.providerRows)
      return {
        providers: patch.providers,
        disabled: config.plugins ? patch.disabled : {},
        bundles: config.plugins ? readBundles(await readText(files.manifest)) : null,
        refs: config.credentials ? readRefs(await readText(files.credentials)) : {},
      }
    }

    if (firstPass) {
      const seed = profiles.find(files => files.name === self)
      if (seed === undefined) return []
      const backup = join(storeDir, `backup-${new Date(now).toISOString().replace(/[:.]/g, '-')}`)
      for (const files of profiles) {
        mkdirSync(join(backup, files.name), { recursive: true })
        for (const path of [files.patch, files.manifest, files.credentials]) {
          if (existsSync(path)) await copyFile(path, join(backup, files.name, basename(path)))
        }
      }
      const others: ProfileSnapshot[] = []
      for (const files of profiles) {
        if (files.name === self) continue
        const snapshot = await snapshotOf(files)
        others.push(snapshot)
        store.baselines[files.name] = snapshot
      }
      const seedSnapshot = await snapshotOf(seed)
      Object.assign(store, seedState(seedSnapshot, others, self, now))
      // The running profile counts as already absorbed; what it lacked arrives by the write below.
      store.baselines[self] = seedSnapshot
    }

    // Later edits win: absorb profiles in the order their files last changed.
    let state: SharedState = store
    const ordered = [...profiles].sort((a, b) => mtimeOf(a) - mtimeOf(b))
    for (const files of ordered) {
      const snapshot = await snapshotOf(files)
      state = absorb(state, snapshot, store.baselines[files.name] ?? null, files.name, mtimeOf(files)).state
    }

    const want = desired(state)
    const rewritten: string[] = []
    for (const files of profiles) {
      await withFileLock(files.manifest, async () => {
        const patchText = await readText(files.patch)
        const nextPatch = writePatch(patchText, want.providers, config.plugins ? want.disabled : {})
        const manifestText = await readText(files.manifest)
        const nextManifest = config.plugins && want.bundles !== null ? writeBundles(manifestText, want.bundles) : manifestText
        const credentialsText = await readText(files.credentials)
        const nextCredentials = config.credentials ? writeRefs(credentialsText, want.refs) : credentialsText
        let wrote = false
        if (nextPatch !== patchText) { await writeFileAtomic(files.patch, nextPatch, { mode: 0o600 }); wrote = true }
        if (nextManifest !== manifestText) { await writeFileAtomic(files.manifest, nextManifest, { mode: 0o644 }); wrote = true }
        if (nextCredentials !== credentialsText) {
          await writeFileAtomic(files.credentials, nextCredentials, { mode: 0o600 })
          wrote = true
        }
        if (wrote) rewritten.push(files.name)
      })
      store.baselines[files.name] = await snapshotOf(files)
    }
    if (config.plugins && config.linkBundles && want.bundles !== null) {
      linkSharedBundles(profilesDir, profiles.map(files => files.name), want.bundles)
    }
    const out: StoreFile = { ...state, baselines: store.baselines }
    await writeFileAtomic(storePath, `${JSON.stringify(out, null, 2)}\n`, { mode: 0o600 })
    return rewritten
  })
}

/**
 * Run a pass on start and after every change to this profile's shared files.
 * @param ctx - the plugin context; requires the profile context.
 * @param config - the resolved configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const profile = ctx.get('profileContext')
  if (!config.enabled || profile === undefined) return
  const self = profile.name
  if (config.exclude.includes(self)) return
  const profilesDir = join(profile.home, 'profiles')
  const storeDir = join(profile.home, 'profile-sync')

  let timer: NodeJS.Timeout | undefined
  let running: Promise<void> = Promise.resolve()
  const run = (): void => {
    running = running.then(async () => {
      const rewritten = await synchronize(profilesDir, storeDir, self, config)
      if (rewritten.length > 0) ctx.logger.info('synchronized profiles: %s', rewritten.join(', '))
    }).catch((error: unknown) => { ctx.logger.warn('profile sync failed: %s', String(error)) })
  }
  const schedule = (): void => {
    clearTimeout(timer)
    timer = setTimeout(run, config.debounceMs)
  }

  ctx.effect(() => {
    const files = filesOf(profile.dir)
    // Watch the directory: atomic writes replace the file, which a file watch loses.
    const watched = new Set([basename(files.patch), basename(files.manifest), basename(files.credentials)])
    let watcher: FSWatcher | undefined
    try {
      watcher = watch(profile.dir, (_event, filename) => {
        if (filename !== null && watched.has(filename)) schedule()
      })
    } catch (error) {
      ctx.logger.warn('profile sync cannot watch %s: %s', profile.dir, String(error))
    }
    run()
    return () => {
      clearTimeout(timer)
      watcher?.close()
    }
  }, 'profile-sync: watch')
}
