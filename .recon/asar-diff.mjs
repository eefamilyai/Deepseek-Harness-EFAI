// Compare one file inside two asar archives, the way Electron reads them.
// Usage: node .recon/asar-diff.mjs <archiveA> <archiveB> <innerPath>
import { readFileSync } from 'node:fs'

/** Read one file out of an asar archive without extracting it. */
function readFromAsar(archive, innerPath) {
  const buffer = readFileSync(archive)
  const headerSize = buffer.readUInt32LE(4)
  const jsonSize = buffer.readUInt32LE(12)
  const header = JSON.parse(buffer.subarray(16, 16 + jsonSize).toString('utf8'))
  const base = 16 + headerSize
  let node = header
  for (const part of innerPath.split('/')) node = node.files[part]
  return buffer.subarray(base + Number(node.offset), base + Number(node.offset) + Number(node.size)).toString('utf8')
}

const [a, b, inner] = process.argv.slice(2)
const left = readFromAsar(a, inner)
const right = readFromAsar(b, inner)
if (left === right) { console.log('identical'); process.exit(0) }
const leftLines = left.split('\n')
const rightLines = right.split('\n')
console.log(`sizes: ${left.length} vs ${right.length} | lines: ${leftLines.length} vs ${rightLines.length}`)
// Line-level diff, bounded.
let shown = 0
const max = Number(process.env.MAX_DIFF ?? 60)
for (let i = 0, j = 0; (i < leftLines.length || j < rightLines.length) && shown < max; i += 1, j += 1) {
  if (leftLines[i] === rightLines[j]) continue
  // Report the first divergence with a little context, then resynchronize.
  console.log(`--- line ${i + 1} ---`)
  console.log(`  A: ${(leftLines[i] ?? '<eof>').slice(0, 220)}`)
  console.log(`  B: ${(rightLines[j] ?? '<eof>').slice(0, 220)}`)
  shown += 1
  // Resynchronize on the next matching line.
  for (let k = 1; k < 400; k += 1) {
    if (leftLines[i + k] === rightLines[j + k]) { i += k - 1; j += k - 1; break }
  }
}
if (shown === 0) console.log('no line-level difference detected')
