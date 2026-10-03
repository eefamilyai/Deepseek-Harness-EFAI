#!/usr/bin/env node
/**
 * Read the running host's authenticated Web URL out of the encrypted access
 * file `@deepseek-ai/dsh-host-web-access` publishes.
 *
 * The Web host mints one token per boot and prints it once, to stdout, so an
 * operator or an agent that did not capture that line cannot open the GUI. This
 * reads the file the host wrote instead. The decryption below mirrors the
 * package's helpers rather than importing its built output: this script is what
 * an operator runs when the harness is otherwise unavailable, and it must not
 * depend on a build having happened.
 *
 * One host owns the configured path while it serves, so a second host sharing the
 * state directory publishes beside it as `web-access.<port>.json` rather than
 * withdrawing a URL nothing can re-mint. This script therefore reads the whole
 * set: by default it reports the newest host that is still running, and `--all`
 * lists every record it finds.
 *
 * Usage:
 *   node scripts/web-access.mjs              # the newest live host's URL
 *   node scripts/web-access.mjs --token      # only the token
 *   node scripts/web-access.mjs --all        # one line per record
 *   node scripts/web-access.mjs --port 50140 # the host that serves that port
 *   node scripts/web-access.mjs --json       # the whole record, url decrypted
 *   node scripts/web-access.mjs --path <file> --key-path <file>
 */

import { hostname, userInfo } from 'node:os'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { createDecipheriv, scryptSync } from 'node:crypto'
import { parseArgs } from 'node:util'
import { pathToFileURL } from 'node:url'

/** Loopback hosts whose token is the process token, not a LAN trust grant. */
const KEY_BYTES = 32
const ACCESS_FILE_VERSION = 1

/** The harness state directory, mirroring `dshHomePath` without importing it. */
function dshHome() {
  const configured = process.env.DSH_HOME
  if (configured !== undefined && configured !== '') return configured
  return join(homedir(), '.dsh')
}

/** The machine-and-user context mixed into the key, mirroring the package. */
export function machineContext() {
  return `dsh-web-access\u0000${hostname()}\u0000${userInfo().username}`
}

/**
 * Decrypt one access record.
 * @param {object} record - the parsed access file.
 * @param {string} secret - the key file's contents.
 * @returns {{url: string, token: string}} the recovered payload.
 */
export function openRecord(record, secret) {
  if (record.version !== ACCESS_FILE_VERSION) {
    throw new Error(`access file version ${String(record.version)} is not ${String(ACCESS_FILE_VERSION)}; upgrade this script`)
  }
  const key = scryptSync(secret, machineContext(), KEY_BYTES)
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(record.iv, 'base64'))
  decipher.setAuthTag(Buffer.from(record.tag, 'base64'))
  const opened = Buffer.concat([decipher.update(Buffer.from(record.sealed, 'base64')), decipher.final()])
  return JSON.parse(opened.toString('utf8'))
}

/**
 * Read and decrypt the access file.
 * @param {string} [path] - access-file path; defaults to `$DSH_HOME/run/web-access.json`.
 * @param {string} [keyPath] - key-file path; defaults to `$DSH_HOME/run/web-access.key`.
 * @returns {{record: object, payload: {url: string, token: string}, stale: boolean}} the record, payload, and whether its pid is gone.
 */
export function readAccess(path, keyPath) {
  const file = path ?? join(dshHome(), 'run', 'web-access.json')
  const keyFile = keyPath ?? join(dshHome(), 'run', 'web-access.key')
  const record = JSON.parse(readFileSync(file, 'utf8'))
  const secret = readFileSync(keyFile, 'utf8').trim()
  const payload = openRecord(record, secret)
  let stale = false
  try {
    process.kill(record.pid, 0)
  } catch {
    stale = true
  }
  return { record, payload, stale }
}

/**
 * The path a host serving one port publishes under.
 * @param {string} file - the configured access-file path.
 * @param {string} port - the port that host serves.
 * @returns {string} the port-scoped sibling path (`web-access.50140.json`).
 */
export function portScopedPath(file, port) {
  const dir = dirname(file)
  const base = basename(file)
  const dot = base.lastIndexOf('.')
  // Mirrors the publisher's rule: the port goes before the extension, so both ends
  // name the same file for the paths a deployment configures.
  return dot <= 0 ? join(dir, `${base}.${port}`) : join(dir, `${base.slice(0, dot)}.${port}${base.slice(dot)}`)
}

/**
 * Every record beside the configured path, newest first.
 *
 * A host that finds the configured path held by a live process publishes beside it,
 * so the directory is what states which hosts are running.
 * @param {string} file - the configured access-file path.
 * @returns {string[]} the record paths that exist.
 */
export function recordPaths(file) {
  const base = basename(file)
  const stem = base.replace(/\.json$/, '')
  const dir = dirname(file)
  let siblings = []
  try {
    siblings = readdirSync(dir)
      .filter(name => name !== base && name.startsWith(`${stem}.`) && name.endsWith('.json'))
      .map(name => join(dir, name))
  } catch {
    // No directory yet: only an explicit path can name a record.
  }
  const paths = existsSync(file) ? [file, ...siblings] : siblings
  return paths.sort((left, right) => Date.parse(createdAt(right)) - Date.parse(createdAt(left)))
}

/** The publication time of a record, or '' when the file cannot be parsed. */
function createdAt(path) {
  try {
    return String(JSON.parse(readFileSync(path, 'utf8')).createdAt ?? '')
  } catch {
    return ''
  }
}

function main() {
  const { values } = parseArgs({
    options: {
      path: { type: 'string' },
      'key-path': { type: 'string' },
      port: { type: 'string' },
      all: { type: 'boolean', default: false },
      token: { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
    },
    allowPositionals: false,
  })
  const configured = values.path ?? join(dshHome(), 'run', 'web-access.json')
  const keyPath = values['key-path']
  // A named file or port is the caller's choice; the default walks the directory,
  // because a second host publishes beside the first rather than over it.
  const named = values.path !== undefined || values.port !== undefined
  const paths = named
    ? [values.port === undefined ? configured : portScopedPath(configured, values.port)]
    : recordPaths(configured)
  const records = []
  const unreadable = []
  for (const path of paths) {
    try {
      records.push({ path, ...readAccess(path, keyPath) })
    } catch (error) {
      // A record that cannot be opened is reported only when nothing else can be:
      // one stale sibling must not hide the host that is actually serving.
      unreadable.push({ path, reason: error instanceof Error ? error.message : String(error) })
    }
  }
  if (records.length === 0) {
    const detail = unreadable.map(entry => `${entry.path}: ${entry.reason}`).join('; ')
    console.error(`web-access: could not read an access file${detail === '' ? '' : ` (${detail})`}`)
    console.error('web-access: the host publishes one once it is ready; if the app was started without the web-access row, capture the `dsh web:` line instead')
    process.exitCode = 1
    return
  }
  const live = records.filter(entry => !entry.stale)
  // The configured path is the host a deployment names; a port-scoped sibling is a
  // host somebody started beside it. When both are running, the named one wins.
  const canonical = live.find(entry => entry.path === configured)
  const chosen = canonical ?? (live.length > 0 ? live : records)[0]
  if (values.all) {
    for (const entry of records) {
      const state = entry.stale ? 'gone ' : 'live '
      console.log(`${entry.record.createdAt}  pid ${String(entry.record.pid)}  ${state} ${entry.payload.url}`)
    }
    return
  }
  if (records.length > 1) {
    console.error(`web-access: ${String(records.length)} hosts published here; showing ${basename(chosen.path)} (${live.length} still running)`)
  }
  if (chosen.stale) {
    console.error(`web-access: warning: process ${String(chosen.record.pid)} is gone; this file is left over from a host that did not shut down`)
  }
  if (values.json) {
    console.log(JSON.stringify({ ...chosen.record, path: chosen.path, payload: chosen.payload, stale: chosen.stale }, null, 2))
    return
  }
  console.log(values.token ? chosen.payload.token : chosen.payload.url)
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) main()
