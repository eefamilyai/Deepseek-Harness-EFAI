/**
 * Request accounting.
 *
 * One row per API request, written when the request settles, so the dashboard
 * can show what the gateway did and which account carried it.
 *
 * @module dswg/store/usage
 */

import { uuid } from '../util/ids.ts'
import type { Db } from './db.ts'

/** One settled request. */
export interface UsageEntry {
  id: string
  ts: number
  keyId: string | null
  accountId: string | null
  endpoint: string
  model: string | null
  /** `ok`, `error`, or `cancelled`. */
  status: string
  httpStatus: number
  errorKind: string | null
  promptChars: number
  outputChars: number
  toolCalls: number
  latencyMs: number
  ttfbMs: number | null
  stream: boolean
}

/** Aggregated counts for one window. */
export interface UsageSummary {
  requests: number
  errors: number
  promptChars: number
  outputChars: number
  avgLatencyMs: number
  toolCalls: number
  byAccount: Array<{ accountId: string | null; requests: number; errors: number }>
  byDay: Array<{ day: string; requests: number; errors: number }>
}

/** Usage storage operations. */
export class UsageRepo {
  #db: Db

  /**
   * @param db - open database.
   */
  constructor(db: Db) {
    this.#db = db
  }

  /**
   * Record one request.
   * @param entry - the row, without its generated id.
   */
  record(entry: Omit<UsageEntry, 'id'>): void {
    this.#db.sql
      .prepare(
        `INSERT INTO usage (id, ts, key_id, account_id, endpoint, model, status, http_status, error_kind,
           prompt_chars, output_chars, tool_calls, latency_ms, ttfb_ms, stream)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        uuid(),
        entry.ts,
        entry.keyId,
        entry.accountId,
        entry.endpoint,
        entry.model,
        entry.status,
        entry.httpStatus,
        entry.errorKind,
        entry.promptChars,
        entry.outputChars,
        entry.toolCalls,
        entry.latencyMs,
        entry.ttfbMs,
        entry.stream ? 1 : 0,
      )
  }

  /**
   * Most recent requests.
   * @param limit - maximum rows.
   * @returns the rows.
   */
  recent(limit = 50): UsageEntry[] {
    const rows = this.#db.sql.prepare('SELECT * FROM usage ORDER BY ts DESC LIMIT ?').all(limit) as unknown as Array<
      Record<string, unknown>
    >
    return rows.map((row) => ({
      id: String(row.id),
      ts: Number(row.ts),
      keyId: row.key_id === null ? null : String(row.key_id),
      accountId: row.account_id === null ? null : String(row.account_id),
      endpoint: String(row.endpoint),
      model: row.model === null ? null : String(row.model),
      status: String(row.status),
      httpStatus: Number(row.http_status),
      errorKind: row.error_kind === null ? null : String(row.error_kind),
      promptChars: Number(row.prompt_chars),
      outputChars: Number(row.output_chars),
      toolCalls: Number(row.tool_calls),
      latencyMs: Number(row.latency_ms),
      ttfbMs: row.ttfb_ms === null ? null : Number(row.ttfb_ms),
      stream: Number(row.stream) === 1,
    }))
  }

  /**
   * Aggregate the last `hours` of traffic.
   * @param hours - window length.
   * @returns the summary.
   */
  summary(hours = 24): UsageSummary {
    const since = Date.now() - hours * 3600_000
    const totals = this.#db.sql
      .prepare(
        `SELECT COUNT(*) AS requests,
                SUM(CASE WHEN status != 'ok' THEN 1 ELSE 0 END) AS errors,
                SUM(prompt_chars) AS prompt_chars,
                SUM(output_chars) AS output_chars,
                SUM(tool_calls) AS tool_calls,
                AVG(latency_ms) AS avg_latency
         FROM usage WHERE ts >= ?`,
      )
      .get(since) as Record<string, unknown>
    const byAccount = this.#db.sql
      .prepare(
        `SELECT account_id, COUNT(*) AS requests, SUM(CASE WHEN status != 'ok' THEN 1 ELSE 0 END) AS errors
         FROM usage WHERE ts >= ? GROUP BY account_id ORDER BY requests DESC`,
      )
      .all(since) as unknown as Array<Record<string, unknown>>
    const byDay = this.#db.sql
      .prepare(
        `SELECT date(ts / 1000, 'unixepoch', 'localtime') AS day,
                COUNT(*) AS requests,
                SUM(CASE WHEN status != 'ok' THEN 1 ELSE 0 END) AS errors
         FROM usage WHERE ts >= ? GROUP BY day ORDER BY day`,
      )
      .all(since) as unknown as Array<Record<string, unknown>>
    return {
      requests: Number(totals.requests ?? 0),
      errors: Number(totals.errors ?? 0),
      promptChars: Number(totals.prompt_chars ?? 0),
      outputChars: Number(totals.output_chars ?? 0),
      avgLatencyMs: Math.round(Number(totals.avg_latency ?? 0)),
      toolCalls: Number(totals.tool_calls ?? 0),
      byAccount: byAccount.map((row) => ({
        accountId: row.account_id === null ? null : String(row.account_id),
        requests: Number(row.requests),
        errors: Number(row.errors),
      })),
      byDay: byDay.map((row) => ({ day: String(row.day), requests: Number(row.requests), errors: Number(row.errors) })),
    }
  }
}
