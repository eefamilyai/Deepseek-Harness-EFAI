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

/**
 * The row's body. The stylesheet is the whole plugin — evaluating this module is
 * what injects it — so there is nothing to register and no service to wait for.
 */
export function apply(): void {}
