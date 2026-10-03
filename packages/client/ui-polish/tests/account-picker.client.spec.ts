// @vitest-environment jsdom
/**
 * The account pool's fold, driven against a menu built the way the dropdown and the
 * group primitive render one: a section per provider, a heading, and `menuitemradio`
 * rows. The behavior under test is the fold the operator asked for — one group, one
 * row of account choices, the models untouched — and the click-through that keeps a
 * choice a click on the row it stands for.
 */
import { describe, expect, it } from 'vitest'
import { wireAccountPicker } from '../src/client/account-picker.ts'

/** The four routes the free web provider serves under every login. */
const MODELS = ['DeepSeek', 'DeepSeek · Thinking', 'DeepSeek · Search', 'DeepSeek · Thinking + Search']

/** The pool a deployment of ten logins renders. */
const ACCOUNTS = [
  'deepseek.ee.1+hunt@gmail.com', 'deepseek.ee.1+v@gmail.com', 'deepseek.ee.1+f@gmail.com',
  'deepseek.ee.1+j1@gmail.com', 'deepseek.ee.1+t1@gmail.com', 'deepseek.ee.1+t2@gmail.com',
  'deepseek.ee.1+d1@gmail.com', 'deepseek.ee.1+claude1@gmail.com', 'deepseek.ee.1+claude2@gmail.com',
  'deepseek.ee.1+merge@gmail.com',
]

/** Which route the menu considers current, and under which model. */
interface Current {
  /** Index into the account list, or -1 for the base route. */
  readonly route: number
  /** The model the checked row carries. */
  readonly model: string
}

/**
 * One provider group, rendered as the group primitive renders it.
 * @param title - the group's rendered title.
 * @param checked - the model whose row carries `aria-checked`, when this is the group in use.
 * @param disabled - models whose rows are disabled, as a pending selection leaves them.
 * @returns the section element.
 */
function group(title: string, checked?: string, disabled: readonly string[] = []): HTMLElement {
  const section = document.createElement('section')
  section.setAttribute('role', 'group')
  section.setAttribute('data-menu-group', '')
  const start = document.createElement('span')
  start.setAttribute('data-menu-group-start', '')
  const heading = document.createElement('div')
  heading.setAttribute('data-menu-group-heading', '')
  heading.textContent = title
  section.append(start, heading)
  for (const model of MODELS) {
    const row = document.createElement('button')
    row.type = 'button'
    row.setAttribute('role', 'menuitemradio')
    row.setAttribute('aria-checked', String(model === checked))
    row.title = model
    row.textContent = model
    row.disabled = disabled.includes(model)
    section.append(row)
  }
  return section
}

/**
 * A menu holding the base route and one group per login.
 * @param current - the route and model in use, or null for a menu with nothing checked.
 * @param disabled - models whose rows are disabled in every group.
 * @returns the menu element, attached to the document.
 */
function menu(current: Current | null, disabled: readonly string[] = []): HTMLElement {
  const root = document.createElement('div')
  root.setAttribute('role', 'menu')
  root.append(group('DeepSeek (free web)', current?.route === -1 ? current.model : undefined, disabled))
  ACCOUNTS.forEach((account, index) => {
    root.append(group(
      `DeepSeek (free web) (${account})`,
      current?.route === index ? current.model : undefined,
      disabled,
    ))
  })
  document.body.append(root)
  return root
}

/**
 * Record every row click in the menu, which is what a choice performs.
 * @param root - the menu element.
 * @returns the clicks, appended as `title|model`.
 */
function record(root: HTMLElement): string[] {
  const clicked: string[] = []
  for (const section of root.querySelectorAll<HTMLElement>('[data-menu-group]')) {
    for (const row of section.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')) {
      const title = section.querySelector('[data-menu-group-heading]')?.textContent ?? ''
      row.addEventListener('click', () => { clicked.push(`${title}|${row.title}`) })
    }
  }
  return clicked
}

/** The choices the fold built, in order. */
function choices(root: HTMLElement): HTMLElement[] {
  const picker = root.querySelector<HTMLElement>('[data-dsh-picker]')
  expect(picker).not.toBeNull()
  return [...(picker?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? [])]
}

describe('account picker', () => {
  it('folds ten login routes into one group and one row of choices', () => {
    const root = menu({ route: 3, model: 'DeepSeek · Thinking' })
    wireAccountPicker(root, { legend: 'Account', auto: 'Auto' })
    const picker = root.querySelector<HTMLElement>('[data-dsh-picker]')
    expect(picker?.getAttribute('aria-label')).toBe('Account')
    // Choices are the unpinned route plus every login, named as the operator names them.
    expect(choices(root).map(choice => choice.textContent))
      .toEqual(['Auto', 'hunt', 'v', 'f', 'j1', 't1', 't2', 'd1', 'claude1', 'claude2', 'merge'])
    // The group in use keeps its place, and its title is the provider's own name.
    const open = root.children[4]
    expect(open?.getAttribute('data-dsh-pool-hidden')).toBeNull()
    expect(open?.querySelector('[data-menu-group-heading]')?.textContent).toBe('DeepSeek (free web)')
    expect(open?.querySelector('[data-dsh-picker]')?.previousElementSibling)
      .toBe(open?.querySelector('[data-menu-group-heading]'))
    // Every other pool route is hidden, not removed: its rows are what a choice clicks.
    const hidden = [...root.children].filter(section => section.hasAttribute('data-dsh-pool-hidden'))
    expect(hidden).toHaveLength(10)
    expect(hidden[0]?.querySelectorAll('[role="menuitemradio"]')).toHaveLength(MODELS.length)
    // The checked row's model is the model a choice keeps.
    expect(choices(root)[4]?.getAttribute('aria-checked')).toBe('true')
    expect(root.querySelector('[data-dsh-picker] [aria-checked="true"]')?.getAttribute('title'))
      .toBe('DeepSeek (free web) (deepseek.ee.1+j1@gmail.com)')
  })

  it('clicks the row a choice stands for, under the model in use', () => {
    const root = menu({ route: 0, model: 'DeepSeek · Search' })
    const clicked = record(root)
    wireAccountPicker(root, { auto: 'Auto' })
    choices(root)[5]?.click()
    expect(clicked).toEqual(['DeepSeek (free web) (deepseek.ee.1+t1@gmail.com)|DeepSeek · Search'])
  })

  it('falls back to the route\u2019s first usable row when the model is gone', () => {
    const root = menu({ route: 0, model: 'DeepSeek · Thinking + Search' }, ['DeepSeek · Thinking + Search'])
    const clicked = record(root)
    wireAccountPicker(root, {})
    choices(root)[1]?.click()
    expect(clicked).toEqual(['DeepSeek (free web) (deepseek.ee.1+hunt@gmail.com)|DeepSeek'])
  })

  it('keeps the base route when nothing in the pool is checked', () => {
    const root = menu(null)
    wireAccountPicker(root, { auto: 'Auto' })
    expect(root.children[0]?.querySelector('[data-dsh-picker]')).not.toBeNull()
    expect(root.children[0]?.querySelector('[data-menu-group-heading]')?.textContent).toBe('DeepSeek (free web)')
    expect(choices(root).filter(choice => choice.getAttribute('aria-checked') === 'true')).toHaveLength(0)
    expect([...root.children].filter(section => section.hasAttribute('data-dsh-pool-hidden'))).toHaveLength(10)
  })

  it('names the unpinned route by the provider when the plugin has no copy', () => {
    const root = menu(null)
    wireAccountPicker(root, {})
    expect(choices(root)[0]?.textContent).toBe('DeepSeek (free web)')
    expect(root.querySelector('[data-dsh-picker]')?.hasAttribute('aria-label')).toBe(false)
  })

  it('folds a menu once, however often it is scanned', () => {
    const root = menu({ route: 0, model: 'DeepSeek' })
    wireAccountPicker(root, {})
    wireAccountPicker(root, {})
    expect(root.querySelectorAll('[data-dsh-picker]')).toHaveLength(1)
    expect(choices(root)).toHaveLength(ACCOUNTS.length + 1)
  })

  it('folds the innermost pool, not the route whose title merely prefixes it', () => {
    // The deployment this was written against nests the free web route inside a plain
    // `DeepSeek` provider by name alone: folding the outer one would hide the free web
    // route and label the group on screen with the wrong provider.
    const root = document.createElement('div')
    root.setAttribute('role', 'menu')
    root.append(group('DeepSeek', 'DeepSeek-V41-Flash'), group('DeepSeek (free web)'))
    ACCOUNTS.forEach((account, index) => {
      root.append(group(`DeepSeek (free web) (${account})`, index === 1 ? 'DeepSeek' : undefined))
    })
    document.body.append(root)
    const clicked = record(root)
    wireAccountPicker(root, { auto: 'Auto' })
    expect(choices(root).map(choice => choice.textContent))
      .toEqual(['Auto', 'hunt', 'v', 'f', 'j1', 't1', 't2', 'd1', 'claude1', 'claude2', 'merge'])
    // The plain route is not part of the pool: untouched title, untouched rows.
    expect(root.children[0]?.getAttribute('data-dsh-pool-hidden')).toBeNull()
    expect(root.children[0]?.querySelector('[data-menu-group-heading]')?.textContent).toBe('DeepSeek')
    // The group in use is the login, and it now reads as the route it belongs to.
    expect(root.children[3]?.querySelector('[data-menu-group-heading]')?.textContent).toBe('DeepSeek (free web)')
    expect([...root.children].filter(section => section.hasAttribute('data-dsh-pool-hidden'))).toHaveLength(10)
    choices(root)[0]?.click()
    expect(clicked).toEqual(['DeepSeek (free web)|DeepSeek'])
  })

  it('leaves a provider that pools nothing exactly as it rendered', () => {
    const root = document.createElement('div')
    root.setAttribute('role', 'menu')
    root.append(group('google', 'Gemini 3 Pro Preview'), group('anthropic', 'Claude Opus 5'))
    document.body.append(root)
    wireAccountPicker(root, {})
    expect(root.querySelector('[data-dsh-picker]')).toBeNull()
    expect(root.querySelector('[data-dsh-pool-hidden]')).toBeNull()
    expect(root.querySelector('[data-menu-group-heading]')?.textContent).toBe('google')
  })

  it('does not read one suffixed sibling as a pool', () => {
    const root = document.createElement('div')
    root.setAttribute('role', 'menu')
    root.append(group('DeepSeek (free web)', 'DeepSeek'), group('DeepSeek (free web) (a@b.c)', 'DeepSeek'))
    document.body.append(root)
    wireAccountPicker(root, {})
    expect(root.querySelector('[data-dsh-picker]')).toBeNull()
  })

  it('selects a login whose label carries no tag', () => {
    const root = document.createElement('div')
    root.setAttribute('role', 'menu')
    root.append(group('Kiln', 'DeepSeek'), group('Kiln (deepseek.ee.1)', 'DeepSeek'), group('Kiln (plain@example.com)', 'DeepSeek'))
    document.body.append(root)
    wireAccountPicker(root, { auto: 'Auto' })
    expect(choices(root).map(choice => choice.textContent)).toEqual(['Auto', 'deepseek.ee.1', 'plain'])
  })
})
