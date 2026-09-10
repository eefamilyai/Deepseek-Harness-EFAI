// Apply the mod layer's patches.
//
// Usage:
//   node local-overlay/apply.mjs            # apply every patch to this checkout
//   node local-overlay/apply.mjs --check    # verify every patch applies to a pristine base
//   node local-overlay/apply.mjs --3way     # apply with a three-way merge, leaving conflicts
//   node local-overlay/apply.mjs --target <dir>   # apply into another checkout
//
// `--check` is the mode to run before trusting an upstream update: it
// materializes the recorded base in a temporary tree and reports whether each
// patch still applies there. Checking against the working tree instead would
// always fail, because the fork's edits are already in it.
//
// `--3way` is the mode to run *after* an upstream update that moved the base.
// The patches in `patches/` were generated against the previous base, so
// upstream's refactor of the code around a fork edit makes the context lines
// stale and a plain `git apply` refuses. A three-way apply instead replays the
// fork's edit onto upstream's new text and leaves conflict markers only where
// the two edits genuinely overlap — a handful of lines a maintainer can read,
// rather than the whole file the fork edit sits in. Resolve the markers by
// hand, then re-run `rebuild.mjs` so the patch set records the new base.
//
// The two modes do not compose: a three-way merge needs the index of the tree
// it is merging into, and `--check` works in a throwaway checkout of the base
// where the fork's own text is absent by construction. Passing both is an error
// rather than a silent no-op.
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

/**
 * List the paths a three-way apply left in conflict.
 *
 * `git apply --3way` reports the whole patch as one failure and names the
 * conflicted paths on stderr. The index is the authority, and it is also what
 * separates "the patch could not be applied at all" from "it applied, with
 * conflicts in these files" — a difference the exit code alone does not carry.
 * @param cwd - the directory the patch was applied in.
 * @returns the conflicted paths, sorted.
 */
function unmergedPaths(cwd) {
  const out = tryGit(['diff', '--name-only', '--diff-filter=U'], cwd)
  return out.ok ? out.stderr.split('\n').filter(Boolean).sort() : []
}

const checkOnly = process.argv.includes('--check')
const threeWay = process.argv.includes('--3way')

if (checkOnly && threeWay) {
  console.error('--check and --3way cannot be combined.')
  console.error('  --check : does each patch still apply cleanly to a pristine base?')
  console.error('  --3way  : replay each patch onto this checkout, leaving conflicts to resolve.')
  process.exitCode = 1
} else {
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
      const conflicted = []
      for (const [name, paths] of byGroup) {
        if (paths.length === 0) continue
        const patch = join(patchDir, `${name}.patch`)
        const args = threeWay
          ? ['apply', '--3way', '--whitespace=nowarn', patch]
          : ['apply', '--whitespace=nowarn', patch]
        const result = tryGit(args, work)
        if (result.ok) {
          applied++
          console.log(`${checkOnly ? 'APPLIES' : 'OK  '} ${name}.patch (${paths.length} file(s))`)
          continue
        }
        // A three-way apply that hit overlapping edits is a result, not a
        // failure: the fork's change is in the tree with markers around the few
        // lines upstream also touched.
        if (threeWay && /with conflicts/.test(result.stderr)) {
          conflicted.push({ name, paths: unmergedPaths(work) })
          console.log(`MARKED   ${name}.patch (${paths.length} file(s))`)
          continue
        }
        failed++
        console.error(`FAIL  ${name}.patch`)
        for (const line of result.stderr.trim().split('\n').slice(0, 10)) console.error(`      ${line}`)
      }
      return { failed, applied, conflicted }
    }

    const outcome = checkOnly
      ? withBaseCheckout(base, tier2.map(record => record.path), run)
      : run(target)

    for (const entry of outcome.conflicted) {
      const paths = entry.paths.length > 0 ? entry.paths : byGroup.get(entry.name)
      console.error(`  ${entry.name}.patch conflicts in ${paths.length} file(s):`)
      for (const path of paths.slice(0, 20)) console.error(`      ${path}`)
      if (paths.length > 20) console.error(`      …and ${paths.length - 20} more`)
    }

    console.log('')
    if (outcome.failed === 0 && outcome.conflicted.length === 0) {
      console.log(`${checkOnly ? 'All' : 'Applied'} ${outcome.applied} patch(es) against base ${base.slice(0, 10)}${checkOnly ? '' : ` in ${target}`}.`)
    } else if (outcome.failed === 0) {
      console.log(`${outcome.applied} patch(es) applied against base ${base.slice(0, 10)}; ${outcome.conflicted.length} need a three-way resolution.`)
      console.log('Resolve the conflict markers above, then run: node local-overlay/rebuild.mjs')
    } else {
      console.error(`${outcome.failed} patch(es) failed against base ${base.slice(0, 10)}${outcome.conflicted.length > 0 ? `; ${outcome.conflicted.length} more conflicted` : ''}.`)
      process.exitCode = 1
    }
  }
}
