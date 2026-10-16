// Repack the installed Desktop application's asar with two patched files.
//
// The archive is header + the concatenated *packed* files, with the 1497
// `unpacked` native modules left on disk beside it. This preserves that split
// exactly (a stock extract+pack would pull 242 MB of native modules into the
// archive and break them) and rewrites only the two files named here.
//
// Usage: node .recon/repack-desktop-asar.mjs <archive> <output>
import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

const archive = process.argv[2]
const output = process.argv[3]
const asarEntry = 'D:\\deepseek-kernel-harness\\node_modules\\@electron\\asar\\bin\\asar.js'

/** Replace exactly one occurrence, or fail loudly with what was actually there. */
function replaceOnce(source, before, after, label) {
  const first = source.indexOf(before)
  if (first === -1) throw new Error(`${label}: the text to replace is not present`)
  if (source.indexOf(before, first + 1) !== -1) throw new Error(`${label}: the text to replace appears twice`)
  console.log(`prepared patch for ${label}`)
  return `${source.slice(0, first)}${after}${source.slice(first + before.length)}`
}

/** One file out of the archive, at the offsets the header records. */
function readEntry(buffer, base, entry) {
  const start = base + Number(entry.offset)
  return buffer.subarray(start, start + Number(entry.size)).toString('utf8')
}

const buffer = readFileSync(archive)
const jsonSize = buffer.readUInt32LE(12)
// Data starts after the whole header pickle, which is padded to 4 bytes.
const base = 8 + buffer.readUInt32LE(4)
/** The header as the archive has it: read-only, and what the result is checked against. */
const original = JSON.parse(buffer.subarray(16, base).toString('utf8'))
/** The header to write: every packed entry's offset is recomputed on this copy. */
const header = structuredClone(original)

// The two edits: the shell resolves the profile it owns from the launch
// environment, and the Host boots that profile by name on a port a second
// window can own.
const mainPath = 'lib/main.js'
const hostPath = 'dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js'
const find = (path) => {
  let found
  const walk = (node, prefix) => {
    for (const [name, entry] of Object.entries(node.files)) {
      const full = prefix === '' ? name : `${prefix}/${name}`
      if (entry.files !== undefined) { walk(entry, full); continue }
      if (full === path) found = entry
    }
  }
  walk(header, '')
  if (found === undefined) throw new Error(`no entry ${path}`)
  return found
}

const patched = new Map()
patched.set(mainPath, replaceOnce(readEntry(buffer, base, find(mainPath)),
  `function resolveDesktopPaths(dshHome = resolveDshHome()) {
	return {
		profile: join(dshHome, "profiles", "desktop"),
		lock: join(dshHome, "profiles", "desktop", "lock")
	};
}`,
  `function desktopProfileName(dshHome = resolveDshHome(), environment = process.env) {
	const requested = environment.DSH_DESKTOP_PROFILE?.trim();
	if (requested !== void 0 && requested !== "") return requested;
	const state = join(dshHome, "profile-hub.json");
	if (existsSync(state)) {
		try {
			const launcher = JSON.parse(readFileSync(state, "utf8")).launcher;
			if (typeof launcher === "string" && launcher.trim() !== "" && existsSync(join(dshHome, "profiles", launcher.trim(), "package.json"))) return launcher.trim();
		} catch (error) {
			if (!(error instanceof SyntaxError)) throw error;
		}
	}
	return "desktop";
}
function resolveDesktopPaths(dshHome = resolveDshHome(), profile = desktopProfileName(dshHome)) {
	return {
		profile: join(dshHome, "profiles", profile),
		lock: join(dshHome, "profiles", profile, "lock")
	};
}`, 'lib/main.js'))

const host = replaceOnce(replaceOnce(readEntry(buffer, base, find(hostPath)),
  `	const application = runProfile({
		environment: loadLayeredEnv("dsh"),
		profile: "desktop",`,
  `	const selectedProfile = process.env.DSH_DESKTOP_PROFILE?.trim();
	const profileName = selectedProfile === void 0 || selectedProfile === "" ? "desktop" : selectedProfile;
	const application = runProfile({
		environment: loadLayeredEnv("dsh"),
		profile: profileName,`, 'desktop-host profile name'),
  `		args: [
			"--no-open",
			"--port",
			"19387"
		],`,
  `		args: [
			"--no-open",
			"--port",
			profileName === "desktop" ? "19387" : "0"
		],`, 'desktop-host port')
patched.set(hostPath, host)

// Rewrite every packed entry in document order; `unpacked` entries stay as they
// are, pointing at the files that remain beside the archive.
const chunks = []
let offset = 0
let packed = 0
let unchanged = 0
const walk = (node, prefix) => {
  for (const [name, entry] of Object.entries(node.files)) {
    const full = prefix === '' ? name : `${prefix}/${name}`
    if (entry.files !== undefined) { walk(entry, full); continue }
    if (entry.unpacked === true) { unchanged += 1; continue }
    const replacement = patched.get(full)
    const bytes = replacement === undefined
      ? buffer.subarray(base + Number(entry.offset), base + Number(entry.offset) + Number(entry.size))
      : Buffer.from(replacement, 'utf8')
    // Electron reads `size` as an integer and `offset` as a string; a string
    // size makes every entry unreadable (MODULE_NOT_FOUND).
    entry.offset = String(offset)
    entry.size = bytes.length
    if (replacement !== undefined && entry.integrity !== undefined) {
      const sha = (data) => createHash('sha256').update(data).digest('hex')
      const blockSize = entry.integrity.blockSize
      const blocks = []
      for (let at = 0; at < Math.max(1, bytes.length); at += blockSize) blocks.push(sha(bytes.subarray(at, at + blockSize)))
      entry.integrity = { ...entry.integrity, hash: sha(bytes), blocks }
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
const out = Buffer.concat([
  (() => {
    const prefix = Buffer.alloc(16)
    prefix.writeUInt32LE(4, 0)
    prefix.writeUInt32LE(payload + 4, 4)
    prefix.writeUInt32LE(payload, 8)
    prefix.writeUInt32LE(json.length, 12)
    return prefix
  })(),
  json,
  Buffer.alloc(padding),
  ...chunks,
])
writeFileSync(output, out)
console.log(`packed ${packed} entries, kept ${unchanged} unpacked, wrote ${(out.length / 1048576).toFixed(1)} MB`)

// Read the result back the way Electron does, and confirm only the patch landed.
const written = readFileSync(output)
const writtenJsonSize = written.readUInt32LE(12)
const writtenHeader = JSON.parse(written.subarray(16, 16 + writtenJsonSize).toString('utf8'))
const writtenBase = 8 + written.readUInt32LE(4)
if (written.readUInt32LE(8) !== written.readUInt32LE(4) - 4 || written.readUInt32LE(8) % 4 !== 0) throw new Error('header pickle sizes are inconsistent')
const differences = []
const verify = (before, after, prefix) => {
  for (const [name, entry] of Object.entries(after.files)) {
    const full = prefix === '' ? name : `${prefix}/${name}`
    const original = before.files[name]
    if (entry.files !== undefined) { verify(original, entry, full); continue }
    if (entry.unpacked === true) {
      if (original.unpacked !== true) differences.push(`${full}: lost its unpacked flag`)
      continue
    }
    if (typeof entry.size !== 'number') throw new Error(`${full}: size is not a number`)
    const bytes = written.subarray(writtenBase + Number(entry.offset), writtenBase + Number(entry.offset) + entry.size)
    if (entry.integrity !== undefined && createHash('sha256').update(bytes).digest('hex') !== entry.integrity.hash) throw new Error(`${full}: integrity hash does not match`)
    const a = readEntry(buffer, base, original)
    const b = readEntry(written, writtenBase, entry)
    if (a !== b) differences.push(full)
  }
}
verify(original, writtenHeader, '')
const expected = [mainPath, hostPath].sort()
const actual = differences.sort()
console.log('entries whose content differs:', JSON.stringify(actual.slice(0, 8)), `(${actual.length} total)`)
if (JSON.stringify(actual) !== JSON.stringify(expected)) {
  throw new Error(`expected exactly ${JSON.stringify(expected)} to differ, got ${String(actual.length)} entries`)
}
console.log('verified: only the two intended files changed; every unpacked entry kept its flag')
execFileSync(process.execPath, [asarEntry, 'list', output], { stdio: 'ignore' })
console.log('verified: the electron asar reader lists the result')
