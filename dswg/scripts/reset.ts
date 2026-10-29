/**
 * Reset the gateway's state.
 *
 * The default keeps browser profiles and accounts: a profile *is* the account's
 * device identity, so wiping it means re-doing a hand login for every account.
 * `--all` removes those too, leaving a first-run install.
 *
 * The server must be stopped first — SQLite holds the database open in WAL mode
 * and a live browser may be using a profile.
 *
 *   node scripts/reset.ts --yes                 # keys, usage, logs, corpus
 *   node scripts/reset.ts --yes --all           # also profiles + identities + db
 *   node scripts/reset.ts --yes --keep-usage    # keep the usage table
 *   node scripts/reset.ts --yes --keep-logs     # keep the wire log and corpus
 *
 * @module dswg/scripts/reset
 */

import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { loadConfig } from '../src/config.ts'
import { openDatabase } from '../src/store/db.ts'

/**
 * Delete the gateway's state.
 */
function runReset(): void {
  const argv = process.argv.slice(2)
  if (!argv.includes('--yes')) {
    console.error('refusing to delete anything without --yes')
    console.error('usage: node scripts/reset.ts --yes [--all] [--keep-usage] [--keep-logs]')
    process.exit(2)
  }

  const config = loadConfig()
  const all = argv.includes('--all')
  const keepUsage = argv.includes('--keep-usage')
  const keepLogs = argv.includes('--keep-logs')

  const db = openDatabase(config.home)
  const removed: Record<string, number> = {}
  const wipe = (table: string): void => {
    const before = db.sql.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }
    db.sql.prepare(`DELETE FROM ${table}`).run()
    removed[table] = Number(before.c)
  }

  wipe('api_keys')
  if (!keepUsage) wipe('usage')
  if (!keepLogs) {
    wipe('wire_log')
    wipe('leaks')
    wipe('raw_turns')
    wipe('chat_sessions')
    wipe('learned_patterns')
  }
  const kept = (db.sql.prepare('SELECT COUNT(*) AS c FROM accounts').get() as { c: number }).c
  db.sql.close()
  removed.accountsKept = Number(kept)

  const folders = [join(config.home, 'logs'), join(config.home, 'raw')]
  if (all) folders.push(join(config.home, 'profiles'), join(config.home, 'identities'))
  for (const folder of folders) {
    if (!existsSync(folder)) continue
    rmSync(folder, { recursive: true, force: true })
    removed[`dir:${folder}`] = -1
  }
  if (all) {
    for (const file of ['gateway.db', 'gateway.db-wal', 'gateway.db-shm', 'gateway.pid']) {
      const path = join(config.home, file)
      if (existsSync(path)) rmSync(path, { force: true })
    }
  }

  console.log(JSON.stringify({ home: config.home, all, removed }, null, 2))
  console.log(all ? 'everything removed — the next start creates a fresh install' : 'state cleared; accounts and profiles kept')
}

runReset()
