
// Run ONE spec file in its own process, the way vitest isolates a file.
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
const spec = process.argv[2]
// A spec name arrives relative to the repo root; a file URL must be absolute
// or Windows rejects it outright. Resolve it here, once, for every caller.
const specUrl = pathToFileURL(resolve(process.cwd(), spec)).href
const shim = await import('./vitest-shim.mjs')
try {
  await import(specUrl)
} catch (e) {
  console.log(JSON.stringify({ file: spec, loadError: String(e?.stack ?? e) }))
  process.exit(0)
}
for (const { name, fn } of shim.results.pending) {
  const before = shim.results.failures.length
  try {
    await fn()
  } catch (e) {
    shim.results.failures.push(e instanceof Error ? e : new Error(String(e)))
  }
  if (shim.results.failures.length > before) shim.results.failedTests.push(name)
}
for (const fn of shim.results.after) { try { await fn() } catch {} }
console.log(JSON.stringify({
  file: spec,
  tests: shim.results.tests.length,
  passed: shim.results.passes,
  failures: shim.results.failures.map(f => String(f.message).slice(0, 400)),
  failedTests: shim.results.failedTests,
}))
