/**
 * The terminal tab's chip title.
 *
 * A terminal's name is its type, not the address it was opened under, so the
 * chip shows the label the registry captured at open time rather than a
 * composed page address.
 * @module @deepseek-ai/dsh-client-ui-sidebar-terminal/client/TerminalTitle
 */

import type { ReactNode } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'

/**
 * The title as the chip and a floating panel's header show it.
 * @param props - the tab information hook.
 * @returns the tab's title text.
 */
export function TerminalTitle({ useTabInfo }: PropsRuntime<'sidebar.right.pane.tab.title'>): ReactNode {
  const { tab } = useTabInfo()
  return tab.title
}
