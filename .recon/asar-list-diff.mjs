// List the files that differ between two asar archives, by path and size, then
// hash the ones whose sizes match to catch equal-length edits.
// Usage: node .recon/asar-list-diff.mjs <archiveA> <archiveB>
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

function open(archive) {
  const buffer = readFileSync(archive)
  const headerSize = buffer.readUInt32LE(4)
  const jsonSize = buffer.readUInt32LE(12)
  return { buffer, base: 16 + headerSize, header: JSON.parse(buffer.subarray(16, 16 + jsonSize).toString('utf8')) }
}

function collect(archive) {
  const { buffer, base, header } = open(archive)
  const files = new Map()
  const walk = (node, prefix) => {
    for (const [name, entry] of Object.entries(node.files ?? {})) {
      const path = prefix === '' ? name : `${prefix}/${name}`
      if (entry.files !== undefined) { walk(entry, path); continue }
      const start = base + Number(entry.offset)
      const bytes = buffer.subarray(start, start + Number(entry.size))
      files.set(path, { size: Number(entry.size), hash: createHash('sha1').update(bytes).digest('hex') })
    }
  }
  walk(header, '')
  return files
}

const [a, b] = process.argv.slice(2)
const left = collect(a)
const right = collect(b)
const onlyLeft = [...left.keys()].filter(k => !right.has(k))
const onlyRight = [...right.keys()].filter(k => !left.has(k))
const changed = [...left.keys()].filter(k => right.has(k) && left.get(k).hash !== right.get(k).hash)
console.log(`files: ${left.size} vs ${right.size}`)
console.log(`only in A (${onlyLeft.length}):`, onlyLeft.slice(0, 20).join(', '))
console.log(`only in B (${onlyRight.length}):`, onlyRight.slice(0, 20).join(', '))
console.log(`changed (${changed.length}):`)
for (const path of changed.slice(0, 40)) {
  console.log(`  ${path}  ${left.get(path).size} -> ${right.get(path).size}`)
}
