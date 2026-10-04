/**
 * Re-place the app's anchored card after this plugin changed its height.
 *
 * `ui-model-selection` places the dropdown from its trigger's rect and the card's own
 * measured height, in a layout effect that re-runs on a pane or query change, a page
 * scroll, and a window resize. This plugin changes that height without React knowing —
 * it contracts every provider group but the one in use, folds an account pool into one
 * row of choices, and opens a group on a click — so the card keeps the position it was
 * given for the height it had first, and floats above the composer by exactly the rows
 * the contraction removed.
 *
 * The resize event is the app's own signal for "measure me again", and it is the only
 * one available here: the plugin holds no React state and must not reach into the
 * component's placement. Dispatching it right after the change means the card is placed
 * once, from the height it now has.
 */

/**
 * Ask the app to re-measure and re-place the card this plugin changed.
 * @param menu - the menu element whose height this plugin changed.
 */
export function reanchorMenu(menu: HTMLElement): void {
  // A menu already unmounted has nothing to place, and a stale element must not make
  // every other anchored overlay in the app re-measure for it.
  if (!menu.isConnected) return
  window.dispatchEvent(new Event('resize'))
}
