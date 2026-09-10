// Temporary diagnostic: replay the reader's frame scan against a real artifact.
// scanZstdFrames is copied verbatim from src/zstd.ts so the structural verdict
// matches the running backend; decode uses the public one-shot zlib API.
import { readFileSync } from 'node:fs'
import { constants, zstdDecompressSync } from 'node:zlib'

const ZSTD_MAGIC = 0xFD2FB528

function scanZstdFrames(buffer, maxFrames = Number.POSITIVE_INFINITY) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) return { frames, tornStart: start }
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error(`invalid frame magic at byte ${offset}`)
    }
    offset += 4
    if (offset === buffer.length) return { frames, tornStart: start }
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 0x18) !== 0) throw new Error(`reserved frame-header bit at byte ${offset - 1}`)
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 0x20) !== 0
    const checksum = (descriptor & 0x04) !== 0
    const dictionaryFlag = descriptor & 0x03
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start }
    offset += remainingHeaderBytes
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start }
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 0x03
      const blockSize = blockHeader >>> 3
      if (blockType === 0x03) throw new Error(`reserved block type at byte ${offset - 3}`)
      const payloadBytes = blockType === 0x01 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start }
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start }
      offset += 4
    }
    frames.push({ start, end: offset })
    if (frames.length === maxFrames) return { frames }
  }
  return { frames }
}

/** Row -> [firstSeq, eventCount], mirroring decodeStorageRecord's expansion. */
function rowSpan(line) {
  const o = JSON.parse(line)
  if (typeof o.seq === 'number') return [o.seq, 1, o.type]
  if (typeof o.seq0 === 'number') return [o.seq0, o.data.texts.length, o.type]
  return null
}

const path = process.argv[2]
const buffer = readFileSync(path)
const { frames, tornStart } = scanZstdFrames(buffer)
console.log('file bytes     :', buffer.length)
console.log('complete frames:', frames.length)
console.log('tornStart      :', tornStart)
if (frames.length > 0) {
  const last = frames.at(-1)
  console.log('last frame     :', JSON.stringify(last), 'trailing bytes:', buffer.length - last.end)
}

// Decode complete frames and run the scanner's contiguity invariant over them.
let pending = ''
let eventLine = 0
let count = 0
let firstIssue
const report = (msg) => { firstIssue ??= msg; if (firstIssue === msg) console.log('>>>', msg) }

function feed(text, label) {
  pending += text
  for (;;) {
    const nl = pending.indexOf('\n')
    if (nl === -1) break
    const line = pending.slice(0, nl)
    pending = pending.slice(nl + 1)
    if (eventLine === 0 && line.startsWith('{"type":"session"')) { eventLine = 0; count = 0; eventLine = 0; headerSeen = true; continue }
    eventLine += 1
    let span
    try { span = rowSpan(line) } catch { report(`unparsable committed event at line ${eventLine} (${label})`); continue }
    if (span === null) continue
    const [start, len, type] = span
    if (start !== count) {
      report(`seq gap in committed region at line ${eventLine} (expected ${count}, got ${start}) [type=${type}, ${label}]`)
    }
    count = start + len
  }
}

let headerSeen = false
for (let i = 0; i < frames.length; i++) {
  const { start, end } = frames[i]
  const plain = zstdDecompressSync(buffer.subarray(start, end)).toString('utf8')
  feed(plain, `frame ${i}`)
}
console.log('after complete frames: eventLine =', eventLine, 'events =', count, 'unterminated tail bytes =', pending.length)

if (tornStart !== undefined) {
  let recovered = Buffer.alloc(0)
  try {
    recovered = zstdDecompressSync(buffer.subarray(tornStart), { finishFlush: constants.ZSTD_e_flush })
  } catch (error) {
    console.log('torn-prefix decode threw:', error.message)
  }
  console.log('recovered plaintext bytes:', recovered.length)
  console.log('recovered head:', JSON.stringify(recovered.subarray(0, 200).toString('utf8')))
  feed(recovered.toString('utf8'), 'torn frame')
  console.log('after torn frame: eventLine =', eventLine, 'events =', count, 'unterminated tail bytes =', pending.length)
}
console.log('VERDICT:', firstIssue ?? 'clean')
