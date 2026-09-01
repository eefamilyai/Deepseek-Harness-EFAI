/**
 * ModelSelect's injected face. The target 'conversation.input.model' seat is
 * declared (children table) and typed by ui-conversation's composer-bar
 * entry; this package only contributes the single occupant, so no SlotMap
 * merge lives here.
 */
import type { ModelSelection } from '@deepseek-ai/dsh-api-remotes/client'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ModelDirectoryState } from './directory.ts'

/** Injected business face of the composer model seat. */
export interface ModelSelectInjected {
  /** Whether this session supports Agent-bound model inspection and selection. */
  available: boolean
  /** The session's shared directory store (same instance the /model popup reads). */
  directory: SnapshotStore<ModelDirectoryState>
  /** Ensure the shared advisory catalog is loaded (errors land on the store). */
  load: () => void
  /**
   * Select a complete provider/model/reasoning selection.
   * @param selection - model selection and optional adapter-owned effort.
   * @returns whether the host accepted the selection.
   */
  select: (selection: ModelSelection) => Promise<boolean>
  /**
   * Test and add a login for an account-pooling provider (DeepSeek web). On
   * success the new account becomes a selectable route, and the directory
   * reloads so the chips show it. The password is used only for the test.
   * @param provider - the pooling provider route.
   * @param draft - the login to test.
   * @returns whether it was added, and the failure reason otherwise.
   */
  addAccount: (
    provider: string,
    draft: Readonly<{ email?: string; mobile?: string; areaCode?: string; password: string }>,
  ) => Promise<{ ok: boolean; account?: string; message?: string }>
}
