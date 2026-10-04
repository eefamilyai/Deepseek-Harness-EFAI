#!/usr/bin/env node
/**
 * Repair the markdown tables a Session already recorded.
 *
 * The stream pass (`@deepseek-ai/dsh-llm-markdown-fidelity`) repairs an answer while it
 * arrives, so a table written after that pass was mounted renders correctly. Text recorded
 * before it was mounted cannot be repaired by any pass: nothing streams it again.
 *
 * No supported mechanism can shadow a recorded `assistant/message` either. A surface
 * `replace` demands `sourceEventSeqs` naming every shadowed node, while an
 * `assistant/message` may not carry that field at all (`assertSourceEventReferences` in
 * `packages/core/session/src/surface.ts`), and the client derives its transcript from the raw
 * event data, not from a host message projection. The recorded bytes are therefore the only
 * place a historical table can be fixed, and this tool is that one-time repair.
 *
 * It runs on a Session *file*, so it must not run while the owning host writes it: the host
 * holds the authoritative log in memory and rewrites the file as it compacts, which would
 * silently revert an edit made underneath it. `--wait-for-pid` waits for a host to exit;
 * `--held <session-id>` names the session that host will reopen, which this tool leaves for a
 * later pass once no host is running at all; and a log modified inside `--settle` seconds is
 * skipped as possibly being written right now.
 *
 * Every changed file is backed up beside itself (`<name>.bak-<stamp>`) and verified after the
 * write: the event count, every event `seq`, and every repaired text are read back before the
 * new bytes are kept, and the backup is restored when any of them disagree.
 *
 * Usage:
 *   node local-overlay/tools/repair-recorded-tables.mjs                     # report only
 *   node local-overlay/tools/repair-recorded-tables.mjs --apply             # rewrite
 *   node local-overlay/tools/repair-recorded-tables.mjs --apply --wait-for-pid 18296 \
 *     --held session-59771944-fd85-4f04-9dbe-e738901702f2
 *   node local-overlay/tools/repair-recorded-tables.mjs --sessions <dir> --apply --settle 0
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ZSTD_MAGIC = 0xfd2fb528
const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPAIR_MODULE = path.resolve(HERE, '../../packages/llm/llm-markdown-fidelity/lib/index.js')

/** One parsed command line. */
function options(argv) {
  const parsed = {
    apply: false,
    sessions: path.join(process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'), 'sessions'),
    waitForPid: undefined,
    held: undefined,
    settleSeconds: 120,
    holdMs: 6 * 60 * 60 * 1000,
    pruneBackups: undefined,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    if (flag === '--apply') parsed.apply = true
    else if (flag === '--sessions') parsed.sessions = argv[++index]
    else if (flag === '--wait-for-pid') parsed.waitForPid = Number(argv[++index])
    else if (flag === '--held') parsed.held = argv[++index]
    else if (flag === '--settle') parsed.settleSeconds = Number(argv[++index])
    else if (flag === '--hold-ms') parsed.holdMs = Number(argv[++index])
    else if (flag === '--prune-backups') parsed.pruneBackups = Number(argv[++index] ?? 14)
    else throw new Error(`unknown argument ${flag}`)
  }
  return parsed
}

/** Structurally scan a concatenated Zstandard stream into frame byte ranges. */
function scanFrames(buf) {
  const frames = []
  let offset = 0
  while (offset < buf.length) {
    const start = offset
    if (buf.length - offset < 4 || buf.readUInt32LE(offset) !== ZSTD_MAGIC) break
    offset += 4
    if (offset === buf.length) break
    const descriptor = buf.readUInt8(offset)
    offset += 1
    if ((descriptor & 0x18) !== 0) break
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 0x20) !== 0
    const checksum = (descriptor & 0x04) !== 0
    const dictionaryFlag = descriptor & 0x03
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remaining = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buf.length - offset < remaining) break
    offset += remaining
    for (;;) {
      if (buf.length - offset < 3) return { frames, torn: true }
      const header = buf.readUIntLE(offset, 3)
      offset += 3
      const last = (header & 1) !== 0
      const type = (header >>> 1) & 0x03
      const size = header >>> 3
      if (type === 0x03) return { frames, torn: true }
      const payload = type === 0x01 ? 1 : size
      if (buf.length - offset < payload) return { frames, torn: true }
      offset += payload
      if (last) break
    }
    if (checksum) {
      if (buf.length - offset < 4) return { frames, torn: true }
      offset += 4
    }
    frames.push({ start, end: offset })
  }
  return { frames, torn: false }
}

/**
 * Read one log as its history units: frame groups that each end on a line boundary, so a
 * repair never has to touch a line split across frames.
 * @param file - log path.
 * @returns the compressed/uncompressed form, the units' text, and whether a tail was torn.
 */
function readLog(file) {
  const buf = fs.readFileSync(file)
  if (buf.length < 4 || buf.readUInt32LE(0) !== ZSTD_MAGIC) {
    return { compressed: false, units: [buf.toString('utf8')], torn: false }
  }
  const { frames, torn } = scanFrames(buf)
  const units = []
  let held = ''
  for (const frame of frames) {
    held += zlib.zstdDecompressSync(buf.subarray(frame.start, frame.end)).toString('utf8')
    if (held.endsWith('\n')) {
      units.push(held)
      held = ''
    }
  }
  if (held !== '') units.push(held)
  return { compressed: true, units, torn }
}

/**
 * Write units back as a concatenation of independent Zstandard frames, through a temporary
 * file: a host that has the log open refuses the rename instead of seeing a truncated file.
 */
function writeLog(file, units) {
  const parts = units.map(unit => zlib.zstdCompressSync(Buffer.from(unit, 'utf8')))
  const temp = `${file}.repairing`
  fs.writeFileSync(temp, Buffer.concat(parts))
  try {
    fs.renameSync(temp, file)
  } catch (error) {
    fs.rmSync(temp, { force: true })
    throw error
  }
}

/** Whether a host process of the app image is running. */
function hostRunning() {
  const listed = spawnSync('tasklist', ['/FI', 'IMAGENAME eq DeepSeek Harness.exe', '/NH'], { encoding: 'utf8' })
  return (listed.stdout ?? '').includes('DeepSeek Harness.exe')
}

/** The repaired text of one recorded event, or null when markdown reads it as written. */
function repairEvent(event, repairTableLines) {
  if (event?.type === 'compaction/summary') {
    if (typeof event.data?.summary !== 'string') return null
    const summary = repairTableLines(event.data.summary)
    return summary === event.data.summary ? null : { ...event, data: { ...event.data, summary } }
  }
  if (event?.type !== 'assistant/message') return null
  const content = event.data?.message?.content
  if (!Array.isArray(content)) return null
  let changed = false
  const repaired = content.map((block) => {
    if (block?.type !== 'text' || typeof block.text !== 'string') return block
    const text = repairTableLines(block.text)
    if (text === block.text) return block
    changed = true
    return { ...block, text }
  })
  return changed ? { ...event, data: { ...event.data, message: { ...event.data.message, content: repaired } } } : null
}

/**
 * Repair every recorded table inside one log's units.
 * @param units - the log's history text, one entry per frame group.
 * @param repairTableLines - the shared repair.
 * @returns the repaired units and how many messages changed.
 */
function repairUnits(units, repairTableLines) {
  let repaired = 0
  const out = units.map((unit) => {
    const lines = unit.split('\n')
    const kept = lines.map((line) => {
      const trimmed = line.trim()
      if (trimmed === '') return line
      let event
      try {
        event = JSON.parse(trimmed)
      } catch {
        return line
      }
      const next = repairEvent(event, repairTableLines)
      if (next === null) return line
      repaired += 1
      return JSON.stringify(next)
    })
    return kept.join('\n')
  })
  return { units: out, repaired }
}

/** Whether a repaired log holds the same events, in the same order, with repaired text. */
function verify(units, repairTableLines) {
  let events = 0
  let headers = 0
  let unfixed = 0
  for (const unit of units) {
    for (const line of unit.split('\n')) {
      const trimmed = line.trim()
      if (trimmed === '') continue
      let event
      try {
        event = JSON.parse(trimmed)
      } catch {
        return `unparseable line after repair: ${trimmed.slice(0, 80)}`
      }
      // The log opens with one `session` header record; every other line is a keyed event.
      if (typeof event.seq !== 'number') {
        headers += 1
        continue
      }
      if (event.seq !== events) return `seq ${String(event.seq)} at event index ${String(events)} after repair`
      events += 1
      if (event.type === 'compaction/summary' && typeof event.data?.summary === 'string'
        && repairTableLines(event.data.summary) !== event.data.summary) unfixed += 1
      if (event.type !== 'assistant/message') continue
      for (const block of event.data?.message?.content ?? []) {
        if (block?.type !== 'text') continue
        if (repairTableLines(block.text) !== block.text) unfixed += 1
      }
    }
  }
  if (headers !== 1) return `${String(headers)} header line(s) after repair, expected 1`
  return unfixed === 0 ? null : `${String(unfixed)} text block(s) still misread after repair`
}

/** Wait until the named host pid is gone. */
async function waitForPid(pid) {
  const alive = (candidate) => {
    try {
      process.kill(candidate, 0)
      return true
    } catch {
      return false
    }
  }
  while (alive(pid)) await new Promise(resolve => setTimeout(resolve, 2000))
}

/**
 * Wait until no host of the app image is running, or the budget runs out.
 *
 * Polled every second, always: a restart closes and reopens the app in about that long, and
 * that gap is the only safe moment to rewrite the log the host reopens. A slower poll misses
 * every ordinary restart, and an operator restarts far more often than they close. The wait
 * reports a heartbeat each minute, so a reader can tell "still waiting" from "died".
 * @param timeoutMs - how long to wait.
 * @returns whether the wait succeeded.
 */
async function waitForNoHost(timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let waited = 0
  while (hostRunning()) {
    if (Date.now() > deadline) return false
    waited += 1000
    if (waited % 60_000 === 0) console.log(`[repair] still waiting for a host-free window (${String(waited / 1000)}s)`)
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
  return true
}

/** Write one repaired log, with a backup, and roll back when the result does not verify. */
function applyLog(file, units, repairTableLines, stamp) {
  const problem = verify(units, repairTableLines)
  if (problem !== null) {
    console.log(`[repair] SKIP ${file}: ${problem}`)
    return false
  }
  const backup = `${file}.bak-${stamp}`
  fs.copyFileSync(file, backup)
  try {
    writeLog(file, units)
    const failure = verify(readLog(file).units, repairTableLines)
    if (failure !== null) throw new Error(failure)
    return true
  } catch (error) {
    fs.copyFileSync(backup, file)
    console.log(`[repair] ROLLED BACK ${file}: ${error instanceof Error ? error.message : String(error)}`)
    return false
  }
}

/**
 * Repair every log the selector accepts.
 *
 * A log the host may be writing is never touched: the host holds the authoritative copy in
 * memory and rewrites the file as it compacts, so an edit underneath it is reverted at best.
 * Two guards say "possibly written": the session named `--held` (the one this repair was
 * scheduled from, which the restarted host reopens) and any log whose modification time is
 * inside the settle window.
 * @param config - parsed command line.
 * @param repairTableLines - the shared repair.
 * @param select - which logs this pass owns.
 * @param label - how the pass names itself in the report.
 * @returns how many messages the pass repaired.
 */
function repairLogs(config, repairTableLines, select, label) {
  const stamp = new Date().toISOString().replaceAll(/[:.]/gu, '-')
  let files = 0
  let messages = 0
  for (const file of logsUnder(config.sessions)) {
    try {
      if (!select(file)) continue
      if (config.apply && Date.now() - fs.statSync(file).mtimeMs < config.settleSeconds * 1000) {
        console.log(`[repair] ${label} SKIP (written recently) ${file}`)
        continue
      }
      const read = readLog(file)
      const { units, repaired } = repairUnits(read.units, repairTableLines)
      if (repaired === 0) continue
      files += 1
      messages += repaired
      console.log(`[repair] ${label} ${read.compressed ? '' : 'plain '}${file}: ${String(repaired)} message(s)`)
      if (config.apply) applyLog(file, units, repairTableLines, stamp)
    } catch (error) {
      console.log(`[repair] ${label} SKIP ${file}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return { files, messages }
}

/**
 * Delete the backup copies a repair left beside logs, once they are older than a grace
 * period.
 *
 * A backup is only useful until the operator has seen the repaired session open; after that
 * it is a second copy of a multi-megabyte log in a directory the harness lists. The default
 * grace is two weeks, and `--prune-backups 0` removes them all.
 * @param root - sessions root or one project directory.
 * @param days - keep backups newer than this many days.
 * @returns how many files were removed.
 */
function pruneBackups(root, days) {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000
  let removed = 0
  const walk = (dir, depth) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const next = path.join(dir, entry.name)
      for (const file of fs.readdirSync(next)) {
        if (!/\.bak-\d/u.test(file)) continue
        const full = path.join(next, file)
        if (fs.statSync(full).mtimeMs > cutoff) continue
        fs.rmSync(full, { force: true })
        removed += 1
      }
      if (depth > 0) walk(next, depth - 1)
    }
  }
  walk(root, 1)
  console.log(`[repair] pruned ${String(removed)} backup(s) older than ${String(days)} day(s) under ${root}`)
  return removed
}

async function main(argv) {
  const config = options(argv)
  if (config.pruneBackups !== undefined) pruneBackups(config.sessions, config.pruneBackups)
  if (config.waitForPid !== undefined) {
    if (!Number.isSafeInteger(config.waitForPid)) throw new Error(`invalid --wait-for-pid ${String(config.waitForPid)}`)
    console.log(`[repair] waiting for host pid ${String(config.waitForPid)} to exit`)
    await waitForPid(config.waitForPid)
  }
  const { repairTableLines } = await import(pathToFileURL(REPAIR_MODULE).href)
  const held = config.held
  const isHeld = (file) => held !== undefined && path.basename(path.dirname(file)) === held
  let files = 0
  let messages = 0
  const first = repairLogs(config, repairTableLines, file => !isHeld(file), '')
  files += first.files
  messages += first.messages
  if (config.apply) {
    console.log(`[repair] holding ${held ?? 'the rest'} until no host is running`)
    if (await waitForNoHost(config.holdMs)) {
      // Nothing is writing now, so every log this pass skipped for being recently touched is
      // safe to repair here too.
      const settled = repairLogs({ ...config, settleSeconds: 0 }, repairTableLines, () => true, 'settled ')
      files += settled.files
      messages += settled.messages
    } else {
      console.log(`[repair] gave up waiting for a host-free window after ${String(config.holdMs)} ms`)
    }
  }
  console.log(`[repair] ${String(messages)} message(s) in ${String(files)} file(s); ${config.apply ? 'applied' : 'dry run'}`)
}

/**
 * Every canonical session log under a root, at `<root>/<project>/<session>/` or directly
 * under a project directory (the repair is often pointed at one project).
 * @param root - sessions root or one project directory.
 * @returns log paths.
 */
function logsUnder(root) {
  const found = []
  const walk = (dir, depth) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const next = path.join(dir, entry.name)
      for (const file of fs.readdirSync(next)) {
        if (/^session(\.[vV][0-9]+)?\.jsonl(\.zstd)?$/u.test(file)) found.push(path.join(next, file))
      }
      if (depth > 0) walk(next, depth - 1)
    }
  }
  walk(root, 1)
  return found
}

// A watcher that dies silently is worse than one that never started: it looks like it is
// still waiting. Report the failure and leave the log on disk for the next run.
try {
  await main(process.argv.slice(2))
} catch (error) {
  console.log(`[repair] FAILED: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`)
  process.exitCode = 1
}
