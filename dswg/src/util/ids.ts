/**
 * Identifier and hashing helpers shared by the store, the pool, and the API.
 *
 * @module dswg/util/ids
 */

import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'

/**
 * A fresh random UUID (v4).
 * @returns the UUID.
 */
export function uuid(): string {
  return randomUUID()
}

/**
 * Cryptographically random URL-safe token.
 * @param bytes - entropy in bytes before encoding (default 32).
 * @returns the base64url token.
 */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url')
}

/**
 * A filesystem-safe, stable slug for an account.
 *
 * Stability matters: the slug names the Chromium profile, and a profile that
 * changes name is a profile that was lost — the account would mint a new device
 * instead of recovering the one it already has.
 * @param input - the raw identifier (email, mobile, or label).
 * @returns `<readable>-<digest>`.
 */
export function slug(input: string): string {
  const text = input.trim() || 'account'
  const readable = text.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 40).replace(/^[._-]+|[._-]+$/g, '') || 'account'
  const digest = createHash('sha256').update(text).digest('hex').slice(0, 12)
  return `${readable}-${digest}`
}

/**
 * Hex SHA-256 of a string.
 * @param text - input.
 * @returns lowercase hex digest.
 */
export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/**
 * Compare two strings without leaking length or content timing.
 * @param a - first string.
 * @param b - second string.
 * @returns true when equal.
 */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

/**
 * Short human-readable request id.
 * @returns 12 hex characters.
 */
export function requestId(): string {
  return randomBytes(6).toString('hex')
}
