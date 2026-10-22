/**
 * Sites: small static web pages the agent builds, each served at
 * `https://<name>.<zone>` from its own public GitHub repository through GitHub
 * Pages, with the name pointed there by a deSEC CNAME record.
 *
 * Publishing replaces the whole site with the given files in one commit. The
 * service adds three files it owns: `CNAME` (the Pages custom domain),
 * `.nojekyll` (serve files as they are), and, unless the site brings its own,
 * a `robots.txt` that keeps search engines out.
 *
 * Removing a site deletes the DNS record first, then turns Pages off, then
 * archives the repository, so a name never points at a Pages host that no
 * longer claims it.
 *
 * @module @deepseek-ai/dsh-tool-sites/sites
 */

import type { CommitFile, Desec, GitHub, Pages, PagesBuild, Repo } from './clients.ts'

/** A site name: one DNS label of lowercase letters, digits, and inner hyphens. */
export const SITE_NAME = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/

/** Names that are never sites. */
const RESERVED = new Set(['www', 'mail', 'api', 'ns', 'ns1', 'ns2'])

/** Files the service writes into every site; a caller's copy of `CNAME` or `.nojekyll` is replaced. */
const OWNED = new Set(['CNAME', '.nojekyll'])

/** Limits that keep one publish inside what the Git Data API and Pages accept comfortably. */
export const LIMITS = { files: 1000, fileBytes: 25 * 1024 * 1024, totalBytes: 75 * 1024 * 1024 }

/** One file the caller supplies: text, or bytes as base64. */
export type SiteFileContent = string | { readonly base64: string }

/** What the service is configured with. */
export interface SiteSettings {
  /** The DNS zone sites live in. */
  readonly zone: string
  /** The GitHub account that owns the repositories; empty uses the signed-in account. */
  readonly owner: string
  /** The repository name prefix. */
  readonly repoPrefix: string
  /** The CNAME record's TTL in seconds. */
  readonly ttl: number
  /** Whether a site without its own `robots.txt` gets one that keeps search engines out. */
  readonly noindex: boolean
}

/** A request to publish a site. */
export interface PublishRequest {
  readonly name: string
  /** Every file of the site, keyed by its path; must include `index.html`. */
  readonly files: Readonly<Record<string, SiteFileContent>>
  /** A one-line title, used as the repository description. */
  readonly title?: string
  /** The commit message. */
  readonly message?: string
  /** Seconds to wait for the Pages build of this commit; 0 returns at once. */
  readonly waitSeconds?: number
}

/** What a publish did. */
export interface PublishResult {
  readonly name: string
  /** The address to give the user: https once the certificate is issued, http before. */
  readonly url: string
  readonly httpsReady: boolean
  readonly repo: string
  readonly commit: string
  /** The Pages build state for this commit: built, building, errored, or unknown when not waited for. */
  readonly build: string
  readonly created: boolean
  readonly files: number
  readonly bytes: number
  /** What the user should know: first-publish delays, a build error. */
  readonly notes: readonly string[]
}

/** One site as listed. */
export interface SiteEntry {
  readonly name: string
  readonly url: string
  readonly title: string
  /** Whether the DNS name points at Pages. */
  readonly dns: boolean
  /** Whether the repository exists and is not archived. */
  readonly live: boolean
  readonly updatedAt?: string
}

/** What one HTTPS repair pass found and did for a site. */
export interface SecureResult {
  readonly name: string
  /** The host name the site answers on. */
  readonly host: string
  /** The certificate state GitHub reports, or null when it reports none. */
  readonly certificate: string | null
  /** Whether GitHub now enforces HTTPS for the host. */
  readonly enforced: boolean
  /** Whether a request to the host answered over https with a certificate for it. */
  readonly serving: boolean
}

/** A site's state, piece by piece. */
export interface SiteStatus {
  readonly name: string
  readonly url: string
  readonly repo: string | null
  readonly archived: boolean
  readonly dns: string | null
  readonly pages: string | null
  readonly certificate: string | null
  readonly httpsEnforced: boolean
  readonly build: string | null
  readonly buildError: string | null
  /** What a request to the site answered, for http and https. */
  readonly reachable: { readonly http: string; readonly https: string }
}

/** A site the caller named badly, or files the service refuses. */
export class SiteError extends Error {
  override readonly name = 'SiteError'
}

/**
 * Check a site name.
 * @param name - the requested name.
 * @returns the name.
 */
export function checkName(name: string): string {
  if (!SITE_NAME.test(name)) {
    throw new SiteError(`"${name}" is not a site name: use 1-40 lowercase letters, digits, and inner hyphens, like "solar-system"`)
  }
  if (RESERVED.has(name)) throw new SiteError(`"${name}" is reserved; pick another name`)
  return name
}

/**
 * Check a file path inside a site.
 * @param path - the path, with forward slashes.
 * @returns the normalized path.
 */
export function checkPath(path: string): string {
  const clean = path.replace(/\\/gu, '/').replace(/^\.\//u, '')
  const parts = clean.split('/')
  if (clean === '' || clean.startsWith('/') || /^[a-z]:/iu.test(clean) || parts.some(part => part === '' || part === '.' || part === '..')) {
    throw new SiteError(`"${path}" is not a relative file path inside the site`)
  }
  if (parts[0] === '.git') throw new SiteError(`"${path}" is inside .git`)
  return clean
}

/**
 * The commit's files: the caller's, checked and sized, plus the service's own.
 * @param files - the files to publish, keyed by path.
 * @param host - the site's host name.
 * @param noindex - whether to add a `robots.txt` that keeps search engines out.
 * @returns the files and the caller's byte total.
 */
export function siteFiles(
  files: Readonly<Record<string, SiteFileContent>>, host: string, noindex: boolean,
): { files: CommitFile[]; bytes: number } {
  const out = new Map<string, CommitFile>()
  let bytes = 0
  for (const [raw, content] of Object.entries(files)) {
    const path = checkPath(raw)
    if (OWNED.has(path)) continue
    const file: CommitFile = typeof content === 'string'
      ? { path, content, encoding: 'utf-8' }
      : { path, content: content.base64, encoding: 'base64' }
    const size = typeof content === 'string' ? Buffer.byteLength(content) : Buffer.from(content.base64, 'base64').length
    if (size > LIMITS.fileBytes) throw new SiteError(`"${path}" is ${String(size)} bytes; one file may be at most ${String(LIMITS.fileBytes)}`)
    bytes += size
    out.set(path, file)
  }
  if (!out.has('index.html')) throw new SiteError('a site needs an index.html at its root')
  if (out.size > LIMITS.files) throw new SiteError(`a site may have at most ${String(LIMITS.files)} files; this one has ${String(out.size)}`)
  if (bytes > LIMITS.totalBytes) throw new SiteError(`a site may be at most ${String(LIMITS.totalBytes)} bytes; this one is ${String(bytes)}`)
  out.set('CNAME', { path: 'CNAME', content: `${host}\n`, encoding: 'utf-8' })
  out.set('.nojekyll', { path: '.nojekyll', content: '', encoding: 'utf-8' })
  if (noindex && !out.has('robots.txt')) out.set('robots.txt', { path: 'robots.txt', content: 'User-agent: *\nDisallow: /\n', encoding: 'utf-8' })
  return { files: [...out.values()], bytes }
}

/** How a site check reaches the network; tests replace it. */
export type Probe = (url: string) => Promise<string>

/** Waits between Pages build checks; tests replace it. */
export type Sleep = (ms: number) => Promise<void>

/** Certificate states of a failed request, which setting the domain again retries. */
const RETRY_STATES = new Set(['bad_authz', 'errored', 'authorization_revoked', 'dns_changed'])

/**
 * The shortest gap between two certificate requests for one site: a validator that cached "no such name"
 * keeps it for the zone's negative TTL (an hour), so asking more often only queues more failures.
 */
export const NUDGE_EVERY_MS = 20 * 60 * 1000

/** The sites in one zone, backed by one GitHub account: publish, list, check, and take down. */
export class Sites {
  private owner: string | undefined
  /** When each repository's certificate was last asked for again. */
  private readonly nudged = new Map<string, number>()

  /**
   * @param settings - zone, owner, prefix, TTL, and robots policy.
   * @param desec - the zone's DNS client.
   * @param github - the GitHub client.
   * @param probe - fetches a URL and describes the answer.
   * @param sleep - waits between build checks.
   * @param now - the clock.
   */
  constructor(
    private readonly settings: SiteSettings,
    private readonly desec: Desec,
    private readonly github: GitHub,
    private readonly probe: Probe,
    private readonly sleep: Sleep,
    private readonly now: () => number = Date.now,
  ) {
    if (settings.owner !== '') this.owner = settings.owner
  }

  /**
   * A site's host name.
   * @param name - the site name.
   * @returns `<name>.<zone>`.
   */
  host(name: string): string {
    return `${name}.${this.settings.zone}`
  }

  /** The repository owner, asked of GitHub once when not configured. */
  private async account(): Promise<string> {
    this.owner ??= await this.github.login()
    return this.owner
  }

  /** The CNAME target for this owner's Pages. */
  private async target(): Promise<string> {
    return `${await this.account()}.github.io.`
  }

  /**
   * Publish a site, creating its repository, Pages site, and DNS name the first time.
   * @param request - the name, files, and options.
   * @returns what was published and where.
   */
  async publish(request: PublishRequest): Promise<PublishResult> {
    const name = checkName(request.name)
    const host = this.host(name)
    const { files, bytes } = siteFiles(request.files, host, this.settings.noindex)
    const owner = await this.account()
    const repoName = `${this.settings.repoPrefix}${name}`
    const title = request.title?.trim()
    const describe = (text: string): string => text === '' ? `https://${host}` : `${text} — https://${host}`
    let repo = await this.github.repo(owner, repoName)
    const created = repo === null
    if (repo === null) repo = await this.github.createRepo(repoName, describe(title ?? ''), `https://${host}`)
    else {
      // An archived repository is read-only, so it is restored before anything else changes.
      if (repo.archived) await this.github.updateRepo(owner, repoName, { archived: false })
      // Without a new title the site keeps the one it has.
      if (title !== undefined) await this.github.updateRepo(owner, repoName, { description: describe(title), homepage: `https://${host}` })
    }
    // DNS first: GitHub requests the HTTPS certificate only when the name already resolves to Pages.
    const target = await this.target()
    const record = await this.desec.get(name, 'CNAME')
    if (record?.records[0] !== target) await this.desec.put({ subname: name, type: 'CNAME', ttl: this.settings.ttl, records: [target] })
    // Pages validates the domain for the certificate as soon as it is set; a name not yet published fails that (bad_authz).
    for (let tries = 0; tries < 20 && !await this.desec.visible(host, target); tries++) await this.sleep(3000)
    const commit = await this.github.commit(owner, repoName, repo.default_branch, files, request.message ?? `Publish ${name}`)
    let pages = await this.github.pages(owner, repoName)
    if (pages === null) {
      await this.github.enablePages(owner, repoName, repo.default_branch)
      pages = { status: null, cname: null }
    }
    if (pages.cname !== host) await this.github.updatePages(owner, repoName, { cname: host })
    const wait = request.waitSeconds ?? 90
    const build = await this.awaitBuild(owner, repoName, commit, wait)
    // A brand-new name is not probed: an early lookup makes the local resolver cache "not found" for minutes.
    const httpsReady = wait > 0 && await this.secure(owner, repoName, host, !created)
    const notes: string[] = []
    if (build.status === 'errored') notes.push(`The Pages build failed: ${build.error?.message ?? 'no reason given'}.`)
    else if (build.status !== 'built') notes.push('The Pages build is still running; the site updates within a minute or two.')
    if (created) notes.push('A new name can take a few minutes to resolve everywhere (DNS TTL and resolver caches).')
    if (!httpsReady) {
      notes.push(`HTTPS is not serving yet (GitHub issues the certificate, then rolls it out; usually minutes). http://${host} works now;`
        + ' run site status later, which also retries the certificate.')
    }
    return {
      name, url: `${httpsReady ? 'https' : 'http'}://${host}/`, httpsReady, repo: `https://github.com/${owner}/${repoName}`,
      commit, build: build.status, created, files: files.length, bytes, notes,
    }
  }

  /**
   * Wait for the Pages build of a commit.
   * @param owner - the account.
   * @param repo - the repository name.
   * @param commit - the commit the build must be for.
   * @param seconds - how long to wait at most.
   * @returns the build's state, `unknown` when not waited for, `building` when time ran out.
   */
  private async awaitBuild(owner: string, repo: string, commit: string, seconds: number): Promise<{ status: string; error?: PagesBuild['error'] }> {
    if (seconds <= 0) return { status: 'unknown' }
    const deadline = this.now() + seconds * 1000
    for (;;) {
      const build = await this.github.latestBuild(owner, repo)
      if (build !== null && build.commit === commit && (build.status === 'built' || build.status === 'errored')) {
        return build.error === undefined ? { status: build.status } : { status: build.status, error: build.error }
      }
      if (this.now() >= deadline) return { status: 'building' }
      await this.sleep(3000)
    }
  }

  /**
   * Get HTTPS working: ask for the certificate again when GitHub has none, enforce
   * HTTPS once it is approved, and report whether https actually answers.
   * @param owner - the account.
   * @param repo - the repository name.
   * @param host - the site's host name.
   * @param check - whether to ask the site itself; false answers not ready.
   * @returns whether https serves the site now.
   */
  async secure(owner: string, repo: string, host: string, check = true): Promise<boolean> {
    let pages = await this.github.pages(owner, repo)
    const state = pages?.https_certificate?.state ?? null
    const last = this.nudged.get(repo) ?? Number.NEGATIVE_INFINITY
    if (pages !== null && (state === null || RETRY_STATES.has(state)) && this.now() - last >= NUDGE_EVERY_MS) {
      // GitHub checks DNS when the custom domain is set: set before the name resolved, no certificate is requested,
      // or the request fails (bad_authz). Setting the domain again asks again. A request still in progress ("new")
      // is left alone, since setting the domain again restarts it.
      this.nudged.set(repo, this.now())
      await this.github.updatePages(owner, repo, { cname: '' })
      await this.github.updatePages(owner, repo, { cname: host })
      await this.sleep(10_000)
      pages = await this.github.pages(owner, repo)
    }
    if (pages?.https_certificate?.state === 'approved' && pages.https_enforced !== true) {
      try {
        await this.github.updatePages(owner, repo, { https_enforced: true })
      } catch {
        // Enforcement is refused until the certificate is live on GitHub's edge; the next publish or status retries.
      }
    }
    return check && /^[23]/u.test(await this.probe(`https://${host}/`))
  }

  /**
   * Repair HTTPS for every site, or for one.
   *
   * A published site is not usable until GitHub's edge serves a certificate for
   * its own host. The Pages API reports a certificate as approved well before
   * that, and a site whose certificate request failed stays broken with no
   * signal at all — the name simply answers with GitHub's default `*.github.io`
   * certificate and every browser rejects it.
   *
   * This runs the same repair per site: re-request a certificate GitHub gave up
   * on, enforce HTTPS once one is approved, and report what the host actually
   * serves. Publish and status already take this path for the site they touch;
   * this is the sweep that covers every site, including ones published before.
   * @param name - one site, or every live site with a DNS name when omitted.
   * @returns one row per site checked.
   */
  async secureAll(name?: string): Promise<SecureResult[]> {
    const owner = await this.account()
    const names = name === undefined
      ? (await this.list()).filter(site => site.live && site.dns).map(site => site.name)
      : [name]
    const results: SecureResult[] = []
    for (const site of names) {
      const repo = `${this.settings.repoPrefix}${site}`
      const host = this.host(site)
      const serving = await this.secure(owner, repo, host)
      const pages = await this.github.pages(owner, repo)
      results.push({
        name: site,
        host,
        certificate: pages?.https_certificate?.state ?? null,
        enforced: pages?.https_enforced === true,
        serving,
      })
    }
    return results
  }

  /**
   * Every site: DNS names pointing at Pages and the repositories behind them.
   * @returns the sites, by name.
   */
  async list(): Promise<SiteEntry[]> {
    const owner = await this.account()
    const target = await this.target()
    const [records, repos] = await Promise.all([this.desec.list(), this.github.repos(owner)])
    const named = new Set(records.filter(rr => rr.type === 'CNAME' && rr.records[0] === target).map(rr => rr.subname))
    const byName = new Map<string, Repo>()
    const prefix = this.settings.repoPrefix
    for (const repo of repos) if (repo.name.startsWith(prefix)) byName.set(repo.name.slice(prefix.length), repo)
    return [...new Set([...named, ...byName.keys()])].toSorted().map((name) => {
      const repo = byName.get(name)
      const title = repo?.description?.replace(/\s*—?\s*https?:\/\/\S+$/u, '') ?? ''
      return {
        name, url: `https://${this.host(name)}/`, title, dns: named.has(name), live: repo !== undefined && !repo.archived,
        ...repo === undefined ? {} : { updatedAt: repo.pushed_at },
      }
    })
  }

  /**
   * Everything about one site, including whether it answers.
   * @param name - the site name.
   * @returns its state.
   */
  async status(name: string): Promise<SiteStatus> {
    checkName(name)
    const owner = await this.account()
    const repoName = `${this.settings.repoPrefix}${name}`
    const host = this.host(name)
    const [repo, record] = await Promise.all([this.github.repo(owner, repoName), this.desec.get(name, 'CNAME')])
    let pages: Pages | null = null
    let build: PagesBuild | null = null
    if (repo !== null && !repo.archived && record !== null) await this.secure(owner, repoName, host)
    if (repo !== null) [pages, build] = await Promise.all([this.github.pages(owner, repoName), this.github.latestBuild(owner, repoName)])
    const [http, https] = await Promise.all([this.probe(`http://${host}/`), this.probe(`https://${host}/`)])
    return {
      name,
      url: `https://${host}/`,
      repo: repo === null ? null : repo.html_url,
      archived: repo?.archived ?? false,
      dns: record?.records[0] ?? null,
      pages: pages?.status ?? null,
      certificate: pages?.https_certificate?.state ?? null,
      httpsEnforced: pages?.https_enforced ?? false,
      build: build?.status ?? null,
      buildError: build?.error?.message ?? null,
      reachable: { http, https },
    }
  }

  /**
   * Take a site down: the DNS name, then Pages, then archive the repository.
   * @param name - the site name.
   * @returns what was done.
   */
  async remove(name: string): Promise<string[]> {
    checkName(name)
    const owner = await this.account()
    const repoName = `${this.settings.repoPrefix}${name}`
    const done: string[] = []
    await this.desec.remove(name, 'CNAME')
    done.push(`removed the DNS name ${this.host(name)}`)
    const repo = await this.github.repo(owner, repoName)
    if (repo === null) return [...done, `no repository ${owner}/${repoName}`]
    await this.github.disablePages(owner, repoName)
    done.push('turned GitHub Pages off')
    if (!repo.archived) {
      await this.github.updateRepo(owner, repoName, { archived: true })
      done.push(`archived ${repo.html_url} (publishing to the same name again restores it)`)
    }
    return done
  }
}
