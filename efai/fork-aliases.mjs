#!/usr/bin/env node
/**
 * Re-insert the fork's hand-written tsconfig path aliases.
 *
 * `scripts/gen-tsconfig-paths.ts` (upstream-owned) maps every workspace package
 * whose npm name equals `@deepseek-ai/dsh-<directory>` into the generated region
 * of `tsconfig.base.json`, and fails when a package is mapped by nothing. The
 * fork's client packages are named `@deepseek-ai/dsh-client-ui-<surface>` while
 * their directories are `packages/client/ui-<surface>`, so they cannot be
 * generated and must stay hand-written.
 *
 * An upstream update takes upstream's `tsconfig.base.json` wholesale. Running
 * this script afterwards restores the fork's block, so the file never becomes a
 * merge seam: the fork's content arrives from a fork-owned path, not from a
 * conflict resolution. It is idempotent and writes only when the block differs.
 *
 * Usage: node efai/fork-aliases.mjs [--check]
 * @module efai/fork-aliases
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const CONFIG = join(ROOT, 'tsconfig.base.json')
const BEGIN = '      // BEGIN generated package aliases — pnpm run gen-tsconfig-paths'
const HEAD = '      // DSH-FORK(all): fork packages whose npm names do not match their directory'
const TAIL = '      // DSH-FORK end'

/** Package specifier to source directory, relative to the repository root. */
const ALIASES = [
  ['@deepseek-ai/dsh-client-ui-brand-efai', './packages/client/ui-brand-efai/src'],
  ['@deepseek-ai/dsh-client-ui-effects', './packages/client/ui-effects/src'],
  ['@deepseek-ai/dsh-client-ui-flow-accents', './packages/client/ui-flow-accents/src'],
  ['@deepseek-ai/dsh-client-ui-model-visibility', './packages/client/ui-model-visibility/src'],
  ['@deepseek-ai/dsh-client-ui-peak-hours', './packages/client/ui-peak-hours/src'],
  ['@deepseek-ai/dsh-client-ui-personalization', './packages/client/ui-personalization/src'],
  ['@deepseek-ai/dsh-client-ui-polish', './packages/client/ui-polish/src'],
  ['@deepseek-ai/dsh-client-ui-settings-accounts', './packages/client/ui-settings-accounts/src'],
  ['@deepseek-ai/dsh-client-ui-settings-tools', './packages/client/ui-settings-tools/src'],
  ['@deepseek-ai/dsh-client-ui-skill-mention', './packages/client/ui-skill-mention/src'],
  ['@deepseek-ai/dsh-host-version-route', './packages/host/version-route/src'],
  ['@deepseek-ai/dsh-host-web-access', './packages/host/web-access/src'],
  ['@deepseek-ai/dsh-tool-roster', './packages/kernel/roster/src'],
]

/** Render the fenced block, including its two marker lines. */
function renderBlock() {
  return [
    HEAD,
    '      // names, so the generated aliases below cannot map them.',
    '      // Rewritten by `node efai/fork-aliases.mjs`; the generator preserves it.',
    ...ALIASES.map(([specifier, source]) => `      ${JSON.stringify(specifier)}: [${JSON.stringify(source)}],`),
    TAIL,
    '',
  ].join('\n')
}

const current = readFileSync(CONFIG, 'utf8')
const begin = current.indexOf(BEGIN)
if (begin < 0) {
  console.error('fork-aliases: tsconfig.base.json has no generated-region marker; upstream changed the file shape.')
  process.exit(1)
}
// Drop an existing block, then insert the current one immediately before the
// generated region so the two never interleave.
const without = current
  .replace(/^ {6}\/\/ DSH-FORK\(all\): fork packages[\s\S]*?^ {6}\/\/ DSH-FORK end\n/m, '')
  .replace(/^ {6}\/\/ DSH-FORK\(all\): fork packages[^\n]*\n(?: {6}.*\n)*?(?= {6}\/\/ BEGIN generated)/m, '')
const at = without.indexOf(BEGIN)
const next = `${without.slice(0, at)}${renderBlock()}${without.slice(at)}`

if (next === current) {
  console.log('fork-aliases: tsconfig.base.json already carries the fork aliases.')
} else if (process.argv.includes('--check')) {
  console.error('fork-aliases: tsconfig.base.json is missing the fork aliases; run `node efai/fork-aliases.mjs`.')
  process.exitCode = 1
} else {
  writeFileSync(CONFIG, next)
  console.log(`fork-aliases: wrote ${ALIASES.length} aliases into tsconfig.base.json.`)
}
