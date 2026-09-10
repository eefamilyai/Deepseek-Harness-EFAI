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
 * Usage:
 *   node session-read.mjs list [--cwd DIR] [--limit N] [--json]
 *   node session-read.mjs prompts [--session ID] [--kind KIND] [--limit N]
 *   node session-read.mjs latest-prompt [--session ID] [--kind instructional|steering|user|any]
 *   node session-read.mjs types [--session ID]
 *   node session-read.mjs grep <regex> [--session ID] [--limit N] [--before N] [--after N]
 *   node session-read.mjs tail [--session ID] [--limit N]
 *   node session-read.mjs show [--session ID] [--from N] [--to N]
 *
 * Every mode bounds its own output; nothing prints an unbounded transcript.
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
const LOG_NAME = 'session.jsonl.zstd'
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
      const file = path.join(projectDir, id, LOG_NAME)
      let stat
      try { stat = fs.statSync(file) } catch { continue }
      if (!stat.isFile()) continue
      let header = null
      try {
        const buf = fs.readFileSync(file)
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
        file,
        bytes: stat.size,
        mtime: stat.mtimeMs,
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
  if (!fragment) return all[0]
  const exact = all.find(s => s.id === fragment)
  if (exact) return exact
  for (const match of [
    s => s.id.startsWith(fragment),
    s => s.id.includes(fragment),
  ]) {
    const candidates = all.filter(match)
    if (candidates.length === 1) return candidates[0]
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

/**
 * Find the prompt at which the goal was set.
 *
 * A goal is created by the agent mid-turn, so the prompt that *set* it is the
 * operator message that opened the turn containing the most recent `goal/change`
 * with operation `create`. That message is the task statement a fresh reader
 * should adopt; later turn-opening messages are corrections to it, and
 * `next-step` splices are steering.
 *
 * Returns the prompt record plus the anchor's provenance, or `undefined` when
 * the session never created a goal.
 */
function goalAnchor(events, prompts) {
  let changeIndex
  let objective
  for (let index = events.length - 1; index >= 0; index--) {
    const data = events[index]?.data
    if (events[index]?.type !== 'goal/change') continue
    if (data?.operation !== 'create') continue
    changeIndex = index
    objective = data.goal?.objective
    break
  }
  if (changeIndex === undefined) return undefined
  // Walk back to the turn that contains the goal creation.
  let turnStartIndex
  for (let index = changeIndex; index >= 0; index--) {
    if (events[index]?.type === 'turn/start') { turnStartIndex = index; break }
  }
  if (turnStartIndex === undefined) return undefined
  // The turn's opening prompt: the first operator message at or after it.
  for (const prompt of prompts) {
    if (prompt.index < turnStartIndex) continue
    if (prompt.kind !== 'user') continue
    return { prompt, objective, changeIndex }
  }
  return undefined
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
  const anchor = goalAnchor(events, prompts)
  if (anchor) {
    anchor.prompt.role = 'goal'
    anchor.prompt.goalObjective = anchor.objective
  }
  return prompts
}

function clip(text, width) {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= width ? flat : flat.slice(0, width) + '…'
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
  if (kind === 'instructional') return prompt.role === 'instructional' || prompt.role === 'goal'
  if (kind === 'steering' || kind === 'injected' || kind === 'goal') return prompt.role === kind
  return prompt.kind === kind
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
      emit(`${session.id}  ${timestamp(session.mtime)}  ${(session.bytes / 1024).toFixed(0)}KB  ${session.agentPreset ?? '?'}  cwd=${session.cwd ?? '?'}`)
    }
  }
} else if (command === 'prompts') {
  const session = resolveSession(arg('session'))
  if (!session) { console.error('no such session'); process.exit(1) }
  const kind = arg('kind', 'all')
  const limit = Number(arg('limit', 60))
  const prompts = classifyPrompts(parseEvents(decodeAll(session.file)), STEER_MAX_CHARS)
  const rows = prompts.filter(p => matchesKind(p, kind))
  console.log(`session ${session.id} — ${rows.length} prompt(s) matching ${kind}, showing last ${Math.min(limit, rows.length)}`)
  for (const prompt of rows.slice(-limit)) {
    emit(`[${prompt.role}] ${prompt.delivery} turn=${prompt.turn ?? '-'} ${timestamp(prompt.time)} src=${prompt.kind} #${prompt.index} :: ${clip(prompt.text, 150)}`)
  }
} else if (command === 'latest-prompt') {
  const session = resolveSession(arg('session'))
  if (!session) { console.error('no such session'); process.exit(1) }
  const wanted = arg('kind', 'instructional')
  const prompts = classifyPrompts(parseEvents(decodeAll(session.file)), STEER_MAX_CHARS)
  const candidates = prompts.filter(p => matchesKind(p, wanted))
  if (candidates.length === 0) { console.log(`no ${wanted} prompt found`); process.exit(0) }
  // The instructional prompt is the one the goal was set at: that is the task
  // statement, and everything after it is a correction to it. Fall back to the
  // most recent turn-opening operator prompt only when no goal was ever set.
  const anchored = wanted === 'instructional' ? candidates.find(p => p.role === 'goal') : undefined
  const prompt = anchored ?? candidates[candidates.length - 1]
  console.log(`session ${session.id} — ${anchored ? 'instructional prompt (the prompt the goal was set at)' : `latest ${wanted} prompt`}`)
  console.log(`role=${prompt.role} delivery=${prompt.delivery} turn=${prompt.turn ?? '-'} time=${timestamp(prompt.time)} src=${prompt.kind} event=#${prompt.index}`)
  if (prompt.goalObjective) console.log(`goal objective: ${clip(prompt.goalObjective, 300)}`)
  console.log('---')
  console.log(prompt.text)
} else if (command === 'types') {
  const session = resolveSession(arg('session'))
  if (!session) { console.error('no such session'); process.exit(1) }
  const events = parseEvents(decodeAll(session.file))
  const histogram = new Map()
  for (const event of events) histogram.set(event.type, (histogram.get(event.type) ?? 0) + 1)
  console.log(`session ${session.id} — ${events.length} events`)
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
      emit(`--- ${session.id} #${index} [${events[index].type}]`)
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
  console.log(`session ${session.id} — ${events.length} events, last ${Math.min(limit, events.length)}`)
  for (const event of events.slice(-limit)) {
    const body = clip(textOf(event.data) || JSON.stringify(event.data ?? {}), 500)
    emit(`${timestamp(event.time)} [${event.type}] ${body}`)
  }
} else if (command === 'show') {
  const session = resolveSession(arg('session'))
  if (!session) { console.error('no such session'); process.exit(1) }
  const from = Number(arg('from', 0))
  const to = Number(arg('to', 25))
  const events = parseEvents(decodeAll(session.file))
  console.log(`session ${session.id} — events ${from}..${Math.min(to, events.length - 1)} of ${events.length}`)
  for (let index = from; index <= to && index < events.length; index++) {
    const body = clip(textOf(events[index].data) || JSON.stringify(events[index].data ?? {}), 800)
    emit(`#${index} ${timestamp(events[index].time)} [${events[index].type}] ${body}`)
  }
} else {
  console.log(`usage:
  list [--cwd DIR] [--limit N] [--json]
  prompts [--session ID] [--kind instructional|steering|injected|user|goal|plugin|all] [--limit N]
  latest-prompt [--session ID] [--kind instructional|steering|user|any]
  types [--session ID]
  grep <regex> [--session ID] [--limit N] [--before N] [--after N]
  tail [--session ID] [--limit N]
  show [--session ID] [--from N] [--to N]

options:
  --steer-max-chars N   longest message the shape test may call a steer (default ${DEFAULT_STEER_MAX_CHARS}; 0 disables it)`)
  process.exit(command ? 1 : 0)
}
