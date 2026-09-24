/** Branded identifiers for a system-prompt file upload. @module dsh-llm-system-file/file-id */

import type { Branded } from '@deepseek-ai/dsh-brand'

/** Opaque identifier returned by the provider Files API for an uploaded system prompt. */
export type SystemPromptFileId = Branded<'SystemPromptFileId'>

/**
 * Brand a provider-returned file identifier after wire validation.
 * @param id - non-empty Files API identifier.
 * @returns the same string with its provider identity attached at type level.
 */
export function SystemPromptFileId(id: string): SystemPromptFileId {
  return id as SystemPromptFileId
}

/** Non-secret digest identifying one endpoint and API-key file namespace. */
export type SystemPromptFileScope = Branded<'SystemPromptFileScope'>

/**
 * Brand a locally derived namespace digest.
 * @param scope - SHA-256 digest of endpoint and API key.
 * @returns the same string with namespace identity attached at type level.
 */
export function SystemPromptFileScope(scope: string): SystemPromptFileScope {
  return scope as SystemPromptFileScope
}
