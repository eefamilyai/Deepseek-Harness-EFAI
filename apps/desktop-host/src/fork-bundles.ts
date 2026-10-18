/**
 * Keep the fork's bundles on the Desktop profile this Host boots.
 *
 * A fresh install creates its profile from upstream's `web` template, which
 * names only `dsh-base` and `dsh-web-app`. The fork ships its plugins as two
 * more bundles that follow those (`dsh-efai-base`, `dsh-efai-web`), so before
 * the profile is loaded each upstream bundle gets its fork bundle placed right
 * after it, and each fork bundle is registered as an installed dependency (what
 * the Plugins page reads). A profile that already lists them is left byte for
 * byte as it was, and a profile that removed a fork bundle on purpose keeps it
 * removed (see {@link FORK_OPT_OUT}).
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The bundles that follow each upstream one, in order: the fork's own, and after
 * the web one the two optional bundles the fork's Desktop always runs
 * (Automation tasks and voice input).
 */
export const FORK_AFTER: Readonly<Record<string, readonly string[]>> = {
  '@deepseek-ai/dsh-base': ['@deepseek-ai/dsh-efai-base'],
  '@deepseek-ai/dsh-web-app': [
    '@deepseek-ai/dsh-efai-web', '@deepseek-ai/dsh-experimental-schedule-bundle', '@deepseek-ai/dsh-experimental-voice-input-bundle',
  ],
}

/** Every bundle this module adds. */
const ADDED = new Set(Object.values(FORK_AFTER).flat())

/** A profile manifest key that opts the profile out of fork bundles entirely. */
export const FORK_OPT_OUT = 'forkBundles'

interface ProfileManifest {
  dependencies?: Record<string, string>
  dsh?: { profile?: { bundles?: string[] }; [FORK_OPT_OUT]?: boolean }
  [key: string]: unknown
}

/**
 * The bundle list with each fork bundle right after the upstream one it extends.
 * @param bundles - the profile's bundles.
 * @returns the list, unchanged when nothing was missing.
 */
export function withForkBundles(bundles: readonly string[]): string[] {
  const out: string[] = []
  for (const bundle of bundles) {
    out.push(bundle)
    for (const fork of FORK_AFTER[bundle] ?? []) if (!bundles.includes(fork)) out.push(fork)
  }
  return out
}

/**
 * Add the fork bundles to one profile, if it lacks them.
 * @param profileDir - the profile directory (holding package.json).
 * @param version - the dependency range to record for each fork bundle.
 * @returns the fork bundles that were added, empty when the profile was already current.
 */
export function ensureForkBundles(profileDir: string, version = '*'): string[] {
  const path = join(profileDir, 'package.json')
  if (!existsSync(path)) return []
  const text = readFileSync(path, 'utf8')
  const manifest = JSON.parse(text) as ProfileManifest
  if (manifest.dsh?.[FORK_OPT_OUT] === false) return []
  const bundles = manifest.dsh?.profile?.bundles
  if (!Array.isArray(bundles)) return []
  const next = withForkBundles(bundles)
  const added = next.filter(bundle => !bundles.includes(bundle))
  const deps = { ...manifest.dependencies }
  let depsChanged = false
  for (const bundle of next) {
    if (ADDED.has(bundle) && deps[bundle] === undefined) {
      deps[bundle] = version
      depsChanged = true
    }
  }
  if (added.length === 0 && !depsChanged) return []
  const updated: ProfileManifest = {
    ...manifest,
    dependencies: deps,
    dsh: { ...manifest.dsh, profile: { ...manifest.dsh?.profile, bundles: next } },
  }
  writeFileSync(path, `${JSON.stringify(updated, null, 2)}\n`)
  return added
}
