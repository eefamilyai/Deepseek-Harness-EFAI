// @vitest-environment jsdom
/**
 * The window's agent pages: one guest per agent Session, operations performed in
 * order, the page shown in its conversation's tab and parked while the tab is hidden.
 *
 * The guest is a stand-in for Electron's `<webview>` tag: it answers the tag methods
 * the module drives and fires the tag events it listens to.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentBrowserRequest } from '../src/types.ts'
import { AgentPages, stackingOrder, type GuestBridge } from '../src/client/pages.ts'

/** What the stand-in guests recorded. */
interface GuestLog {
  readonly inputs: Record<string, unknown>[]
  readonly inserted: string[]
  readonly scripts: string[]
}

let log: GuestLog
let released: string[]
let leases = 0

/** Give a created `<webview>` the tag methods the module drives. */
function decorate(element: HTMLElement): void {
  let url = ''
  let history: string[] = []
  let index = -1
  const fire = (name: string): void => { element.dispatchEvent(new Event(name)) }
  Object.assign(element, {
    loadURL: (next: string) => {
      if (next.startsWith('https://fail.test')) return Promise.reject(new Error('ERR_NAME_NOT_RESOLVED (-105)'))
      history = [...history.slice(0, index + 1), next]
      index = history.length - 1
      url = next
      fire('did-navigate')
      return Promise.resolve()
    },
    getURL: () => url,
    getTitle: () => (url === '' ? '' : `Title of ${url}`),
    isLoading: () => false,
    canGoBack: () => index > 0,
    canGoForward: () => index < history.length - 1,
    goBack: () => { index--; url = history[index] ?? ''; fire('did-navigate') },
    goForward: () => { index++; url = history[index] ?? ''; fire('did-navigate') },
    reload: () => {},
    clearHistory: () => { history = [url]; index = 0 },
    executeJavaScript: (code: string) => { log.scripts.push(code); return Promise.resolve({ ran: code.length }) },
    sendInputEvent: (event: Record<string, unknown>) => { log.inputs.push(event) },
    insertText: (text: string) => { log.inserted.push(text); return Promise.resolve() },
    capturePage: () => Promise.resolve({ isEmpty: () => false, getSize: () => ({ width: 2, height: 1 }), toDataURL: () => 'data:image/png;base64,AQID' }),
    // jsdom lays nothing out; a shown panel has a size.
    getBoundingClientRect: () => ({ x: 0, y: 0, top: 0, left: 0, right: 400, bottom: 300, width: 400, height: 300, toJSON: () => ({}) }),
  })
  // The real tag finishes its bootstrap document after it is attached.
  queueMicrotask(() => {
    url = element.getAttribute('src') ?? ''
    history = [url]
    index = 0
    fire('dom-ready')
  })
}

const bridge: GuestBridge = {
  acquire: () => Promise.resolve({ lease: `lease-${String(++leases)}`, partition: 'persist:p' }),
  release: (lease) => { released.push(lease); return Promise.resolve() },
  onOpenRequested: () => () => {},
}

let activity: string[]
let pages: AgentPages

beforeEach(() => {
  log = { inputs: [], inserted: [], scripts: [] }
  released = []
  activity = []
  leases = 0
  const create = (tag: string): HTMLElement => document.createElementNS('http://www.w3.org/1999/xhtml', tag)
  vi.spyOn(document, 'createElement').mockImplementation((tag: string): HTMLElement => {
    const element: HTMLElement = create(tag)
    if (tag === 'webview') decorate(element)
    return element
  })
  pages = new AgentPages({ bridge, document, workspace: id => `session:${id}`, activity: (id, op) => { activity.push(`${id}:${op}`) } })
})

afterEach(async () => {
  await pages.dispose()
  vi.restoreAllMocks()
})

let ids = 0
function request(op: AgentBrowserRequest['op'], fields: Partial<AgentBrowserRequest> = {}): AgentBrowserRequest {
  return { id: String(++ids), op, pageId: 'agent', displaySessionId: 'root', viewportWidth: 1024, viewportHeight: 700, timeoutMs: 1000, ...fields }
}

describe('agent pages', () => {
  it('creates one guest on first use, navigates it, and drops the bootstrap entry from its history', async () => {
    const reply = await pages.perform(request('navigate', { url: 'https://a.test/' }))
    expect(reply).toMatchObject({ ok: true, fresh: true, url: 'https://a.test/', title: 'Title of https://a.test/' })
    const guests = document.querySelectorAll('webview')
    expect(guests).toHaveLength(1)
    expect(guests[0]?.getAttribute('src')).toBe('about:blank#lease-1')
    expect(pages.tabState('root').getSnapshot()).toMatchObject({ pageId: 'agent', url: 'https://a.test/', canGoBack: false, busy: undefined })
    // The second operation reuses the guest.
    expect(await pages.perform(request('navigate', { url: 'https://b.test/' }))).toMatchObject({ fresh: false })
    expect(document.querySelectorAll('webview')).toHaveLength(1)
    expect(pages.tabState('root').getSnapshot().canGoBack).toBe(true)
    expect(activity).toEqual(['root:navigate', 'root:navigate'])
  })

  it('refuses addresses that are not http or https, and reports load failures', async () => {
    const refused = await pages.perform(request('navigate', { url: 'file:///C:/x' }))
    expect(refused.ok).toBe(false)
    expect(refused.error).toContain('only http and https')
    const failed = await pages.perform(request('navigate', { url: 'https://fail.test/' }))
    expect(failed.ok).toBe(false)
    expect(failed.error).toContain('ERR_NAME_NOT_RESOLVED')
  })

  it('runs scripts, clicks, types, presses, and captures through the guest', async () => {
    await pages.perform(request('navigate', { url: 'https://a.test/' }))
    expect(await pages.perform(request('evaluate', { script: '1 + 1' }))).toMatchObject({ ok: true, value: JSON.stringify({ ran: 5 }) })
    await pages.perform(request('click', { x: 10.4, y: 20.6 }))
    expect(log.inputs.map(event => `${String(event.type)}@${String(event.x)},${String(event.y)}`)).toEqual(['mouseMove@10,21', 'mouseDown@10,21', 'mouseUp@10,21'])
    await pages.perform(request('insertText', { text: 'hello' }))
    expect(log.inserted).toEqual(['hello'])
    log.inputs.length = 0
    await pages.perform(request('key', { key: 'Tab' }))
    expect(log.inputs.map(event => event.type)).toEqual(['keyDown', 'keyUp'])
    expect(await pages.perform(request('screenshot'))).toMatchObject({ ok: true, png: 'AQID', width: 2, height: 1 })
  })

  it('goes back and forward only when history allows', async () => {
    await pages.perform(request('navigate', { url: 'https://a.test/' }))
    await pages.perform(request('navigate', { url: 'https://b.test/' }))
    expect(await pages.perform(request('back'))).toMatchObject({ url: 'https://a.test/' })
    expect(await pages.perform(request('back'))).toMatchObject({ url: 'https://a.test/' })
    expect(await pages.perform(request('forward'))).toMatchObject({ url: 'https://b.test/' })
  })

  it('performs one page\'s operations in arrival order', async () => {
    const order: string[] = []
    const first = pages.perform(request('navigate', { url: 'https://a.test/' })).then(() => { order.push('navigate') })
    const second = pages.perform(request('evaluate', { script: 'x' })).then(() => { order.push('evaluate') })
    await Promise.all([first, second])
    expect(order).toEqual(['navigate', 'evaluate'])
  })

  it('parks the page at its layout size, and lays it over the tab while attached', async () => {
    await pages.perform(request('navigate', { url: 'https://a.test/' }))
    const guest = document.querySelector('webview') as HTMLElement
    expect(guest.dataset.agentBrowserShown).toBe('false')
    expect(guest.style.width).toBe('1024px')
    expect(guest.style.opacity).toBe('0')
    const viewport = document.createElement('div')
    document.body.append(viewport)
    vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue({ left: 900, top: 80, width: 400, height: 600 } as DOMRect)
    const detach = pages.attach('root', viewport)
    expect(guest.dataset.agentBrowserShown).toBe('true')
    expect(guest.style).toMatchObject({ left: '900px', top: '80px', width: '400px', height: '600px', opacity: '1' })
    detach()
    expect(guest.dataset.agentBrowserShown).toBe('false')
  })

  it('closes a page and releases its guest; the next operation starts fresh', async () => {
    await pages.perform(request('navigate', { url: 'https://a.test/' }))
    expect(await pages.perform(request('close'))).toMatchObject({ ok: true })
    expect(released).toEqual(['lease-1'])
    expect(document.querySelectorAll('webview')).toHaveLength(0)
    expect(pages.tabState('root').getSnapshot().url).toBe('')
    expect(await pages.perform(request('navigate', { url: 'https://a.test/' }))).toMatchObject({ fresh: true })
    // A close for a page that never existed has nothing to do.
    expect(await pages.perform(request('close', { pageId: 'other' }))).toMatchObject({ ok: true })
  })

  it('shows the page of the agent that acted most recently in its conversation', async () => {
    await pages.perform(request('navigate', { url: 'https://a.test/' }))
    await pages.perform(request('navigate', { url: 'https://sub.test/', pageId: 'subagent' }))
    expect(pages.tabState('root').getSnapshot()).toMatchObject({ pageId: 'subagent', url: 'https://sub.test/' })
    expect(pages.hasPage('root')).toBe(true)
    expect(pages.hasPage('elsewhere')).toBe(false)
  })

  it('drives the shown page from the toolbar', async () => {
    await pages.perform(request('navigate', { url: 'https://a.test/' }))
    pages.load('root', 'https://b.test/')
    await Promise.resolve()
    expect(pages.tabState('root').getSnapshot().url).toBe('https://b.test/')
    pages.command('root', 'back')
    expect(pages.tabState('root').getSnapshot().url).toBe('https://a.test/')
  })
})

describe('stackingOrder', () => {
  it('stacks one above the outermost positioned ancestor with a z-index', () => {
    const outer = document.createElement('div')
    outer.style.position = 'relative'
    outer.style.zIndex = '5'
    const inner = document.createElement('div')
    outer.append(inner)
    document.body.append(outer)
    expect(stackingOrder(inner)).toBe(6)
    outer.remove()
  })

  it('counts a flex item\'s z-index, which stacks without being positioned', () => {
    const row = document.createElement('div')
    row.style.display = 'flex'
    const cell = document.createElement('div')
    cell.style.zIndex = '10'
    const inner = document.createElement('div')
    cell.append(inner)
    row.append(cell)
    document.body.append(row)
    expect(stackingOrder(inner)).toBe(11)
    row.remove()
  })
})
