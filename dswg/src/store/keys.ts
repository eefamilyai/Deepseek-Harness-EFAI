/**
 * API key persistence.
 *
 * A key is stored as a hash plus a short prefix: the plaintext exists only in
 * the response that created it, so a database copy cannot be replayed against
 * the gateway.
 *
 * @module dswg/store/keys
 */

import { randomToken, sha256, uuid } from '../util/ids.ts'
import type { Db } from './db.ts'

/** Key material prefix, so a leaked string is recognisable. */
export const KEY_PREFIX = 'sk-dswg-'

/** One API key. */
export interface ApiKey {
  id: string
  name: string
  /** First characters of the secret, for display. */
  prefix: string
  /** Account ids this key may use; empty means "every account". */
  accountIds: string[]
  /** Model allow list; empty means "every model". */
  models: string[]
  /** Requests per minute for this key. */
  rpm: number | null
  createdAt: number
  lastUsedAt: number | null
  revokedAt: number | null
  notes: string | null
}

/** Row shape as SQLite returns it. */
interface Row {
  id: string
  name: string
  prefix: string
  account_ids: string
  models: string
  rpm: number | null
  created_at: number
  last_used_at: number | null
  revoked_at: number | null
  notes: string | null
}

/**
 * Parse a JSON array column, tolerating bad data.
 * @param text - stored JSON.
 * @returns the array of strings.
 */
function parseList(text: string): string[] {
  try {
    const value: unknown = JSON.parse(text)
    return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []
  } catch {
    return []
  }
}

/**
 * Convert a row to a key.
 * @param row - the row.
 * @returns the key.
 */
function toKey(row: Row): ApiKey {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    accountIds: parseList(row.account_ids),
    models: parseList(row.models),
    rpm: row.rpm,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
    notes: row.notes,
  }
}

/** API key storage operations. */
export class KeyRepo {
  #db: Db

  /**
   * @param db - open database.
   */
  constructor(db: Db) {
    this.#db = db
  }

  /**
   * Create a key and return its plaintext exactly once.
   * @param input - name, scope and limits.
   * @returns the stored key and the secret to hand back.
   */
  create(input: {
    name: string
    accountIds?: string[]
    models?: string[]
    rpm?: number | null
    notes?: string | null
  }): { key: ApiKey; secret: string } {
    const secret = `${KEY_PREFIX}${randomToken(24)}`
    const id = uuid()
    const now = Date.now()
    const prefix = secret.slice(0, KEY_PREFIX.length + 6)
    this.#db.sql
      .prepare(
        `INSERT INTO api_keys (id, name, prefix, hash, account_ids, models, rpm, created_at, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.name,
        prefix,
        sha256(secret),
        JSON.stringify(input.accountIds ?? []),
        JSON.stringify(input.models ?? []),
        input.rpm ?? null,
        now,
        input.notes ?? null,
      )
    return { key: this.get(id) as ApiKey, secret }
  }

  /**
   * Every key, newest first.
   * @returns the keys.
   */
  list(): ApiKey[] {
    const rows = this.#db.sql.prepare('SELECT * FROM api_keys ORDER BY created_at DESC').all() as unknown as Row[]
    return rows.map(toKey)
  }

  /**
   * One key by id.
   * @param id - key id.
   * @returns the key, or null.
   */
  get(id: string): ApiKey | null {
    const row = this.#db.sql.prepare('SELECT * FROM api_keys WHERE id = ?').get(id) as unknown as Row | undefined
    return row ? toKey(row) : null
  }

  /**
   * Resolve a presented secret.
   * @param secret - the plaintext bearer token.
   * @returns the matching, non-revoked key, or null.
   */
  authenticate(secret: string): ApiKey | null {
    const row = this.#db.sql
      .prepare('SELECT * FROM api_keys WHERE hash = ?')
      .get(sha256(secret)) as unknown as Row | undefined
    if (!row) return null
    const key = toKey(row)
    return key.revokedAt === null ? key : null
  }

  /**
   * Change a key's scope or limits.
   * @param id - key id.
   * @param patch - fields to change.
   * @returns the updated key, or null.
   */
  update(id: string, patch: Partial<Pick<ApiKey, 'name' | 'accountIds' | 'models' | 'rpm' | 'notes'>>): ApiKey | null {
    const assignments: string[] = []
    const values: Array<string | number | null> = []
    if (patch.name !== undefined) {
      assignments.push('name = ?')
      values.push(patch.name)
    }
    if (patch.accountIds !== undefined) {
      assignments.push('account_ids = ?')
      values.push(JSON.stringify(patch.accountIds))
    }
    if (patch.models !== undefined) {
      assignments.push('models = ?')
      values.push(JSON.stringify(patch.models))
    }
    if (patch.rpm !== undefined) {
      assignments.push('rpm = ?')
      values.push(patch.rpm)
    }
    if (patch.notes !== undefined) {
      assignments.push('notes = ?')
      values.push(patch.notes)
    }
    if (assignments.length === 0) return this.get(id)
    this.#db.sql.prepare(`UPDATE api_keys SET ${assignments.join(', ')} WHERE id = ?`).run(...values, id)
    return this.get(id)
  }

  /**
   * Mark a key revoked; the row is kept so its usage history still resolves.
   * @param id - key id.
   * @returns true when a live key was revoked.
   */
  revoke(id: string): boolean {
    const result = this.#db.sql.prepare('UPDATE api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(Date.now(), id)
    return Number(result.changes) > 0
  }

  /**
   * Delete a key row outright.
   *
   * Revoking keeps a key for audit, which is the right default, but a key that
   * only ever existed for a smoke test is noise — and its usage rows are keyed by
   * id, so they survive as unattributed history rather than pointing at nothing.
   * @param id - key id.
   * @returns true when a row was removed.
   */
  delete(id: string): boolean {
    const result = this.#db.sql.prepare('DELETE FROM api_keys WHERE id = ?').run(id)
    return Number(result.changes) > 0
  }

  /**
   * Delete every revoked key.
   * @returns how many rows were removed.
   */
  deleteRevoked(): number {
    const result = this.#db.sql.prepare('DELETE FROM api_keys WHERE revoked_at IS NOT NULL').run()
    return Number(result.changes)
  }

  /**
   * Record key use.
   * @param id - key id.
   */
  touch(id: string): void {
    this.#db.sql.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?').run(Date.now(), id)
  }
}
