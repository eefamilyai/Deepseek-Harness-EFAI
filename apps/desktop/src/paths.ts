/** Filesystem ownership for the Electron-managed desktop installation. */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

/** Stable desktop installation paths under the shared Harness home. */
export interface DesktopPaths {
  readonly profile: string
  readonly lock: string
}

/** The profile the shell boots when nothing selects another. */
const DESKTOP_PROFILE_NAME = 'desktop'

/** The file the profile hub records its startup choice in, under the Harness home. */
const PROFILE_HUB_STATE_FILENAME = 'profile-hub.json'

/**
 * The profile this launch of the shell should boot.
 *
 * `DSH_DESKTOP_PROFILE` selects one for a single launch, which is how a running
 * Harness opens another profile as a second Desktop window. A launch that names
 * none starts where the profile hub recorded, so the choice a person makes on
 * the profiles page is the profile the application really opens in.
 * @param dshHome - Harness home shared with npm-installed dsh.
 * @param environment - the environment this launch was started with.
 * @returns the profile name, never empty.
 */
export function desktopProfileName(
  dshHome: string = resolveDshHome(),
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const requested = environment.DSH_DESKTOP_PROFILE?.trim()
  if (requested !== undefined && requested !== '') return requested
  return recordedLauncher(dshHome) ?? DESKTOP_PROFILE_NAME
}

/**
 * Read the profile the hub recorded as opening first, when it still exists.
 * @param dshHome - Harness home holding the hub's state file.
 * @returns the recorded profile name, or undefined when none is usable.
 */
function recordedLauncher(dshHome: string): string | undefined {
  const state = join(dshHome, PROFILE_HUB_STATE_FILENAME)
  if (!existsSync(state)) return undefined
  try {
    const parsed = JSON.parse(readFileSync(state, 'utf8')) as { launcher?: unknown } | null
    const launcher = parsed?.launcher
    if (typeof launcher !== 'string' || launcher.trim() === '') return undefined
    const name = launcher.trim()
    return existsSync(join(dshHome, 'profiles', name, 'package.json')) ? name : undefined
  } catch (error) {
    // An unreadable choice is not a boot failure: the shell's own profile is the
    // documented default. Only this one small file and its own parse are in scope.
    if (error instanceof SyntaxError) return undefined
    throw error
  }
}

/**
 * Resolve every Electron-owned path without changing the shared data roots.
 * @param dshHome - Harness home shared with npm-installed dsh.
 * @param profile - the profile name this shell owns; defaults to the one this launch selected.
 * @returns immutable desktop path set.
 */
export function resolveDesktopPaths(
  dshHome: string = resolveDshHome(),
  profile: string = desktopProfileName(dshHome),
): DesktopPaths {
  return {
    profile: join(dshHome, 'profiles', profile),
    lock: join(dshHome, 'profiles', profile, 'lock'),
  }
}
