/** Localized copy adapters for Cordis-free Markdown primitives. */

// DSH-FORK(brand): fork edit on an upstream-owned file. EXIT: a fork-owned client package owns these labels.
import { requestRunInTerminal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MarkdownLabels } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChatViewSlotProps } from './contract/slots.ts'

/**
 * Build the complete Markdown chrome copy for one locale revision.
 * @param t - Chat locale seat.
 * @returns Labels for code fences and footnotes.
 */
export function markdownLabels(t: ChatViewSlotProps['t']): MarkdownLabels {
  return {
    code: { copyLabel: t('copy'), copiedLabel: t('copied'), runLabel: t('run'), downloadLabel: t('download'), onRun: requestRunInTerminal },
    footnotes: t('markdown.footnotes'),
  }
}
