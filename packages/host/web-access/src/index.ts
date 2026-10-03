/**
 * The running host's authenticated Web URL, published into an encrypted lock
 * file so a later process can reach the GUI it started.
 *
 * The Web host mints a fresh token per boot and prints it once, to stdout. That
 * makes the GUI unreachable to anything that did not capture that line: a
 * supervisor that restarted the app, a second terminal, or an agent that finds
 * the app already running (the token exists only in the host's memory — it is
 * not on disk, in an environment variable, or in the browser's cookie store for
 * another reader). This row writes the URL to a documented path instead, sealed
 * with a key that does not travel with it.
 *
 * What the sealing protects and what it does not:
 *
 * - It keeps the token out of every plain-text reader: a grep over the state
 *   directory, a log tail, a backup, or a screenshot of the file shows
 *   ciphertext only. That is the failure this exists to prevent.
 * - The key file sits beside it, because a single-user machine has no keystore
 *   this process can reach without native code. The key is derived through
 *   scrypt over the key file, the machine name, and the user name, so the pair
 *   is useless when copied to another machine or read as another user.
 * - It is NOT protection against a process running as this user on this
 *   machine: such a process can read the key file and derive the same key. On a
 *   shared machine, protect the state directory at the filesystem layer.
 *
 * ```yaml
 * - id: web-access
 *   name: '@deepseek-ai/dsh-host-web-access'
 *   config:
 *     path: ~/.dsh/run/web-access.json
 * ```
 *
 * @module @deepseek-ai/dsh-host-web-access
 */

import { hostname, userInfo } from 'node:os'
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { createCipheriv, createDecipheriv, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'web-access'

/**
 * Services required: the Web carrier for the port, and the connection service
 * that owns the credential. The credential never leaves that service — this row
 * asks it for the authenticated form of a local URL rather than minting one.
 */
export const inject = ['connection', 'webServer']

/**
 * The one connection method this row calls, declared here rather than imported:
 * the connection package's `Context` merge lives in its Client face
 * (`./client`), and a host-plan project that reaches it drags the browser's
 * gateway types into the host program, which the compiler faces forbid. The
 * service contract is one pure function of a base URL, so a local declaration
 * states it exactly.
 */
interface WebCredentialSource {
  /**
   * Attach the current boot's credential to a Web URL.
   * @param url - the unauthenticated origin to sign.
   * @returns the URL a browser can open.
   */
  authenticatedUrl(url: string): string
}

/** Loopback host the local URL is built from, matching the Web runtime's own. */
export const LOOPBACK_HOST = '127.0.0.1'

/** Sealed-payload format version; a reader refuses any other value. */
export const ACCESS_FILE_VERSION = 1

/** Length of the per-machine encryption key. */
const KEY_BYTES = 32

/** Key-file length in bytes; hex-encoded on disk. */
const KEY_FILE_BYTES = 32

/** Per-file random salt length, in bytes. */
const SALT_BYTES = 16

/** GCM nonce length, in bytes. */
const IV_BYTES = 12

/** Default access-file path inside the harness state directory. */
export const DEFAULT_ACCESS_PATH: string = dshHomePath('run', 'web-access.json')

/** Default key-file path inside the harness state directory. */
export const DEFAULT_KEY_PATH: string = dshHomePath('run', 'web-access.key')

/** Plugin config: where the access file and its key live. */
export interface Config {
  /**
   * The lock file holding the encrypted URL. Defaults to
   * `$DSH_HOME/run/web-access.json`, which is where an operator or agent looks
   * for a host this process did not start. The file is removed when the row
   * unmounts, so a stale file means a host that died without shutting down.
   */
  path?: string
  /**
   * The encryption key file. Defaults to `$DSH_HOME/run/web-access.key`. Written
   * once and reused, so the file pair stays readable across restarts; it is
   * what makes the access file useless off this machine and this user.
   */
  keyPath?: string
}

export const Config: z<Config> = z.object({
  path: z.string().default(DEFAULT_ACCESS_PATH)
    .description('Lock file receiving the encrypted Web URL.'),
  keyPath: z.string().default(DEFAULT_KEY_PATH)
    .description('Encryption key file paired with the access file.'),
})

/** The plaintext a reader recovers: the URL and the token inside it. */
export interface AccessPayload {
  /** Fully authenticated URL, token included as a query parameter. */
  url: string
  /** The token alone, for a caller that builds its own URL. */
  token: string
}

/** The sealed, on-disk record. Every field is ciphertext or public metadata. */
export interface AccessRecord extends AccessPayloadSeal {
  /** Format version a reader must match. */
  version: number
  /** Publication time, ISO 8601. */
  createdAt: string
  /** Process id of the publishing host, for staleness detection. */
  pid: number
  /** Active profile name, when the launcher named one. */
  profile?: string
  /** Cipher identifier, for a reader that must pick a decryptor. */
  algorithm: string
  /** Base64 salt mixed into the key derivation. */
  salt: string
  /** Base64 GCM nonce. */
  iv: string
  /** Base64 GCM authentication tag. */
  tag: string
  /** Base64 ciphertext of the JSON-encoded {@link AccessPayload}. */
  sealed: string
  /** One-line pointer for a human who found the file. */
  hint: string
}

/** The ciphertext half of a record, as the encryption helpers produce it. */
export interface AccessPayloadSeal {
  /** Base64 salt mixed into the key derivation. */
  salt: string
  /** Base64 GCM nonce. */
  iv: string
  /** Base64 GCM authentication tag. */
  tag: string
  /** Base64 ciphertext. */
  sealed: string
}

/**
 * The machine-and-user context mixed into the key, so the pair is not portable.
 * @returns the context string bound into every key derivation on this machine.
 */
export function machineContext(): string {
  return `dsh-web-access\u0000${hostname()}\u0000${userInfo().username}`
}

/**
 * Derive the encryption key from the key file's secret.
 * @param secret - the key-file bytes, as text.
 * @param context - {@link machineContext} for the publishing machine.
 * @returns a 32-byte key.
 */
export function deriveKey(secret: string, context: string): Buffer {
  return scryptSync(secret, context, KEY_BYTES)
}

/**
 * Seal a payload for one record.
 * @param payload - the URL and token to seal.
 * @param key - the derived key.
 * @returns the ciphertext fields, with a fresh salt and nonce.
 */
export function sealPayload(payload: AccessPayload, key: Buffer): AccessPayloadSeal {
  const salt = randomBytes(SALT_BYTES)
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const sealed = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()])
  return {
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    sealed: sealed.toString('base64'),
  }
}

/**
 * Open a sealed payload.
 * @param record - the ciphertext fields read from disk.
 * @param key - the derived key.
 * @returns the recovered payload.
 * @throws when the tag does not authenticate, which means the wrong key or a
 * modified file — never a partially trusted payload.
 */
export function openPayload(record: AccessPayloadSeal, key: Buffer): AccessPayload {
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(record.iv, 'base64'))
  decipher.setAuthTag(Buffer.from(record.tag, 'base64'))
  const opened = Buffer.concat([decipher.update(Buffer.from(record.sealed, 'base64')), decipher.final()])
  return JSON.parse(opened.toString('utf8')) as AccessPayload
}

/**
 * Read the key file, creating it on first use.
 *
 * The file is written with owner-only permissions where the platform honours
 * them; on Windows the mode is advisory, which is why the derivation also binds
 * the machine and user.
 * @param keyPath - the key file to read or create.
 * @returns the key-file secret.
 */
export function readOrCreateKey(keyPath: string): string {
  try {
    return readFileSync(keyPath, 'utf8').trim()
  } catch {
    mkdirSync(dirname(keyPath), { recursive: true })
    const secret = randomBytes(KEY_FILE_BYTES).toString('hex')
    writeFileSync(keyPath, `${secret}\n`, { encoding: 'utf8', mode: 0o600 })
    try {
      chmodSync(keyPath, 0o600)
    } catch {
      // A filesystem without POSIX modes (Windows) keeps the derivation as the
      // protection; failing here would refuse to publish at all.
    }
    return secret
  }
}

/**
 * The authenticated URL of the local Web carrier.
 *
 * The credential comes from the connection service, which owns the per-boot
 * token; this row never sees the token minting and never invents a URL shape.
 * @param ctx - a context carrying `webServer` and `connection`.
 * @returns the authenticated loopback URL.
 */
function authenticatedLocalUrl(ctx: Context): string {
  const port = ctx.webServer.port
  const connection = ctx.get('connection') as WebCredentialSource | undefined
  if (connection === undefined) throw new Error('web-access: connection service missing while resolving the Web credential')
  return connection.authenticatedUrl(`http://${LOOPBACK_HOST}:${String(port)}`)
}

/**
 * Publish the URL once the host is ready, and withdraw the file on unmount.
 * @param ctx - the plugin context.
 * @param config - the resolved configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const accessPath = config.path ?? DEFAULT_ACCESS_PATH
  const keyPath = config.keyPath ?? DEFAULT_KEY_PATH
  // One publication per root: this row may be reached again by a live patch
  // reload, and rewriting the file on every recomposition would rotate nothing
  // while making the timestamps meaningless.
  let published = false

  const publish = (): void => {
    if (published) return
    // The tree can be disposed between the readiness await and this call; a file
    // pointing at a dead server would only mislead the reader it exists for.
    if (ctx.get('webServer') === undefined || ctx.get('connection') === undefined) return
    const url = authenticatedLocalUrl(ctx)
    const token = new URL(url).searchParams.get('token') ?? ''
    const key = deriveKey(readOrCreateKey(keyPath), machineContext())
    const profile = process.env.DSH_PROFILE
    const record: AccessRecord = {
      version: ACCESS_FILE_VERSION,
      createdAt: new Date().toISOString(),
      pid: process.pid,
      ...(profile === undefined || profile === '' ? {} : { profile }),
      algorithm: 'aes-256-gcm',
      ...sealPayload({ url, token }, key),
      hint: 'node scripts/web-access.mjs',
    }
    mkdirSync(dirname(accessPath), { recursive: true })
    writeFileSync(accessPath, `${JSON.stringify(record, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    published = true
    ctx.effect(() => () => {
      // Only this publisher's file is removed: a reloading composition may have
      // published a newer one under the same path.
      try {
        const current = JSON.parse(readFileSync(accessPath, 'utf8')) as AccessRecord
        if (current.pid === process.pid && sameSeal(current, record)) rmSync(accessPath, { force: true })
      } catch {
        // An absent or unreadable file is already the state this teardown wants.
      }
    }, 'web-access: withdraw the access file')
  }

  const loader = ctx.get('loader')
  if (loader === undefined) {
    publish()
    return
  }
  // Readiness is the Loader tree's: publishing while siblings such as the /api
  // route owner are still mounting would hand out a URL that 404s.
  void loader.await().then(() => { publish() }).catch(() => {
    // Boot owns the failure diagnostic; an unpublished URL stays unpublished.
  })
}

/** Whether two records carry the same ciphertext, i.e. the same publication. */
function sameSeal(left: AccessRecord, right: AccessRecord): boolean {
  const leftTag = Buffer.from(left.tag, 'base64')
  const rightTag = Buffer.from(right.tag, 'base64')
  return leftTag.length === rightTag.length && timingSafeEqual(leftTag, rightTag)
}
