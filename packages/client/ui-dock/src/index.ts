/**
 * Host half of the dock plugin — intentionally inert.
 *
 * The dock is a pure client surface; everything with a server side (the
 * user PTY) lives in
 * `@deepseek-ai/dsh-host-sidebar-bridge`. This half exists only so the package
 * presents a node entry to the loader.
 * @module @deepseek-ai/dsh-client-ui-dock
 */

/** Stable Cordis plugin name. */
export const name = 'client-ui-dock'

/** No host behavior; the dock is client-only. */
export function apply(): void {}
