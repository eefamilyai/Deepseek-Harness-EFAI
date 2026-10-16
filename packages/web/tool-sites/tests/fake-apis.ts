/**
 * An in-memory deSEC zone and GitHub account behind one `fetch`, so the sites
 * service runs end to end without a network.
 */
import type { Fetch } from '../src/clients.ts'

interface FakeRepo {
  name: string
  archived: boolean
  description: string | null
  homepage: string
  commits: { sha: string; tree: string; files: Record<string, { content: string; encoding: string }> }[]
  pages: { status: string | null; cname: string | null; https_enforced: boolean; https_certificate: { state: string } | null } | null
  builds: { status: string; commit: string; error?: { message: string | null } }[]
}

/** The fake's knobs and records. */
export interface FakeApis {
  fetch: Fetch
  owner: string
  repos: Map<string, FakeRepo>
  rrsets: Map<string, { subname: string; type: string; ttl: number; records: string[] }>
  calls: string[]
  /** Answer the next request to a path (substring) with this status. */
  failOnce: (method: string, pathPart: string, status: number, body?: string) => void
  /** How a new commit's build ends: built, errored, or left building. */
  buildOutcome: 'built' | 'errored' | 'building'
  /** The certificate a domain change produces: null (none), new, or approved. */
  certificateAfterCname: string | null
}

/**
 * Make the fake.
 * @param owner - the signed-in GitHub login.
 * @returns the fake's fetch and state.
 */
export function fakeApis(owner = 'octo'): FakeApis {
  let counter = 0
  const sha = (): string => `sha${String(++counter)}`
  const blobs = new Map<string, { content: string; encoding: string }>()
  const trees = new Map<string, Record<string, { content: string; encoding: string }>>()
  const failures: { method: string; part: string; status: number; body: string }[] = []
  const state: FakeApis = {
    owner,
    repos: new Map(),
    rrsets: new Map(),
    calls: [],
    buildOutcome: 'built',
    certificateAfterCname: 'approved',
    failOnce: (method, part, status, body = '{"message":"nope"}') => { failures.push({ method, part, status, body }) },
    fetch: async (url, init) => {
      const method = init?.method ?? 'GET'
      const { pathname, searchParams } = new URL(url)
      state.calls.push(`${method} ${pathname}`)
      const failure = failures.findIndex(item => item.method === method && pathname.includes(item.part))
      if (failure >= 0) {
        const [item] = failures.splice(failure, 1)
        return new Response(item!.body, { status: item!.status })
      }
      const raw = typeof init?.body === 'string' ? init.body : undefined
      const body = (raw === undefined ? undefined : JSON.parse(raw)) as Record<string, unknown> & unknown[]
      const json = (value: unknown, status = 200): Response => new Response(value === undefined ? null : JSON.stringify(value), { status })
      const none = (): Response => new Response(null, { status: 204 })
      const missing = (): Response => new Response('{"message":"Not Found"}', { status: 404 })
      if (url.startsWith('https://desec.io/')) {
        const rr = /\/rrsets\/(?:([^/]+)\/([A-Z]+)\/)?$/u.exec(pathname)!
        if (rr[1] === undefined) {
          if (method === 'GET') return json([...state.rrsets.values()])
          const sets: { subname: string; type: string; ttl: number; records: string[] }[] = body
          for (const item of sets) state.rrsets.set(`${item.subname}/${item.type}`, item)
          return json(body)
        }
        const key = `${rr[1]}/${rr[2]!}`
        if (method === 'DELETE') { state.rrsets.delete(key); return none() }
        return state.rrsets.has(key) ? json(state.rrsets.get(key)) : missing()
      }
      if (pathname === '/user') return json({ login: owner })
      if (pathname === '/user/repos' && method === 'GET') {
        const page = Number(searchParams.get('page'))
        const all = [...state.repos.values()].map(repo => view(repo))
        return json(all.slice((page - 1) * 100, page * 100))
      }
      if (pathname === '/user/repos') {
        const repo: FakeRepo = {
          name: String(body.name), archived: false, description: String(body.description), homepage: String(body.homepage),
          commits: [{ sha: sha(), tree: 'init', files: { 'README.md': { content: 'init', encoding: 'utf-8' } } }], pages: null, builds: [],
        }
        state.repos.set(repo.name, repo)
        return json(view(repo), 201)
      }
      const match = /^\/repos\/[^/]+\/([^/]+)(\/.*)?$/u.exec(pathname)!
      const repo = state.repos.get(match[1]!)
      const rest = match[2] ?? ''
      if (repo === undefined) return missing()
      if (rest === '' && method === 'GET') return json(view(repo))
      if (rest === '' && method === 'PATCH') {
        if (repo.archived && body.archived !== false) return new Response('{"message":"archived"}', { status: 403 })
        Object.assign(repo, body)
        return json(view(repo))
      }
      if (rest === '/git/ref/heads/main') return json({ object: { sha: repo.commits.at(-1)!.sha } })
      if (rest === '/git/blobs') {
        const id = sha()
        const blob: { content: string; encoding: string } = body as never
        blobs.set(id, blob)
        return json({ sha: id }, 201)
      }
      if (rest === '/git/trees') {
        const id = sha()
        trees.set(id, Object.fromEntries((body.tree as { path: string; sha: string }[]).map(item => [item.path, blobs.get(item.sha)!])))
        return json({ sha: id }, 201)
      }
      if (rest === '/git/commits') {
        const id = sha()
        repo.commits.push({ sha: id, tree: String(body.tree), files: trees.get(String(body.tree))! })
        return json({ sha: id }, 201)
      }
      if (rest === '/git/refs/heads/main') {
        const commit = repo.commits.at(-1)!
        if (state.buildOutcome !== 'building' && repo.pages !== null) {
          repo.builds.push({ status: state.buildOutcome, commit: commit.sha, ...state.buildOutcome === 'errored' ? { error: { message: 'bad liquid' } } : {} })
        } else repo.builds.push({ status: 'building', commit: commit.sha })
        return json({ object: { sha: commit.sha } })
      }
      if (rest === '/pages') {
        if (method === 'GET') return repo.pages === null ? missing() : json(repo.pages)
        if (method === 'POST') {
          repo.pages = { status: 'building', cname: null, https_enforced: false, https_certificate: null }
          const last = repo.builds.at(-1)
          if (last !== undefined && state.buildOutcome !== 'building') last.status = state.buildOutcome
          if (last !== undefined && state.buildOutcome === 'errored') last.error = { message: 'bad liquid' }
          return json(repo.pages, 201)
        }
        if (method === 'DELETE') { if (repo.pages === null) return missing(); repo.pages = null; return none() }
        if (repo.pages === null) return missing()
        if ('cname' in body) {
          repo.pages.cname = body.cname as string | null
          const cert = state.certificateAfterCname
          if (body.cname !== null) repo.pages.https_certificate = cert === null ? null : { state: cert }
        }
        if ('https_enforced' in body) repo.pages.https_enforced = Boolean(body.https_enforced)
        return none()
      }
      if (rest === '/pages/builds/latest') return repo.builds.length === 0 ? missing() : json(repo.builds.at(-1))
      return missing()
    },
  }
  const view = (repo: FakeRepo) => ({
    name: repo.name, archived: repo.archived, html_url: `https://github.com/${owner}/${repo.name}`,
    description: repo.description, pushed_at: '2026-10-10T00:00:00Z', default_branch: 'main',
  })
  return state
}
