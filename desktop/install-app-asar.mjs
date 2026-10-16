// Rewrite named files inside an installed Desktop app.asar, preserving the
// archive's packed/unpacked split exactly.
//
// A package the installed `app.asar` ships wins at boot over the same package in
// this repository, so a fork edit to one of those bundles reaches the Desktop
// only by replacing the archive's copy. This script does that surgically: the
// header's `unpacked` entries keep their flags and their files stay on disk
// beside the archive, while every packed entry is rewritten at a recomputed
// offset with its integrity hash rebuilt.
//
// Usage:
//   node desktop/install-app-asar.mjs --resources <dir> [--manifest <file>] [--out <file>]
//   node desktop/install-app-asar.mjs --resources <dir> --apply
//
// Without --apply it writes the rewritten archive beside the original and never
// touches it. --apply swaps the two, keeping the previous archive as a backup,
// and refuses while the application is running: Windows will not replace an
// archive an open process holds.
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Read one `--name value` pair, or undefined when the flag is absent. */
function option(name) {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? undefined : process.argv[index + 1]
}

const resources = option('resources')
if (resources === undefined) {
  console.error('usage: node desktop/install-app-asar.mjs --resources <dir> [--manifest <file>] [--out <file>] [--apply]')
  process.exit(2)
}
const manifestPath = option('manifest') ?? join(repo, 'desktop', 'app-asar-files.json')
const archive = join(resolve(resources), 'app.asar')
const output = option('out') ?? `${archive}.new`
const backup = `${archive}.orig-before-install`
const apply = process.argv.includes('--apply')
const asarCli = join(repo, 'node_modules', '@electron', 'asar', 'bin', 'asar.js')

if (!existsSync(archive)) throw new Error(`no archive at ${archive}`)
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))

/** The archive's own bytes, its header, and the offset its packed data starts at. */
const buffer = readFileSync(archive)
const jsonSize = buffer.readUInt32LE(12)
const base = 8 + buffer.readUInt32LE(4)
/** The header as the archive has it; what the result is checked against. */
const original = JSON.parse(buffer.subarray(16, base).toString('utf8'))
/** The header to write, with every packed entry's offset recomputed. */
const header = structuredClone(original)

/** The header entry for one archive path. */
function findEntry(path) {
  let node = header
  const parts = path.split('/')
  for (const part of parts.slice(0, -1)) {
    node = node.files[part]
    if (node === undefined) throw new Error(`no such directory in the archive: ${path}`)
  }
  const entry = node.files[parts.at(-1)]
  if (entry === undefined) throw new Error(`no such file in the archive: ${path}`)
  if (entry.files !== undefined) throw new Error(`the archive path is a directory: ${path}`)
  return entry
}

/** One file's bytes out of the archive, at the offset its header records. */
function readEntry(entry) {
  const start = base + Number(entry.offset)
  return buffer.subarray(start, start + Number(entry.size))
}

const replacements = new Map()
for (const [archivePath, source] of Object.entries(manifest.files)) {
  const sourcePath = join(repo, source)
  if (!existsSync(sourcePath)) {
    throw new Error(`${archivePath}: build the package first — ${sourcePath} does not exist`)
  }
  const entry = findEntry(archivePath)
  if (entry.unpacked === true) throw new Error(`${archivePath}: an unpacked entry cannot be replaced in place`)
  replacements.set(archivePath, readFileSync(sourcePath))
  console.log(`prepared ${archivePath} <- ${source} (${(replacements.get(archivePath).length / 1024).toFixed(1)} kB, was ${(Number(entry.size) / 1024).toFixed(1)} kB)`)
}

// Rewrite every packed entry in document order; `unpacked` entries stay as they
// are, pointing at the files that remain beside the archive.
const chunks = []
let offset = 0
let packed = 0
let unpacked = 0
const walk = (node, prefix) => {
  for (const [name, entry] of Object.entries(node.files)) {
    const full = prefix === '' ? name : `${prefix}/${name}`
    if (entry.files !== undefined) { walk(entry, full); continue }
    if (entry.unpacked === true) { unpacked += 1; continue }
    const replacement = replacements.get(full)
    const bytes = replacement ?? readEntry(entry)
    // Electron reads `size` as a number and `offset` as a string; a string size
    // makes every entry unreadable, and a number offset fails the same way.
    entry.offset = String(offset)
    entry.size = bytes.length
    if (replacement !== undefined && entry.integrity !== undefined) {
      const digest = data => createHash('sha256').update(data).digest('hex')
      const blockSize = entry.integrity.blockSize
      const blocks = []
      for (let at = 0; at < Math.max(1, bytes.length); at += blockSize) {
        blocks.push(digest(bytes.subarray(at, at + blockSize)))
      }
      entry.integrity = { ...entry.integrity, hash: digest(bytes), blocks }
    }
    chunks.push(bytes)
    offset += bytes.length
    packed += 1
  }
}
walk(header, '')

const json = Buffer.from(JSON.stringify(header), 'utf8')
// Pickle layout: [4][payload + 4][payload][json length] json padding, where the
// payload (length field + json) is padded to a multiple of 4.
const padding = (4 - (json.length % 4)) % 4
const payload = 4 + json.length + padding
const prefix = Buffer.alloc(16)
prefix.writeUInt32LE(4, 0)
prefix.writeUInt32LE(payload + 4, 4)
prefix.writeUInt32LE(payload, 8)
prefix.writeUInt32LE(json.length, 12)
const written = Buffer.concat([prefix, json, Buffer.alloc(padding), ...chunks])
writeFileSync(output, written)
console.log(`packed ${packed} entries, kept ${unpacked} unpacked, wrote ${(written.length / 1048576).toFixed(1)} MB to ${output}`)

// Read the result back the way Electron does, and confirm only the intended
// files differ from what the archive held.
const reread = readFileSync(output)
const rereadBase = 8 + reread.readUInt32LE(4)
const rereadHeader = JSON.parse(reread.subarray(16, 16 + reread.readUInt32LE(12)).toString('utf8'))
if (reread.readUInt32LE(8) !== reread.readUInt32LE(4) - 4 || reread.readUInt32LE(8) % 4 !== 0) {
  throw new Error('the rewritten header pickle sizes are inconsistent')
}
const differences = []
let stale = 0
const verify = (before, after, prefix) => {
  for (const [name, entry] of Object.entries(after.files)) {
    const full = prefix === '' ? name : `${prefix}/${name}`
    const prior = before.files[name]
    if (entry.files !== undefined) { verify(prior, entry, full); continue }
    if (entry.unpacked === true) {
      if (prior.unpacked !== true) differences.push(`${full}: lost its unpacked flag`)
      continue
    }
    if (typeof entry.size !== 'number') throw new Error(`${full}: size is not a number`)
    const bytes = reread.subarray(rereadBase + Number(entry.offset), rereadBase + Number(entry.offset) + entry.size)
    // An entry this script rewrote must hash to the integrity it recorded; an
    // entry it only copied keeps whatever the archive already said, which may
    // already disagree with its bytes in an archive that was patched before.
    if (replacements.has(full) && entry.integrity !== undefined
      && createHash('sha256').update(bytes).digest('hex') !== entry.integrity.hash) {
      throw new Error(`${full}: the recomputed integrity hash does not match the written bytes`)
    }
    if (entry.integrity !== undefined && createHash('sha256').update(bytes).digest('hex') !== entry.integrity.hash) stale += 1
    if (!readEntry(prior).equals(bytes)) differences.push(full)
  }
}
verify(original, rereadHeader, '')
const expected = Object.keys(manifest.files).sort()
const actual = differences.sort()
if (JSON.stringify(actual) !== JSON.stringify(expected)) {
  throw new Error(`expected exactly ${JSON.stringify(expected)} to differ, got ${JSON.stringify(actual)}`)
}
console.log(`verified: exactly ${actual.length} intended file(s) changed, and every unpacked entry kept its flag`)
if (stale > 0) {
  console.log(`note: ${stale} untouched entr${stale === 1 ? 'y' : 'ies'} already disagreed with its recorded integrity hash before this run`)
}
execFileSync(process.execPath, [asarCli, 'list', output], { stdio: 'ignore' })
console.log('verified: the Electron asar reader lists the result')

if (!apply) {
  console.log(`\nStaged at ${output}.`)
  console.log('To install it: quit the Harness from the tray (closing its window is not enough), then re-run with --apply.')
} else {
  const running = execFileSync('tasklist', ['/FI', 'IMAGENAME eq DeepSeek Harness.exe'], { encoding: 'utf8' })
  if (/DeepSeek Harness\.exe/i.test(running)) {
    throw new Error('the Harness is running; quit it from the tray before applying the archive')
  }
  rmSync(backup, { force: true })
  renameSync(archive, backup)
  try {
    copyFileSync(output, archive)
  } catch (error) {
    renameSync(backup, archive)
    throw error
  }
  rmSync(output, { force: true })
  console.log(`\nInstalled ${(statSync(archive).size / 1048576).toFixed(1)} MB into ${archive}`)
  console.log(`The previous archive is kept at ${backup}`)
  console.log('Start the Harness again to load it.')
}
