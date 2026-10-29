/**
 * Account persistence: credentials, captured browser identity, and health state.
 *
 * Secrets (token, cookies, password) are sealed with the process SecretBox
 * before they reach SQLite and are opened only when a browser profile is being
 * seeded or a request is about to be made.
 *
 * @module dswg/store/accounts
 */

import type { SecretBox } from '../util/crypto.ts'
import { uuid } from '../util/ids.ts'
import type { Db } from './db.ts'

/** Why an account is not currently serving requests. */
export type AccountStatus = 'active' | 'reauth' | 'muted' | 'disabled'

/** One DeepSeek account, as stored. */
export interface AccountRecord {
  id: string
  slug: string
  label: string
  email: string | null
  /** Bearer token, decrypted. */
  token: string | null
  /** Cookie header snapshot, decrypted. */
  cookie: string | null
  /** Login password, decrypted, when the operator chose to store one. */
  password: string | null
  /** `x-device-id` the profile minted. */
  deviceId: string | null
  /** Shumei fingerprint (`device_id` in the login body). */
  shumeiId: string | null
  /** `did` query parameter the client sends on client/settings. */
  did: string | null
  userId: string | null
  userAgent: string | null
  status: AccountStatus
  /** Unix ms until which an upstream mute is known to last. */
  mutedUntil: number | null
  /** Unix ms until which the pool should skip this account (backoff). */
  cooldownUntil: number | null
  disabled: boolean
  rpmLimit: number | null
  createdAt: number
  updatedAt: number
  lastUsedAt: number | null
  lastError: string | null
  notes: string | null
}

/** Fields that may be written after creation. */
export type AccountPatch = Partial<
  Pick<
    AccountRecord,
    | 'label'
    | 'email'
    | 'token'
    | 'cookie'
    | 'password'
    | 'deviceId'
    | 'shumeiId'
    | 'did'
    | 'userId'
    | 'userAgent'
    | 'status'
    | 'mutedUntil'
    | 'cooldownUntil'
    | 'disabled'
    | 'rpmLimit'
    | 'lastUsedAt'
    | 'lastError'
    | 'notes'
  >
>

/** Raw row shape as SQLite returns it. */
interface Row {
  id: string
  slug: string
  label: string
  email: string | null
  token_sealed: string | null
  cookie_sealed: string | null
  password_sealed: string | null
  device_id: string | null
  shumei_id: string | null
  did: string | null
  user_id: string | null
  user_agent: string | null
  status: string
  muted_until: number | null
  cooldown_until: number | null
  disabled: number
  rpm_limit: number | null
  created_at: number
  updated_at: number
  last_used_at: number | null
  last_error: string | null
  notes: string | null
}

/**
 * Open one sealed value, tolerating rows written by an older key.
 * @param box - the secret box.
 * @param sealed - stored text.
 * @returns the plaintext, or null when absent or unreadable.
 */
function open(box: SecretBox, sealed: string | null): string | null {
  if (!sealed) return null
  try {
    return box.open(sealed)
  } catch {
    return null
  }
}

/**
 * Convert a row to a record.
 * @param box - the secret box.
 * @param row - the row.
 * @returns the record.
 */
function toRecord(box: SecretBox, row: Row): AccountRecord {
  return {
    id: row.id,
    slug: row.slug,
    label: row.label,
    email: row.email,
    token: open(box, row.token_sealed),
    cookie: open(box, row.cookie_sealed),
    password: open(box, row.password_sealed),
    deviceId: row.device_id,
    shumeiId: row.shumei_id,
    did: row.did,
    userId: row.user_id,
    userAgent: row.user_agent,
    status: row.status as AccountStatus,
    mutedUntil: row.muted_until,
    cooldownUntil: row.cooldown_until,
    disabled: row.disabled === 1,
    rpmLimit: row.rpm_limit,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastUsedAt: row.last_used_at,
    lastError: row.last_error,
    notes: row.notes,
  }
}

/** Column name for each patchable record field. */
const COLUMNS: Record<keyof AccountPatch, string> = {
  label: 'label',
  email: 'email',
  token: 'token_sealed',
  cookie: 'cookie_sealed',
  password: 'password_sealed',
  deviceId: 'device_id',
  shumeiId: 'shumei_id',
  did: 'did',
  userId: 'user_id',
  userAgent: 'user_agent',
  status: 'status',
  mutedUntil: 'muted_until',
  cooldownUntil: 'cooldown_until',
  disabled: 'disabled',
  rpmLimit: 'rpm_limit',
  lastUsedAt: 'last_used_at',
  lastError: 'last_error',
  notes: 'notes',
}

/** Sealed fields, which need the box on the way out. */
const SEALED: ReadonlySet<keyof AccountPatch> = new Set(['token', 'cookie', 'password'])

/** Account storage operations. */
export class AccountRepo {
  #db: Db
  #box: SecretBox

  /**
   * @param db - open database.
   * @param box - secret box used for credential fields.
   */
  constructor(db: Db, box: SecretBox) {
    this.#db = db
    this.#box = box
  }

  /**
   * Every account, newest first.
   * @returns the records.
   */
  list(): AccountRecord[] {
    const rows = this.#db.sql.prepare('SELECT * FROM accounts ORDER BY created_at ASC').all() as unknown as Row[]
    return rows.map((row) => toRecord(this.#box, row))
  }

  /**
   * One account by id.
   * @param id - account id.
   * @returns the record, or null.
   */
  get(id: string): AccountRecord | null {
    const row = this.#db.sql.prepare('SELECT * FROM accounts WHERE id = ?').get(id) as unknown as Row | undefined
    return row ? toRecord(this.#box, row) : null
  }

  /**
   * One account by slug.
   * @param slug - profile slug.
   * @returns the record, or null.
   */
  bySlug(slug: string): AccountRecord | null {
    const row = this.#db.sql.prepare('SELECT * FROM accounts WHERE slug = ?').get(slug) as unknown as Row | undefined
    return row ? toRecord(this.#box, row) : null
  }

  /**
   * Insert an account.
   * @param input - the fields to store; `slug` must already be computed.
   * @returns the stored record.
   */
  create(input: { slug: string; label: string } & AccountPatch): AccountRecord {
    const id = uuid()
    const now = Date.now()
    this.#db.sql
      .prepare(
        `INSERT INTO accounts (id, slug, label, email, token_sealed, cookie_sealed, password_sealed,
           device_id, shumei_id, did, user_id, user_agent, status, muted_until, cooldown_until,
           disabled, rpm_limit, created_at, updated_at, last_used_at, last_error, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.slug,
        input.label,
        input.email ?? null,
        input.token ? this.#box.seal(input.token) : null,
        input.cookie ? this.#box.seal(input.cookie) : null,
        input.password ? this.#box.seal(input.password) : null,
        input.deviceId ?? null,
        input.shumeiId ?? null,
        input.did ?? null,
        input.userId ?? null,
        input.userAgent ?? null,
        input.status ?? 'active',
        input.mutedUntil ?? null,
        input.cooldownUntil ?? null,
        input.disabled ? 1 : 0,
        input.rpmLimit ?? null,
        now,
        now,
        input.lastUsedAt ?? null,
        input.lastError ?? null,
        input.notes ?? null,
      )
    return this.get(id) as AccountRecord
  }

  /**
   * Write selected fields.
   * @param id - account id.
   * @param patch - fields to change.
   * @returns the updated record, or null when the account does not exist.
   */
  update(id: string, patch: AccountPatch): AccountRecord | null {
    const entries = Object.entries(patch).filter(([, value]) => value !== undefined) as Array<
      [keyof AccountPatch, unknown]
    >
    if (entries.length === 0) return this.get(id)
    const assignments = entries.map(([key]) => `${COLUMNS[key]} = ?`)
    const values = entries.map(([key, value]) => {
      if (SEALED.has(key)) return value === null ? null : this.#box.seal(String(value))
      if (key === 'disabled') return value ? 1 : 0
      return value as string | number | null
    })
    this.#db.sql
      .prepare(`UPDATE accounts SET ${assignments.join(', ')}, updated_at = ? WHERE id = ?`)
      .run(...(values as Array<string | number | null>), Date.now(), id)
    return this.get(id)
  }

  /**
   * Delete an account row.
   * @param id - account id.
   * @returns true when a row was removed.
   */
  delete(id: string): boolean {
    const result = this.#db.sql.prepare('DELETE FROM accounts WHERE id = ?').run(id)
    return Number(result.changes) > 0
  }

  /**
   * Record that an account was used for a turn.
   * @param id - account id.
   */
  touch(id: string): void {
    this.#db.sql.prepare('UPDATE accounts SET last_used_at = ? WHERE id = ?').run(Date.now(), id)
  }
}
