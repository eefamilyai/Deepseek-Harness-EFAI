import { pathToFileURL } from 'node:url'
const lib = await import(pathToFileURL(process.cwd() + '/packages/web/tool-sites/lib/index.js').href)
const { execFile } = await import('node:child_process')
const run = (f, a) => new Promise((res, rej) => execFile(f, a, { windowsHide: true }, (e, o) => e ? rej(e) : res(String(o).trim())))
const config = { zone: 'dshai.reggilion.com', tokenEnv: 'DESEC_TOKEN', owner: '', repoPrefix: 'dshai-', ttl: 900, noindex: true }
const sites = await lib.createSites(config, { env: process.env, platform: process.platform, fetch, run })
const [action, name, ...rest] = process.argv.slice(2)
const t0 = Date.now()
let out
if (action === 'publish') out = await sites.publish({ name, title: rest[0] ?? '', files: { 'index.html': `<!doctype html><meta charset=utf-8><title>${name}</title><h1>${name} works</h1><p>${new Date().toISOString()}</p>` } })
else if (action === 'publish-dir') out = await sites.publish({ name, title: rest[1] ?? '', files: await lib.readSiteFolder(rest[0]) })
else if (action === 'status') out = await sites.status(name)
else if (action === 'list') out = await sites.list()
else if (action === 'remove') out = await sites.remove(name)
console.log(JSON.stringify(out, null, 1)); console.log('seconds', Math.round((Date.now() - t0) / 1000))
