/**
 * The sites service, the API clients, the local helpers, the tool, and the
 * plugin, against an in-memory GitHub and deSEC.
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const dnsMock = vi.hoisted(() => ({ cname: ['octo.github.io'] as string[] | Error }))
vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async (name: string) => ({ address: name === 'ns1.desec.io' ? '1.1.1.1' : '2.2.2.2' })),
  Resolver: class {
    servers: string[] = []
    setServers(servers: string[]) { this.servers = servers }
    async resolveCname() { if (dnsMock.cname instanceof Error) throw dnsMock.cname; return dnsMock.cname }
  },
}))
import { Context } from '@deepseek-ai/cordis'
import { ApiError, authoritativeCname, Desec, GitHub } from '../src/clients.ts'
import { apply, Config, createSites, inject, name as pluginName } from '../src/index.ts'
import { githubToken, probe, readSiteFolder, run as runProgram, secret } from '../src/local.ts'
import { checkName, checkPath, LIMITS, NUDGE_EVERY_MS, SiteError, siteFiles, Sites, type SiteSettings } from '../src/sites.ts'
import { filesFrom, siteTool } from '../src/tool.ts'
import { fakeApis, type FakeApis } from './fake-apis.ts'

const settings: SiteSettings = { zone: 'z.example', owner: '', repoPrefix: 'dshai-', ttl: 900, noindex: true }
const temps: string[] = []
afterEach(() => { for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function service(api: FakeApis = fakeApis(), overrides: Partial<SiteSettings> = {}, answer = '200', step = NUDGE_EVERY_MS) {
  const probe = vi.fn(async () => answer)
  const sleep = vi.fn(async () => {})
  let clock = 0
  // The authoritative lookup reads the fake zone, so a record is visible as soon as it is written.
  const lookup = vi.fn(async (host: string) => {
    const record = api.rrsets.get(`${host.split('.')[0]!}/CNAME`)
    if (record === undefined) throw new Error('ENOTFOUND')
    return record.records.map(target => target.replace(/\.$/u, ''))
  })
  const desec = new Desec(api.fetch, 't', 'z.example', lookup)
  const sites = new Sites({ ...settings, ...overrides }, desec, new GitHub(api.fetch, 'g'), probe, sleep, () => (clock += step))
  return { api, sites, probe, sleep, lookup }
}

const page = { 'index.html': '<h1>hi</h1>' }

describe('names, paths, and files', () => {
  it('accepts DNS-label names and refuses others', () => {
    expect(checkName('solar-system')).toBe('solar-system')
    for (const bad of ['', '-a', 'a-', 'A', 'a_b', 'a'.repeat(41), 'a.b']) expect(() => checkName(bad)).toThrow(SiteError)
    expect(() => checkName('www')).toThrow('reserved')
  })

  it('accepts relative paths and refuses escapes', () => {
    expect(checkPath('./a\\b.js')).toBe('a/b.js')
    for (const bad of ['', '/a', 'C:/a', 'a//b', 'a/../b', '.', '.git/config']) expect(() => checkPath(bad)).toThrow(SiteError)
  })

  it('adds the owned files, keeps a site robots.txt, sizes bytes, and enforces limits', () => {
    const { files, bytes } = siteFiles({ ...page, CNAME: 'evil.example', 'img.png': { base64: Buffer.from('abc').toString('base64') } }, 'h.z', true)
    expect(Object.fromEntries(files.map(file => [file.path, file.content]))).toEqual({
      'index.html': '<h1>hi</h1>', 'img.png': 'YWJj', CNAME: 'h.z\n', '.nojekyll': '', 'robots.txt': 'User-agent: *\nDisallow: /\n',
    })
    expect(bytes).toBe(14)
    expect(siteFiles({ ...page, 'robots.txt': 'own' }, 'h', true).files.find(file => file.path === 'robots.txt')!.content).toBe('own')
    expect(siteFiles(page, 'h', false).files.map(file => file.path)).not.toContain('robots.txt')
    expect(() => siteFiles({ 'a.html': 'x' }, 'h', true)).toThrow('index.html')
    expect(() => siteFiles({ ...page, big: 'x'.repeat(LIMITS.fileBytes + 1) }, 'h', true)).toThrow('one file may be at most')
    const many = Object.fromEntries(Array.from({ length: LIMITS.files + 1 }, (_, i) => [`f${String(i)}.txt`, 'x']))
    expect(() => siteFiles({ ...page, ...many }, 'h', true)).toThrow('at most 1000 files')
    const heavy = Object.fromEntries(Array.from({ length: 4 }, (_, i) => [`b${String(i)}.bin`, 'x'.repeat(LIMITS.fileBytes)]))
    expect(() => siteFiles({ ...page, ...heavy }, 'h', true)).toThrow('may be at most')
  })
})

describe('publishing', () => {
  it('creates the repository, DNS name, Pages site, and certificate, in DNS-first order', async () => {
    const { api, sites, probe } = service()
    const result = await sites.publish({ name: 'demo', title: 'Demo', files: page })
    expect(result).toMatchObject({
      name: 'demo', url: 'http://demo.z.example/', httpsReady: false, repo: 'https://github.com/octo/dshai-demo', build: 'built', created: true, files: 4,
    })
    expect(result.notes.join(' ')).toMatch(/resolve everywhere.*HTTPS is not serving yet/u)
    expect(probe).not.toHaveBeenCalled()
    const repo = api.repos.get('dshai-demo')!
    expect(repo.description).toBe('Demo — https://demo.z.example')
    expect(Object.keys(repo.commits.at(-1)!.files).toSorted()).toEqual(['.nojekyll', 'CNAME', 'index.html', 'robots.txt'])
    expect(api.rrsets.get('demo/CNAME')).toEqual({ subname: 'demo', type: 'CNAME', ttl: 900, records: ['octo.github.io.'] })
    expect(repo.pages).toMatchObject({ cname: 'demo.z.example', https_enforced: true, https_certificate: { state: 'approved' } })
    const order = api.calls.map(call => call.replace(/^(\w+) .*?(rrsets|git\/commits|pages)(?:\/.*)?$/u, '$1 $2'))
    expect(order.indexOf('PUT rrsets')).toBeLessThan(order.indexOf('POST git/commits'))
    expect(order.indexOf('POST git/commits')).toBeLessThan(order.indexOf('POST pages'))
  })

  it('updates an existing site, reports https when it answers, and leaves the DNS record alone', async () => {
    const { api, sites, probe } = service(fakeApis(), { owner: 'octo' })
    await sites.publish({ name: 'demo', files: page })
    api.calls.length = 0
    const result = await sites.publish({ name: 'demo', files: { 'index.html': 'v2' }, message: 'second' })
    expect(result).toMatchObject({ url: 'https://demo.z.example/', httpsReady: true, created: false, notes: [] })
    expect(probe).toHaveBeenCalledWith('https://demo.z.example/')
    expect(api.calls).not.toContain('PUT /api/v1/domains/z.example/rrsets/')
    expect(api.calls).not.toContain('GET /user')
    expect(api.repos.get('dshai-demo')!.description).toBe('https://demo.z.example')
    await sites.publish({ name: 'demo', files: page, title: 'Named' })
    await sites.publish({ name: 'demo', files: page })
    expect(api.repos.get('dshai-demo')!.description).toBe('Named — https://demo.z.example')
    await sites.publish({ name: 'demo', files: page, title: ' ' })
    expect(api.repos.get('dshai-demo')!.description).toBe('https://demo.z.example')
  })

  it('restores an archived repository before changing it', async () => {
    const { api, sites } = service()
    await sites.publish({ name: 'demo', files: page })
    await sites.remove('demo')
    expect(api.repos.get('dshai-demo')!.archived).toBe(true)
    const result = await sites.publish({ name: 'demo', files: page })
    expect(api.repos.get('dshai-demo')!.archived).toBe(false)
    expect(result.created).toBe(false)
  })

  it('asks for the certificate again when none was requested or a request failed, at most every 20 minutes', async () => {
    const api = fakeApis()
    api.certificateAfterCname = null
    const slow = service(api, {}, '200', 1000)
    await slow.sites.publish({ name: 'demo', files: page })
    const repo = api.repos.get('dshai-demo')!
    expect(repo.pages!.https_certificate).toBeNull()
    api.certificateAfterCname = 'approved'
    // Within the gap since the last request, no new request is made.
    await slow.sites.publish({ name: 'demo', files: page })
    expect(repo.pages!.https_certificate).toBeNull()
    const { sites } = service(api)
    for (const failed of ['bad_authz', 'errored', 'authorization_revoked', 'dns_changed']) {
      repo.pages!.https_certificate = { state: failed }
      api.calls.length = 0
      await sites.publish({ name: 'demo', files: page })
      expect(api.calls.filter(call => call === 'PUT /repos/octo/dshai-demo/pages').length).toBeGreaterThanOrEqual(2)
      expect(repo.pages!.https_certificate).toEqual({ state: 'approved' })
    }
    // A request in progress is left alone.
    repo.pages!.https_certificate = { state: 'new' }
    api.calls.length = 0
    await sites.publish({ name: 'demo', files: page })
    expect(repo.pages!.https_certificate).toEqual({ state: 'new' })
  })

  it('enforces HTTPS once approved, tolerating a refusal while the certificate rolls out', async () => {
    const api = fakeApis()
    const { sites } = service(api)
    await sites.publish({ name: 'demo', files: page })
    const repo = api.repos.get('dshai-demo')!
    repo.pages!.https_enforced = false
    api.failOnce('PUT', '/pages', 409)
    expect((await sites.publish({ name: 'demo', files: page })).httpsReady).toBe(true)
    expect(repo.pages!.https_enforced).toBe(false)
    expect((await sites.publish({ name: 'demo', files: page })).httpsReady).toBe(true)
    expect(repo.pages!.https_enforced).toBe(true)
  })

  it('waits for deSEC to publish a new record before setting the Pages domain', async () => {
    const api = fakeApis()
    const { sites, sleep, lookup } = service(api)
    lookup.mockRejectedValueOnce(new Error('ENOTFOUND')).mockResolvedValueOnce(['someone.else'])
    await sites.publish({ name: 'demo', files: page })
    expect(lookup).toHaveBeenCalledTimes(3)
    expect(sleep).toHaveBeenCalledWith(3000)
    lookup.mockClear()
    lookup.mockRejectedValue(new Error('down'))
    await sites.publish({ name: 'other', files: page })
    expect(lookup).toHaveBeenCalledTimes(20)
  })

  it('reports a failed build, a build still running, and a publish that does not wait', async () => {
    const api = fakeApis()
    const { sites, sleep } = service(api, {}, '200', 1000)
    api.buildOutcome = 'errored'
    expect((await sites.publish({ name: 'demo', files: page })).notes[0]).toBe('The Pages build failed: bad liquid.')
    api.buildOutcome = 'building'
    const running = await sites.publish({ name: 'demo', files: page, waitSeconds: 5 })
    expect(running.build).toBe('building')
    expect(running.notes[0]).toMatch(/still running/u)
    expect(sleep).toHaveBeenCalledWith(3000)
    const quick = await sites.publish({ name: 'demo', files: page, waitSeconds: 0 })
    expect(quick).toMatchObject({ build: 'unknown', httpsReady: false })
  })

  it('names an errored build without a message', async () => {
    const api = fakeApis()
    const { sites } = service(api)
    await sites.publish({ name: 'demo', files: page })
    api.buildOutcome = 'building'
    const original = api.fetch
    api.fetch = async (url, init) => {
      if (url.endsWith('/pages/builds/latest')) {
        const head = api.repos.get('dshai-demo')!.commits.at(-1)!.sha
        return new Response(JSON.stringify({ status: 'errored', commit: head, error: { message: null } }))
      }
      return await original(url, init)
    }
    const again = service(api).sites
    expect((await again.publish({ name: 'demo', files: page })).notes[0]).toBe('The Pages build failed: no reason given.')
  })
})

describe('listing, status, and removal', () => {
  it('lists DNS names and repositories together', async () => {
    const api = fakeApis()
    const { sites } = service(api)
    expect(await sites.list()).toEqual([])
    await sites.publish({ name: 'alpha', title: 'Alpha', files: page })
    await sites.publish({ name: 'beta', files: page })
    await sites.remove('beta')
    api.rrsets.set('orphan/CNAME', { subname: 'orphan', type: 'CNAME', ttl: 900, records: ['octo.github.io.'] })
    api.rrsets.set('other/A', { subname: 'other', type: 'A', ttl: 900, records: ['1.2.3.4'] })
    api.repos.set('unrelated', { ...api.repos.get('dshai-alpha')!, name: 'unrelated' })
    api.repos.set('dshai-nodesc', { ...api.repos.get('dshai-alpha')!, name: 'dshai-nodesc', description: null })
    expect(await sites.list()).toEqual([
      { name: 'alpha', url: 'https://alpha.z.example/', title: 'Alpha', dns: true, live: true, updatedAt: '2026-10-10T00:00:00Z' },
      { name: 'beta', url: 'https://beta.z.example/', title: '', dns: false, live: false, updatedAt: '2026-10-10T00:00:00Z' },
      { name: 'nodesc', url: 'https://nodesc.z.example/', title: '', dns: false, live: true, updatedAt: '2026-10-10T00:00:00Z' },
      { name: 'orphan', url: 'https://orphan.z.example/', title: '', dns: true, live: false },
    ])
  })

  it('pages through more than one hundred repositories', async () => {
    const api = fakeApis()
    const { sites } = service(api)
    await sites.publish({ name: 'seed', files: page })
    const seed = api.repos.get('dshai-seed')!
    for (let i = 0; i < 120; i++) api.repos.set(`dshai-s${String(i)}`, { ...seed, name: `dshai-s${String(i)}` })
    expect((await sites.list()).length).toBe(121)
  })

  it('reports every piece of a site, and of a missing one', async () => {
    const api = fakeApis()
    const { sites } = service(api, {}, '200')
    await sites.publish({ name: 'demo', files: page })
    expect(await sites.status('demo')).toEqual({
      name: 'demo', url: 'https://demo.z.example/', repo: 'https://github.com/octo/dshai-demo', archived: false,
      dns: 'octo.github.io.', pages: 'building', certificate: 'approved', httpsEnforced: true, build: 'built', buildError: null,
      reachable: { http: '200', https: '200' },
    })
    expect(await sites.status('nothing')).toMatchObject({ repo: null, dns: null, pages: null, certificate: null, build: null, httpsEnforced: false })
    api.buildOutcome = 'errored'
    await sites.publish({ name: 'demo', files: page })
    expect((await sites.status('demo')).buildError).toBe('bad liquid')
  })

  it('takes a site down DNS first, and tolerates one already gone', async () => {
    const api = fakeApis()
    const { sites } = service(api)
    await sites.publish({ name: 'demo', files: page })
    expect(await sites.remove('demo')).toEqual([
      'removed the DNS name demo.z.example', 'turned GitHub Pages off',
      'archived https://github.com/octo/dshai-demo (publishing to the same name again restores it)',
    ])
    expect(api.rrsets.has('demo/CNAME')).toBe(false)
    expect(await sites.remove('demo')).toEqual(['removed the DNS name demo.z.example', 'turned GitHub Pages off'])
    expect(await sites.remove('ghost')).toEqual(['removed the DNS name ghost.z.example', 'no repository octo/dshai-ghost'])
  })
})

describe('the API clients', () => {
  it('raises an ApiError with the status, path, and body', async () => {
    const api = fakeApis()
    api.failOnce('GET', '/user', 401, 'bad credentials')
    const error = await new GitHub(api.fetch, 'g').login().catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(ApiError)
    expect((error as ApiError).message).toBe('GitHub 401 on /user: bad credentials')
    expect((error as ApiError).status).toBe(401)
  })

  it('asks deSEC nameservers directly for a CNAME', async () => {
    dnsMock.cname = ['octo.github.io']
    expect(await authoritativeCname('a.z')).toEqual(['octo.github.io'])
    expect(await new Desec(vi.fn(), 't', 'z').visible('a.z', 'octo.github.io.')).toBe(true)
    dnsMock.cname = new Error('ENOTFOUND')
    await expect(authoritativeCname('a.z')).rejects.toThrow('ENOTFOUND')
    expect(await new Desec(vi.fn(), 't', 'z').visible('a.z', 'octo.github.io.')).toBe(false)
    dnsMock.cname = ['octo.github.io']
  })

  it('refuses an empty answer where a body is needed', async () => {
    await expect(new GitHub(async () => new Response('', { status: 200 }), 'g').login()).rejects.toThrow('GitHub answered /user with an empty body')
  })

  it('reads an empty deSEC zone listing as none', async () => {
    const empty = new Desec(async () => new Response('', { status: 200 }), 't', 'z')
    expect(await empty.list()).toEqual([])
    const github = new GitHub(async () => new Response('', { status: 200 }), 'g')
    expect(await github.repos('o')).toEqual([])
    expect(await github.latestBuild('o', 'r')).toBeNull()
  })
})

describe('local helpers', () => {
  it('reads a secret from the environment, then the Windows user environment', async () => {
    const run = vi.fn(async () => '\r\nHKEY_CURRENT_USER\\Environment\r\n    TOKEN    REG_SZ    abc123\r\n')
    expect(await secret('TOKEN', { TOKEN: ' env ' }, run, 'win32')).toBe('env')
    expect(await secret('TOKEN', {}, run, 'win32')).toBe('abc123')
    expect(await secret('TOKEN', { TOKEN: '' }, run, 'linux')).toBeUndefined()
    expect(await secret('TOKEN', {}, vi.fn(async () => 'nothing'), 'win32')).toBeUndefined()
    expect(await secret('TOKEN', {}, vi.fn(async () => { throw new Error('absent') }), 'win32')).toBeUndefined()
  })

  it('runs a program and answers its trimmed output, or rejects', async () => {
    expect(await runProgram(process.execPath, ['-e', 'console.log("  out  ")'])).toBe('out')
    await expect(runProgram(process.execPath, ['-e', 'process.exit(3)'])).rejects.toThrow()
  })

  it('finds a GitHub token in the environment or the GitHub CLI', async () => {
    expect(await githubToken({ GITHUB_TOKEN: 'a' }, vi.fn())).toBe('a')
    expect(await githubToken({ GH_TOKEN: 'b', GITHUB_TOKEN: ' ' }, vi.fn())).toBe('b')
    expect(await githubToken({}, vi.fn(async () => 'c'))).toBe('c')
    expect(await githubToken({}, vi.fn(async () => ''))).toBeUndefined()
    expect(await githubToken({}, vi.fn(async () => { throw new Error('no gh') }))).toBeUndefined()
  })

  it('reads a site folder, skipping .git and node_modules, with binary files as base64', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'site-'))
    temps.push(dir)
    mkdirSync(join(dir, 'assets'))
    mkdirSync(join(dir, '.git'))
    mkdirSync(join(dir, 'node_modules'))
    writeFileSync(join(dir, 'index.html'), '<h1>x</h1>')
    writeFileSync(join(dir, 'assets', 'logo.png'), Buffer.from([1, 2, 3]))
    writeFileSync(join(dir, '.git', 'HEAD'), 'ref')
    writeFileSync(join(dir, 'node_modules', 'm.js'), 'x')
    // A junction is neither a plain file nor a folder entry, so it is skipped.
    symlinkSync(join(dir, 'assets'), join(dir, 'linked'), 'junction')
    expect(await readSiteFolder(dir)).toEqual({ 'index.html': '<h1>x</h1>', 'assets/logo.png': { base64: 'AQID' } })
    await expect(readSiteFolder(join(dir, 'index.html'))).rejects.toThrow('is not a folder')
    await expect(readSiteFolder(join(dir, 'missing'))).rejects.toThrow('is not a folder')
  })

  it('refuses a folder with too many files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'site-'))
    temps.push(dir)
    for (let i = 0; i <= LIMITS.files; i++) writeFileSync(join(dir, `f${String(i)}.txt`), 'x')
    await expect(readSiteFolder(dir)).rejects.toThrow('more than 1000 files')
  })

  it('describes what a URL answers', async () => {
    const real = globalThis.fetch
    try {
      globalThis.fetch = vi.fn(async () => new Response('ok', { status: 200 }))
      expect(await probe('https://a')).toBe('200')
      globalThis.fetch = vi.fn(async () => new Response(null, { status: 301, headers: { location: 'https://b' } }))
      expect(await probe('http://a')).toBe('301 → https://b')
      globalThis.fetch = vi.fn(async () => new Response(null, { status: 302 }))
      expect(await probe('http://a')).toBe('302 → ?')
      globalThis.fetch = vi.fn(async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }) })
      expect(await probe('http://a')).toMatch(/^no answer \(ENOTFOUND: this computer's DNS cache/u)
      globalThis.fetch = vi.fn(async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { message: 'cert' } }) })
      expect(await probe('http://a')).toBe('no answer (cert)')
      globalThis.fetch = vi.fn(async () => { throw new Error('timeout') })
      expect(await probe('http://a')).toBe('no answer (timeout)')
      globalThis.fetch = vi.fn(async () => { throw 'odd' })
      expect(await probe('http://a')).toBe('no answer (odd)')
    } finally {
      globalThis.fetch = real
    }
  })
})

describe('the site tool', () => {
  async function run(args: Record<string, unknown>, api = fakeApis(), readFolder = vi.fn(async () => page)) {
    const { sites } = service(api)
    const tool = siteTool({ sites: async () => sites, readFolder, zone: 'z.example' })
    const exec: never = { signal: new AbortController().signal } as never
    const value = await tool.execute(args, exec) as { text: string; url?: string }
    return { value, api, readFolder, tool }
  }

  it('describes itself and maps inline files', () => {
    const tool = siteTool({ sites: vi.fn(), readFolder: vi.fn(), zone: 'z.example' })
    expect(tool.name).toBe('site')
    expect(tool.description).toContain('https://<name>.z.example')
    const shown: never = { text: 'shown' } as never
    expect(tool.output?.render?.({}, shown)).toEqual([{ type: 'text', text: 'shown' }])
    expect(filesFrom([{ path: 'a.html', content: 'x' }, { path: 'b.png', content: 'AA==', base64: true }])).toEqual({ 'a.html': 'x', 'b.png': { base64: 'AA==' } })
  })

  it('publishes inline files and folders, and lists, checks, and removes', async () => {
    const api = fakeApis()
    const created = await run({ action: 'publish', name: 'demo', title: 'T', wait_seconds: 5, files: [{ path: 'index.html', content: '<p>x</p>' }] }, api)
    expect(created.value.url).toBe('http://demo.z.example/')
    expect(created.value.text.split('\n').slice(0, 2)).toEqual([
      'Created http://demo.z.example/ (4 files, 8 bytes; build built).', 'Source: https://github.com/octo/dshai-demo',
    ])
    const folder = await run({ action: 'publish', name: 'demo', dir: 'C:\\site' }, api)
    expect(folder.readFolder).toHaveBeenCalledWith('C:\\site')
    expect(folder.value.text).toMatch(/^Updated https:/u)
    expect((await run({ action: 'list' }, api)).value.text).toBe('- demo: https://demo.z.example/ — T')
    expect((await run({ action: 'status', name: 'demo' }, api)).value.text).toContain('- answers: http 200; https 200')
    expect((await run({ action: 'remove', name: 'demo' }, api)).value.text).toContain('- removed the DNS name demo.z.example')
    expect((await run({ action: 'list' }, api)).value.text).toBe('- demo: https://demo.z.example/ — T (taken down)')
    expect((await run({ action: 'status', name: 'demo' }, api)).value.text).toContain('(archived: taken down)')
  })

  it('shows sites without a DNS name, missing pieces, and an empty list', async () => {
    const api = fakeApis()
    expect((await run({ action: 'list' }, api)).value.text).toBe('No sites yet.')
    await run({ action: 'publish', name: 'demo', files: [{ path: 'index.html', content: 'x' }] }, api)
    api.rrsets.clear()
    expect((await run({ action: 'list' }, api)).value.text).toBe('- demo: https://demo.z.example/ (no DNS name)')
    const missing = (await run({ action: 'status', name: 'ghost' }, api)).value.text
    expect(missing).toContain('- repository: none')
    expect(missing).toContain('- DNS: no record')
    expect(missing).toContain('- Pages: off; latest build none')
    expect(missing).toContain('- HTTPS certificate: none')
    api.buildOutcome = 'errored'
    await run({ action: 'publish', name: 'demo', files: [{ path: 'index.html', content: 'x' }] }, api)
    const repo = api.repos.get('dshai-demo')!
    repo.pages!.https_enforced = false
    repo.pages!.https_certificate = { state: 'new' }
    expect((await run({ action: 'status', name: 'demo' }, api)).value.text).toContain('latest build errored (bad liquid)')
    // The API state is not readiness: the line always says whether GitHub's edge
    // is actually serving a certificate a browser accepts, because the two are
    // minutes to hours apart and only the second one makes the site usable.
    const statusText = (await run({ action: 'status', name: 'demo' }, api)).value.text
    expect(statusText).toContain('- HTTPS certificate: new')
    expect(statusText).toMatch(/HTTPS certificate: new[^\n]*— (served|NOT served)/)
  })

  it('sweeps every site for HTTPS and reports what each host actually serves', async () => {
    const api = fakeApis()
    // Two live sites: one already approved but not enforced, one whose
    // certificate request failed and must be asked for again.
    await run({ action: 'publish', name: 'ready', files: [{ path: 'index.html', content: 'x' }] }, api)
    await run({ action: 'publish', name: 'broken', files: [{ path: 'index.html', content: 'x' }] }, api)
    const ready = api.repos.get('dshai-ready')!
    const broken = api.repos.get('dshai-broken')!
    ready.pages!.https_enforced = false
    ready.pages!.https_certificate = { state: 'approved' }
    broken.pages!.https_enforced = false
    broken.pages!.https_certificate = { state: 'bad_authz' }

    const sweep = await run({ action: 'secure' }, api)
    expect(sweep.value.text).toContain('HTTPS repair across 2 site(s)')
    expect(sweep.value.text).toContain('ready: ready.z.example')
    expect(sweep.value.text).toContain('serves https now')
    // The approved certificate is enforced, and the failed one is asked for
    // again rather than reported as fine — the request is what recovers it.
    expect(ready.pages!.https_enforced).toBe(true)
    expect(broken.pages!.https_certificate!.state).not.toBe('bad_authz')
    expect(broken.pages!.https_enforced).toBe(true)
    expect(sweep.value.text).toContain('broken: broken.z.example')

    // One named site sweeps just that one.
    const single = await run({ action: 'secure', name: 'ready' }, api)
    expect(single.value.text).toContain('across 1 site(s)')
    expect(single.value.text).not.toContain('broken.z.example')
  })

  it('refuses incomplete requests', async () => {
    await expect(run({ action: 'status' })).rejects.toThrow('site status needs a name')
    await expect(run({ action: 'remove', name: '' })).rejects.toThrow('needs a name')
    await expect(run({ action: 'publish', name: 'x' })).rejects.toThrow('needs files or dir')
    await expect(run({ action: 'publish', name: 'x', dir: 'rel' })).rejects.toThrow('absolute')
    await expect(run({ action: 'publish', name: 'x', dir: 'C:\\a', files: [] })).rejects.toThrow('not both')
  })
})

describe('the plugin', () => {
  const environment = (api: FakeApis, env: NodeJS.ProcessEnv) => ({ env, platform: 'linux' as const, fetch: api.fetch, run: vi.fn(async () => '') })
  const config = Config({} as Config)

  it('reads its defaults', () => {
    expect(pluginName).toBe('tool-sites')
    expect(inject).toEqual(['tools'])
    expect(config).toEqual({ zone: 'dshai.reggilion.com', tokenEnv: 'DESEC_TOKEN', owner: '', repoPrefix: 'dshai-', ttl: 900, noindex: true })
  })

  it('builds the service from stored credentials, and names a missing one', async () => {
    const api = fakeApis()
    await expect(createSites(config, environment(api, {}))).rejects.toThrow('DESEC_TOKEN')
    await expect(createSites(config, environment(api, { DESEC_TOKEN: 'd' }))).rejects.toThrow('no GitHub token')
    const sites = await createSites(config, environment(api, { DESEC_TOKEN: 'd', GITHUB_TOKEN: 'g' }))
    expect(sites.host('a')).toBe('a.dshai.reggilion.com')
  })

  it('waits between build checks with a real timer', async () => {
    vi.useFakeTimers()
    try {
      const api = fakeApis()
      api.buildOutcome = 'building'
      const sites = await createSites(config, environment(api, { DESEC_TOKEN: 'd', GITHUB_TOKEN: 'g' }))
      const pending = sites.publish({ name: 'demo', files: page, waitSeconds: 1 })
      await vi.advanceTimersByTimeAsync(20_000)
      expect((await pending).build).toBe('building')
    } finally {
      vi.useRealTimers()
    }
  })

  it('registers the tool and retries credentials after a failure', async () => {
    const ctx = new Context()
    const registered: { execute: (args: unknown, exec: unknown) => Promise<unknown> }[] = []
    ctx.provide('tools', { register: (tool: never) => { registered.push(tool); return () => {} } })
    const saved = { ...process.env }
    try {
      delete process.env.DESEC_TOKEN
      const options: typeof config = Object.assign(Config({} as Config), { tokenEnv: 'DSH_TEST_NO_SUCH_TOKEN' })
      await ctx.plugin({ name: 'sites', inject: ['tools'], apply: (scope: Context) => { apply(scope, options) } })
      expect(registered).toHaveLength(1)
      await expect(registered[0]!.execute({ action: 'list' }, {})).rejects.toThrow('DSH_TEST_NO_SUCH_TOKEN')
      await expect(registered[0]!.execute({ action: 'list' }, {})).rejects.toThrow('DSH_TEST_NO_SUCH_TOKEN')
      process.env.DSH_TEST_NO_SUCH_TOKEN = 'd'
      process.env.GITHUB_TOKEN = 'g'
      const realFetch = globalThis.fetch
      const api = fakeApis()
      globalThis.fetch = api.fetch as typeof fetch
      try {
        expect(await registered[0]!.execute({ action: 'list' }, {})).toEqual({ text: 'No sites yet.' })
        expect(await registered[0]!.execute({ action: 'list' }, {})).toEqual({ text: 'No sites yet.' })
      } finally {
        globalThis.fetch = realFetch
      }
    } finally {
      process.env = saved
      await ctx.fiber.dispose()
    }
  })
})
