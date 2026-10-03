/**
 * Interaction polish, browser half.
 *
 * One injected stylesheet and no registrations: every rule selects on a contract
 * that outlives a component — design tokens, ARIA roles and states, the app
 * frame's state attributes, element selectors — so the layer keeps working
 * across the whole component tree without knowing any of it.
 *
 * The sheet is a client-bundle asset rather than a theme layer: the theme
 * service writes `--dsw-*` values, and this layer also retunes the shell's
 * `--ds-*` motion scale, paints materials, and animates overlays — none of which
 * the token registry expresses.
 */
// Tagged style injection owned by the client bundle: imported for its effect,
// deduplicated by the build's `data-plugin-css` tag.
import './polish.css'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { installModelGroups } from './model-groups.ts'

/**
 * The row's body: inject the stylesheet and install the model menu's group keys.
 *
 * Evaluating this module is what injects the sheet. The enhancer is one document
 * observer with no service to wait for, so it installs here too and its disposer
 * goes on the caller's fiber — a client row that is unloaded must leave no
 * observer behind.
 *
 * @param ctx - client root context, used only to scope the observer to this row.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => installModelGroups(), 'ui-polish: model group keys')
}
