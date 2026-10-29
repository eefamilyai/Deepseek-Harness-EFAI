/**
 * Adopt a Chromium profile that is already signed in to chat.deepseek.com.
 *
 * The add-account flow in the dashboard opens a fresh profile and waits for a
 * login. This script covers the other case: a profile that already exists — one
 * this gateway used before, or a normal Chrome profile the operator signed into
 * by hand. The profile directory is linked into the gateway's profile root and
 * an account row is created; `POST /admin/api/accounts/:id/check` then reads the
 * token and device ids straight out of it.
 *
 * Usage:
 *   node scripts/import-profile.ts --profile "D:\path\to\profile" --email me@example.com [--label main] [--copy]
 *
 * @module dswg/scripts/import-profile
 */

import { existsSync, mkdirSync, symlinkSync, cpSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { loadConfig } from '../src/config.ts'
import { openDatabase } from '../src/store/db.ts'
import { AccountRepo } from '../src/store/accounts.ts'
import { SecretBox } from '../src/util/crypto.ts'
import { slug } from '../src/util/ids.ts'

/**
 * Read one `--flag value` argument.
 * @param argv - process arguments.
 * @param name - flag name without dashes.
 * @returns the value, or null.
 */
function arg(argv: string[], name: string): string | null {
  const index = argv.indexOf(`--${name}`)
  return index === -1 ? null : (argv[index + 1] ?? null)
}

/**
 * Run the import.
 */
function main(): void {
  const argv = process.argv.slice(2)
  const source = arg(argv, 'profile')
  const email = arg(argv, 'email')
  if (!source || !email) {
    console.error('usage: node scripts/import-profile.ts --profile <dir> --email <address> [--label name] [--copy]')
    process.exit(2)
  }
  const sourceDir = resolve(source)
  if (!existsSync(sourceDir)) {
    console.error(`no such profile directory: ${sourceDir}`)
    process.exit(1)
  }
  const config = loadConfig()
  const db = openDatabase(config.home)
  const box = new SecretBox(join(config.home, 'secret.key'))
  const accounts = new AccountRepo(db, box)

  const accountSlug = slug(email)
  const target = join(config.home, 'profiles', accountSlug)
  mkdirSync(join(config.home, 'profiles'), { recursive: true })
  if (!existsSync(target)) {
    if (argv.includes('--copy')) {
      console.log(`copying ${sourceDir} -> ${target}`)
      cpSync(sourceDir, target, { recursive: true })
    } else {
      // A junction keeps one profile on disk: the browser writes the cookies and
      // the device identity in exactly one place.
      symlinkSync(sourceDir, target, 'junction')
      console.log(`linked ${target} -> ${sourceDir}`)
    }
  } else {
    console.log(`profile already present at ${target}`)
  }

  const existing = accounts.bySlug(accountSlug)
  const account =
    existing ??
    accounts.create({
      slug: accountSlug,
      label: arg(argv, 'label') ?? email,
      email,
      status: 'reauth',
      notes: `imported from ${sourceDir}`,
    })
  console.log(JSON.stringify({ accountId: account.id, slug: account.slug, profile: target }, null, 2))
  db.sql.close()
}

main()
