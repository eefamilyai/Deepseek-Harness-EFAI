#!/usr/bin/env node
/**
 * Read this harness's own session history.
 *
 * Logs live at `$DSH_HOME/sessions/<project>/<session-id>/session.jsonl.zstd`
 * (`$DSH_HOME` defaults to `~/.dsh`). Each file is a CONCATENATION of independent
 * Zstandard frames, so one `zstdDecompress` call yields only the first frame.
 * This script scans frame boundaries structurally, mirroring
 * `@deepseek-ai/dsh-session-persistence-jsonl`, and decodes each frame in turn.
 * That needs no dependency beyond the zstd support built into Node 22.15+/24.
 *
 * A session directory can hold more than one log. `session.v3.jsonl.zstd` is the
 * current name and `session.jsonl.zstd` the legacy one, which a v3 session
 * keeps alongside the new file as a shorter compaction of the same
 * conversation. Every mode reads the NEWEST format present unless `--log NAME`
 * names another, and every mode prints which log it read.
 *
 * That default is the whole point. Preferring the legacy file once meant a
 * reader asking "what was I doing" got a transcript that stopped twelve turns
 * and six hours early: no error, no marker, and no way to tell from the output
 * that a fresher log sat beside it. A wrong-but-plausible answer with no
 * visible evidence of its wrongness is the worst failure this tool can have, so
 * the log is now both chosen correctly and always named.
 *
 * Usage:
 *   node session-read.mjs resume [--session ID] [--log NAME] [--width N] [--tail N]
 *   node session-read.mjs list [--cwd DIR] [--limit N] [--json]
 *   node session-read.mjs prompts [--session ID] [--log NAME] [--kind KIND] [--limit N]
 *   node session-read.mjs latest-prompt [--session ID] [--log NAME] [--kind instructional|steering|user|any]
 *   node session-read.mjs types [--session ID] [--log NAME]
 *   node session-read.mjs grep <regex> [--session ID] [--log NAME] [--limit N] [--before N] [--after N]
 *   node session-read.mjs tail [--session ID] [--log NAME] [--limit N]
 *   node session-read.mjs show [--session ID] [--log NAME] [--from N] [--to N] [--width N]
 *
 * Every mode bounds its own output; nothing prints an unbounded transcript.
 *
 * ## Start with `resume`
 *
 * `resume` is the one call to make first after a compaction, and it is why this
 * tool exists. It prints, in one pass: the folded goal, the instructional
 * prompt, the latest checkpoint summary **whole**, the operator prompts sent
 * after that checkpoint, and the tail of the log. Every other mode answers one
 * slice of that question, and recovering the whole picture by hand means
 * discovering the right sequence of them — which is exactly the work a
 * compacted reader is least equipped to do.
 *
 * It also fixes the trap that made that recovery slow. Summaries and prompts
 * are multi-line blocks, and the per-event display clip flattens whitespace, so
 * a 10 KB summary came back as one unreadable line and the reader had to go
 * back to the log for structure that was already in front of them. `resume`
 * prints blocks with their newlines intact and no width limit by default; pass
 * `--width N` to bound one, and the cut is always reported with the flag that
 * removes it.
 *
 * ## Instruction versus steering
 *
 * A session records far more `user/message` events than the operator typed, and
 * only one of them states the task:
 *
 *   INSTRUCTION — the prompt in effect when the goal was set. The harness
 *   records goal creation as a `goal/change` event with operation `create`,
 *   written mid-turn; the operator message that opened that turn is the prompt
 *   the work was commissioned with. "Pick up from where this ai left off, ...",
 *   "resume". This is what `latest-prompt` returns, and it is the task a fresh
 *   reader should adopt.
 *
 *   STEERING — redirects work already underway and states no new task.
 *   "dont touch that dsml.ts", "use optimized methods to search", "read slightly
 *   more history", "you can use git grep?".
 *
 * The harness's own timing record lives in `agent/inbox/spliced`: each message
 * arrives with `target: "next-step"` when it is injected into the running turn,
 * and `target: "next-turn"` when it opens the next one. A `next-step` delivery is
 * always steering. Timing alone under-reports steering, because the operator can
 * steer in the gap after a turn aborts — the harness then opens a fresh turn for
 * it, which is how "you can use git grep?" became a turn opener. Turn-opening
 * messages that are terse and shaped like a redirection therefore also read as
 * steering; pass `--steer-max-chars 0` to judge by delivery alone.
 *
 * Machine-injected context — `agent-instructions`, `plugin`, `skill-catalog`,
 * `skill-invocation`, `goal`, `subagent-report`, `compaction` — is neither.
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import zlib from 'node:zlib'

const ZSTD_MAGIC = 0xfd2fb528

/**
 * A canonical Session log basename: `session.jsonl` (generation 0) or
 * `session.vN.jsonl`, optionally `.zstd`-compressed.
 *
 * This mirrors `parseSessionFormatLogFilename` in
 * `@deepseek-ai/dsh-session-format`, which is the authority for the naming
 * rule. The version is PARSED rather than listed on purpose: a hardcoded
 * `['session.v3…', 'session.jsonl…']` silently picks v3 the day the writer
 * moves to v4, which is the same class of failure this reader already had once.
 */
const CANONICAL_LOG = /^session(?:\.v([1-9][0-9]*))?\.jsonl(\.zstd)?$/u

/**
 * The generation and compression a log basename declares, or undefined for
 * anything noncanonical (a `.tmp`, a stray file, a name we did not write).
 * @param name - one basename from a Session directory.
 * @returns its parsed identity, or undefined when the name is not canonical.
 */
function parseLogName(name) {
  const match = CANONICAL_LOG.exec(name)
  if (match === null) return undefined
  const version = match[1] === undefined ? 0 : Number(match[1])
  if (!Number.isSafeInteger(version)) return undefined
  return { version, compression: match[2] === undefined ? 'raw' : 'zstd' }
}

/**
 * A session directory can hold several generations of the same conversation.
 * Prefer the ZSTD-compressed, highest-generation log: that is the one the
 * current writer emits, and a lower generation alongside it is a compacted
 * copy that stops early.
 *
 * Defaulting to the legacy copy was a silent failure with teeth: in the
 * session that produced this reader, `session.jsonl.zstd` froze at turn 11
 * while `session.v3.jsonl.zstd` ran on to turn 23. A reader asking "what was I
 * doing" got a transcript that stopped twelve turns and six hours short — no
 * error, no marker, and no way to tell from the output that a fresher log sat
 * beside it.
 * @param logs - candidate logs found in one directory.
 * @returns the logs, newest generation first.
 */
function byNewestGeneration(logs) {
  return [...logs].sort((left, right) => {
    if (left.version !== right.version) return right.version - left.version
    // At equal generation, ZSTD is the compressed form of the raw log.
    return (right.compression === 'zstd' ? 1 : 0) - (left.compression === 'zstd' ? 1 : 0)
  })
}

const DEFAULT_STEER_MAX_CHARS = 200

/** Machine-injected sources that are never an operator prompt. */
const INJECTED_KINDS = new Set([
  'agent-instructions', 'plugin', 'skill-catalog', 'skill-invocation',
  'goal', 'subagent-report', 'subagent-settled', 'coordinator',
])

/**
 * Redirection shapes: a terse message that opens with one of these tells the
 * agent how to continue rather than what to build. Each pattern comes from a
 * real operator message in this history; none is speculative.
 */
const STEER_OPENERS = [
  /^(?:please\s+)?(?:resume|continue|keep going|go on)\b/i, // "resume", "please resume"
  /^(?:do ?n[o']?t|don'?t|stop|hold off|avoid|never)\b/i,    // "dont touch that dsml.ts"
  /^(?:use|try|switch to|go with|prefer)\b/i,                // "use optimized search methods"
  /^(?:read|re-?read|look|check|open|inspect|skim|grep|search)\b/i, // "read slightly more history"
  /^(?:wait|actually|also|and)\b/i,
]

/** Redirection shapes that can appear anywhere in a terse message. */
const STEER_PHRASES = [
  /\byou can (?:use|try|just)\b/i,      // "you can use git grep?"
  /\bmaybe (?:use|try)\b/i,             // "maybe use duckduck or firefox"
  /\buse (?:optimized|optimised|optimize|optimise)\b/i,
  /\b(?:stop|don'?t) (?:doing|using|touching|outputting)\b/i,
]

/**
 * Structurally scan a concatenated Zstandard stream, without decompressing it.
 * Returns `{ frames, tornStart }`; `tornStart` is set when a final frame was cut
 * short, which is how a log written by a still-running session ends.
 */
function scanFrames(buf, maxFrames = Number.POSITIVE_INFINITY) {
  const frames = []
  let offset = 0
  while (offset < buf.length) {
    const start = offset
    if (buf.length - offset < 4) return { frames, tornStart: start }
    if (buf.readUInt32LE(offset) !== ZSTD_MAGIC) return { frames, tornStart: start }
    offset += 4
    if (offset === buf.length) return { frames, tornStart: start }
    const descriptor = buf.readUInt8(offset)
    offset += 1
    // Reserved bits set, or a frame header that cannot be parsed: stop here.
    if ((descriptor & 0x18) !== 0) return { frames, tornStart: start }
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 0x20) !== 0
    const checksum = (descriptor & 0x04) !== 0
    const dictionaryFlag = descriptor & 0x03
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remaining = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buf.length - offset < remaining) return { frames, tornStart: start }
    offset += remaining
    for (;;) {
      if (buf.length - offset < 3) return { frames, tornStart: start }
      const header = buf.readUIntLE(offset, 3)
      offset += 3
      const last = (header & 1) !== 0
      const type = (header >>> 1) & 0x03
      const size = header >>> 3
      if (type === 0x03) return { frames, tornStart: start }
      const payload = type === 0x01 ? 1 : size
      if (buf.length - offset < payload) return { frames, tornStart: start }
      offset += payload
      if (last) break
    }
    if (checksum) {
      if (buf.length - offset < 4) return { frames, tornStart: start }
      offset += 4
    }
    frames.push({ start, end: offset })
    if (frames.length >= maxFrames) return { frames }
  }
  return { frames }
}

/** Decode every complete frame of a log into one plaintext string. */
function decodeAll(file) {
  const buf = fs.readFileSync(file)
  if (buf.length >= 4 && buf.readUInt32LE(0) !== ZSTD_MAGIC) {
    return buf.toString('utf8') // uncompressed JSONL, written by a plaintext provider
  }
  const { frames } = scanFrames(buf)
  const parts = []
  for (const frame of frames) {
    try {
      parts.push(zlib.zstdDecompressSync(buf.subarray(frame.start, frame.end)).toString('utf8'))
    } catch {
      // Skip one unreadable frame rather than discarding the whole log.
    }
  }
  return parts.join('')
}

function parseEvents(text) {
  const events = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      events.push(JSON.parse(trimmed))
    } catch {
      // A torn final line is expected while a session is still writing.
    }
  }
  return events
}

function sessionsRoot() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(home, 'sessions')
}

/**
 * Enumerate every session log, reading only the first frame of each so that a
 * listing stays cheap across hundreds of sessions and gigabytes of logs.
 */
function listSessions() {
  const root = sessionsRoot()
  if (!fs.existsSync(root)) return []
  const sessions = []
  for (const project of fs.readdirSync(root)) {
    const projectDir = path.join(root, project)
    let projectStat
    try { projectStat = fs.statSync(projectDir) } catch { continue }
    if (!projectStat.isDirectory()) continue
    for (const id of fs.readdirSync(projectDir)) {
      const sessionDir = path.join(projectDir, id)
      let dirStat
      try { dirStat = fs.statSync(sessionDir) } catch { continue }
      if (!dirStat.isDirectory()) continue
      // A directory can hold several generations of the same conversation.
      // Parse every canonical log name rather than checking a fixed list, so a
      // future generation needs no change here.
      const logs = []
      for (const name of fs.readdirSync(sessionDir)) {
        const parsed = parseLogName(name)
        if (parsed === undefined) continue
        const file = path.join(sessionDir, name)
        let stat
        try { stat = fs.statSync(file) } catch { continue }
        if (!stat.isFile()) continue
        logs.push({ name, file, bytes: stat.size, mtime: stat.mtimeMs, ...parsed })
      }
      if (logs.length === 0) continue
      const ordered = byNewestGeneration(logs)
      const preferred = ordered[0]
      let header = null
      try {
        const buf = fs.readFileSync(preferred.file)
        const { frames } = scanFrames(buf, 1)
        if (frames.length > 0) {
          const first = zlib.zstdDecompressSync(buf.subarray(frames[0].start, frames[0].end)).toString('utf8')
          const line = first.split('\n').find(l => l.trim())
          if (line) header = JSON.parse(line)
        }
      } catch {
        // Header unreadable: still list the session, just without its metadata.
      }
      sessions.push({
        id,
        project,
        file: preferred.file,
        log: preferred.name,
        logs: ordered,
        bytes: preferred.bytes,
        mtime: Math.max(...logs.map(l => l.mtime)),
        cwd: header?.cwd,
        createdAt: header?.createdAt,
        agentPreset: header?.agentPreset,
        delegationDepth: header?.delegationDepth,
      })
    }
  }
  return sessions.sort((a, b) => b.mtime - a.mtime)
}

/**
 * Resolve a session by full id, by id prefix, or by a bare UUID fragment.
 * Session ids carry a `session-` prefix, so `f30b9b43` must find
 * `session-f30b9b43-...`; an ambiguous fragment resolves to nothing rather than
 * to a guess.
 */
function resolveSession(fragment) {
  const all = listSessions()
  if (all.length === 0) return undefined
  const wanted = arg('log')
  const pick = session => {
    if (wanted) {
      const log = session.logs.find(l => l.name === wanted)
      if (log) return { ...session, file: log.file, log: log.name, bytes: log.bytes }
      // An explicit `--log` for a session that lacks it is an error, not a
      // silent fallback: reading the wrong log would be worse than failing.
      console.error(`session ${session.id} has no ${wanted}; available: ${session.logs.map(l => l.name).join(', ')}`)
      process.exit(1)
    }
    return session
  }
  if (!fragment) return pick(all[0])
  const exact = all.find(s => s.id === fragment)
  if (exact) return pick(exact)
  for (const match of [
    s => s.id.startsWith(fragment),
    s => s.id.includes(fragment),
  ]) {
    const candidates = all.filter(match)
    if (candidates.length === 1) return pick(candidates[0])
  }
  return undefined
}

/** Plain text of a message's content blocks. */
function textOf(data) {
  const content = data?.content ?? data?.text ?? data?.summary ?? ''
  return (Array.isArray(content) ? content : [content])
    .map(block => (typeof block === 'string' ? block : (block?.text ?? '')))
    .join('\n')
}

/** Whether a terse operator message is shaped like a redirection, not a task. */
function looksLikeSteer(text, maxChars) {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (flat.length === 0 || flat.length > maxChars) return false
  if (STEER_OPENERS.some(pattern => pattern.test(flat))) return true
  return STEER_PHRASES.some(pattern => pattern.test(flat))
}

/**
 * Walk the log once and annotate every `user/message` with how it arrived and
 * what it does. `delivery` is the harness's timing record; `role` is the
 * instruction-versus-steering judgment described in the module docstring.
 */
function classifyPrompts(events, steerMaxChars) {
  let turn = null
  const spliceByMessageId = new Map()
  const prompts = []
  for (let index = 0; index < events.length; index++) {
    const event = events[index]
    if (event.type === 'turn/start') {
      turn = event.data?.turn ?? null
      continue
    }
    if (event.type === 'turn/end') {
      turn = null
      continue
    }
    if (event.type === 'agent/inbox/spliced') {
      for (const message of event.data?.inserted ?? []) {
        if (message?.id) spliceByMessageId.set(message.id, { target: event.data.target, at: index })
      }
      continue
    }
    if (event.type !== 'user/message') continue
    const data = event.data ?? {}
    const kind = data.source?.kind ?? '(none)'
    const splice = data.id ? spliceByMessageId.get(data.id) : undefined
    const text = textOf(data)
    let role
    if (INJECTED_KINDS.has(kind)) role = 'injected'
    else if (kind !== 'user') role = 'injected'
    else if (splice?.target === 'next-step') role = 'steering'
    else if (steerMaxChars > 0 && looksLikeSteer(text, steerMaxChars)) role = 'steering'
    else role = 'instructional'
    prompts.push({
      index,
      seq: event.seq,
      time: event.time,
      turn,
      kind,
      role,
      delivery: splice?.target ?? (turn === null ? 'between-turns' : 'in-turn'),
      text,
    })
  }
  return prompts
}

/**
 * Locate every compaction boundary and the operator prompt that preceded it.
 *
 * A reader resuming after a compaction needs the message the operator last sent
 * *before* the summary replaced the transcript — the newer turns after the
 * boundary are already visible. `compaction/start` marks the boundary; the
 * prompt is the nearest preceding `user/message` whose source is the operator,
 * since machine-injected context (a `plugin` checkpoint, `agent-instructions`)
 * is not a prompt.
 *
 * Turns without a preceding operator prompt keep `prompt: undefined` rather
 * than borrowing an older one: the boundary is still real, and attributing the
 * wrong message to it would be worse than reporting none.
 */
function compactionBoundaries(events, prompts) {
  const operatorPrompts = prompts.filter(p => p.kind === 'user')
  const boundaries = []
  for (let index = 0; index < events.length; index++) {
    if (events[index].type !== 'compaction/start') continue
    const data = events[index].data ?? {}
    let endIndex
    for (let near = index + 1; near < events.length; near++) {
      if (events[near].type === 'compaction/end') { endIndex = near; break }
    }
    let prompt
    for (let near = operatorPrompts.length - 1; near >= 0; near--) {
      if (operatorPrompts[near].index >= index) continue
      prompt = operatorPrompts[near]
      break
    }
    boundaries.push({
      index,
      endIndex,
      compactionId: data.compactionId,
      turn: data.turn,
      prompt,
    })
  }
  return boundaries
}

function clip(text, width) {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= width ? flat : flat.slice(0, width) + '…'
}

/**
 * Truncate a multi-line block WITHOUT flattening it, and always say what was
 * cut and how to get it.
 *
 * `clip` collapses every run of whitespace to one space, which is right for a
 * one-line listing and catastrophic for a checkpoint summary: a 10 KB summary
 * with headings and bullets came back as an unreadable single line, so a
 * resuming reader had to re-read the log to recover structure that was already
 * there. Block text keeps its newlines.
 *
 * `width <= 0` means "no limit": the caller is explicitly asking for the whole
 * thing, so the answer is the whole thing. Every other width names the exact
 * number of characters withheld and the flag that removes the cap, because a
 * silently truncated brief is the failure this reader exists to prevent.
 * @param text - the multi-line block to bound.
 * @param width - maximum characters, or <= 0 for unbounded.
 * @returns the block, with a trailing note when it was cut.
 */
function clipBlock(text, width) {
  const body = text.replace(/\s+$/u, '')
  if (width <= 0 || body.length <= width) return body
  return `${body.slice(0, width)}\n… (${body.length - width} more character(s) withheld; pass --width 0 for all of it)`
}

/**
 * Push a block's markdown headings one level down, so an embedded document's
 * structure reads as nested rather than as siblings of the printer's own.
 *
 * A checkpoint summary is written as its own markdown document with `##`
 * sections. Printed verbatim under this tool's `## Latest checkpoint summary`,
 * its headings are indistinguishable from the printer's — a reader scanning for
 * "where does the brief end" finds four plausible answers. Demoting makes the
 * containment visible without altering the text.
 *
 * "Without altering the text" is why this walks lines instead of running one
 * regex over the block. A summary routinely quotes a fenced code block, and a
 * heading-looking line inside one is code, not structure: a naive
 * `^#{1,5}\s` replacement rewrote ```# comment``` into ```## comment```, silently
 * changing the code the summary was preserving. Fenced regions are therefore
 * passed through untouched, tracked with the CommonMark rule that a closing
 * fence is the same character as the opener and at least as long.
 *
 * A heading may be indented up to three spaces (four is a code block), and that
 * indentation is preserved; `######` is left alone because markdown has no
 * seventh level to demote it into.
 * @param text - the embedded markdown block.
 * @returns the block with every ATX heading outside a fence demoted one level.
 */
function demoteHeadings(text) {
  const lines = []
  let fence = null
  for (const line of text.split('\n')) {
    const marker = /^ {0,3}(`{3,}|~{3,})/u.exec(line)
    if (marker !== null) {
      const run = marker[1]
      if (fence === null) fence = { char: run[0], length: run.length }
      else if (run[0] === fence.char && run.length >= fence.length) fence = null
      lines.push(line)
      continue
    }
    if (fence !== null) {
      lines.push(line)
      continue
    }
    lines.push(line.replace(/^( {0,3})(#{1,5})(\s)/u, '$1#$2$3'))
  }
  return lines.join('\n')
}

/**
 * The current goal, folded from every `goal/change` event in order.
 *
 * A goal is the one piece of state that tells a resuming reader what the work
 * is FOR, and it is not derivable from the prompts alone: an operator can
 * steer a dozen times without restating the objective. The last mutation wins,
 * so folding in order reproduces the live view.
 * @param events - the parsed session events.
 * @returns the folded goal view, or undefined when the session never had one.
 */
function foldGoal(events) {
  let view
  for (const event of events) {
    if (event.type !== 'goal/change') continue
    const data = event.data ?? {}
    // A change carries the whole new goal view (or `null` when cleared), so the
    // last one wins; there is no partial update to merge.
    view = data.goal === null || data.goal === undefined ? undefined : data.goal
  }
  return view
}

/**
 * The most recent compaction summary — the checkpoint whose text is the only
 * surviving record of everything the cut removed.
 *
 * This is the payload a resuming reader most needs and the one hardest to
 * recover by hand: it sits on a `compaction/summary` event, and reading it
 * through `show` means first finding the event index (a `grep`), then passing
 * a width wide enough not to truncate it. Every one of those steps is a place
 * to lose the thread, so `resume` performs all of them.
 * @param events - the parsed session events.
 * @returns the newest summary with its index, or undefined when none exists.
 */
function lastSummary(events) {
  for (let index = events.length - 1; index >= 0; index--) {
    if (events[index].type !== 'compaction/summary') continue
    return { index, text: textOf(events[index].data) }
  }
  return undefined
}

function arg(name, fallback) {
  const at = process.argv.indexOf('--' + name)
  return at >= 0 && process.argv[at + 1] !== undefined ? process.argv[at + 1] : fallback
}

function flag(name) {
  return process.argv.includes('--' + name)
}

function timestamp(ms) {
  return typeof ms === 'number' ? new Date(ms).toISOString().replace('T', ' ').slice(0, 19) : '?'
}

const OUT_BUDGET = Number(arg('chars', 16000))
let emitted = 0
function emit(line) {
  if (emitted > OUT_BUDGET) return false
  emitted += line.length + 1
  console.log(line)
  return true
}

/** `--kind` filters either the instruction/steering judgment or a source kind. */
function matchesKind(prompt, kind) {
  if (kind === 'all' || kind === 'any') return true
  if (kind === 'instructional') return prompt.role === 'instructional'
  if (kind === 'steering' || kind === 'injected') return prompt.role === kind
  return prompt.kind === kind
}

/**
 * Name the log a reading came from, and flag the case that caused a silent
 * stale read.
 *
 * Every mode prints this. The reader that hid the filename let a transcript cut
 * short at turn 11 answer a question about turn 23 with no visible signal that
 * another log existed; naming the source makes the same mistake impossible to
 * miss. Any lower generation sitting alongside is a compaction of the same
 * conversation, so reading it is nearly always the wrong choice and says so.
 * @param session - the resolved session, carrying its log and the others.
 * @returns a one-line provenance note.
 */
function logNote(session) {
  const note = `log=${session.log}`
  const current = parseLogName(session.log)
  const older = (session.logs ?? [])
    .filter(l => l.name !== session.log)
    .filter(l => current === undefined || l.version < current.version || l.compression !== current.compression)
  if (older.length === 0) return note
  return `${note} (NOTE: ${older.map(l => l.name).join(', ')} also present — an older or uncompressed copy, often shorter; pass --log NAME to read one deliberately)`
}

const [command] = process.argv.slice(2)
const STEER_MAX_CHARS = Number(arg('steer-max-chars', DEFAULT_STEER_MAX_CHARS))

if (command === 'list') {
  const cwdFilter = arg('cwd')
  const limit = Number(arg('limit', 25))
  let sessions = listSessions()
  if (cwdFilter) {
    sessions = sessions.filter(s => s.cwd && path.resolve(s.cwd) === path.resolve(cwdFilter))
  }
  if (flag('json')) {
    console.log(JSON.stringify(sessions.slice(0, limit), null, 2))
  } else {
    console.log(`${sessions.length} session(s)${cwdFilter ? ` for ${cwdFilter}` : ''} — newest first, showing ${Math.min(limit, sessions.length)}`)
    for (const session of sessions.slice(0, limit)) {
      const logs = session.logs.map(l => `${l.name}@${(l.bytes / 1024).toFixed(0)}KB`).join(' + ')
      emit(`${session.id}  ${timestamp(session.mtime)}  ${(session.bytes / 1024).toFixed(0)}KB  ${session.agentPreset ?? '?'}  cwd=${session.cwd ?? '?'}  logs=[${logs}]`)
    }
  }
} else if (command === 'resume') {
  // One call that answers "what was I doing", the question every other mode
  // answers only in pieces. Recovering this by hand after a compaction took a
  // dozen calls — `types` to size the log, `prompts` to find the brief,
  // `latest-prompt`, `grep` to locate the checkpoint, then `show` twice with a
  // guessed width, because the default clipped the summary and flattened it to
  // one line. Each step was a place to lose the thread, and the summary the
  // whole exercise exists to recover was the hardest part to reach.
  const session = resolveSession(arg('session'))
  if (!session) { console.error('no such session'); process.exit(1) }
  const events = parseEvents(decodeAll(session.file))
  const prompts = classifyPrompts(events, STEER_MAX_CHARS)
  const width = Number(arg('width', 0))

  console.log(`session ${session.id} — resume brief — ${logNote(session)}`)
  console.log(`cwd=${session.cwd ?? '?'} preset=${session.agentPreset ?? '?'} events=${events.length}`)

  // 1. The goal: what the work is FOR. Not derivable from prompts alone.
  const goal = foldGoal(events)
  console.log('\n## Goal')
  if (goal === undefined) {
    console.log('(none — this session never set a goal)')
  } else {
    console.log(`id=${goal.id} revision=${goal.revision} phase=${goal.phase} activation=${goal.activation}`)
    if (goal.roundsStarted !== undefined) console.log(`rounds=${goal.roundsStarted}/${goal.maxGoalRounds ?? '?'}`)
    console.log(`objective: ${goal.objective}`)
    if (goal.blockedReason) console.log(`blocked: ${goal.blockedReason}`)
  }

  // 2. The instructional brief — the task the work was commissioned with.
  const instructional = prompts.filter(p => p.role === 'instructional')
  console.log('\n## Instructional prompt')
  if (instructional.length === 0) {
    console.log('(none found)')
  } else {
    const prompt = instructional[instructional.length - 1]
    console.log(`turn=${prompt.turn ?? '-'} time=${timestamp(prompt.time)} event=#${prompt.index}`)
    console.log('---')
    console.log(demoteHeadings(clipBlock(prompt.text, width)))
  }

  // 3. The checkpoint summary: the only surviving record of what the cut
  //    removed, and the piece that was hardest to read whole.
  const summary = lastSummary(events)
  console.log('\n## Latest checkpoint summary')
  if (summary === undefined) {
    console.log('(no compaction in this session)')
  } else {
    console.log(`event=#${summary.index} (${summary.text.length} chars)`)
    console.log('---')
    console.log(demoteHeadings(clipBlock(summary.text, width)))
  }

  // 4. What the operator said AFTER the cut — already in context when visible,
  //    but naming it separates "already done" from "still open".
  const cuts = compactionBoundaries(events, prompts)
  const lastCut = cuts[cuts.length - 1]
  console.log('\n## Operator prompts after the last checkpoint')
  if (lastCut === undefined) {
    console.log('(no compaction in this session)')
  } else {
    const after = prompts.filter(p => p.kind === 'user' && p.index > lastCut.index)
    if (after.length === 0) {
      console.log('(none — the transcript resumes with the summary above)')
    }
    for (const prompt of after.slice(-10)) {
      console.log(`[${prompt.role}] turn=${prompt.turn ?? '-'} ${timestamp(prompt.time)} #${prompt.index} :: ${clip(prompt.text, 300)}`)
    }
  }

  // 5. Tail of the log so the reader can see how it stopped.
  console.log('\n## Last events')
  for (const event of events.slice(-Number(arg('tail', 10)))) {
    const body = clip(textOf(event.data) || JSON.stringify(event.data ?? {}), 300)
    console.log(`${timestamp(event.time)} [${event.type}] ${body}`)
  }
} else if (command === 'prompts') {
  const session = resolveSession(arg('session'))
  if (!session) { console.error('no such session'); process.exit(1) }
  const kind = arg('kind', 'all')
  const limit = Number(arg('limit', 60))
  const events = parseEvents(decodeAll(session.file))
  const prompts = classifyPrompts(events, STEER_MAX_CHARS)
  const rows = prompts.filter(p => matchesKind(p, kind))
  console.log(`session ${session.id} — ${rows.length} prompt(s) matching ${kind}, showing last ${Math.min(limit, rows.length)} — ${logNote(session)}`)
  // A compaction is where a resuming reader loses the thread. Flag the exact
  // prompt each one interrupted: everything after that point in the log is
  // summary, so this is the message whose work may still be unfinished.
  const interrupted = new Set(
    compactionBoundaries(events, prompts)
      .map(boundary => boundary.prompt?.index)
      .filter(index => index !== undefined),
  )
  for (const prompt of rows.slice(-limit)) {
    emit(`[${prompt.role}] ${prompt.delivery} turn=${prompt.turn ?? '-'} ${timestamp(prompt.time)} src=${prompt.kind} #${prompt.index} :: ${clip(prompt.text, 150)}`)
    if (interrupted.has(prompt.index)) emit('    ^^ interrupted by the next compaction — work from here may be unfinished')
  }
} else if (command === 'latest-prompt') {
  const session = resolveSession(arg('session'))
  if (!session) { console.error('no such session'); process.exit(1) }
  const wanted = arg('kind', 'instructional')
  const events = parseEvents(decodeAll(session.file))
  const prompts = classifyPrompts(events, STEER_MAX_CHARS)
  const candidates = prompts.filter(p => matchesKind(p, wanted))
  if (candidates.length === 0) { console.log(`no ${wanted} prompt found`); process.exit(0) }
  // No anchoring: the most recent matching prompt is the answer. Earlier
  // prompts are listed in order by `prompts`, and a reader deciding what is
  // still open needs all of them, not one designated task statement.
  const prompt = candidates[candidates.length - 1]
  console.log(`session ${session.id} — latest ${wanted} prompt — ${logNote(session)}`)
  console.log(`role=${prompt.role} delivery=${prompt.delivery} turn=${prompt.turn ?? '-'} time=${timestamp(prompt.time)} src=${prompt.kind} event=#${prompt.index}`)
  // Say explicitly whether this answer came from before or after the last
  // compaction. A prompt from before it is the one a resuming reader wants;
  // one from after it is already in context and says nothing about what was
  // open when the transcript was cut.
  const cuts = compactionBoundaries(events, prompts)
  const last = cuts[cuts.length - 1]
  if (last !== undefined) {
    console.log(
      prompt.index < last.index
        ? `pre-compaction: sent before the compaction at #${last.index}, so this is the brief the cut interrupted`
        : `post-compaction: sent after the compaction at #${last.index}, so it is already in the visible transcript`,
    )
  } else {
    console.log('no compaction in this session')
  }
  console.log('---')
  console.log(prompt.text)
} else if (command === 'types') {
  const session = resolveSession(arg('session'))
  if (!session) { console.error('no such session'); process.exit(1) }
  const events = parseEvents(decodeAll(session.file))
  const histogram = new Map()
  for (const event of events) histogram.set(event.type, (histogram.get(event.type) ?? 0) + 1)
  console.log(`session ${session.id} — ${events.length} events — ${logNote(session)}`)
  for (const [type, count] of [...histogram].sort((a, b) => b[1] - a[1])) {
    emit(`${String(count).padStart(7)}  ${type}`)
  }
} else if (command === 'grep') {
  const pattern = process.argv[3]
  if (!pattern) { console.error('usage: grep <regex> [--session ID]'); process.exit(1) }
  let regex
  try { regex = new RegExp(pattern, 'i') } catch (error) { console.error('bad regex: ' + error.message); process.exit(1) }
  const limit = Number(arg('limit', 20))
  const before = Number(arg('before', 0))
  const after = Number(arg('after', 0))
  const targets = arg('session')
    ? [resolveSession(arg('session'))].filter(Boolean)
    : listSessions()
  if (targets.length === 0) { console.error('no sessions'); process.exit(1) }
  let hits = 0
  for (const session of targets) {
    if (hits >= limit) break
    const events = parseEvents(decodeAll(session.file))
    for (let index = 0; index < events.length && hits < limit; index++) {
      const text = JSON.stringify(events[index].data ?? {})
      if (!regex.test(text)) continue
      hits++
      emit(`--- ${session.id} #${index} [${events[index].type}] (${session.log})`)
      for (let near = Math.max(0, index - before); near <= Math.min(events.length - 1, index + after); near++) {
        emit(`  ${near === index ? '>' : ' '} #${near} [${events[near].type}] ${clip(JSON.stringify(events[near].data ?? {}), 400)}`)
      }
    }
  }
  console.log(`(${hits} match(es))`)
} else if (command === 'tail') {
  const limit = Number(arg('limit', 25))
  const session = resolveSession(arg('session'))
  if (!session) { console.error('no such session'); process.exit(1) }
  const events = parseEvents(decodeAll(session.file))
  console.log(`session ${session.id} — ${events.length} events, last ${Math.min(limit, events.length)} — ${logNote(session)}`)
  for (const event of events.slice(-limit)) {
    const body = clip(textOf(event.data) || JSON.stringify(event.data ?? {}), 500)
    emit(`${timestamp(event.time)} [${event.type}] ${body}`)
  }
} else if (command === 'show') {
  const session = resolveSession(arg('session'))
  if (!session) { console.error('no such session'); process.exit(1) }
  const from = Number(arg('from', 0))
  const to = Number(arg('to', 25))
  // Operator prompts routinely exceed the 800-char default; `--width` widens the
  // per-event clip so a prompt can be read whole instead of truncated. `--width 0`
  // removes the cap entirely, which is what a multi-line summary needs.
  const width = Number(arg('width', 800))
  const events = parseEvents(decodeAll(session.file))
  console.log(`session ${session.id} — events ${from}..${Math.min(to, events.length - 1)} of ${events.length} — ${logNote(session)}`)
  for (let index = from; index <= to && index < events.length; index++) {
    // Block-preserving clip: a summary or prompt keeps its line structure, so a
    // reader can actually read the thing they asked for.
    const body = clipBlock(textOf(events[index].data) || JSON.stringify(events[index].data ?? {}), width)
    emit(`#${index} ${timestamp(events[index].time)} [${events[index].type}] ${body}`)
  }
} else {
  console.log(`usage:
  resume [--session ID] [--width N] [--tail N]
  list [--cwd DIR] [--limit N] [--json]
  prompts [--session ID] [--kind instructional|steering|injected|user|goal|plugin|all] [--limit N]
  latest-prompt [--session ID] [--kind instructional|steering|user|any]
  types [--session ID]
  grep <regex> [--session ID] [--limit N] [--before N] [--after N]
  tail [--session ID] [--limit N]
  show [--session ID] [--from N] [--to N] [--width N]

options:
  --width N             per-block character cap; 0 (the default for resume)
                        prints blocks whole. A cut is always reported with the
                        flag that removes it.
  --log NAME            which log to read when a session directory holds more
                        than one: session.v3.jsonl.zstd (current) or
                        session.jsonl.zstd (legacy, often a shorter compaction
                        of the same conversation). Defaults to the NEWEST
                        format present, so the freshest transcript is what you
                        get without asking. Naming a log a session lacks is an
                        error rather than a silent fallback.
  --steer-max-chars N   longest message the shape test may call a steer (default ${DEFAULT_STEER_MAX_CHARS}; 0 disables it)`)
  process.exit(command ? 1 : 0)
}
