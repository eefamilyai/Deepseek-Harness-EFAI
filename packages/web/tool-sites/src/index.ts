/**
 * `@deepseek-ai/dsh-tool-sites`: the `site` tool, which publishes static web
 * pages the agent builds at `https://<name>.<zone>` so the user sees them in a
 * browser: illustrations, slide decks, interactive explainers, charts, reports.
 *
 * Each site is a public GitHub repository served by GitHub Pages; a deSEC CNAME
 * record points the name at it. The deSEC token comes from the `DESEC_TOKEN`
 * environment variable (on Windows also the user's stored environment, so a
 * variable set after the Host started works), and the GitHub token from
 * `GITHUB_TOKEN`, `GH_TOKEN`, or the signed-in GitHub CLI.
 *
 * ```yaml
 * - id: tool-sites
 *   name: '@deepseek-ai/dsh-tool-sites'
 *   config:
 *     zone: dshai.reggilion.com
 * ```
 *
 * @module @deepseek-ai/dsh-tool-sites
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-tools'
import { Desec, GitHub, type Fetch } from './clients.ts'
import { githubToken, probe, readSiteFolder, run, secret } from './local.ts'
import { Sites } from './sites.ts'
import { siteTool } from './tool.ts'

export { ApiError, authoritativeCname, Desec, GitHub } from './clients.ts'
export type { CommitFile, Fetch, Pages, PagesBuild, Repo, RRset } from './clients.ts'
export { checkName, checkPath, LIMITS, SITE_NAME, SiteError, siteFiles, Sites } from './sites.ts'
export type { PublishRequest, PublishResult, SiteEntry, SiteFileContent, SiteSettings, SiteStatus } from './sites.ts'
export { githubToken, probe, readSiteFolder, secret } from './local.ts'
export { filesFrom, SITE_ACTIONS, siteTool } from './tool.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'tool-sites'

/** Required service: the tool registry. */
export const inject = ['tools']

/** Plugin configuration. */
export interface Config {
  /** The deSEC zone sites live in. */
  zone: string
  /** The environment variable holding the deSEC token. */
  tokenEnv: string
  /** The GitHub account owning the site repositories; empty uses the signed-in account. */
  owner: string
  /** The repository name prefix. */
  repoPrefix: string
  /** The CNAME record TTL in seconds (deSEC's minimum for the zone applies). */
  ttl: number
  /** Whether a site without its own robots.txt keeps search engines out. */
  noindex: boolean
}

export const Config: z<Config> = z.object({
  zone: z.string().default('dshai.reggilion.com').description('The deSEC zone sites are published in: each site is <name>.<zone>.'),
  tokenEnv: z.string().default('DESEC_TOKEN').description('The environment variable holding the deSEC API token for the zone.'),
  owner: z.string().default('').description('The GitHub account that owns the site repositories. Empty uses the account the GitHub token signs in as.'),
  repoPrefix: z.string().default('dshai-').description('The prefix of every site repository name.'),
  ttl: z.natural().min(60).default(900).description('The TTL of each site\'s CNAME record, in seconds.'),
  noindex: z.boolean().default(true).description('Give a site without its own robots.txt one that keeps search engines out.'),
})

/** The process-level pieces the plugin reads; tests replace them. */
export interface Environment {
  readonly env: NodeJS.ProcessEnv
  readonly platform: NodeJS.Platform
  readonly fetch: Fetch
  readonly run: typeof run
}

/**
 * Build the sites service from the config and the stored credentials.
 * @param config - the plugin config.
 * @param environment - environment, platform, fetch, and program runner.
 * @returns the service.
 */
export async function createSites(config: Config, environment: Environment): Promise<Sites> {
  const desecToken = await secret(config.tokenEnv, environment.env, environment.run, environment.platform)
  if (desecToken === undefined) {
    throw new Error(`the deSEC token is not set: put it in the ${config.tokenEnv} environment variable`)
  }
  const ghToken = await githubToken(environment.env, environment.run)
  if (ghToken === undefined) throw new Error('no GitHub token: set GITHUB_TOKEN, or sign in with `gh auth login`')
  return new Sites(
    { zone: config.zone, owner: config.owner, repoPrefix: config.repoPrefix, ttl: config.ttl, noindex: config.noindex },
    new Desec(environment.fetch, desecToken, config.zone),
    new GitHub(environment.fetch, ghToken),
    probe,
    async (ms) => { await new Promise((resolve) => { setTimeout(resolve, ms) }) },
  )
}

/**
 * Register the `site` tool. Credentials are read at the first call, so a token
 * set after the Host started is picked up, and a failure is retried next call.
 * @param ctx - the plugin context.
 * @param config - the plugin config.
 */
export function apply(ctx: Context, config: Config): void {
  let pending: Promise<Sites> | undefined
  const sites = async (): Promise<Sites> => {
    pending ??= createSites(config, { env: process.env, platform: process.platform, fetch: globalThis.fetch.bind(globalThis), run })
    try {
      return await pending
    } catch (error: unknown) {
      pending = undefined
      throw error
    }
  }
  ctx.effect(() => ctx.tools.register(siteTool({ sites, readFolder: readSiteFolder, zone: config.zone })), 'tool-sites: site')
}
