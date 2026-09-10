// Apply the mod layer's patches.
//
// Usage:
//   node local-overlay/apply.mjs            # apply every patch to this checkout
//   node local-overlay/apply.mjs --check    # verify every patch applies to a pristine base
//   node local-overlay/apply.mjs --target <dir>   # apply into another checkout
//
// `--check` is the mode to run before trusting an upstream update: it
// materializes the recorded base in a temporary tree and reports whether each
// patch still applies there. Checking against the working tree instead would
// always fail, because the fork's edits are already in it.
//
// The patch order comes from rules.json, so it is declared in one place rather
// than duplicated here.
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { changedPaths, classify, generatedFor, git, groupFor, patchDir, readBase, readRules, repo, withBaseCheckout } from './lib.mjs'

/**
 * Read one option's value from argv.
 * @param flag - the option name.
 * @returns the following argument, or null when the flag is absent.
 */
function option(flag) {
  const index = process.argv.indexOf(flag)
  return index === -1 ? null : (process.argv[index + 1] ?? null)
}

/**
 * Run git in a target directory, reporting failure instead of throwing.
 * @param args - git arguments, without the leading `git`.
 * @param cwd - the directory to run in.
 * @returns whether it succeeded, and its stderr when it did not.
 */
function tryGit(args, cwd) {
  try {
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    return { ok: true, stderr: '' }
  } catch (error) {
    return { ok: false, stderr: error.stderr?.toString() ?? String(error) }
  }
}

const checkOnly = process.argv.includes('--check')
const target = option('--target') ?? repo
const base = readBase()
const rules = readRules()
const present = new Set(readdirSync(patchDir).filter(name => name.endsWith('.patch')))

// A patch declared by rules.json but absent on disk is a hole in the layer: the
// tree changes upstream-owned files that nothing would reapply after an update.
const declared = rules.patchGroups.map(group => `${group.name}.patch`)
const problems = []
for (const name of declared) {
  if (!present.has(name)) problems.push(`declared by rules.json but absent: ${name}`)
}
for (const name of present) {
  if (!declared.includes(name)) problems.push(`on disk but not declared by rules.json: ${name}`)
}

if (problems.length > 0) {
  console.error('The patch set and rules.json disagree:')
  for (const problem of problems) console.error(`  ${problem}`)
  console.error('Run: node local-overlay/rebuild.mjs')
  process.exitCode = 1
} else {
  // Only the patches covering changed paths are applied, and each group is
  // rebuilt from the base so the bytes applied are the ones this run verified.
  const { tier2 } = classify(changedPaths(base), rules)
  const byGroup = new Map(rules.patchGroups.map(group => [group.name, []]))
  for (const record of tier2) {
    if (generatedFor(record.path, rules) !== null) continue
    const name = groupFor(record.path, rules)
    if (name !== null) byGroup.get(name).push(record.path)
  }

  const run = (work) => {
    let failed = 0
    let applied = 0
    for (const [name, paths] of byGroup) {
      if (paths.length === 0) continue
      const patch = join(patchDir, `${name}.patch`)
      const result = tryGit(['apply', '--whitespace=nowarn', patch], work)
      if (result.ok) {
        applied++
        console.log(`${checkOnly ? 'APPLIES' : 'OK  '} ${name}.patch (${paths.length} file(s))`)
      } else {
        failed++
        console.error(`FAIL  ${name}.patch`)
        for (const line of result.stderr.trim().split('\n').slice(0, 10)) console.error(`      ${line}`)
      }
    }
    return { failed, applied }
  }

  const outcome = checkOnly
    ? withBaseCheckout(base, tier2.map(record => record.path), run)
    : run(target)

  console.log('')
  if (outcome.failed === 0) {
    console.log(`${checkOnly ? 'All' : 'Applied'} ${outcome.applied} patch(es) against base ${base.slice(0, 10)}${checkOnly ? '' : ` in ${target}`}.`)
  } else {
    console.error(`${outcome.failed} patch(es) failed against base ${base.slice(0, 10)}.`)
    process.exitCode = 1
  }
}
