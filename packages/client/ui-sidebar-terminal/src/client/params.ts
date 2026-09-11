/**
 * The `terminal` page kind's navigation parameters.
 *
 * A run-in-terminal request is a navigation: the chat's Run button opens the
 * terminal tab carrying the code block, and the body executes whatever the
 * latest navigation delivered. Declaring the shape here is what types
 * `openTab('terminal', { params })` for every caller.
 */
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'

declare module '@deepseek-ai/dsh-client-ui-sidebar-right/client' {
  interface SidebarRightTabParamsMap {
    /** One code block to run, with the nonce that makes a re-run a new navigation. */
    terminal: {
      /** The exact multi-line command block to run, line by line. */
      readonly code: string
      /** Bumped per request so running the same block twice is two navigations. */
      readonly nonce: number
    }
  }
}
