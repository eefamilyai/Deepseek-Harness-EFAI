/** Deliver a system prompt as an uploaded provider file. @module dsh-llm-system-file */

// DSH-FORK(system-file): the decorator that applies the store to a live request.
export { SystemPromptFileAdapter } from './adapter.ts'
export type { SystemPromptConnectionResolver, SystemPromptFileAdapterOptions } from './adapter.ts'

export { SystemPromptFileId, SystemPromptFileScope } from './file-id.ts'
export type { SystemPromptFileId as SystemPromptFileIdType } from './file-id.ts'
export {
  DEFAULT_FILE_EXPIRY_SECONDS,
  DEFAULT_REFRESH_MARGIN_SECONDS,
  MIN_PROMPT_CHARS,
  SystemPromptFileStore,
  promptFilename,
  supportsSystemFile,
} from './store.ts'
export type {
  SystemPromptConnection,
  SystemPromptDelivery,
  SystemPromptFilePolicy,
} from './store.ts'
export {
  MAX_FILE_UPLOAD_BYTES,
  MIN_FILE_EXPIRY_SECONDS,
  MAX_FILE_EXPIRY_SECONDS,
  SystemPromptFilesClient,
} from './files-api.ts'
export {
  SystemPromptUploadIndex,
  promptVariantId,
  systemPromptFileScope,
} from './upload-index.ts'
export type { SystemPromptUploadRecord } from './upload-index.ts'
