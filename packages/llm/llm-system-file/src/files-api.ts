/**
 * Minimal OpenAI-compatible `/files` upload used by the system-prompt file store.
 *
 * Only upload is needed: the store never lists or retrieves, because a rejected
 * id is answered by re-uploading rather than by repairing the old object.
 * @module dsh-llm-system-file/files-api
 */

import { attributionHeaders, LlmError } from '@deepseek-ai/dsh-llm'
import { SystemPromptFileId } from './file-id.ts'
import type { SystemPromptFileId as SystemPromptFileIdType } from './file-id.ts'

/** Minimum provider-supported file lifetime. */
export const MIN_FILE_EXPIRY_SECONDS = 3_600
/** Maximum provider-supported file lifetime. */
export const MAX_FILE_EXPIRY_SECONDS = 2_592_000
/** Maximum upload size for one text file. */
export const MAX_FILE_UPLOAD_BYTES = 128 * 1024 * 1024

/** Validated file object returned by the upload endpoint. */
export interface UploadedFileObject {
  id: SystemPromptFileIdType
  bytes: number
  createdAt: number
  expiresAt: number
}

interface FilesApiOptions {
  baseURL: string
  apiKey: string
  fetch?: typeof fetch
}

interface WireFileObject {
  id?: unknown
  object?: unknown
  bytes?: unknown
  created_at?: unknown
  expires_at?: unknown
}

function invalidResponse(): LlmError {
  return new LlmError('provider Files API returned an invalid upload response.', 'INVALID_RESPONSE')
}

function parseUpload(value: unknown): UploadedFileObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw invalidResponse()
  const wire = value as WireFileObject
  if (typeof wire.id !== 'string' || wire.id.length === 0
    || wire.object !== 'file'
    || !Number.isSafeInteger(wire.bytes) || (wire.bytes as number) < 0
    || !Number.isSafeInteger(wire.created_at) || (wire.created_at as number) < 0
    || !Number.isSafeInteger(wire.expires_at) || (wire.expires_at as number) < 0) {
    throw invalidResponse()
  }
  return {
    id: SystemPromptFileId(wire.id),
    bytes: wire.bytes as number,
    createdAt: wire.created_at as number,
    expiresAt: wire.expires_at as number,
  }
}

/** Upload-only client for an OpenAI-compatible `/files` endpoint. */
export class SystemPromptFilesClient {
  private readonly baseURL: string
  private readonly apiKey: string
  private readonly fetchImpl: typeof fetch

  /**
   * @param options - endpoint, credential snapshot, and optional test transport.
   */
  constructor(options: FilesApiOptions) {
    this.baseURL = options.baseURL.replace(/\/+$/u, '')
    this.apiKey = options.apiKey
    this.fetchImpl = options.fetch ?? globalThis.fetch
  }

  /**
   * Upload one text file with an explicit expiry.
   * @param input - file bytes, filename, lifetime, media type, and cancellation.
   * @returns the validated provider file object.
   */
  async upload(input: {
    data: Uint8Array
    filename: string
    expiresAfterSeconds: number
    mediaType?: string
    signal?: AbortSignal
  }): Promise<UploadedFileObject> {
    if (input.data.byteLength > MAX_FILE_UPLOAD_BYTES) {
      throw new LlmError('system prompt file exceeds the 128 MiB upload limit.', 'INVALID_REQUEST')
    }
    if (!Number.isSafeInteger(input.expiresAfterSeconds)
      || input.expiresAfterSeconds < MIN_FILE_EXPIRY_SECONDS
      || input.expiresAfterSeconds > MAX_FILE_EXPIRY_SECONDS) {
      throw new LlmError('file expiry must be between 3600 and 2592000 seconds.', 'INVALID_REQUEST')
    }
    const form = new FormData()
    form.set('purpose', 'user_data')
    form.set('expires_after[anchor]', 'created_at')
    form.set('expires_after[seconds]', String(input.expiresAfterSeconds))
    form.set(
      'file',
      new Blob([Uint8Array.from(input.data).buffer], { type: input.mediaType ?? 'text/markdown' }),
      input.filename,
    )
    let response: Response
    try {
      const headers = new Headers(attributionHeaders())
      headers.set('authorization', `Bearer ${this.apiKey}`)
      response = await this.fetchImpl(`${this.baseURL}/files`, {
        method: 'POST',
        headers,
        body: form,
        ...input.signal === undefined ? {} : { signal: input.signal },
      })
    } catch (error: unknown) {
      if (input.signal?.aborted) throw error
      throw new LlmError('file upload request failed', 'TRANSPORT', { cause: error })
    }
    if (!response.ok) {
      throw new LlmError(`file upload failed (HTTP ${response.status})`, 'FILES_API', { status: response.status })
    }
    return parseUpload(await response.json())
  }
}
