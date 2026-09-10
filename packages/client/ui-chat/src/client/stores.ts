/** Per-Session Chat selection store shared by the transcript and details panel. */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'
import type { TurnProcessGeneration } from './contract/turn-process.ts'
import type { ChatStoreState, SelectionTarget, TurnProcessViewEntry } from './contract/store.ts'

type ChatActions = {
  select: (draft: ChatStoreState, target: SelectionTarget | null) => void
  setTurnProcessOpen: (
    draft: ChatStoreState,
    turn: number,
    generation: TurnProcessGeneration,
    open: boolean,
  ) => void
}

/**
 * Resolve any stored generation for one Turn.
 * @param state - Chat store snapshot.
 * @param turn - owning Turn.
 * @returns the Turn's stored entry, when present.
 */
export function storedTurnProcessEntry(
  state: Readonly<ChatStoreState>,
  turn: number,
): Readonly<TurnProcessViewEntry> | undefined {
  return state.turnProcesses.find(entry => entry.turn === turn)
}

/**
 * Create the Chat selection store handle.
 * @returns a handle instantiated once per rendered Session scope.
 */
export function createChatStore(): EngineStoreHandle<ChatStoreState, ChatActions> {
  return defineStore({
    init: (): ChatStoreState => ({ selection: null, turnProcesses: [] }),
    actions: {
      select: (draft, target: SelectionTarget | null) => { draft.selection = target },
      // DSH-FORK(brand): a close is recorded, not deleted. Deleting it would
      // return the Turn to its default, so a reader could never fold a running
      // Turn. EXIT: upstream gives the folded process row a content-derived
      // label.
      setTurnProcessOpen: (draft, turn, generation, open) => {
        const index = draft.turnProcesses.findIndex(entry => entry.turn === turn)
        const next = { turn, generation, open } satisfies TurnProcessViewEntry
        if (index < 0) draft.turnProcesses.push(next)
        else draft.turnProcesses[index] = next
      },
    },
  })
}
