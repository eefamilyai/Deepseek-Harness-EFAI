// Build workspace packages one at a time the way the root build would (typecheck, typert, bundle).
// Usage: node .recon/build-one.mjs <package> [<package> ...]
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
const root = process.cwd()
const lib = await import(pathToFileURL(join(root, 'packages/devtools/harness-dev-tools/lib/index.js')).href)
const scratchDir = join(root, '.recon', 'build-scratch', 'one')
mkdirSync(scratchDir, { recursive: true })
let failed = false
for (const spec of process.argv.slice(2)) {
  const pkg = lib.resolveWorkspacePackage(root, spec)
  const results = await lib.buildWorkspacePackage(pkg, { root, nodeExecutable: process.execPath, scratchDir, outputChars: 4000 })
  for (const r of results) {
    console.log(`${pkg.name} ${r.step}: ${r.skipped ? 'skipped ' + r.skipped : r.ok ? 'ok' : 'FAILED'}`)
    if (!r.ok && r.output) console.log(r.output)
    if (!r.ok && !r.skipped) failed = true
  }
}
process.exit(failed ? 1 : 0)
