#!/usr/bin/env node
// Apply the local overlay patches onto the current checkout, in order.
// Usage: node local-overlay/apply.mjs
import { readdir, readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '..')
const dir = join(here, 'patches')
const order = [
  'root-meta.patch', 'tsconfig.patch', 'lockfile.patch',
  'apps.patch', 'docs.patch', 'boot-bundle.patch', 'client-ui.patch',
  'compaction.patch', 'core.patch', 'extensions.patch', 'llm.patch',
  'presets.patch', 'scripts.patch', 'snapshots.patch', 'other.patch',
]
const names = new Set((await readdir(dir)).filter(n => n.endsWith('.patch')))
let failed = 0
for (const name of order.filter(n => names.has(n))) {
  const src = join(dir, name)
  try {
    execFileSync('git', ['-C', repo, 'apply', '--whitespace=nowarn', src], { stdio: 'inherit' })
    console.log(`OK   ${name}`)
  } catch (e) {
    console.error(`FAIL ${name} (${e.status})`)
    failed++
  }
}
for (const name of names) {
  if (!order.includes(name)) {
    try {
      execFileSync('git', ['-C', repo, 'apply', '--whitespace=nowarn', join(dir, name)], { stdio: 'inherit' })
      console.log(`OK   ${name}`)
    } catch (e) {
      console.error(`FAIL ${name} (${e.status})`)
      failed++
    }
  }
}
process.exitCode = failed === 0 ? 0 : 1
