/**
 * SQLite persistence.
 *
 * The gateway keeps durable state in one SQLite file read through Node's
 * built-in driver: no native module to compile, and the whole database can be
 * copied while the process is stopped.
 *
 * @module dswg/store/db
 */

import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'

/** Monotonic schema version; raise it and add a migration step for every change. */
export const SCHEMA_VERSION = 1

/** The open database plus the paths derived from it. */
export interface Db {
  /** The live connection. */
  sql: DatabaseSync
  /** Directory the database lives in. */
  home: string
}

/**
 * Open (creating when absent) the gateway database and migrate it.
 * @param home - data directory.
 * @returns the open database.
 */
export function openDatabase(home: string): Db {
  const sql = new DatabaseSync(join(home, 'gateway.db'))
  sql.exec('PRAGMA journal_mode = WAL')
  sql.exec('PRAGMA foreign_keys = ON')
  sql.exec('PRAGMA busy_timeout = 5000')
  migrate(sql)
  return { sql, home }
}

/**
 * Apply the schema.
 * @param sql - the connection.
 */
function migrate(sql: DatabaseSync): void {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS accounts (
      id             TEXT PRIMARY KEY,
      slug           TEXT NOT NULL UNIQUE,
      label          TEXT NOT NULL,
      email          TEXT,
      token_sealed   TEXT,
      cookie_sealed  TEXT,
      password_sealed TEXT,
      device_id      TEXT,
      shumei_id      TEXT,
      did            TEXT,
      user_id        TEXT,
      user_agent     TEXT,
      status         TEXT NOT NULL DEFAULT 'active',
      muted_until    INTEGER,
      cooldown_until INTEGER,
      disabled       INTEGER NOT NULL DEFAULT 0,
      rpm_limit      INTEGER,
      created_at     INTEGER NOT NULL,
      updated_at     INTEGER NOT NULL,
      last_used_at   INTEGER,
      last_error     TEXT,
      notes          TEXT
    );

    CREATE TABLE IF NOT EXISTS api_keys (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      prefix      TEXT NOT NULL,
      hash        TEXT NOT NULL UNIQUE,
      account_ids TEXT NOT NULL DEFAULT '[]',
      models      TEXT NOT NULL DEFAULT '[]',
      rpm         INTEGER,
      created_at  INTEGER NOT NULL,
      last_used_at INTEGER,
      revoked_at  INTEGER,
      notes       TEXT
    );

    CREATE TABLE IF NOT EXISTS usage (
      id           TEXT PRIMARY KEY,
      ts           INTEGER NOT NULL,
      key_id       TEXT,
      account_id   TEXT,
      endpoint     TEXT NOT NULL,
      model        TEXT,
      status       TEXT NOT NULL,
      http_status  INTEGER NOT NULL,
      error_kind   TEXT,
      prompt_chars INTEGER NOT NULL DEFAULT 0,
      output_chars INTEGER NOT NULL DEFAULT 0,
      tool_calls   INTEGER NOT NULL DEFAULT 0,
      latency_ms   INTEGER NOT NULL DEFAULT 0,
      ttfb_ms      INTEGER,
      stream       INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS usage_ts ON usage(ts DESC);
    CREATE INDEX IF NOT EXISTS usage_key ON usage(key_id, ts DESC);

    CREATE TABLE IF NOT EXISTS wire_log (
      id         TEXT PRIMARY KEY,
      ts         INTEGER NOT NULL,
      kind       TEXT NOT NULL,
      account_id TEXT,
      turn_id    TEXT,
      data       TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS wire_log_ts ON wire_log(ts DESC);
    CREATE INDEX IF NOT EXISTS wire_log_account ON wire_log(account_id, ts DESC);
    CREATE INDEX IF NOT EXISTS wire_log_turn ON wire_log(turn_id);

    CREATE TABLE IF NOT EXISTS learned_patterns (
      id         TEXT PRIMARY KEY,
      opener     TEXT NOT NULL,
      closer     TEXT NOT NULL,
      score      INTEGER NOT NULL,
      origin     TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      uses       INTEGER NOT NULL DEFAULT 0,
      samples    TEXT NOT NULL DEFAULT '[]'
    );

    CREATE TABLE IF NOT EXISTS raw_turns (
      turn_id     TEXT PRIMARY KEY,
      ts          INTEGER NOT NULL,
      account_id  TEXT,
      model       TEXT,
      tools       TEXT NOT NULL DEFAULT '[]',
      stream_chars INTEGER NOT NULL DEFAULT 0,
      text_chars  INTEGER NOT NULL DEFAULT 0,
      leaked      INTEGER NOT NULL DEFAULT 0,
      salvaged    INTEGER NOT NULL DEFAULT 0,
      path        TEXT,
      sha256      TEXT
    );
    CREATE INDEX IF NOT EXISTS raw_turns_ts ON raw_turns(ts DESC);

    CREATE TABLE IF NOT EXISTS leaks (
      id         TEXT PRIMARY KEY,
      ts         INTEGER NOT NULL,
      turn_id    TEXT,
      account_id TEXT,
      kind       TEXT NOT NULL,
      evidence   TEXT NOT NULL,
      text       TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS leaks_ts ON leaks(ts DESC);

    CREATE TABLE IF NOT EXISTS chat_sessions (
      id             TEXT PRIMARY KEY,
      account_id     TEXT NOT NULL,
      session_id     TEXT NOT NULL,
      transcript_key TEXT NOT NULL,
      last_message_id INTEGER,
      messages_sent  INTEGER NOT NULL,
      created_at     INTEGER NOT NULL,
      updated_at     INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS chat_session_transcript ON chat_sessions(transcript_key);
  `)
  const row = sql.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version') as { value: string } | undefined
  const current = row ? Number(row.value) : 0
  if (current > SCHEMA_VERSION) {
    throw new Error(`database schema ${current} is newer than this build (${SCHEMA_VERSION})`)
  }
  sql.prepare('INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run('schema_version', String(SCHEMA_VERSION))
}

/**
 * Read one meta value.
 * @param db - the database.
 * @param key - the key.
 * @returns the stored value, or null.
 */
export function metaGet(db: Db, key: string): string | null {
  const row = db.sql.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined
  return row?.value ?? null
}

/**
 * Write one meta value.
 * @param db - the database.
 * @param key - the key.
 * @param value - the value.
 */
export function metaSet(db: Db, key: string, value: string): void {
  db.sql.prepare('INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value)
}
