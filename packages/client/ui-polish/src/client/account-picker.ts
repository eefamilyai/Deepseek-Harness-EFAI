/**
 * The model dropdown's account pool as one row of choices.
 *
 * A deployment that pools several logins for one provider registers one route per
 * login, and the dropdown lists them as sibling provider groups: ten sections whose
 * titles differ only by the account inside them and whose rows are the same handful
 * of models. The operator asked for the other arrangement — one provider, one row of
 * account choices, then the models — so this module folds the pool.
 *
 * The pool is read from the group titles rather than from a provider name: a section
 * is the base route when its title is another section's title followed by a
 * parenthesised account. `DeepSeek (free web)` beside `DeepSeek (free web) (…+hunt@…)`
 * is that relation, and a provider that pools nothing has no such pair, so it keeps
 * upstream's rendering untouched.
 *
 * The group holding the checked row — the route in use, and the group the sheet
 * already opens — keeps its place and gains the row. Every other pool group is
 * hidden, never moved or rebuilt, so its rows stay in the document and one choice is
 * a click on the row the operator would otherwise have picked: upstream's own
 * `choose()` runs, and the account and the model stay two halves of one selection.
 */

import { reanchorMenu } from './menu-anchor.ts'

/** Attribute the group primitive puts on each provider section. */
const GROUP = 'data-menu-group'

/** Attribute the group primitive puts on a section's title. */
const HEADING = 'data-menu-group-heading'

/** Attribute this module puts on the row of choices it builds. */
const PICKER = 'data-dsh-picker'

/** Attribute this module puts on every pool route it hides. */
const HIDDEN = 'data-dsh-pool-hidden'

/** Copy the row of choices needs, localized by the owning plugin. */
export interface AccountPickerCopy {
  /** Accessible name for the row of account choices. */
  readonly legend?: string
  /** Label for the pool's unpinned route, which no account names. */
  readonly auto?: string
}

/** One route of a provider's account pool. */
interface Route {
  /** The provider section this choice selects. */
  readonly section: HTMLElement
  /** The title upstream rendered for the section. */
  readonly title: string
  /** The choice's own text. */
  readonly label: string
}

/** The routes one provider serves: the unpinned base route and the logins pinning it. */
interface Pool {
  /** The route that pins no account, which is where the row of choices goes. */
  readonly base: Route
  /** The pinned routes, in render order. */
  readonly accounts: readonly Route[]
}

/**
 * The section's own heading, which is the one child the group primitive names.
 * @param section - a provider section.
 * @returns the heading element, or null when this section was not rendered by the primitive.
 */
function headingOf(section: HTMLElement): HTMLElement | null {
  return section.querySelector<HTMLElement>(`:scope > [${HEADING}]`)
}

/**
 * The title upstream rendered for one provider section.
 *
 * Cached on the section's dataset (`data-dsh-account-title`), because this module
 * rewrites the heading it keeps: reading live titles again would parse that rewrite as a
 * second base route.
 * @param section - a provider section.
 * @returns the rendered title, or null when the section has no heading or an empty one.
 */
function titleOf(section: HTMLElement): string | null {
  const cached = section.dataset.dshAccountTitle
  if (cached !== undefined) return cached
  const title = headingOf(section)?.textContent.trim() ?? ''
  if (title === '') return null
  section.dataset.dshAccountTitle = title
  return title
}

/**
 * Characters one fixed cell shows before a label keeps only its tail.
 *
 * A cell is `4.5rem` wide at an 11px label, which holds about ten characters. A longer
 * name is not cut by the cell's own ellipsis: that keeps the *front*, so two logins
 * sharing a long prefix (`deepseek.ee.1@…` beside `deepseek.ee.2@…`) would read
 * identically. Keeping the tail with a leading ellipsis marks the name as shortened and
 * leaves the part that tells two logins apart.
 */
const LABEL_BUDGET = 10

/**
 * The account's own name, as its choice shows it.
 *
 * Kiln labels a pooled login by its address, and an operator distinguishes the pool by
 * the tag after `+`: `deepseek.ee.1+hunt@gmail.com` is the account they call `hunt`. A
 * login that carries no tag has only its address to be named by — the base account an
 * operator authenticates with, or a mobile number — so that address is the label, and
 * one too long for a cell keeps its tail (`…ee.1`). A leading `+` is a country code, not
 * a tag. The choice's tooltip always carries the route's full name.
 * @param account - the text between the base title's parentheses.
 * @returns the short label.
 */
function loginName(account: string): string {
  const at = account.indexOf('@')
  const address = at < 0 ? account : account.slice(0, at)
  // The tag follows the address, so a `+` at the front is a dialling code and not one.
  const tag = address.indexOf('+', 1)
  const label = tag < 0 ? address : address.slice(tag + 1)
  return label.length <= LABEL_BUDGET ? label : `…${label.slice(-(LABEL_BUDGET - 1))}`
}

/**
 * Whether a route's parenthesised text is a login rather than a route of its own.
 *
 * An account route is named by appending the login to the route it pins, so a nested
 * route reads as two parenthesised groups — `DeepSeek (free web) (…+hunt@…)` — and only
 * the innermost text is a login. Reading the outer text as a login too would put the
 * free web route inside the plain `DeepSeek` route's pool, hide it, and relabel the
 * group on screen with the wrong provider's name.
 * @param inner - the text between a candidate base route's parentheses.
 * @returns true when the text carries no further parenthesised group.
 */
function isLogin(inner: string): boolean {
  return !inner.includes('(') && !inner.includes(')')
}

/**
 * Read a provider's account pool out of one menu's groups.
 * @param sections - the menu's own provider sections, in render order.
 * @param copy - the owning plugin's localized copy.
 * @returns the pool, or null when no provider is served once per login.
 */
function readPool(sections: readonly HTMLElement[], copy: AccountPickerCopy): Pool | null {
  const titled = sections.flatMap((section) => {
    const title = titleOf(section)
    return title === null ? [] : [{ section, title }]
  })
  let widest: { section: HTMLElement; title: string; accounts: readonly { section: HTMLElement; title: string }[] } | null = null
  for (const candidate of titled) {
    const prefix = `${candidate.title} (`
    const accounts = titled
      .filter(other => other.title.startsWith(prefix) && other.title.endsWith(')'))
      .filter(other => isLogin(other.title.slice(prefix.length, -1)))
    // Two routes naming one login is a pool; one is a provider whose title happens to
    // prefix another's. The widest pool wins, so an account route cannot take the base
    // slot and lose the unpinned route behind its own title.
    if (accounts.length < 2) continue
    if (widest !== null && accounts.length <= widest.accounts.length) continue
    widest = { ...candidate, accounts }
  }
  if (widest === null) return null
  const prefix = `${widest.title} (`
  return {
    base: { section: widest.section, title: widest.title, label: copy.auto ?? widest.title },
    accounts: widest.accounts.map(account => ({
      section: account.section,
      title: account.title,
      label: loginName(account.title.slice(prefix.length, -1)),
    })),
  }
}

/**
 * The row upstream marked as current, ignoring this module's own choices.
 * @param menu - the element carrying `role="menu"`.
 * @returns the checked row, or null when nothing in the menu is selected.
 */
function checkedRow(menu: HTMLElement): HTMLElement | null {
  for (const row of menu.querySelectorAll<HTMLElement>('[role="menuitemradio"][aria-checked="true"]')) {
    if (row.closest(`[${PICKER}]`) === null) return row
  }
  return null
}

/**
 * The row that serves one model under one route, or the route's first usable row.
 * @param section - the route's provider section.
 * @param model - the name of the model in use, or null when the menu has no checked row.
 * @returns the row to click, or null when the route renders no selectable row.
 */
function rowFor(section: HTMLElement, model: string | null): HTMLButtonElement | null {
  const rows = [...section.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')]
    .filter(row => row.closest(`[${PICKER}]`) === null && !row.disabled)
  return rows.find(row => row.title === model) ?? rows[0] ?? null
}

/**
 * Show the clicked choice as the current one, before the selection settles.
 * @param picker - the row of choices.
 * @param choice - the clicked choice.
 * @returns nothing.
 */
function mark(picker: HTMLElement, choice: HTMLElement): void {
  for (const bubble of picker.children) {
    if (bubble instanceof HTMLElement) bubble.setAttribute('aria-checked', String(bubble === choice))
  }
}

/**
 * Build one choice per pool route, the route in use carrying `aria-checked`.
 * @param routes - the pool's routes, the base route first.
 * @param marked - the route in use, or null when the pool holds no checked row.
 * @param current - the row upstream marked as current, whose model a choice keeps.
 * @param copy - the owning plugin's localized copy.
 * @returns the row of choices, not yet placed.
 */
function build(
  routes: readonly Route[], marked: Route | null, current: HTMLElement | null, copy: AccountPickerCopy,
): HTMLElement {
  const model = current?.getAttribute('title') ?? null
  const picker = document.createElement('div')
  picker.setAttribute(PICKER, '')
  picker.setAttribute('role', 'group')
  if (copy.legend !== undefined) picker.setAttribute('aria-label', copy.legend)
  for (const route of routes) {
    const choice = document.createElement('button')
    choice.type = 'button'
    // A menu row, not a new kind of control: upstream marks its own choices
    // `menuitemradio`, and one of these is the same kind of thing.
    choice.setAttribute('role', 'menuitemradio')
    choice.setAttribute('aria-checked', String(route === marked))
    choice.title = route.title
    choice.textContent = route.label
    choice.addEventListener('click', () => {
      mark(picker, choice)
      rowFor(route.section, model)?.click()
    })
    picker.append(choice)
  }
  return picker
}

/**
 * Fold one menu's account pool into a single row of choices, once per rendered menu.
 *
 * The dropdown is portalled to the document body and unmounted when it closes, and the
 * component re-renders its groups whenever the search filters them, so the menu is
 * rebuilt rather than reversed: a menu that already carries the row of choices is one
 * this module has already folded.
 * @param menu - the element carrying `role="menu"` that holds the provider groups.
 * @param copy - the owning plugin's localized copy.
 * @returns nothing.
 */
export function wireAccountPicker(menu: HTMLElement, copy: AccountPickerCopy): void {
  if (menu.querySelector(`[${PICKER}]`) !== null) return
  const pool = readPool([...menu.querySelectorAll<HTMLElement>(`:scope > [${GROUP}]`)], copy)
  if (pool === null) return
  const routes = [pool.base, ...pool.accounts]
  const current = checkedRow(menu)
  const inUse = current?.closest<HTMLElement>(`[${GROUP}]`) ?? null
  // The route in use is the group the sheet opens, so it keeps its rows on screen; a
  // menu whose current model belongs to no pool route opens the base route instead.
  const open = routes.find(route => route.section === inUse) ?? pool.base
  const marked = routes.find(route => route.section === inUse) ?? null
  for (const route of routes) route.section.toggleAttribute(HIDDEN, route !== open)
  const heading = headingOf(open.section)
  if (open !== pool.base && heading !== null) heading.textContent = pool.base.title
  const picker = build(routes, marked, current, copy)
  if (heading === null) open.section.prepend(picker)
  else heading.after(picker)
  // The row of choices takes the space the row in use was occupying, and the component
  // scrolled that row into view before this one existed — with a pool of ten, the models
  // would sit below the fold of a menu the operator has not scrolled yet.
  current?.scrollIntoView({ block: 'nearest' })
  // Hiding nine routes and adding one row changed the card's height under the placement
  // the app ran when it opened, so the card is asked to measure itself again.
  reanchorMenu(menu)
}
