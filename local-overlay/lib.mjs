// Shared logic for the local-overlay mod layer.
//
// The mod layer keeps every fork edit to an upstream-owned file outside the
// upstream file itself: `patches/*.patch` hold the diffs, `apply.mjs` replays
// them onto a pristine checkout, and `rebuild.mjs` regenerates them from the
// working tree. `rules.json` decides which path belongs to which patch.
//
// This module owns the parts all three scripts must agree on: locating the
// repository, reading the recorded base commit, loading `rules.json`, parsing
// `git diff` output, and mapping a path to its patch group.
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Absolute path to the repository root. */
export const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Absolute path to this overlay directory. */
export const overlayDir = join(repo, 'local-overlay')

/** Absolute path to the patch directory. */
export const patchDir = join(overlayDir, 'patches')

/**
 * Run git in the repository and return stdout.
 * @param args - git arguments, without the leading `git`.
 * @param options - `cwd` overrides the repository root; `allowFailure` returns stderr instead of throwing.
 * @returns the command's stdout, trimmed of the trailing newline.
 */
export function git(args, options = {}) {
  const cwd = options.cwd ?? repo
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    if (options.allowFailure === true) return error.stderr?.toString() ?? ''
    throw new Error(`git ${args.join(' ')} failed in ${cwd}\n${error.stderr?.toString() ?? ''}`)
  }
}

/** Read the recorded upstream base commit. */
export function readBase() {
  const line = readFileSync(join(overlayDir, 'BASE'), 'utf8').split('\n', 1)[0].trim()
  if (line === '') throw new Error('local-overlay/BASE has no commit on its first line')
  return line
}

/**
 * Split a list of paths into argv-sized chunks.
 *
 * Windows caps a whole command line at 32 KiB, so a pathspec naming thousands
 * of files cannot be passed in one call — which is exactly the shape an
 * upstream update has before the patch set is regenerated, when every file
 * upstream touched is a candidate. Chunking never splits an entry, and because
 * the input is sorted the concatenated results stay sorted too.
 * @param items - the paths to split.
 * @param budget - the maximum bytes of path text per chunk.
 * @returns consecutive slices of `items`, each small enough to pass as argv.
 */
export function chunked(items, budget = 24000) {
  const chunks = []
  let current = []
  let size = 0
  for (const item of items) {
    const cost = item.length + 1
    if (current.length > 0 && size + cost > budget) {
      chunks.push(current)
      current = []
      size = 0
    }
    current.push(item)
    size += cost
  }
  if (current.length > 0) chunks.push(current)
  return chunks
}

/** Load and validate `rules.json`. */
export function readRules() {
  const rules = JSON.parse(readFileSync(join(overlayDir, 'rules.json'), 'utf8'))
  if (!Array.isArray(rules.patchGroups) || rules.patchGroups.length === 0) {
    throw new Error('rules.json: patchGroups must be a non-empty array')
  }
  const seen = new Set()
  for (const group of rules.patchGroups) {
    if (typeof group.name !== 'string' || !Array.isArray(group.paths)) {
      throw new Error(`rules.json: patch group ${JSON.stringify(group.name)} needs a name and a paths array`)
    }
    if (seen.has(group.name)) throw new Error(`rules.json: duplicate patch group ${group.name}`)
    seen.add(group.name)
  }
  return rules
}

/**
 * Map a repository-relative path to its patch group.
 * @param path - a repository-relative path.
 * @param rules - the parsed `rules.json`.
 * @returns the first matching group name, or `null` when no group claims the path.
 */
export function groupFor(path, rules) {
  for (const group of rules.patchGroups) {
    for (const prefix of group.paths) {
      if (path === prefix || path.startsWith(prefix)) return group.name
    }
  }
  return null
}

/**
 * Test a path against the generated-file list.
 * @param path - a repository-relative path.
 * @param rules - the parsed `rules.json`.
 * @returns the matching generated entry, or `null`.
 */
export function generatedFor(path, rules) {
  return rules.generated.find(entry => entry.path === path) ?? null
}

/**
 * Parse `git diff --name-status` output into change records.
 * @param text - raw command output.
 * @returns one record per changed path.
 */
export function parseNameStatus(text) {
  const records = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    const fields = line.split('\t')
    const status = fields[0]
    if (status.startsWith('R') || status.startsWith('C')) {
      records.push({ status: status[0], from: fields[1], path: fields[2] })
      continue
    }
    records.push({ status: status[0], path: fields[1] })
  }
  return records
}

/**
 * List every path the fork changes relative to a commit, including uncommitted
 * working-tree edits.
 *
 * `git diff <rev>` with no second revision compares the commit against the
 * working tree, which is what the mod layer must capture: a fork edit that has
 * not been committed yet is still part of the mod.
 * @param base - the commit to compare against.
 * @returns the change records, sorted by path.
 */
export function changedPaths(base) {
  const records = parseNameStatus(git(['diff', '--name-status', '-M', base]))
  return records.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

/**
 * Split the changed paths into the three tiers the contract defines.
 *
 * Tier 1 is fork-owned and needs no patch. Tier 2 is an upstream file the fork
 * modifies and is the entire merge cost. Generated files are excluded from both
 * because a generator rewrites them; the mod records the command instead.
 * @param records - change records from `changedPaths`.
 * @param rules - the parsed `rules.json`.
 * @returns the classified tiers plus any path no rule claims.
 */
export function classify(records, rules) {
  const tier1 = []
  const tier2 = []
  const generated = []
  const unclaimed = []
  for (const record of records) {
    if (record.status === 'A') {
      tier1.push(record.path)
      continue
    }
    const isGenerated = generatedFor(record.path, rules)
    if (isGenerated !== null) {
      generated.push(record)
      continue
    }
    if (groupFor(record.path, rules) !== null) {
      tier2.push(record)
      continue
    }
    unclaimed.push(record)
  }
  return { tier1, tier2, generated, unclaimed }
}

/**
 * Produce a patch body for a set of paths.
 *
 * `--binary` keeps a binary hunk representable rather than silently dropping
 * it, and `-M` keeps a rename a rename instead of a delete plus an add, so the
 * patch reads the way the edit was made.
 * @param base - the commit the patch applies onto.
 * @param paths - the repository-relative paths to include.
 * @returns the patch text, or the empty string when nothing differs.
 */
export function diffFor(base, paths) {
  if (paths.length === 0) return ''
  // One `git diff` per chunk: each file's hunks are independent, so the
  // concatenation is the same patch the single call would have produced.
  return chunked(paths)
    .map(chunk => git(['diff', '--no-color', '--no-ext-diff', '--binary', '-M', base, '--', ...chunk]))
    .filter(text => text !== '')
    .join('')
}

/**
 * Run one callback against a throwaway checkout of the base commit.
 *
 * The callback receives a directory whose contents are exactly the recorded
 * base for `paths`, materialized through a real git index. That matters for two
 * reasons: `git apply` needs an index to consult, and only the index can
 * reproduce a symlink, a deletion, or a mode change faithfully.
 *
 * The temporary repository borrows this checkout's object database through an
 * `objects/info/alternates` entry, so nothing is copied and the real repository
 * is never written to.
 * @param base - the commit to check out.
 * @param paths - the repository-relative paths to materialize.
 * @param run - receives the temporary directory; its return value is returned.
 * @returns whatever `run` returned.
 */
export function withBaseCheckout(base, paths, run) {
  const work = mkdtempSync(join(tmpdir(), 'dsh-overlay-base-'))
  try {
    git(['init', '--quiet', '.'], { cwd: work })
    for (const [key, value] of [['core.autocrlf', 'false'], ['core.symlinks', 'false'], ['core.filemode', 'false']]) {
      git(['config', key, value], { cwd: work })
    }
    const objectsDir = git(['rev-parse', '--git-path', 'objects']).trim()
    mkdirSync(join(work, '.git', 'objects', 'info'), { recursive: true })
    writeFileSync(join(work, '.git', 'objects', 'info', 'alternates'), `${resolve(repo, objectsDir)}\n`, 'utf8')

    // `--index-info` reads `<mode> SP <sha> TAB <path>` per line.
    const lines = []
    for (const chunk of chunked(paths)) {
      for (const line of git(['ls-tree', '-r', base, '--', ...chunk]).split('\n')) {
        if (line.trim() === '') continue
        const [meta, path] = line.split('\t')
        const [mode, , sha] = meta.split(/\s+/)
        lines.push(`${mode} ${sha}\t${path}`)
      }
    }
    if (lines.length > 0) {
      execFileSync('git', ['update-index', '--add', '--index-info'], { cwd: work, input: `${lines.join('\n')}\n`, encoding: 'utf8' })
    }
    execFileSync('git', ['checkout-index', '--all', '--force'], { cwd: work, encoding: 'utf8' })

    return run(work)
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

/**
 * List the base blobs that exist for a set of paths, keyed by path.
 * @param base - the commit to read.
 * @param paths - the repository-relative paths to look up.
 * @returns a map from path to `{ mode, sha }`, omitting paths absent at the base.
 */
export function baseTree(base, paths) {
  const entries = new Map()
  for (const chunk of chunked(paths)) {
    for (const line of git(['ls-tree', '-r', base, '--', ...chunk]).split('\n')) {
      if (line.trim() === '') continue
      const [meta, path] = line.split('\t')
      const [mode, , sha] = meta.split(/\s+/)
      entries.set(path, { mode, sha })
    }
  }
  return entries
}
