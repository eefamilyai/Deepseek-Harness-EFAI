#!/usr/bin/env node
/**
 * Prove the fork's preset copies are still keyed to the upstream presets they
 * were forked from.
 *
 * `packages/preset/efai-presets` supplies the four preset ids the harness
 * ships, and drops upstream's shipped root to do it (see that package's
 * README). The cost of owning the copies is that an upstream roster change no
 * longer arrives on its own: upstream adds a tool row, the fork's copy keeps
 * the old roster, and nothing says so. This gate says so.
 *
 * It compares the recorded hash of each upstream preset against that file
 * today. A mismatch is not a failure of the fork's copy — it is upstream
 * moving, and the answer is to re-fork the copy and re-record the baseline.
 *
 * Usage:
 *   node local-overlay/verify-efai-presets.mjs            check, exit 1 on drift
 *   node local-overlay/verify-efai-presets.mjs --record   re-record the baseline
 */

import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const BASELINE = `${ROOT}packages/preset/efai-presets/UPSTREAM-BASELINE.json`
const UPSTREAM_PRESETS = `${ROOT}packages/preset/agent-presets/presets`
const PRESETS = ['standard', 'minimal', 'ptc', 'cordis']

/**
 * Hash one upstream preset composition.
 * @param preset - the preset id, which is also its directory name.
 * @returns the hex sha256 of the file's bytes, or null when it is gone.
 */
function hashUpstream(preset) {
  try {
    return createHash('sha256').update(readFileSync(`${UPSTREAM_PRESETS}/${preset}/agent.cordis.yml`)).digest('hex')
  } catch {
    return null
  }
}

const record = process.argv.includes('--record')
const current = Object.fromEntries(PRESETS.map(preset => [preset, hashUpstream(preset)]))

if (record) {
  writeFileSync(BASELINE, `${JSON.stringify({
    _comment: 'sha256 of each upstream agent.cordis.yml the fork copy in presets/ was forked from. Re-record with --record after re-forking.',
    presets: current,
  }, null, 2)}\n`)
  console.log(`efai-presets baseline recorded for ${PRESETS.length} preset(s)`)
  process.exit(0)
}

const baseline = JSON.parse(readFileSync(BASELINE, 'utf8')).presets
const drifted = PRESETS.filter(preset => baseline[preset] !== current[preset])

if (drifted.length === 0) {
  console.log(`efai-presets is current: ${PRESETS.length} preset(s) match their upstream baseline`)
  process.exit(0)
}

console.error(`efai-presets drift: upstream moved under ${drifted.length} forked preset(s): ${drifted.join(', ')}`)
for (const preset of drifted) {
  const gone = current[preset] === null
  console.error(`  ${preset}: ${gone ? 'upstream preset is gone' : 'upstream composition changed'}`)
}
console.error('')
console.error('Re-fork each one, then re-record:')
console.error('  git diff <baseline-commit> -- packages/preset/agent-presets/presets/<id>/agent.cordis.yml')
console.error('  # apply upstream\'s change to packages/preset/efai-presets/presets/<id>/agent.cordis.yml')
console.error('  node local-overlay/verify-efai-presets.mjs --record')
process.exit(1)
