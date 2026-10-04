// @vitest-environment jsdom
/**
 * The re-anchor, and the two affordances that need it.
 *
 * The app places the model card from the trigger's rect and the card's own measured
 * height; everything this plugin does to the card changes that height without React
 * knowing, so each change has to ask the app to measure again or the card floats where
 * the taller card was placed. These specs drive the module's own contract and the two
 * callers: wiring a menu, and opening a group.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { reanchorMenu } from '../src/client/menu-anchor.ts'
import { installModelGroups } from '../src/client/model-groups.ts'

/** Counts the re-measure requests the plugin makes. */
const measured = vi.fn()

beforeEach(() => {
  measured.mockClear()
  // Each case starts with an empty document: installing the observer wires every menu
  // already on the page, and a leftover menu from an earlier case would be counted.
  document.body.replaceChildren()
  window.addEventListener('resize', measured)
})

/** Let the document observer deliver its records. */
async function flushed(): Promise<void> {
  await new Promise((resolve) => { setTimeout(resolve, 0) })
}

/** One provider section, as the group primitive renders it. */
function group(title: string): HTMLElement {
  const section = document.createElement('section')
  section.setAttribute('role', 'group')
  section.setAttribute('data-menu-group', '')
  const heading = document.createElement('div')
  heading.setAttribute('data-menu-group-heading', '')
  heading.textContent = title
  const row = document.createElement('button')
  row.type = 'button'
  row.setAttribute('role', 'menuitemradio')
  row.setAttribute('aria-checked', 'false')
  row.textContent = 'DeepSeek'
  section.append(heading, row)
  return section
}

/** A menu holding the given sections, attached to the document. */
function menu(...sections: readonly HTMLElement[]): HTMLElement {
  const element = document.createElement('div')
  element.setAttribute('role', 'menu')
  element.append(...sections)
  document.body.append(element)
  return element
}

describe('reanchorMenu', () => {
  it('asks the app to re-measure for a menu on screen', () => {
    const element = menu(group('DeepSeek'))
    reanchorMenu(element)
    expect(measured).toHaveBeenCalledTimes(1)
  })

  it('leaves the app alone for a menu that is already unmounted', () => {
    const element = document.createElement('div')
    expect(element.isConnected).toBe(false)
    reanchorMenu(element)
    expect(measured).not.toHaveBeenCalled()
  })
})

describe('installModelGroups re-anchoring', () => {
  it('re-measures once when it contracts a menu', async () => {
    const dispose = installModelGroups()
    const element = menu(group('DeepSeek'), group('google'))
    await flushed()
    expect(measured).toHaveBeenCalledTimes(1)
    expect(element.dataset.dshGroupKeys).toBe('true')
    dispose()
  })

  it('does not re-measure for a menu it has already wired', async () => {
    const dispose = installModelGroups()
    const element = menu(group('DeepSeek'))
    await flushed()
    measured.mockClear()
    // A later scan of the same menu — a row rendered into it, say — changes nothing.
    element.append(document.createElement('span'))
    await flushed()
    expect(measured).not.toHaveBeenCalled()
    dispose()
  })

  it('re-measures when a group opens and when it closes', async () => {
    const dispose = installModelGroups()
    const element = menu(group('DeepSeek'))
    await flushed()
    const heading = element.querySelector<HTMLElement>('[data-menu-group-heading]')
    expect(heading).not.toBeNull()
    measured.mockClear()
    heading?.click()
    expect(heading?.getAttribute('aria-expanded')).toBe('true')
    expect(measured).toHaveBeenCalledTimes(1)
    heading?.click()
    expect(heading?.getAttribute('aria-expanded')).toBe('false')
    expect(measured).toHaveBeenCalledTimes(2)
    dispose()
  })

  it('re-measures when Enter opens a group', async () => {
    const dispose = installModelGroups()
    const element = menu(group('DeepSeek'))
    await flushed()
    const heading = element.querySelector<HTMLElement>('[data-menu-group-heading]')
    measured.mockClear()
    heading?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(heading?.getAttribute('aria-expanded')).toBe('true')
    expect(measured).toHaveBeenCalledTimes(1)
    dispose()
  })
})
