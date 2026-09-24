/**
 * Upload-once, reuse-until-rejected delivery of a system prompt as a provider file.
 *
 * The prompt is the largest fixed block in every request. Uploading it once and
 * referencing the returned id keeps that block out of the token stream while the
 * provider still resolves the same bytes. The id is cached against a digest of
 * the exact prompt revision, so a changed prompt uploads again and an unchanged
 * one never does.
 *
 * `deliver` returns the caller's inline text whenever it cannot produce a
 * *reachable* file reference. A file the model cannot open is worse than inline
 * text, so every failure — no endpoint, transport error, malformed response —
 * degrades to inline and never raises.
 * @module dsh-llm-system-file/store
 */

import { createHash } from 'node:crypto'
import type { SystemPromptFileId } from './file-id.ts'
import { SystemPromptFilesClient } from './files-api.ts'
import { promptVariantId, systemPromptFileScope, SystemPromptUploadIndex } from './upload-index.ts'
import type { SystemPromptUploadRecord } from './upload-index.ts'

/** Default lifetime requested for an uploaded prompt file. */
export const DEFAULT_FILE_EXPIRY_SECONDS = 2_592_000
/** A mapping is not reused when less than this much lifetime remains. */
export const DEFAULT_REFRESH_MARGIN_SECONDS = 86_400

/** Provider route facts needed to upload and reference a file. */
export interface SystemPromptConnection {
  /** Provider schema id, e.g. `openai` or `anthropic`. */
  schema: string
  baseURL: string
  apiKey: string
}

/** Resolved lifetime policy for prompt files. */
export interface SystemPromptFilePolicy {
  expiresAfterSeconds: number
  refreshMarginSeconds: number
}

/** Outcome of one delivery attempt. */
export interface SystemPromptDelivery {
  /** Text to send in the system slot. */
  text: string
  /** Provider file id when the prompt is delivered as a file. */
  fileId?: SystemPromptFileId
  /** Uploaded filename when the prompt is delivered as a file. */
  filename?: string
}

interface StoreOptions {
  index?: SystemPromptUploadIndex
  now?: () => number
  fetch?: typeof fetch
}

/** Shortest prompt worth an upload round trip. */
export const MIN_PROMPT_CHARS = 0

/**
 * Content-addressed filename for one prompt revision.
 * @param schema - provider schema id, part of the identity.
 * @param text - exact prompt text.
 * @returns a stable `.md` filename.
 */
export function promptFilename(schema: string, text: string): string {
  const digest = createHash('sha256').update(text).digest('hex').slice(0, 16)
  return `dsh-system-prompt-${schema}-${digest}.md`
}

/**
 * Whether a schema's system slot can carry a file reference at all.
 * @param schema - provider schema id.
 * @returns true when the prompt may be delivered as a file.
 */
export function supportsSystemFile(schema: string): boolean {
  return schema === 'openai' || schema === 'anthropic'
}

/** Upload-once provider-file delivery for the system prompt. */
export class SystemPromptFileStore {
  private readonly index: SystemPromptUploadIndex
  private readonly now: () => number
  private readonly fetchImpl: typeof fetch | undefined

  /**
   * @param options - testable index, clock, and transport boundaries.
   */
  constructor(options: StoreOptions = {}) {
    this.index = options.index ?? new SystemPromptUploadIndex()
    this.now = options.now ?? Date.now
    this.fetchImpl = options.fetch
  }

  /**
   * Resolve the prompt to file-backed delivery, or fall back to the inline text.
   * @param text - the assembled system prompt.
   * @param connection - provider route facts.
   * @param policy - lifetime policy; defaults apply when omitted.
   * @returns inline text plus, when reachable, the provider file reference.
   */
  async deliver(
    text: string,
    connection: SystemPromptConnection,
    policy: Partial<SystemPromptFilePolicy> = {},
  ): Promise<SystemPromptDelivery> {
    try {
      if (text.trim().length === 0) return { text }
      if (text.length < MIN_PROMPT_CHARS) return { text }
      if (!supportsSystemFile(connection.schema)) return { text }
      if (connection.baseURL.trim().length === 0) return { text }

      const expiresAfterSeconds = policy.expiresAfterSeconds ?? DEFAULT_FILE_EXPIRY_SECONDS
      const refreshMarginSeconds = policy.refreshMarginSeconds ?? DEFAULT_REFRESH_MARGIN_SECONDS
      const filename = promptFilename(connection.schema, text)
      const variantId = promptVariantId(connection.schema, text)
      const scope = systemPromptFileScope(connection.baseURL, connection.apiKey)
      const marginMs = refreshMarginSeconds * 1_000

      const cached = await this.index.get(scope, variantId, this.now(), marginMs)
      if (cached !== undefined) {
        return { text: this.instruction(filename, cached.fileId), fileId: cached.fileId, filename }
      }

      const client = new SystemPromptFilesClient({
        baseURL: connection.baseURL,
        apiKey: connection.apiKey,
        ...this.fetchImpl === undefined ? {} : { fetch: this.fetchImpl },
      })
      const data = new TextEncoder().encode(text)
      const remote = await client.upload({ data, filename, expiresAfterSeconds })
      const candidate: SystemPromptUploadRecord = {
        scope,
        variantId,
        fileId: remote.id,
        bytes: remote.bytes,
        createdAt: remote.createdAt * 1_000,
        expiresAt: remote.expiresAt * 1_000,
      }
      const committed = await this.index.commit(candidate, this.now(), marginMs)
      const fileId = committed.record.fileId
      return { text: this.instruction(filename, fileId), fileId, filename }
    } catch {
      // A provider that cannot store the prompt still gets the prompt.
      return { text }
    }
  }

  /**
   * Forget a mapping the provider rejected so the next turn uploads again.
   * @param connection - provider route facts.
   * @param text - exact prompt text that was rejected.
   * @param fileId - the rejected provider file id.
   * @returns whether a mapping was removed.
   */
  async invalidate(
    connection: SystemPromptConnection,
    text: string,
    fileId: SystemPromptFileId,
  ): Promise<boolean> {
    try {
      const scope = systemPromptFileScope(connection.baseURL, connection.apiKey)
      const variantId = promptVariantId(connection.schema, text)
      const before = await this.index.get(scope, variantId, 0, 0)
      if (before === undefined || before.fileId !== fileId) return false
      await this.index.remove(scope, variantId, fileId)
      return true
    } catch {
      return false
    }
  }

  /** Inline replacement naming the file the model must read. */
  private instruction(filename: string, fileId: SystemPromptFileId): string {
    return `Your system prompt is attached as a file named '${filename}' `
      + `(provider file id '${fileId}'). Read that file before acting: it holds your identity, `
      + 'your operating rules, and your tool guidance. None of it is repeated inline.'
  }
}
