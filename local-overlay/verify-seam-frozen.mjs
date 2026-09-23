#!/usr/bin/env node
/**
 * Refuse a NEW edit to an upstream-owned file.
 *
 * The fork's merge cost is exactly its Tier-2 set: the upstream files it
 * modifies. `rebuild.mjs` keeps the patches for that set honest, but it is
 * equally happy with a set that grows — add a path to a patch group and the
 * rebuild goes green. This gate is the other half: the seam is frozen at a
 * recorded list, and a path that is not on it fails the build.
 *
 * The list may always SHRINK. Retiring an edit — moving it into a fork-owned
 * plugin, or sending it upstream — is reported here and recorded with
 * `--record`. Growing it is a deliberate act that a human records the same
 * way, and the diff shows exactly which upstream file the fork just took on.
 *
 * Usage:
 *   node local-overlay/verify-seam-frozen.mjs            check, exit 1 on a new seam path
 *   node local-overlay/verify-seam-frozen.mjs --record   re-record the frozen list
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { changedPaths, classify, readBase, readRules } from './lib.mjs'

const SEAM_FILE = fileURLToPath(new URL('SEAM.json', import.meta.url))

const base = readBase()
const rules = readRules()
const { tier2 } = classify(changedPaths(base), rules)
const current = tier2.map(record => record.path).sort()

if (process.argv.includes('--record')) {
  writeFileSync(SEAM_FILE, `${JSON.stringify({
    _comment: [
      'The upstream-owned files this fork is allowed to modify: its entire merge cost.',
      'verify-seam-frozen.mjs fails on any Tier-2 path absent from this list.',
      'Shrinking is the goal; re-record after retiring an edit. Growing is a decision:',
      'record it in the same commit that adds the edit, so review sees the path arrive.',
    ],
    base,
    paths: current,
  }, null, 2)}\n`)
  console.log(`seam recorded: ${current.length} upstream file(s) at base ${base.slice(0, 10)}`)
  process.exit(0)
}

const frozen = JSON.parse(readFileSync(SEAM_FILE, 'utf8'))
const allowed = new Set(frozen.paths)
const added = current.filter(path => !allowed.has(path))
const retired = frozen.paths.filter(path => !current.includes(path))

if (retired.length > 0) {
  console.log(`seam shrank by ${retired.length} file(s) — re-record with --record:`)
  for (const path of retired) console.log(`  retired  ${path}`)
}

if (added.length === 0) {
  console.log(`seam is frozen at ${allowed.size} upstream file(s); ${current.length} in the tree`)
  process.exit(0)
}

console.error(`seam grew: ${added.length} upstream file(s) this fork did not modify before`)
for (const path of added) console.error(`  NEW SEAM  ${path}`)
console.error('')
console.error('An upstream file is the one kind of edit that costs a conflict on every release.')
console.error('Before recording it, try the cheaper mechanisms in order:')
console.error('  1. a fork-owned package on a documented extension point')
console.error('  2. a row in packages/bundle/efai-base (or efai-web) — composition never edits upstream')
console.error('  3. a Config field, if the value varies per deployment')
console.error('  4. an upstream pull request, for a bug or anything upstream would accept')
console.error('If none of those can express it, record the decision:')
console.error('  node local-overlay/verify-seam-frozen.mjs --record')
process.exit(1)
