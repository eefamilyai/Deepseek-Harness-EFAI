#!/usr/bin/env node
/**
 * Put the fork's bundles on a profile's layer list, idempotently.
 *
 * The fork ships its composition as profile bundles (`dsh-efai-base`,
 * `dsh-efai-web`) rather than as edits to upstream's `dsh-base` and
 * `dsh-web-app`. What names a bundle is the profile, and upstream's profile
 * TEMPLATES are an upstream file — so the launcher is what keeps the two fork
 * bundles on the profiles this fork actually starts. Running it on an
 * already-current profile writes nothing.
 *
 * A profile directory that does not exist yet is created here rather than left
 * to the first boot, because a profile created without these rows would start
 * one upstream-only session before anything could fix it.
 *
 * Usage:
 *   node efai/ensure-profile-bundles.mjs            # every profile below
 *   node efai/ensure-profile-bundles.mjs web        # just one
 *   node efai/ensure-profile-bundles.mjs --check    # report drift, write nothing, exit 1
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/** The fork bundle each upstream bundle must be followed by. */
const FORK_AFTER = {
  '@deepseek-ai/dsh-base': '@deepseek-ai/dsh-efai-base',
  '@deepseek-ai/dsh-web-app': '@deepseek-ai/dsh-efai-web',
}

/**
 * Upstream's shipped layer lists, mirrored so a profile can be created before
 * first boot. `PROFILE_TEMPLATES` in `@deepseek-ai/dsh-app-boot` is the
 * authority; `--check` fails when this copy no longer matches a profile that
 * upstream created, which is the signal to re-read it.
 */
const TEMPLATES = {
  web: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] },
  headless: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'] },
  acp: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-acp-app'] },
  sdk: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-sdk-app'] },
}

const PATCH_TEMPLATE = `# Your patch layer for this dsh profile, applied after every bundle layer:
# a top-level YAML array of loader patch entries (id-targeted config
# overrides, disables, and insert lists; \`!!js\` expressions allowed).
[]
`

const PNPM_WORKSPACE = `packages:
  - .

nodeLinker: hoisted
autoInstallPeers: false
`

/**
 * The harness home, resolved the way `@deepseek-ai/dsh-home-paths` resolves it.
 * @returns the absolute harness home directory.
 */
function dshHome() {
  const configured = process.env.DSH_HOME
  if (configured !== undefined && configured.trim().length > 0) return resolve(configured.trim())
  return join(homedir(), '.dsh')
}

/**
 * Insert each fork bundle after the upstream bundle it extends.
 *
 * Appending at the end would work today and break the day a profile gains a
 * layer that must stay last: a fork row belongs directly behind the upstream
 * rows it patches.
 * @param bundles - the profile's current layer list.
 * @returns the list with every missing fork bundle placed, or the same array when current.
 */
export function placeForkBundles(bundles) {
  const out = []
  let changed = false
  for (const bundle of bundles) {
    out.push(bundle)
    const fork = FORK_AFTER[bundle]
    if (fork === undefined || bundles.includes(fork)) continue
    out.push(fork)
    changed = true
  }
  return changed ? out : bundles
}

/**
 * Bring one profile's manifest up to date.
 * @param name - the profile name, e.g. `web`.
 * @param check - report only; write nothing.
 * @returns a one-line report, or null when the profile was already current.
 */
function ensureProfile(name, check) {
  const dir = join(dshHome(), 'profiles', name)
  const manifestPath = join(dir, 'package.json')

  if (!existsSync(manifestPath)) {
    const template = TEMPLATES[name]
    if (template === undefined) return `${name}: no such profile and no template for it`
    if (check) return `${name}: not initialized`
    mkdirSync(dir, { recursive: true })
    writeFileSync(manifestPath, `${JSON.stringify({
      name: `dsh-profile-${name}`,
      private: true,
      dependencies: {},
      dsh: { profile: { bundles: placeForkBundles(template.bundles) } },
    }, undefined, 2)}\n`)
    const patchPath = join(dir, 'cordis.patch.yml')
    if (!existsSync(patchPath)) writeFileSync(patchPath, PATCH_TEMPLATE)
    const workspacePath = join(dir, 'pnpm-workspace.yaml')
    if (!existsSync(workspacePath)) writeFileSync(workspacePath, PNPM_WORKSPACE)
    return `${name}: initialized with the fork bundles`
  }

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const bundles = manifest.dsh?.profile?.bundles ?? []
  const placed = placeForkBundles(bundles)
  if (placed === bundles) return null
  if (check) return `${name}: missing ${placed.filter(bundle => !bundles.includes(bundle)).join(', ')}`
  manifest.dsh = { ...manifest.dsh, profile: { ...manifest.dsh?.profile, bundles: placed } }
  writeFileSync(manifestPath, `${JSON.stringify(manifest, undefined, 2)}\n`)
  return `${name}: added ${placed.filter(bundle => !bundles.includes(bundle)).join(', ')}`
}

/** The row the fork's switches live on, and the package it composes. */
const ROSTER_ROW = 'tool-roster'
const ROSTER_PACKAGE = '@deepseek-ai/dsh-roster'

/**
 * The YAML library, borrowed from the package that edits profile patches:
 * it is not a root dependency, so a bare import from here cannot resolve it.
 * @returns the `yaml` module.
 */
function loadYaml() {
  return createRequire(join(resolve(import.meta.dirname, '..'), 'packages', 'boot', 'config-editor', 'package.json'))('yaml')
}

/**
 * Carry the pre-0.1.7 switch positions onto the roster row, once.
 *
 * On first boot upstream imports the removed `settings.yaml` into the profile
 * by row id. The fork's switches lived in sections named `kernel`, `rlm`, and
 * `tools`, which name no fork row, so that import drops them — and with them
 * every tool the operator had switched off. This writes them onto the
 * `tool-roster` row first. It runs only while `settings.yaml` is still
 * unimported, and only when the profile patch has no `tool-roster` row, so it
 * never overrides an edit.
 * @param name - the profile name.
 * @param check - report only; write nothing.
 * @returns a one-line report, or null when there is nothing to carry.
 */
function migrateLegacySwitches(name, check) {
  const legacy = join(dshHome(), 'settings.yaml')
  const patchPath = join(dshHome(), 'profiles', name, 'cordis.patch.yml')
  if (!existsSync(legacy) || !existsSync(patchPath)) return null
  const { parse, parseDocument } = loadYaml()
  const sections = parse(readFileSync(legacy, 'utf8')) ?? {}
  const config = {}
  if (typeof sections.kernel?.enabled === 'boolean') config.kernel = sections.kernel.enabled
  if (typeof sections.rlm?.enabled === 'boolean') config.rlm = sections.rlm.enabled
  if (typeof sections.tools?.enabled === 'boolean') config.enabled = sections.tools.enabled
  // Only the switched-off tools carry meaning: an absent name is on.
  const off = Object.entries(sections.tools?.tools ?? {}).filter(([, on]) => on === false)
  if (off.length > 0) config.tools = Object.fromEntries(off)
  if (Object.keys(config).length === 0) return null

  const doc = parseDocument(readFileSync(patchPath, 'utf8'))
  const rows = doc.toJS() ?? []
  if (!Array.isArray(rows)) return `${name}: the profile patch is not a list, so the switches were not carried over`
  if (rows.some(row => row?.id === ROSTER_ROW)) return null
  if (check) return `${name}: the kernel/rlm/tools switches are not yet on ${ROSTER_ROW}`
  const row = doc.createNode({ id: ROSTER_ROW, name: ROSTER_PACKAGE, config })
  // The initial template is an empty flow list; a block list keeps the file editable.
  if (doc.contents !== null && 'flow' in doc.contents) doc.contents.flow = false
  if (doc.contents === null) doc.contents = doc.createNode([row])
  else doc.add(row)
  writeFileSync(patchPath, doc.toString())
  return `${name}: carried the kernel/rlm/tools switches onto ${ROSTER_ROW}`
}

const args = process.argv.slice(2)
const check = args.includes('--check')
const names = args.filter(argument => !argument.startsWith('--'))
const targets = names.length > 0 ? names : Object.keys(TEMPLATES)

const reports = targets
  .flatMap(name => [ensureProfile(name, check), migrateLegacySwitches(name, check)])
  .filter(report => report !== null)
if (reports.length === 0) {
  console.log(`efai profiles are current: ${targets.join(', ')}`)
  process.exit(0)
}
for (const report of reports) console.log(`efai profile ${report}`)
process.exit(check ? 1 : 0)
