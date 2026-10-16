/**
 * The two HTTP APIs a site needs: deSEC for the DNS name and GitHub for the
 * repository and its Pages site. Both take the `fetch` to use, so tests drive
 * them without a network.
 *
 * @module @deepseek-ai/dsh-tool-sites/clients
 */

import { lookup, Resolver } from 'node:dns/promises'

/** The `fetch` the clients call. */
export type Fetch = (url: string, init?: RequestInit) => Promise<Response>

/** A non-2xx answer from either API, with the status and the body text. */
export class ApiError extends Error {
  override readonly name = 'ApiError'

  /**
   * @param api - which API answered.
   * @param status - the HTTP status.
   * @param path - the request path.
   * @param body - the response body text, cut to a readable length.
   */
  constructor(readonly api: 'deSEC' | 'GitHub', readonly status: number, readonly path: string, body: string) {
    super(`${api} ${String(status)} on ${path}: ${body.slice(0, 300)}`)
  }
}

/**
 * Send one JSON request and read the answer.
 * @param fetcher - the fetch to use.
 * @param api - the API name for errors.
 * @param url - the full URL.
 * @param init - method, headers, and body.
 * @returns the parsed body, or undefined for an empty one; 404 answers `null` when `missingOk`.
 */
async function call<T>(
  fetcher: Fetch, api: 'deSEC' | 'GitHub', url: string, init: RequestInit & { missingOk?: boolean },
): Promise<T | null | undefined> {
  const { missingOk, ...rest } = init
  const response = await fetcher(url, rest)
  if (missingOk === true && response.status === 404) return null
  const text = await response.text()
  if (!response.ok) throw new ApiError(api, response.status, new URL(url).pathname, text)
  return text === '' ? undefined : JSON.parse(text) as T
}

/**
 * An answer a call cannot do without.
 * @param value - the parsed body.
 * @param path - the request path, for the error.
 * @returns the value.
 */
function required<T>(value: T | null | undefined, path: string): T {
  if (value === null || value === undefined) throw new Error(`GitHub answered ${path} with an empty body`)
  return value
}

/** deSEC's nameservers, which answer for every zone it hosts. */
const DESEC_NAMESERVERS = ['ns1.desec.io', 'ns2.desec.org']

/**
 * A name's CNAME as deSEC's nameservers answer it, bypassing every cache.
 * @param host - the full name.
 * @returns the CNAME targets.
 */
export async function authoritativeCname(host: string): Promise<string[]> {
  const servers = (await Promise.all(DESEC_NAMESERVERS.map(async name => (await lookup(name, { family: 4 })).address)))
  const resolver = new Resolver({ timeout: 3000, tries: 1 })
  resolver.setServers(servers)
  return await resolver.resolveCname(host)
}

/** One deSEC record set. */
export interface RRset {
  readonly subname: string
  readonly type: string
  readonly ttl: number
  readonly records: readonly string[]
}

/** The deSEC calls a site makes, all inside one zone. */
export class Desec {
  /**
   * @param fetcher - the fetch to use.
   * @param token - the deSEC API token.
   * @param zone - the zone the token manages, e.g. `dshai.reggilion.com`.
   * @param lookup - resolves a name's CNAME at deSEC's own nameservers.
   */
  constructor(
    private readonly fetcher: Fetch,
    private readonly token: string,
    readonly zone: string,
    private readonly lookup: (host: string) => Promise<string[]> = authoritativeCname,
  ) {}

  private async request<T>(path: string, init: RequestInit & { missingOk?: boolean } = {}): Promise<T | null | undefined> {
    return await call<T>(this.fetcher, 'deSEC', `https://desec.io/api/v1/domains/${this.zone}${path}`, {
      ...init,
      headers: { Authorization: `Token ${this.token}`, 'Content-Type': 'application/json' },
    })
  }

  /**
   * Every record set in the zone.
   * @returns the record sets.
   */
  async list(): Promise<RRset[]> {
    return await this.request<RRset[]>('/rrsets/') ?? []
  }

  /**
   * One record set.
   * @param subname - the label below the zone.
   * @param type - the record type.
   * @returns the record set, or null when absent.
   */
  async get(subname: string, type: string): Promise<RRset | null> {
    return await this.request<RRset>(`/rrsets/${subname}/${type}/`, { missingOk: true }) ?? null
  }

  /**
   * Create or replace one record set.
   * @param rrset - the record set.
   */
  async put(rrset: RRset): Promise<void> {
    // A bulk PUT on the collection upserts, so one call serves both a new and an existing name.
    await this.request('/rrsets/', { method: 'PUT', body: JSON.stringify([rrset]) })
  }

  /**
   * Whether deSEC's nameservers answer a name's CNAME yet: deSEC publishes a
   * change a little after accepting it. The authoritative servers are asked
   * directly, because asking a public resolver too early makes it cache "no such
   * name" for the zone's negative TTL (an hour), which is exactly what breaks
   * certificate validation.
   * @param host - the full name.
   * @param target - the CNAME target it must point at.
   * @returns true once a deSEC nameserver answers with that target.
   */
  async visible(host: string, target: string): Promise<boolean> {
    try {
      return (await this.lookup(host)).some(name => `${name.replace(/\.$/u, '')}.` === target)
    } catch {
      return false
    }
  }

  /**
   * Delete one record set; an absent one is not an error.
   * @param subname - the label below the zone.
   * @param type - the record type.
   */
  async remove(subname: string, type: string): Promise<void> {
    await this.request(`/rrsets/${subname}/${type}/`, { method: 'DELETE', missingOk: true })
  }
}

/** The repository fields a site reads. */
export interface Repo {
  readonly name: string
  readonly archived: boolean
  readonly html_url: string
  readonly description: string | null
  readonly pushed_at: string
  readonly default_branch: string
}

/** The Pages fields a site reads. */
export interface Pages {
  readonly status: string | null
  readonly cname: string | null
  readonly html_url?: string
  readonly https_enforced?: boolean
  readonly https_certificate?: { readonly state: string } | null
}

/** One Pages build. */
export interface PagesBuild {
  readonly status: string
  readonly commit: string
  readonly error?: { readonly message: string | null }
}

/** One file of a commit: text, or bytes as base64. */
export interface CommitFile {
  readonly path: string
  readonly content: string
  readonly encoding: 'utf-8' | 'base64'
}

/** The GitHub calls a site makes, all under one owner. */
export class GitHub {
  /**
   * @param fetcher - the fetch to use.
   * @param token - a token with the `repo` scope.
   */
  constructor(private readonly fetcher: Fetch, private readonly token: string) {}

  private async request<T>(path: string, init: RequestInit & { missingOk?: boolean } = {}): Promise<T | null | undefined> {
    return await call<T>(this.fetcher, 'GitHub', `https://api.github.com${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
      },
    })
  }

  /**
   * The signed-in account's login.
   * @returns the login.
   */
  async login(): Promise<string> {
    return required(await this.request<{ login: string }>('/user'), '/user').login
  }

  /**
   * One repository.
   * @param owner - the account.
   * @param repo - the repository name.
   * @returns the repository, or null when absent.
   */
  async repo(owner: string, repo: string): Promise<Repo | null> {
    return await this.request<Repo>(`/repos/${owner}/${repo}`, { missingOk: true }) ?? null
  }

  /**
   * The owner's repositories, every page.
   * @param owner - the signed-in account.
   * @returns the repositories.
   */
  async repos(owner: string): Promise<Repo[]> {
    const all: Repo[] = []
    for (let page = 1; ; page++) {
      const batch = await this.request<Repo[]>(`/user/repos?affiliation=owner&per_page=100&page=${String(page)}`) ?? []
      all.push(...batch.filter(repo => repo.html_url.includes(`/${owner}/`)))
      if (batch.length < 100) return all
    }
  }

  /**
   * Create a public repository with one initial commit.
   * @param name - the repository name.
   * @param description - its description.
   * @param homepage - its website field.
   * @returns the repository.
   */
  async createRepo(name: string, description: string, homepage: string): Promise<Repo> {
    return required(await this.request<Repo>('/user/repos', {
      method: 'POST',
      body: JSON.stringify({ name, description, homepage, auto_init: true, has_issues: false, has_wiki: false, has_projects: false }),
    }), '/user/repos')
  }

  /**
   * Change repository fields.
   * @param owner - the account.
   * @param repo - the repository name.
   * @param fields - the fields to set.
   */
  async updateRepo(owner: string, repo: string, fields: Record<string, unknown>): Promise<void> {
    await this.request(`/repos/${owner}/${repo}`, { method: 'PATCH', body: JSON.stringify(fields) })
  }

  /**
   * Replace a branch's whole content with these files in one commit.
   * @param owner - the account.
   * @param repo - the repository name.
   * @param branch - the branch.
   * @param files - every file the commit holds.
   * @param message - the commit message.
   * @returns the new commit's SHA.
   */
  async commit(owner: string, repo: string, branch: string, files: readonly CommitFile[], message: string): Promise<string> {
    const base = `/repos/${owner}/${repo}/git`
    const head = required(await this.request<{ object: { sha: string } }>(`${base}/ref/heads/${branch}`), 'ref').object.sha
    const tree = []
    for (const file of files) {
      const blob = required(await this.request<{ sha: string }>(`${base}/blobs`, { method: 'POST', body: JSON.stringify(file) }), 'blobs')
      tree.push({ path: file.path, mode: '100644', type: 'blob', sha: blob.sha })
    }
    // No base tree: the commit holds exactly these files, so a file dropped from the site is gone.
    const treeSha = required(await this.request<{ sha: string }>(`${base}/trees`, { method: 'POST', body: JSON.stringify({ tree }) }), 'trees').sha
    const commit = required(await this.request<{ sha: string }>(`${base}/commits`, {
      method: 'POST', body: JSON.stringify({ message, tree: treeSha, parents: [head] }),
    }), 'commits').sha
    await this.request(`${base}/refs/heads/${branch}`, { method: 'PATCH', body: JSON.stringify({ sha: commit }) })
    return commit
  }

  /**
   * The repository's Pages site.
   * @param owner - the account.
   * @param repo - the repository name.
   * @returns the site, or null when Pages is off.
   */
  async pages(owner: string, repo: string): Promise<Pages | null> {
    return await this.request<Pages>(`/repos/${owner}/${repo}/pages`, { missingOk: true }) ?? null
  }

  /**
   * Turn Pages on for a branch's root.
   * @param owner - the account.
   * @param repo - the repository name.
   * @param branch - the branch to serve.
   */
  async enablePages(owner: string, repo: string, branch: string): Promise<void> {
    await this.request(`/repos/${owner}/${repo}/pages`, { method: 'POST', body: JSON.stringify({ source: { branch, path: '/' } }) })
  }

  /**
   * Change the Pages site's custom domain or HTTPS enforcement.
   * @param owner - the account.
   * @param repo - the repository name.
   * @param fields - `cname` (empty clears it) and/or `https_enforced`.
   */
  async updatePages(owner: string, repo: string, fields: { cname?: string; https_enforced?: boolean }): Promise<void> {
    const body = fields.cname === '' ? { ...fields, cname: null } : fields
    await this.request(`/repos/${owner}/${repo}/pages`, { method: 'PUT', body: JSON.stringify(body) })
  }

  /**
   * Turn Pages off; an already-off site is not an error.
   * @param owner - the account.
   * @param repo - the repository name.
   */
  async disablePages(owner: string, repo: string): Promise<void> {
    await this.request(`/repos/${owner}/${repo}/pages`, { method: 'DELETE', missingOk: true })
  }

  /**
   * The latest Pages build.
   * @param owner - the account.
   * @param repo - the repository name.
   * @returns the build, or null before the first one.
   */
  async latestBuild(owner: string, repo: string): Promise<PagesBuild | null> {
    return await this.request<PagesBuild>(`/repos/${owner}/${repo}/pages/builds/latest`, { missingOk: true }) ?? null
  }
}
