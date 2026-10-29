/**
 * Secret-at-rest encryption for account tokens, cookies and passwords.
 *
 * The gateway is a personal tool that holds live session credentials, so the
 * database never stores them in the clear: each value is AES-256-GCM sealed
 * with a key that lives in its own file under the data directory.
 *
 * @module dswg/util/crypto
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync, chmodSync, existsSync } from 'node:fs'
import { dirname } from 'node:path'

const ALGORITHM = 'aes-256-gcm'
const VERSION = 'v1'

/** Seals and opens values with one process-wide key. */
export class SecretBox {
  #key: Buffer

  /**
   * @param keyFile - path to a 32-byte key file; created on first use.
   */
  constructor(keyFile: string) {
    this.#key = SecretBox.loadKey(keyFile)
  }

  /**
   * Read the key, minting one on first use.
   * @param keyFile - path to the key file.
   * @returns the 32-byte key.
   */
  static loadKey(keyFile: string): Buffer {
    if (existsSync(keyFile)) {
      const raw = readFileSync(keyFile)
      if (raw.length !== 32) {
        throw new Error(`secret key at ${keyFile} must be 32 bytes, found ${raw.length}`)
      }
      return raw
    }
    mkdirSync(dirname(keyFile), { recursive: true })
    const key = randomBytes(32)
    writeFileSync(keyFile, key, { mode: 0o600 })
    try {
      chmodSync(keyFile, 0o600)
    } catch {
      // Windows ignores POSIX modes; the file is still created user-only by the ACL default.
    }
    return key
  }

  /**
   * Seal a UTF-8 string.
   * @param plaintext - the value to seal.
   * @returns `v1:<iv>:<tag>:<ciphertext>`, all base64url.
   */
  seal(plaintext: string): string {
    const iv = randomBytes(12)
    const cipher = createCipheriv(ALGORITHM, this.#key, iv)
    const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
    const tag = cipher.getAuthTag()
    return [VERSION, iv.toString('base64url'), tag.toString('base64url'), body.toString('base64url')].join(':')
  }

  /**
   * Open a value produced by {@link seal}.
   * @param sealed - the stored representation.
   * @returns the plaintext.
   * @throws when the value is malformed or the key no longer matches.
   */
  open(sealed: string): string {
    const parts = sealed.split(':')
    if (parts.length !== 4 || parts[0] !== VERSION) throw new Error('malformed sealed value')
    const [, ivText, tagText, bodyText] = parts as [string, string, string, string]
    const decipher = createDecipheriv(ALGORITHM, this.#key, Buffer.from(ivText, 'base64url'))
    decipher.setAuthTag(Buffer.from(tagText, 'base64url'))
    return Buffer.concat([decipher.update(Buffer.from(bodyText, 'base64url')), decipher.final()]).toString('utf8')
  }
}
