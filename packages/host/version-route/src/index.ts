/**
 * The `/version` diagnostics route: which checkout commit the running host was
 * started from.
 *
 * An operator or an agent reading the answer can confirm that the process
 * serving the page is the checkout they just edited, without poking the
 * filesystem or the process table. The snapshot is taken once, when the plugin
 * applies, because the answer describes the code the process is running rather
 * than the code on disk right now.
 *
 * ```yaml
 * - id: version-route
 *   name: '@deepseek-ai/dsh-host-version-route'
 *   config:
 *     root: /path/to/checkout
 * ```
 *
 * @module @deepseek-ai/dsh-host-version-route
 */

import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-host-webserver'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'version-route'

/** The route answers over the web carrier, so the server must be present. */
export const inject = ['webServer']

/** The checkout this package was loaded from, used when no `root` is configured. */
export const DEFAULT_ROOT: string = fileURLToPath(new URL('../../../..', import.meta.url))

/** The path the snapshot is served at. */
export const VERSION_ROUTE_PATH = '/version'

/** Git identity of a checkout, resolved once when the plugin applies. */
export interface VersionInfo {
  /** Full commit hash of the checkout HEAD (40 hex chars), or 'unknown' outside a git tree. */
  commit: string
  /** Seven-character commit prefix for humans. */
  short: string
  /** Whether the working tree carries uncommitted changes relative to HEAD. */
  dirty: boolean
}

/** Plugin config: which checkout the snapshot describes. */
export interface Config {
  /**
   * The checkout whose HEAD the route reports. Defaults to the checkout this
   * package was loaded from, which is the answer a source launch wants; a
   * deployment serving a working tree elsewhere names it here.
   */
  root?: string
}

export const Config: z<Config> = z.object({
  root: z.string().default(DEFAULT_ROOT)
    .description('Checkout whose HEAD commit the /version route reports.'),
})

/**
 * Read a checkout's HEAD and dirty state.
 *
 * A packed or vendored install has no `.git`, so every field falls back to a
 * stable 'unknown' rather than failing the row that mounted this.
 * @param root - the checkout to read.
 * @returns the version snapshot.
 */
export function resolveCommitVersion(root: string): VersionInfo {
  const unknown: VersionInfo = { commit: 'unknown', short: 'unknown', dirty: false }
  try {
    const commit = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
    if (!/^[0-9a-f]{40}$/.test(commit)) return unknown
    let dirty = false
    try {
      dirty = execFileSync('git', ['-C', root, 'status', '--porcelain'], { encoding: 'utf8' }).trim() !== ''
    } catch {
      // Unreadable status is not a version failure; report clean rather than losing the hash.
    }
    return { commit, short: commit.slice(0, 7), dirty }
  } catch {
    return unknown
  }
}

/**
 * Register the route with the boot-time snapshot as its whole answer.
 * @param ctx - the plugin context.
 * @param config - the resolved configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const version = resolveCommitVersion(config.root ?? DEFAULT_ROOT)
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: VERSION_ROUTE_PATH,
    handler: (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(version))
    },
  }), 'version-route: /version')
}
