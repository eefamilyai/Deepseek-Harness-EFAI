/**
 * Signing in with a browser the gateway did not launch.
 *
 * Every other path opens the profile under Playwright, which is the right way to
 * run turns — the traffic has to come from inside the profile's own page. It is
 * the wrong way to pass a human-verification check: the widget scores the
 * browser it is running in, and a window under automation is exactly what it
 * refuses, however carefully the operator solves it.
 *
 * So this path opens the same profile directory in plain Chrome. Same profile,
 * same device, same cookies — no automation flags, no debugger, nothing to
 * detect. The gateway waits for that window to close and then reads the session
 * the operator created.
 *
 * @module dswg/browser/native
 */

import { spawn } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { Config } from '../config.ts'
import { logger } from '../util/log.ts'

const log = logger('native')

/** Where Chrome installs itself on Windows, in the order worth trying. */
const WINDOWS_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
]

/**
 * The browser binary to open for a hand sign-in.
 * @param config - gateway configuration; an explicit path wins.
 * @returns the executable path, or null when no browser was found.
 */
export function nativeBrowserPath(config: Config): string | null {
  const configured = config.chromeChannel
  if (configured.includes('/') || configured.includes('\\') || configured.toLowerCase().endsWith('.exe')) {
    return existsSync(configured) ? configured : null
  }
  const localAppData = process.env.LOCALAPPDATA
  const candidates = [
    ...(localAppData === undefined ? [] : [join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe')]),
    ...WINDOWS_CANDIDATES,
  ]
  return candidates.find((candidate) => existsSync(candidate)) ?? null
}

/** A sign-in window that is open, and the promise of it closing. */
export interface NativeSignIn {
  /** Process id of the browser, for logging and for the dashboard. */
  pid: number
  /** Resolves when the window has closed. */
  closed: Promise<void>
}

/**
 * Open the account's profile in a browser the gateway does not drive.
 *
 * The profile directory is the same one turns use, so the device the site sees
 * is the device that will serve turns afterwards. Only this process's absence of
 * automation differs.
 * @param config - gateway configuration.
 * @param profileDir - the account's profile directory.
 * @param url - where to open.
 * @returns the running window, or null when no browser could be started.
 */
export function openNativeSignIn(config: Config, profileDir: string, url: string): NativeSignIn | null {
  const executable = nativeBrowserPath(config)
  if (executable === null) {
    log.warn('no installed Chrome or Edge found for a native sign-in')
    return null
  }
  const child = spawn(executable, [`--user-data-dir=${profileDir}`, '--profile-directory=Default', '--no-first-run', '--no-default-browser-check', url], {
    detached: false,
    stdio: 'ignore',
  })
  log.info('opened a native sign-in window', { executable, profileDir, pid: child.pid ?? null })
  const closed = new Promise<void>((resolve) => {
    child.once('exit', () => resolve())
    child.once('error', () => resolve())
  })
  return { pid: child.pid ?? 0, closed }
}


/**
 * Everything a profile's local storage holds about who it is.
 *
 * This is the same information a browser capture reads through the page, taken
 * from the files instead. The point is timing: while the operator's own Chrome
 * holds the profile, the page cannot be opened, and waiting for them to close a
 * window is waiting on bookkeeping rather than on anything the gateway needs.
 */
export interface ProfileIdentity {
  token: string | null
  deviceId: string | null
  did: string | null
}

/** A UUID, which is how the site spells both of its device ids. */
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'

/**
 * Read the newest value of a key from a profile's local storage.
 *
 * LevelDB appends, so the last record a file holds is the current one; the files
 * are read in write order for that reason. A record that cleared the key is
 * honoured: `"value":null` means signed out, not "keep the old one".
 * @param text - the concatenated leveldb bytes, as latin1.
 * @param key - the storage key.
 * @returns the value, `null` when it was cleared, or undefined when absent.
 */
function storageValue(text: string, key: string): string | null | undefined {
  let at = text.lastIndexOf(key)
  let result: string | null | undefined
  while (at !== -1) {
    const window = text.slice(at, at + 400)
    const value = /"value"\s*:\s*"([^"]+)"/.exec(window)
    if (value !== null) {
      result = value[1] as string
      break
    }
    if (/"value"\s*:\s*null/.test(window)) {
      result = null
      break
    }
    at = text.lastIndexOf(key, at - 1)
  }
  return result
}

/**
 * Read every leveldb file of a profile in write order.
 * @param profileDir - the account's profile directory.
 * @returns the bytes as latin1, or the empty string when nothing is readable.
 */
function storageText(profileDir: string): string {
  const folder = join(profileDir, 'Default', 'Local Storage', 'leveldb')
  if (!existsSync(folder)) return ''
  let files: string[]
  try {
    files = readdirSync(folder).filter((name) => name.endsWith('.log') || name.endsWith('.ldb'))
  } catch {
    return ''
  }
  files.sort((a, b) => {
    try {
      return statSync(join(folder, a)).mtimeMs - statSync(join(folder, b)).mtimeMs
    } catch {
      return 0
    }
  })
  let out = ''
  for (const file of files) {
    try {
      out += readFileSync(join(folder, file), 'latin1')
    } catch {
      // A file being rewritten is simply not read this pass.
    }
  }
  return out
}

/**
 * Read a profile's identity from its files.
 * @param profileDir - the account's profile directory.
 * @returns whatever the profile currently holds.
 */
export function readProfileIdentity(profileDir: string): ProfileIdentity {
  const text = storageText(profileDir)
  if (text.length === 0) return { token: null, deviceId: null, did: null }
  const token = storageValue(text, 'userToken') ?? null

  // The device id is stored under a key ending `-device-id:chat`; the value
  // follows the key inside the same record.
  let deviceId: string | null = null
  let at = text.lastIndexOf('-device-id')
  while (at !== -1) {
    const found = new RegExp(UUID).exec(text.slice(at, at + 160))
    if (found !== null) {
      deviceId = found[0]
      break
    }
    at = text.lastIndexOf('-device-id', at - 1)
  }

  // The anonymous device id the site calls `did`, kept under one feature key.
  let did: string | null = null
  at = text.lastIndexOf('__ds_Ix4_feature_did')
  if (at !== -1) {
    const found = new RegExp(UUID).exec(text.slice(at, at + 160))
    if (found !== null) did = found[0]
  }
  return { token, deviceId, did }
}

/**
 * The session token a profile currently holds.
 *
 * A profile being used by its own browser cannot be opened again, so the only
 * way to see progress while the operator signs in is to read the profile's own
 * local storage. LevelDB keeps the newest value last, and a cleared token is
 * written as `null`, so the last record wins.
 * @param profileDir - the account's profile directory.
 * @returns the token, or null when the profile holds none yet.
 */
export function readProfileToken(profileDir: string): string | null {
  const folder = join(profileDir, 'Default', 'Local Storage', 'leveldb')
  if (!existsSync(folder)) return null
  let files: string[]
  try {
    files = readdirSync(folder).filter((name) => name.endsWith('.log') || name.endsWith('.ldb'))
  } catch {
    // The directory is being written; there is nothing to read this second.
    return null
  }
  // Newest first: the live value is in the most recently written file.
  files.sort((a, b) => {
    try {
      return statSync(join(folder, b)).mtimeMs - statSync(join(folder, a)).mtimeMs
    } catch {
      return 0
    }
  })
  for (const file of files) {
    let raw: string
    try {
      raw = readFileSync(join(folder, file), 'latin1')
    } catch {
      continue
    }
    let at = raw.lastIndexOf('userToken')
    while (at !== -1) {
      const window = raw.slice(at, at + 400)
      const value = /"value"\s*:\s*"([^"]+)"/.exec(window)
      if (value !== null && (value[1] as string).length > 20) return value[1] as string
      // `"value":null` means the profile signed out; the record before it is stale.
      if (/"value"\s*:\s*null/.test(window)) return null
      at = raw.lastIndexOf('userToken', at - 1)
    }
  }
  return null
}
