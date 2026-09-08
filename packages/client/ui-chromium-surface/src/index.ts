/**
 * Chromium-surface plugin, node half. Pure UI plugin: the empty apply exists so
 * the package appears in the Loader; the browser half ships via exports["./client"],
 * discovered through the package.json dsh.client declaration.
 * @module @deepseek-ai/dsh-client-ui-chromium-surface
 */

/** Host plugin body — no host-side behavior for this client surface. */
export function apply(): void {}
