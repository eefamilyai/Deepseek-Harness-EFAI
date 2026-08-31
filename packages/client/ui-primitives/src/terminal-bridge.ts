/** Run-in-terminal bridge between chat code blocks and the dock's terminal.
 *
 * `ui-primitives` is cordis-free and must not import the dock, so the Run
 * affordance talks through a window CustomEvent. The dock package is the only
 * listener; any environment without the dock mounted simply ignores the event.
 * Nothing runs without an explicit user click on the Run button, and the event
 * carries only the plain-text code payload.
 */

/** CustomEvent type name. Shared by producer (CodeBlock) and consumer (ui-dock). */
export const RUN_IN_TERMINAL_EVENT = 'dsh:run-in-terminal'

/**
 * Ask the dock terminal to run `code` in the current chat's shell.
 * No-op when the dock is absent or the payload is empty.
 * @param code - the exact plain-text code to execute.
 */
export function requestRunInTerminal(code: string): void {
  if (code.trim() === '') return
  window.dispatchEvent(new CustomEvent<string>(RUN_IN_TERMINAL_EVENT, { detail: code }))
}
