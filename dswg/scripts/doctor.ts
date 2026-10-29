/**
 * Pre-flight check for a gateway install.
 *
 * Answers the questions that otherwise surface as a confusing failure mid-turn:
 * is Chrome where the launcher expects it, is the data directory writable, is the
 * database healthy, does every account have a usable identity, and is there at
 * least one key that can call anything.
 *
 *   node scripts/doctor.ts
 *
 * @module dswg/scripts/doctor
 */

import { accessSync, constants, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { loadConfig, chromeTarget } from '../src/config.ts'
import { openDatabase } from '../src/store/db.ts'
import { AccountRepo } from '../src/store/accounts.ts'
import { KeyRepo } from '../src/store/keys.ts'
import { SecretBox } from '../src/util/crypto.ts'

/** One check result. */
interface Check {
  name: string
  ok: boolean
  detail: string
}

/**
 * Run one check.
 * @param name - what is being checked.
 * @param fn - the check.
 * @returns the result.
 */
function check(name: string, fn: () => string): Check {
  try {
    return { name, ok: true, detail: fn() }
  } catch (error) {
    return { name, ok: false, detail: error instanceof Error ? error.message : String(error) }
  }
}

const results: Check[] = []
const config = loadConfig()

results.push(
  check('data directory writable', () => {
    accessSync(config.home, constants.W_OK)
    return config.home
  }),
)

results.push(
  check('chromium available', () => {
    const target = chromeTarget(config)
    return target.executablePath ?? `channel ${target.channel}`
  }),
)

const db = openDatabase(config.home)
results.push(
  check('database', () => {
    const version = db.sql.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | undefined
    const integrity = db.sql.prepare('PRAGMA integrity_check').get() as { integrity_check: string }
    if (integrity.integrity_check !== 'ok') throw new Error(`integrity check: ${integrity.integrity_check}`)
    return `schema ${version?.value ?? '?'}, integrity ok`
  }),
)

const box = new SecretBox(join(config.home, 'secret.key'))
const accounts = new AccountRepo(db, box)
const keys = new KeyRepo(db)

results.push(
  check('secret key', () => {
    const path = join(config.home, 'secret.key')
    if (!existsSync(path)) throw new Error('secret.key missing — accounts cannot be decrypted')
    return `${statSync(path).size} bytes`
  }),
)

const list = accounts.list()
results.push(
  check('accounts', () => {
    if (list.length === 0) throw new Error('no accounts yet — add one from the dashboard')
    const ready = list.filter((account) => account.status === 'active' && !account.disabled)
    if (ready.length === 0) throw new Error(`${list.length} account(s), none active`)
    return `${ready.length} active of ${list.length}`
  }),
)

results.push(
  check('account identities', () => {
    const withDevice = list.filter((account) => account.deviceId !== null)
    if (withDevice.length === 0) throw new Error('no account has a captured device id — run "Check" on each')
    return `${withDevice.length} account(s) have a device id`
  }),
)

results.push(
  check('profiles', () => {
    const missing = list.filter((account) => !existsSync(join(config.home, 'profiles', account.slug)))
    if (missing.length > 0) throw new Error(`missing profile for: ${missing.map((account) => account.label).join(', ')}`)
    return `${list.length} profile directory(ies) present`
  }),
)

const keyList = keys.list().filter((key) => key.revokedAt === null)
results.push(
  check('api keys', () => {
    if (keyList.length === 0) throw new Error('no active API key — create one in the dashboard')
    return `${keyList.length} active`
  }),
)

for (const result of results) {
  console.log(`${result.ok ? 'ok  ' : 'FAIL'}  ${result.name.padEnd(24)} ${result.detail}`)
}
db.sql.close()
process.exit(results.every((result) => result.ok) ? 0 : 1)
