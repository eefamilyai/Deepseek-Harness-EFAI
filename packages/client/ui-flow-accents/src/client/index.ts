/**
 * Flow-accent theme tokens, browser half.
 *
 * Registers one theme override layer carrying the fork's per-family accent
 * palette. The theme presenter writes every token of the composed snapshot to
 * `document.body` as a CSS custom property, so a layer registered here reaches
 * every stylesheet that reads `var(--dsw-alias-flow-*)` — including the module
 * stylesheets of packages this one does not own.
 *
 * An override layer rather than an edit to `design-platform.css`: the layer is
 * a documented extension point of `@deepseek-ai/dsh-client-ui-theme`, it
 * follows the active palette automatically, and it retracts cleanly when this
 * plugin unmounts.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-theme/client'
import { FLOW_ACCENT_TOKENS } from './tokens.ts'

export { FLOW_ACCENT_TOKENS } from './tokens.ts'

/** Layer identity; one layer per source, and the source names its origin. */
const SOURCE = '@deepseek-ai/dsh-client-ui-flow-accents'

/** The theme registry carries the layer. */
export const inject = ['theme']

/**
 * Register the accent layer for exactly this plugin's lifetime.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.theme.overrideTokens(SOURCE, FLOW_ACCENT_TOKENS), 'ui-flow-accents: token layer')
}
