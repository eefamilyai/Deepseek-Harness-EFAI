// Verify the mod layer round-trips.
//
// Usage:
//   node local-overlay/verify.mjs
//
// The claim this checks is the one the layer rests on: upstream at the recorded
// base, plus every patch, reproduces exactly the fork's version of every Tier-2
// file. When that holds, an upstream update is "take upstream, reapply the mod"
// rather than a hand merge of a hundred-odd files.
//
// It works in a temporary checkout and never writes to the working tree. The
// counterpart check, that the patches apply at all, is `apply.mjs --check`; this
// one additionally proves they apply to the right result.
//
// Line endings are normalized before the content comparison. `.gitattributes`
// sets `* text=auto eol=lf` for the repository while a Windows checkout presents
// CRLF, so one file has two correct on-disk forms and only its content is
// comparable.
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  changedPaths, classify, diffFor, generatedFor, git, groupFor, readBase, readRules, repo,
  withBaseCheckout,
} from './lib.mjs'

/**
 * Read a file as text with CRLF collapsed to LF.
 * @param path - the file to read.
 * @returns the normalized contents, or null when the file is absent.
 */
function readNormalized(path) {
  try {
    return readFileSync(path, 'utf8').replaceAll('\r\n', '\n')
  } catch {
    return null
  }
}

/**
 * Map a repository-relative path onto a filesystem path under a root.
 * @param root - the directory to resolve against.
 * @param path - a repository-relative path, always slash-separated.
 * @returns the platform path.
 */
function under(root, path) {
  return join(root, ...path.split('/'))
}

const base = readBase()
const rules = readRules()
const { tier2, generated, unclaimed } = classify(changedPaths(base), rules)

if (unclaimed.length > 0) {
  console.error('Paths no rule claims:')
  for (const record of unclaimed) console.error(`  ${record.status}  ${record.path}`)
  process.exitCode = 1
}

// Group the paths exactly as rebuild.mjs does, so this tests the partition that
// was written to disk rather than a second, independent guess at it.
const byGroup = new Map(rules.patchGroups.map(group => [group.name, []]))
for (const record of tier2) {
  if (generatedFor(record.path, rules) !== null) continue
  const name = groupFor(record.path, rules)
  if (name !== null) byGroup.get(name).push(record)
}
const plans = [...byGroup]
  .filter(([, group]) => group.length > 0)
  .map(([name, group]) => ({ name, group }))

const paths = tier2.map(record => record.path)
const problems = []

withBaseCheckout(base, paths, (work) => {
  for (const plan of plans) {
    const patchPath = join(work, `${plan.name}.patch`)
    writeFileSync(patchPath, diffFor(base, plan.group.map(record => record.path)).replaceAll('\r\n', '\n'), 'utf8')
    try {
      git(['apply', '--whitespace=nowarn', patchPath], { cwd: work })
    } catch (error) {
      const first = (error.message.split('\n')[1] ?? '').trim()
      problems.push(`apply ${plan.name}.patch${first === '' ? '' : `: ${first}`}`)
    }
  }

  if (problems.length > 0) return

  for (const plan of plans) {
    for (const record of plan.group) {
      const produced = readNormalized(under(work, record.path))
      const actual = readNormalized(under(repo, record.path))
      if (record.status === 'D') {
        // A deletion is correct when the applied tree lost the path and the
        // working tree does not have it either.
        if (produced !== null) problems.push(`not deleted by its patch: ${record.path}`)
        else if (actual !== null) problems.push(`still present in the working tree: ${record.path}`)
        continue
      }
      if (produced === null) problems.push(`not produced by its patch: ${record.path}`)
      else if (actual === null) problems.push(`missing from the working tree: ${record.path}`)
      else if (produced !== actual) problems.push(`content differs: ${record.path}`)
    }
  }
})

const fileCount = plans.reduce((sum, plan) => sum + plan.group.length, 0)

if (problems.length === 0) {
  console.log(`Round-trip verified: base ${base.slice(0, 10)} + ${plans.length} patch(es) reproduces ${fileCount} Tier-2 path(s) exactly.`)
  console.log('The repository was not modified; every check ran in a temporary checkout of the base.')
  if (generated.length > 0) {
    console.log(`Excluded as generated (${generated.length}): ${generated.map(record => record.path).join(', ')}`)
  }
} else {
  console.error(`Round-trip FAILED with ${problems.length} problem(s):`)
  for (const problem of problems) console.error(`  ${problem}`)
  process.exitCode = 1
}
