/**
 * The corpus of model outputs.
 *
 * Every turn's raw stream and assembled text are kept, so the parser can be
 * improved from what the model actually produced rather than from what a schema
 * says it should produce. Two things read it: the leak report (what the reader
 * missed) and the pattern miner (what delimiters those misses share).
 *
 * Raw streams are large, so they are gzipped to `data/raw/<day>/<turn>.json.gz`
 * and pruned by age; the database keeps only metadata.
 *
 * @module dswg/store/corpus
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { gunzipSync, gzipSync } from 'node:zlib'
import type { Db } from './db.ts'
import { uuid } from '../util/ids.ts'

/** Metadata for one captured turn. */
export interface CapturedTurn {
  turnId: string
  ts: number
  accountId: string | null
  model: string | null
  tools: string[]
  streamChars: number
  textChars: number
  leaked: boolean
  salvaged: boolean
  path: string | null
  sha256: string | null
}

/** One recorded leak. */
export interface LeakRecord {
  id: string
  ts: number
  turnId: string | null
  accountId: string | null
  kind: string
  evidence: string
  text: string
}

/** Stores and retrieves model outputs. */
export class Corpus {
  #db: Db
  #dir: string
  #retainDays: number
  #maxBytes: number

  /**
   * @param db - the database.
   * @param home - data directory; raw streams live under `<home>/raw`.
   * @param retainDays - age at which a raw stream is deleted.
   * @param maxBytes - a stream longer than this is truncated before storage.
   */
  constructor(db: Db, home: string, retainDays = 30, maxBytes = 4 * 1024 * 1024) {
    this.#db = db
    this.#dir = join(home, 'raw')
    this.#retainDays = retainDays
    this.#maxBytes = maxBytes
    mkdirSync(this.#dir, { recursive: true })
  }

  /**
   * Store one turn's output.
   * @param input - the turn data.
   */
  recordTurn(input: {
    turnId: string
    accountId: string | null
    model: string | null
    tools: string[]
    rawStream: string
    prompt: string
    text: string
    thinking: string
    leaked: boolean
    salvaged: boolean
  }): void {
    const day = new Date().toISOString().slice(0, 10)
    const folder = join(this.#dir, day)
    mkdirSync(folder, { recursive: true })
    const raw = input.rawStream.length > this.#maxBytes ? input.rawStream.slice(0, this.#maxBytes) : input.rawStream
    const payload = JSON.stringify({ raw, prompt: input.prompt, text: input.text, thinking: input.thinking })
    const file = join(folder, `${input.turnId}.json.gz`)
    try {
      writeFileSync(file, gzipSync(Buffer.from(payload, 'utf8')))
    } catch {
      // The metadata row below is still useful; a full disk must not fail a turn.
    }
    const sha = createHash('sha256').update(payload).digest('hex')
    try {
      this.#db.sql
        .prepare(
          `INSERT INTO raw_turns (turn_id, ts, account_id, model, tools, stream_chars, text_chars, leaked, salvaged, path, sha256)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(turn_id) DO UPDATE SET text_chars = excluded.text_chars, leaked = excluded.leaked, salvaged = excluded.salvaged`,
        )
        .run(
          input.turnId,
          Date.now(),
          input.accountId,
          input.model,
          JSON.stringify(input.tools),
          raw.length,
          input.text.length,
          input.leaked ? 1 : 0,
          input.salvaged ? 1 : 0,
          file,
          sha,
        )
    } catch {
      // Recording is best effort; the turn already succeeded.
    }
  }

  /**
   * Read one captured turn.
   * @param turnId - the turn id.
   * @returns the stored payload, or null.
   */
  read(turnId: string): { raw: string; prompt: string; text: string; thinking: string } | null {
    const row = this.#db.sql.prepare('SELECT path FROM raw_turns WHERE turn_id = ?').get(turnId) as { path: string | null } | undefined
    if (!row?.path || !existsSync(row.path)) return null
    try {
      const parsed: unknown = JSON.parse(gunzipSync(readFileSync(row.path)).toString('utf8'))
      if (parsed === null || typeof parsed !== 'object') return null
      const record = parsed as { raw?: unknown; prompt?: unknown; text?: unknown; thinking?: unknown }
      return {
        raw: typeof record.raw === 'string' ? record.raw : '',
        prompt: typeof record.prompt === 'string' ? record.prompt : '',
        text: typeof record.text === 'string' ? record.text : '',
        thinking: typeof record.thinking === 'string' ? record.thinking : '',
      }
    } catch {
      return null
    }
  }

  /**
   * Recent captured turns.
   * @param limit - maximum rows.
   * @returns the metadata.
   */
  recent(limit = 100): CapturedTurn[] {
    const rows = this.#db.sql.prepare('SELECT * FROM raw_turns ORDER BY ts DESC LIMIT ?').all(limit) as unknown as Array<Record<string, unknown>>
    return rows.map((row) => ({
      turnId: String(row.turn_id),
      ts: Number(row.ts),
      accountId: row.account_id === null ? null : String(row.account_id),
      model: row.model === null ? null : String(row.model),
      tools: safeArray(String(row.tools)),
      streamChars: Number(row.stream_chars),
      textChars: Number(row.text_chars),
      leaked: Number(row.leaked) === 1,
      salvaged: Number(row.salvaged) === 1,
      path: row.path === null ? null : String(row.path),
      sha256: row.sha256 === null ? null : String(row.sha256),
    }))
  }

  /**
   * Record a reply that contained a call the reader did not recognise.
   * @param input - the leak.
   */
  recordLeak(input: { turnId: string | null; accountId: string | null; kind: string; evidence: string; text: string }): void {
    try {
      this.#db.sql
        .prepare('INSERT INTO leaks (id, ts, turn_id, account_id, kind, evidence, text) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(uuid(), Date.now(), input.turnId, input.accountId, input.kind, input.evidence, input.text.slice(0, 20_000))
    } catch {
      // A failed leak insert must not fail the turn.
    }
  }

  /**
   * Recent leaks.
   * @param limit - maximum rows.
   * @param since - epoch milliseconds floor.
   * @returns the leaks.
   */
  leaks(limit = 100, since: number | null = null): LeakRecord[] {
    const rows = (since === null
      ? this.#db.sql.prepare('SELECT * FROM leaks ORDER BY ts DESC LIMIT ?').all(limit)
      : this.#db.sql.prepare('SELECT * FROM leaks WHERE ts >= ? ORDER BY ts DESC LIMIT ?').all(since, limit)) as unknown as Array<Record<string, unknown>>
    return rows.map((row) => ({
      id: String(row.id),
      ts: Number(row.ts),
      turnId: row.turn_id === null ? null : String(row.turn_id),
      accountId: row.account_id === null ? null : String(row.account_id),
      kind: String(row.kind),
      evidence: String(row.evidence),
      text: String(row.text),
    }))
  }

  /**
   * Text of replies that were plain prose, for the miner's negative control.
   * @param limit - maximum samples.
   * @returns the texts.
   */
  proseSamples(limit = 200): string[] {
    const rows = this.#db.sql
      .prepare('SELECT turn_id FROM raw_turns WHERE leaked = 0 AND text_chars > 40 ORDER BY ts DESC LIMIT ?')
      .all(limit) as unknown as Array<{ turn_id: string }>
    const out: string[] = []
    for (const row of rows) {
      const payload = this.read(row.turn_id)
      if (payload && payload.text.trim().length > 0) out.push(payload.text)
    }
    return out
  }

  /**
   * Text of replies recorded as leaks, with the tools those turns declared.
   * @param limit - maximum samples.
   * @returns the samples.
   */
  leakSamples(limit = 200): Array<{ text: string; tools: string[] }> {
    return this.leaks(limit).map((leak) => {
      const row = leak.turnId
        ? (this.#db.sql.prepare('SELECT tools FROM raw_turns WHERE turn_id = ?').get(leak.turnId) as { tools: string } | undefined)
        : undefined
      return { text: leak.text, tools: row ? safeArray(row.tools) : [] }
    })
  }

  /**
   * Every tool name any captured turn declared, for mining across turns.
   * @param limit - maximum turns considered.
   * @returns the names.
   */
  knownToolNames(limit = 500): string[] {
    const rows = this.#db.sql.prepare('SELECT tools FROM raw_turns ORDER BY ts DESC LIMIT ?').all(limit) as unknown as Array<{ tools: string }>
    const names = new Set<string>()
    for (const row of rows) for (const name of safeArray(row.tools)) names.add(name)
    return [...names]
  }

  /** Delete raw streams older than the retention window. */
  prune(): void {
    const cutoff = Date.now() - this.#retainDays * 86_400_000
    const rows = this.#db.sql.prepare('SELECT turn_id, path FROM raw_turns WHERE ts < ?').all(cutoff) as unknown as Array<{ turn_id: string; path: string | null }>
    for (const row of rows) {
      if (row.path) {
        try {
          rmSync(row.path, { force: true })
        } catch {
          // Already gone.
        }
      }
    }
    try {
      this.#db.sql.prepare('DELETE FROM raw_turns WHERE ts < ?').run(cutoff)
      this.#db.sql.prepare('DELETE FROM leaks WHERE ts < ?').run(cutoff)
    } catch {
      // Nothing to prune.
    }
  }
}

/**
 * Parse a stored JSON array column.
 * @param text - the column.
 * @returns the strings.
 */
function safeArray(text: string): string[] {
  try {
    const value: unknown = JSON.parse(text)
    return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []
  } catch {
    return []
  }
}
