import { pathToFileURL } from 'node:url'
const m = await import(pathToFileURL(process.cwd() + '/packages/web/tool-sites/lib/index.js').href)
for (const h of ['probe.dshai.reggilion.com', 'nope-xyz.dshai.reggilion.com']) console.log(h, await m.authoritativeCname(h).catch(e => 'ERR ' + e.code))
