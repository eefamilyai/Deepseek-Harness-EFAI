/**
 * Provider-group keyboard and pointer affordances for the model dropdown.
 *
 * The sheet beside this module contracts every provider group except the one in
 * use, and leaves hover and focus as the way to open the others. That is enough to
 * look right and not enough to use: a group has to open on a click or a key, and a
 * contracted group must not leave its rows in the arrow-key order, where upstream's
 * roving focus would land on rows the operator cannot see.
 *
 * This module adds both, and adds nothing else. It reads the contract the group
 * primitive publishes — `data-menu-group` on the section, `data-menu-group-heading`
 * on its title, `menuitemradio` rows inside — and never touches upstream's element
 * identity, its classes, or its React state. A deployment whose menu lacks those
 * attributes gets the stylesheet alone: no headings are wired and the arrow keys
 * are left to the component.
 *
 * Rows are hidden by CSS, so this module cannot mark them `disabled` or
 * `tabindex="-1"`: React owns both properties and would overwrite them on its next
 * render. Instead the arrow keys are intercepted on the menu container and moved
 * between the rows that are actually visible, which is a no-op while every group is
 * open.
 */

/** Attribute the group primitive puts on each provider section. */
const GROUP = 'data-menu-group'

/** Attribute the group primitive puts on the section's title. */
const HEADING = 'data-menu-group-heading'

/** Keys that move the roving focus. */
const STEPS: Readonly<Record<string, number>> = { ArrowDown: 1, ArrowUp: -1 }

/** Whether a row is actually on screen, which `display: none` rows are not. */
function visible(row: HTMLElement): boolean {
  return row.offsetParent !== null
}

/** Flip one group, letting the sheet's `:has()` rule follow the heading's state. */
function toggle(heading: HTMLElement): void {
  const open = heading.getAttribute('aria-expanded') === 'true'
  heading.setAttribute('aria-expanded', open ? 'false' : 'true')
}

/**
 * Wire one title as a toggle, once.
 * @param group - the provider section.
 * @returns nothing; the listeners live as long as the section does.
 */
function wire(group: HTMLElement): void {
  const heading = group.querySelector<HTMLElement>(`:scope > [${HEADING}]`)
  if (heading === null || heading.dataset.dshGroupWired === 'true') return
  heading.dataset.dshGroupWired = 'true'
  heading.setAttribute('role', 'button')
  heading.setAttribute('tabindex', '0')
  // Undefined means "not chosen yet": the sheet contracts the group unless its row
  // is the checked one, and the first click decides from there.
  heading.addEventListener('click', () => { toggle(heading) })
  heading.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    toggle(heading)
  })
}

/**
 * Move the roving focus between visible rows, wrapping at the ends.
 *
 * Upstream keeps its own order over every rendered row, including the contracted
 * ones, so its handler would step onto rows the sheet has hidden. This one runs in
 * the capture phase and stops the event only when it actually moved: with nothing
 * contracted it finds the same next row upstream would and stays out of the way.
 * @param menu - the element carrying `role="menu"`.
 * @param step - +1 for the next row, -1 for the previous.
 * @returns whether focus moved.
 */
function step(menu: HTMLElement, step: number): boolean {
  // Every row is a button: model rows carry `menuitemradio`, account rows drill in
  // as plain buttons. Group headings are divs, so they never enter this list.
  const rows = [...menu.querySelectorAll<HTMLElement>('button')].filter(visible)
  if (rows.length === 0) return false
  const current = rows.findIndex(row => row === document.activeElement)
  if (current < 0) return false
  const next = rows[(current + step + rows.length) % rows.length]
  if (next === undefined) return false
  next.focus()
  return true
}

/**
 * Wire every provider group inside one menu, and keep its arrow keys honest.
 * @param menu - the element carrying `role="menu"`.
 * @returns nothing; the listener lives as long as the element does.
 */
function wireMenu(menu: HTMLElement): void {
  if (menu.dataset.dshGroupKeys === 'true') return
  menu.dataset.dshGroupKeys = 'true'
  for (const group of menu.querySelectorAll<HTMLElement>(`:scope > [${GROUP}]`)) wire(group)
  menu.addEventListener('keydown', (event) => {
    const delta = STEPS[event.key]
    if (delta === undefined) return
    if (step(menu, delta)) event.stopPropagation()
  }, true)
}

/**
 * Watch the document for model menus and wire each one as it appears.
 *
 * The dropdown is portalled to the document body and unmounted when it closes, so
 * there is nothing to subscribe to and nothing to hold: every scan is idempotent,
 * and disposal only stops the observer.
 * @returns disposer that disconnects the observer.
 */
export function installModelGroups(): () => void {
  const scan = (root: ParentNode): void => {
    for (const menu of root.querySelectorAll<HTMLElement>('[role="menu"]')) wireMenu(menu)
  }
  scan(document)
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node instanceof HTMLElement) scan(node.matches('[role="menu"]') ? node.parentNode ?? document : node)
      }
    }
  })
  observer.observe(document.body, { childList: true, subtree: true })
  return () => { observer.disconnect() }
}
