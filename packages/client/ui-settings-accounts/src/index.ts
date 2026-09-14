/**
 * Host loader entry for the browser implementation exported from `./client`.
 *
 * The Accounts section talks to the Host entirely through the `llm` Remote
 * namespace, so this host half registers nothing of its own.
 */

/** Host plugin body — no host-side behavior for this surface plugin. */
export function apply(): void {}
