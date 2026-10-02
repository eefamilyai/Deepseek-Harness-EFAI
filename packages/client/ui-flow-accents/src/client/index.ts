/**
 * Flow-accent theme tokens, browser half.
 *
 * Two halves, both fork-owned: the palette (`tokens.ts`) registered as a theme
 * override layer, and the binding sheet (`accents.css`) that puts each family's
 * hue on its rows. Upstream owns the row chrome and reads the palette through
 * `--dsh-row-accent`-shaped custom properties, so the fork contributes the
 * colours and the binding instead of editing the rows.
 *
 * The theme presenter writes every token of the composed snapshot to
 * `document.body` as a CSS custom property, so a layer registered here reaches
 * every stylesheet that reads `var(--dsw-alias-flow-*)` — including the module
 * stylesheets of packages this one does not own. The binding sheet selects on
 * attributes upstream emits for styling (see its own header), never on hashed
 * module classes, so it survives a plugin bundle upstream does not build.
 *
 * An override layer rather than an edit to `design-platform.css`: the layer is
 * a documented extension point of `@deepseek-ai/dsh-client-ui-theme`, it
 * follows the active palette automatically, and it retracts cleanly when this
 * plugin unmounts.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-theme/client'
import { FLOW_ACCENT_TOKENS } from './tokens.ts'
// Tagged style injection owned by the client bundle: imported for its effect,
// deduplicated by the build's `data-plugin-css` tag.
import './accents.css'

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
