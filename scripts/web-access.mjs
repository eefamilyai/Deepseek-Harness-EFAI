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
 * Usage:
 *   node scripts/web-access.mjs              # the authenticated URL
 *   node scripts/web-access.mjs --token      # only the token
 *   node scripts/web-access.mjs --json       # the whole record, url decrypted
 *   node scripts/web-access.mjs --path <file> --key-path <file>
 */

import { hostname, userInfo } from 'node:os'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
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

function main() {
  const { values } = parseArgs({
    options: {
      path: { type: 'string' },
      'key-path': { type: 'string' },
      token: { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
    },
    allowPositionals: false,
  })
  let result
  try {
    result = readAccess(values.path, values['key-path'])
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    console.error(`web-access: could not read the access file (${reason})`)
    console.error('web-access: the host publishes it once it is ready; if the app was started without the web-access row, capture the `dsh web:` line instead')
    process.exitCode = 1
    return
  }
  if (result.stale) {
    console.error(`web-access: warning: process ${String(result.record.pid)} is gone; this file is left over from a host that did not shut down`)
  }
  if (values.json) {
    console.log(JSON.stringify({ ...result.record, payload: result.payload, stale: result.stale }, null, 2))
    return
  }
  console.log(values.token ? result.payload.token : result.payload.url)
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) main()
