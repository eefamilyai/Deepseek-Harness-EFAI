/**
 * Durable system-prompt-to-file-id index.
 *
 * A provider file id is stable: the same bytes stay one object. Caching the id
 * against the prompt revision is what makes "upload once, reuse until the
 * provider rejects it" true across turns and across restarts.
 * @module dsh-llm-system-file/upload-index
 */

import { createHash } from 'node:crypto'
import { readFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { SystemPromptFileId, SystemPromptFileScope } from './file-id.ts'
import type {
  SystemPromptFileId as SystemPromptFileIdType,
  SystemPromptFileScope as SystemPromptFileScopeType,
} from './file-id.ts'

/** One durable remote upload mapping. Unix times are milliseconds. */
export interface SystemPromptUploadRecord {
  scope: SystemPromptFileScopeType
  /** Digest of the exact prompt revision that was uploaded. */
  variantId: string
  fileId: SystemPromptFileIdType
  bytes: number
  createdAt: number
  expiresAt: number
}

interface StoredIndex {
  formatVersion: 1
  records: SystemPromptUploadRecord[]
}

const SCOPE_PATTERN = /^[0-9a-f]{64}$/u
const VARIANT_PATTERN = /^[0-9a-f]{64}$/u

class InvalidUploadIndexError extends Error {}

/**
 * Derive a non-secret stable namespace without persisting or logging the API key.
 * @param baseURL - normalized provider endpoint namespace.
 * @param apiKey - resolved credential used only as hash input.
 * @returns branded SHA-256 namespace digest.
 */
export function systemPromptFileScope(baseURL: string, apiKey: string): SystemPromptFileScopeType {
  return SystemPromptFileScope(createHash('sha256')
    .update(baseURL.replace(/\/+$/u, ''))
    .update('\0')
    .update(apiKey)
    .digest('hex'))
}

/** Digest identifying one prompt revision on one route. */
export function promptVariantId(schema: string, promptText: string): string {
  return createHash('sha256')
    .update(schema)
    .update('\0')
    .update(promptText)
    .digest('hex')
}

function absent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}

function parseRecord(value: unknown): SystemPromptUploadRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidUploadIndexError('llm-system-file: upload index contains a non-object record')
  }
  const record = value as Record<string, unknown>
  if (typeof record.scope !== 'string' || !SCOPE_PATTERN.test(record.scope)
    || typeof record.variantId !== 'string' || !VARIANT_PATTERN.test(record.variantId)
    || typeof record.fileId !== 'string' || record.fileId.length === 0
    || !Number.isSafeInteger(record.bytes) || (record.bytes as number) < 0
    || !Number.isSafeInteger(record.createdAt) || (record.createdAt as number) < 0
    || !Number.isSafeInteger(record.expiresAt) || (record.expiresAt as number) < 0) {
    throw new InvalidUploadIndexError('llm-system-file: upload index contains an invalid record')
  }
  return {
    scope: SystemPromptFileScope(record.scope),
    variantId: record.variantId,
    fileId: SystemPromptFileId(record.fileId),
    bytes: record.bytes as number,
    createdAt: record.createdAt as number,
    expiresAt: record.expiresAt as number,
  }
}

function parseIndex(text: string): StoredIndex {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error: unknown) {
    throw new InvalidUploadIndexError('llm-system-file: upload index is not valid JSON', { cause: error })
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidUploadIndexError('llm-system-file: upload index is not an object')
  }
  const index = value as { formatVersion?: unknown; records?: unknown }
  if (index.formatVersion !== 1 || !Array.isArray(index.records)) {
    throw new InvalidUploadIndexError('llm-system-file: unsupported upload index format')
  }
  const records = index.records.map(parseRecord)
  const keys = new Set<string>()
  for (const record of records) {
    const key = `${record.scope}\0${record.variantId}`
    if (keys.has(key)) throw new InvalidUploadIndexError('llm-system-file: duplicate mappings')
    keys.add(key)
  }
  return { formatVersion: 1, records }
}

function reusable(record: SystemPromptUploadRecord, now: number, refreshMarginMs: number): boolean {
  return record.expiresAt - now > refreshMarginMs
}

/** Atomic local index shared by every session in this DSH home. */
export class SystemPromptUploadIndex {
  /** Absolute owner-private JSON index path. */
  readonly path: string

  /**
   * @param path - explicit test path; omission uses `DSH_HOME/llm-system-file/files-v1.json`.
   */
  constructor(path = join(resolveDshHome(), 'llm-system-file', 'files-v1.json')) {
    this.path = path
  }

  private async load(): Promise<StoredIndex> {
    try {
      return parseIndex(await readFile(this.path, 'utf8'))
    } catch (error: unknown) {
      if (absent(error) || error instanceof InvalidUploadIndexError) return { formatVersion: 1, records: [] }
      throw error
    }
  }

  private async save(index: StoredIndex): Promise<void> {
    await writeFileAtomic(this.path, `${JSON.stringify(index, undefined, 2)}\n`, {
      mode: 0o600,
      dirMode: 0o700,
    })
  }

  /**
   * Read one reusable mapping.
   * @param scope - endpoint/API-key namespace.
   * @param variantId - prompt revision digest.
   * @param now - current Unix time in milliseconds.
   * @param refreshMarginMs - remaining lifetime below which a mapping is not reused.
   * @returns the mapping when it has enough lifetime remaining.
   */
  async get(
    scope: SystemPromptFileScopeType,
    variantId: string,
    now: number,
    refreshMarginMs: number,
  ): Promise<SystemPromptUploadRecord | undefined> {
    const record = (await this.load()).records.find(candidate => (
      candidate.scope === scope && candidate.variantId === variantId
    ))
    return record !== undefined && reusable(record, now, refreshMarginMs) ? record : undefined
  }

  /**
   * Publish a completed upload unless another process already published a reusable mapping.
   * @param candidate - completed remote upload.
   * @param now - current Unix time in milliseconds.
   * @param refreshMarginMs - minimum reusable remaining lifetime.
   * @returns the winning record and whether the candidate entered the index.
   */
  async commit(
    candidate: SystemPromptUploadRecord,
    now: number,
    refreshMarginMs: number,
  ): Promise<{ record: SystemPromptUploadRecord; accepted: boolean }> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
    return withFileLock(this.path, async () => {
      const index = await this.load()
      const existing = index.records.find(record => (
        record.scope === candidate.scope
        && record.variantId === candidate.variantId
        && reusable(record, now, refreshMarginMs)
      ))
      if (existing !== undefined) return { record: existing, accepted: false }
      const records = index.records.filter(record => (
        reusable(record, now, refreshMarginMs)
        && !(record.scope === candidate.scope && record.variantId === candidate.variantId)
      ))
      records.push(candidate)
      await this.save({ formatVersion: 1, records })
      return { record: candidate, accepted: true }
    })
  }

  /**
   * Remove one exact mapping without deleting a concurrently installed successor.
   * @param scope - endpoint/API-key namespace.
   * @param variantId - prompt revision digest.
   * @param fileId - exact rejected remote id.
   */
  async remove(
    scope: SystemPromptFileScopeType,
    variantId: string,
    fileId: SystemPromptFileIdType,
  ): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
    await withFileLock(this.path, async () => {
      const index = await this.load()
      const records = index.records.filter(record => !(
        record.scope === scope && record.variantId === variantId && record.fileId === fileId
      ))
      if (records.length !== index.records.length) await this.save({ formatVersion: 1, records })
    })
  }
}
