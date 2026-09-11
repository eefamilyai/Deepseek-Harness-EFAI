/** Chat-owned per-Session view state. */

/** Tool call identity as carried by Chat nodes. */
export type ToolCallId = string

// DSH-FORK(brand): `open` records the reader's explicit choice so a running
// Turn can default to expanded while a finalized one defaults to folded.
// `answerStep` is nullable for the same reason: a choice made while the Turn
// still runs records null, so it survives the Turn pinning its answer step.
// EXIT: upstream gives the folded process row a content-derived label.
/**
 * The reader's explicit open/closed choice for one Turn answer generation.
 *
 * A stored entry is an override. An absent one means the Turn's own default,
 * which is open while the Turn is still running and closed once it finalizes.
 */
export interface TurnProcessViewEntry {
  readonly turn: number
  /**
   * The answer step this choice was made against, or null while the Turn is
   * still running and has no finalized answer yet.
   *
   * Widening past `number` is what lets a reader fold a running Turn at all: a
   * running Turn stores null, and the entry then matches the Turn's own null
   * answer step instead of being discarded as belonging to another generation.
   */
  readonly answerStep: number | null
  readonly open: boolean
}

/** Per-Session state shared only by the Chat view and details surface. */
export interface ChatStoreState {
  turnProcesses: TurnProcessViewEntry[]
}
