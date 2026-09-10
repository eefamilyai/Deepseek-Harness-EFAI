/** Chat-owned selection state shared by the transcript and details panel. */

import type { TurnProcessGeneration } from './turn-process.ts'

/** Tool call identity as carried by Chat nodes. */
export type ToolCallId = string

/** Selection target for the Chat details linkage channel. */
export interface SelectionTarget {
  turnSeq: number
  stepSeq?: number
  callId?: ToolCallId
  toolName?: string
}

// DSH-FORK(brand): `open` records the reader's explicit choice so a running
// Turn can default to expanded while a finalized one defaults to folded.
// EXIT: upstream gives the folded process row a content-derived label.
/**
 * The reader's explicit open/closed choice for one Turn answer generation.
 *
 * A stored entry is an override. An absent one means the Turn's own default,
 * which is open while the Turn is still running and closed once it finalizes.
 */
export interface TurnProcessViewEntry {
  readonly turn: number
  readonly generation: TurnProcessGeneration
  readonly open: boolean
}

/** Per-Session state shared only by the Chat view and details surface. */
export interface ChatStoreState {
  selection: SelectionTarget | null
  turnProcesses: TurnProcessViewEntry[]
}
