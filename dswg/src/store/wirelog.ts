/**
 * The forensic record.
 *
 * When an account is muted, the evidence that explains it is already gone: the
 * verdict arrives minutes to hours after the traffic that earned it, and by then
 * the interesting question is "what did we send, in what order, from which
 * identity". This module answers that by recording every upstream interaction and
 * every account-state change, with enough detail to correlate them later.
 *
 * Two sinks, deliberately:
 *
 * - **SQLite** for the dashboard (bounded rows, indexed by time and account).
 * - **Daily JSONL** for anything the process survives: a crash, a `rm`, a
 *   downgrade. It is append-only and never rewritten.
 *
 * Secrets are never written. A token or cookie is recorded as its length and a
 * short digest, which is exactly what a correlation needs (did the token change
 * between turn 41 and the mute?) without storing a credential.
 *
 * @module dswg/store/wirelog
 */

import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import type { Db } from './db.ts'
import { uuid } from '../util/ids.ts'

/** What kind of record this is. */
export type WireKind =
  | 'turn.start'
  | 'turn.http'
  | 'turn.end'
  | 'turn.verdict'
  | 'turn.retry'
  | 'turn.salvage'
  | 'turn.leak'
  | 'turn.wait'
  | 'account.state'
  | 'account.identity'
  | 'pool.pace'
  | 'pattern.learned'
  | 'error'

/** One recorded event. */
export interface WireEvent {
  kind: WireKind
  /** Account the event belongs to, when it has one. */
  accountId?: string | null
  /** Turn correlation id, when the event belongs to a turn. */
  turnId?: string | null
  /** Anything else worth keeping; must be JSON-serializable. */
  data?: Record<string, unknown>
  /** Epoch milliseconds; filled in when absent. */
  ts?: number
}

/** Query filters. */
export interface WireQuery {
  limit?: number
  accountId?: string | null
  turnId?: string | null
  kind?: WireKind | null
  since?: number | null
}

/** One row as returned to the dashboard. */
export interface WireRow {
  id: string
  ts: number
  kind: string
  accountId: string | null
  turnId: string | null
  data: Record<string, unknown>
}

/**
 * Replace a value with a length and a short digest.
 * @param value - the secret.
 * @returns a fingerprint that survives comparison but reveals nothing.
 */
export function fingerprint(value: string): string {
  if (!value) return 'empty'
  return `len=${value.length},sha=${createHash('sha256').update(value).digest('hex').slice(0, 8)}`
}

/**
 * Redact a header map: secrets become fingerprints, everything else is kept.
 * @param headers - request or response headers.
 * @returns the redacted map.
 */
export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase()
    if (lower === 'authorization') out[name] = `Bearer ${fingerprint(value.replace(/^bearer\s+/i, ''))}`
    else if (lower === 'cookie') out[name] = fingerprint(value)
    else if (lower === 'x-ds-pow-response') out[name] = fingerprint(value)
    else out[name] = value.length > 300 ? `${value.slice(0, 300)}…(${value.length})` : value
  }
  return out
}

/** Writes events to both sinks. */
export class WireLog {
  #db: Db
  #dir: string
  #keepDays: number
  #warned = false

  /**
   * @param db - the database.
   * @param home - data directory; JSONL files go under `<home>/logs`.
   * @param keepDays - rows older than this are pruned on start.
   */
  constructor(db: Db, home: string, keepDays = 30) {
    this.#db = db
    this.#dir = join(home, 'logs')
    this.#keepDays = keepDays
    mkdirSync(this.#dir, { recursive: true })
    this.prune()
  }

  /**
   * Record one event.
   * @param event - what happened.
   * @returns the row id.
   */
  record(event: WireEvent): string {
    const ts = event.ts ?? Date.now()
    const data = event.data ?? {}
    const id = uuid()
    try {
      this.#db.sql
        .prepare('INSERT INTO wire_log (id, ts, kind, account_id, turn_id, data) VALUES (?, ?, ?, ?, ?, ?)')
        .run(id, ts, event.kind, event.accountId ?? null, event.turnId ?? null, JSON.stringify(data))
    } catch {
      // The file sink below is the fallback; a failed insert must not fail a turn.
    }
    try {
      const day = new Date(ts).toISOString().slice(0, 10)
      appendFileSync(
        join(this.#dir, `wire-${day}.jsonl`),
        `${JSON.stringify({ ts, iso: new Date(ts).toISOString(), kind: event.kind, accountId: event.accountId ?? null, turnId: event.turnId ?? null, ...data })}\n`,
      )
    } catch (error) {
      if (!this.#warned) {
        this.#warned = true
        process.stderr.write(`wire log file sink failed: ${String(error)}\n`)
      }
    }
    return id
  }

  /**
   * Read recent events.
   * @param query - filters.
   * @returns the rows, newest first.
   */
  query(query: WireQuery = {}): WireRow[] {
    const clauses: string[] = []
    const values: Array<string | number> = []
    if (query.accountId) {
      clauses.push('account_id = ?')
      values.push(query.accountId)
    }
    if (query.turnId) {
      clauses.push('turn_id = ?')
      values.push(query.turnId)
    }
    if (query.kind) {
      clauses.push('kind = ?')
      values.push(query.kind)
    }
    if (query.since) {
      clauses.push('ts >= ?')
      values.push(query.since)
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
    const limit = Math.min(Math.max(query.limit ?? 200, 1), 2000)
    values.push(limit)
    const rows = this.#db.sql
      .prepare(`SELECT * FROM wire_log ${where} ORDER BY ts DESC LIMIT ?`)
      .all(...values) as unknown as Array<Record<string, unknown>>
    return rows.map((row) => ({
      id: String(row.id),
      ts: Number(row.ts),
      kind: String(row.kind),
      accountId: row.account_id === null ? null : String(row.account_id),
      turnId: row.turn_id === null ? null : String(row.turn_id),
      data: safeParse(String(row.data)),
    }))
  }

  /**
   * Count events per kind over a window.
   * @param since - epoch milliseconds.
   * @returns counts keyed by kind.
   */
  counts(since: number): Array<{ kind: string; count: number }> {
    const rows = this.#db.sql
      .prepare('SELECT kind, COUNT(*) AS count FROM wire_log WHERE ts >= ? GROUP BY kind ORDER BY count DESC')
      .all(since) as unknown as Array<{ kind: string; count: number }>
    return rows.map((row) => ({ kind: row.kind, count: Number(row.count) }))
  }

  /** Drop rows older than the retention window. */
  prune(): void {
    const cutoff = Date.now() - this.#keepDays * 86_400_000
    try {
      this.#db.sql.prepare('DELETE FROM wire_log WHERE ts < ?').run(cutoff)
    } catch {
      // A fresh database has nothing to prune.
    }
  }
}

/**
 * Parse JSON without throwing.
 * @param text - stored JSON.
 * @returns the value, or an object carrying the parse failure.
 */
function safeParse(text: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(text)
    return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : { value }
  } catch {
    return { raw: text.slice(0, 500) }
  }
}
