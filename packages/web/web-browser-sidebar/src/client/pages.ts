/**
 * The agent's browser pages: one Electron `<webview>` per agent Session, owned by this
 * window and performing the Host's low-level page operations.
 *
 * A webview reloads when it moves in the DOM, so every page lives for its whole life in
 * one fixed layer on `document.body`. While its conversation's sidebar tab is hidden the
 * page is parked there — transparent, inert, at the Host's layout size — and still
 * renders, so the agent keeps browsing with the sidebar closed. When the tab shows, the
 * page is laid over the tab's viewport rectangle and follows it, so the operator sees
 * the agent's page exactly as the agent left it and can use it directly.
 *
 * @module @deepseek-ai/dsh-web-browser-sidebar/pages
 */

import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { AgentBrowserReply, AgentBrowserRequest } from '../types.ts'
import css from './AgentBrowser.module.css'
import { keyEvents } from './keys.ts'

/** Main-issued identity of one guest reservation. */
type LeaseId = string & { readonly __lease?: never }

/** The Desktop preload's guest operations, as `dshDesktop.browser` exposes them. */
export interface GuestBridge {
  /** @param workspace - storage account. @returns one approved guest reservation. */
  acquire(workspace: string): Promise<{ readonly lease: LeaseId; readonly partition: string }>
  /** @param lease - the reservation to end. @returns after the guest is destroyed. */
  release(lease: LeaseId): Promise<void>
  /** @param lease - originating guest. @param listener - approved popup address. @returns unsubscribe. */
  onOpenRequested(lease: LeaseId, listener: (url: string) => void): () => void
}

/** A captured guest image, as the webview hands it to the embedder. */
interface GuestImage {
  toDataURL(): string
  getSize(): { width: number; height: number }
  isEmpty(): boolean
}

/** The Electron tag API this module drives. */
export interface WebviewElement extends HTMLElement {
  loadURL(url: string): Promise<void>
  getURL(): string
  getTitle(): string
  isLoading(): boolean
  canGoBack(): boolean
  canGoForward(): boolean
  goBack(): void
  goForward(): void
  reload(): void
  clearHistory(): void
  executeJavaScript(code: string, userGesture?: boolean): Promise<unknown>
  insertText(text: string): Promise<void>
  sendInputEvent(event: Record<string, unknown>): void
  capturePage(): Promise<GuestImage>
}

/** What the sidebar tab of one conversation shows about its agent page. */
export interface AgentTabState {
  /** The page shown, or undefined before the agent opened one in this conversation. */
  readonly pageId: string | undefined
  readonly url: string
  readonly title: string
  readonly loading: boolean
  readonly canGoBack: boolean
  readonly canGoForward: boolean
  /** The operation the agent is performing, while one is in flight. */
  readonly busy: AgentBrowserRequest['op'] | undefined
}

/** The tab state before the agent opened a page. */
const EMPTY_TAB: AgentTabState = {
  pageId: undefined, url: '', title: '', loading: false, canGoBack: false, canGoForward: false, busy: undefined,
}

/** Construction inputs shared by every page. */
export interface AgentPagesOptions {
  readonly bridge: GuestBridge
  /** @param sessionId - the conversation. @returns the storage account its pages share with its Browser tabs. */
  readonly workspace: (sessionId: string) => string
  /** The document pages are created in. */
  readonly document: Document
  /** Called after each agent operation lands on a page, with the conversation that shows it. */
  readonly activity: (displaySessionId: string, op: AgentBrowserRequest['op']) => void
}

/** Milliseconds a click or key waits for a navigation it may have started to begin. */
const INPUT_SETTLE_MS = 250
/** Milliseconds between two loading checks while settling. */
const SETTLE_POLL_MS = 100

/** Resolve after `ms`. */
function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** Race a promise against a deadline. */
async function within<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => { timer = setTimeout(() => { reject(new Error(`${what} timed out after ${String(ms)} ms`)) }, ms) }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

/** The script that makes a guest paint: two animation frames and a no-op scroll. */
const REPAINT = 'new Promise(r => requestAnimationFrame(() => { scrollBy(0, 0); requestAnimationFrame(() => r(true)) }))'

/**
 * Capture a guest's viewport. `capturePage` resolves on the guest's next composited
 * frame, so a guest that is not painting never answers: a panel that is hidden or
 * collapsed, a window in the background whose rendering is throttled, or a busy page
 * mid-animation. The capture runs in stages, asking the guest to paint between them,
 * and a failure says which of those it was.
 * @param element - the guest.
 * @param timeoutMs - the whole budget.
 * @returns the captured image.
 */
export async function capture(element: WebviewElement, timeoutMs: number): Promise<GuestImage> {
  const box = element.getBoundingClientRect()
  if (box.width < 1 || box.height < 1) {
    throw new Error('cannot capture the page: the AI Browser panel is collapsed or hidden, so the page is not drawn; open the panel and try again')
  }
  const deadline = Date.now() + timeoutMs
  const slice = Math.max(1000, Math.min(4000, Math.floor(timeoutMs / 3)))
  let attempt = element.capturePage()
  for (;;) {
    const left = deadline - Date.now()
    try {
      return await within(attempt, Math.max(1, Math.min(slice, left)), 'capturing the page')
    } catch (error) {
      if (deadline - Date.now() <= 0) {
        const hidden = element.ownerDocument.hidden ? ' The window is minimized or hidden, which stops it painting.' : ''
        throw new Error(`capturing the page timed out after ${String(timeoutMs)} ms: the page drew no new frame.${hidden}`
          + ' Bring the window to the front (a background window is throttled), or use read for the page text.', { cause: error })
      }
    }
    // Ask for a frame, then capture again; the earlier capture may still answer first.
    await within(element.executeJavaScript(REPAINT), Math.min(1000, Math.max(1, deadline - Date.now())), 'repainting').catch(() => undefined)
    const retry = element.capturePage()
    attempt = Promise.any([attempt, retry])
  }
}

/** The message of a thrown value. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** One agent page and its guest. */
class AgentPage {
  readonly state: SnapshotStore<AgentTabState>
  private element: WebviewElement | undefined
  private lease: LeaseId | undefined
  private ready: Promise<void> | undefined
  private chain: Promise<unknown> = Promise.resolve()
  private navigated = false
  private stopOpen: (() => void) | undefined
  private disposed = false
  private parked = { width: 1280, height: 800 }

  constructor(
    readonly pageId: string,
    public displaySessionId: string,
    private readonly options: AgentPagesOptions,
    private readonly layer: HTMLElement,
  ) {
    this.state = createSnapshotStore<AgentTabState>({ ...EMPTY_TAB, pageId })
  }

  /** Perform operations one at a time, in arrival order. */
  enqueue(request: AgentBrowserRequest): Promise<AgentBrowserReply> {
    const run = this.chain.then(() => this.perform(request))
    this.chain = run.catch(() => undefined)
    return run
  }

  /** The guest, created on first use. */
  private async guest(request: AgentBrowserRequest): Promise<{ element: WebviewElement; fresh: boolean }> {
    if (this.element !== undefined && this.ready !== undefined) {
      await this.ready
      return { element: this.element, fresh: false }
    }
    const { document } = this.options
    const reservation = await this.options.bridge.acquire(this.options.workspace(request.displaySessionId))
    if (this.disposed) {
      await this.options.bridge.release(reservation.lease)
      throw new Error('the agent page was closed')
    }
    const element = document.createElement('webview') as WebviewElement
    element.className = css.page ?? ''
    element.dataset.sidebarBrowserFrame = 'webview'
    element.dataset.agentBrowserPage = this.pageId
    element.setAttribute('name', reservation.lease)
    element.setAttribute('partition', reservation.partition)
    element.setAttribute('allowpopups', '')
    element.setAttribute('src', `about:blank#${reservation.lease}`)
    this.lease = reservation.lease
    this.element = element
    this.parked = { width: request.viewportWidth, height: request.viewportHeight }
    this.park()
    this.stopOpen = this.options.bridge.onOpenRequested(reservation.lease, (url) => {
      // A page asked for a new window; the agent's page has one tab, so it navigates there.
      void element.loadURL(url).catch(() => { /* the load failure is observed through did-fail-load */ })
    })
    for (const name of ['did-start-loading', 'did-stop-loading', 'did-navigate', 'did-navigate-in-page', 'page-title-updated']) {
      element.addEventListener(name, () => { this.observe() })
    }
    for (const name of ['render-process-gone', 'destroyed']) {
      element.addEventListener(name, () => { void this.drop() })
    }
    this.ready = new Promise<void>((resolve) => {
      element.addEventListener('dom-ready', () => { resolve() }, { once: true })
    })
    this.layer.append(element)
    await within(this.ready, request.timeoutMs, 'opening the agent page')
    return { element, fresh: true }
  }

  /**
   * Publish the guest's navigation state.
   * @param busy - the operation in flight; omitted keeps the one already published.
   */
  private observe(...busy: [AgentTabState['busy']] | []): void {
    const element = this.element
    if (element === undefined || this.ready === undefined) return
    try {
      const url = element.getURL()
      const shown = url.startsWith('about:blank#') ? '' : url
      this.state.set({
        pageId: this.pageId,
        url: shown,
        title: shown === '' ? '' : element.getTitle(),
        loading: element.isLoading(),
        canGoBack: element.canGoBack(),
        canGoForward: element.canGoForward(),
        busy: busy.length === 0 ? this.state.getSnapshot().busy : busy[0],
      })
    } catch (_notReady) {
      // A webview throws from its getters until its guest has attached; dom-ready observes again.
    }
  }

  /** Wait until the page stops loading, bounded by `ms`. */
  private async settle(element: WebviewElement, ms: number): Promise<void> {
    const deadline = Date.now() + ms
    await delay(INPUT_SETTLE_MS)
    while (element.isLoading() && Date.now() < deadline) await delay(SETTLE_POLL_MS)
  }

  private async perform(request: AgentBrowserRequest): Promise<AgentBrowserReply> {
    if (request.op === 'close') {
      await this.drop()
      return { id: request.id, ok: true }
    }
    this.displaySessionId = request.displaySessionId
    this.observe(request.op)
    try {
      const { element, fresh } = await this.guest(request)
      this.observe(request.op)
      const reply = await this.operate(element, request)
      return { ...reply, id: request.id, ok: true, fresh, url: this.address(element), title: element.getTitle() }
    } catch (error) {
      return { id: request.id, ok: false, error: messageOf(error) }
    } finally {
      this.observe(undefined)
      this.options.activity(request.displaySessionId, request.op)
    }
  }

  /** The page's address, without the bootstrap document's lease fragment. */
  private address(element: WebviewElement): string {
    const url = element.getURL()
    return url.startsWith('about:blank#') ? 'about:blank' : url
  }

  private async operate(element: WebviewElement, request: AgentBrowserRequest): Promise<Partial<AgentBrowserReply>> {
    switch (request.op) {
      case 'hello':
      case 'close':
        return {}
      case 'navigate': {
        const url = request.url ?? ''
        if (!/^https?:\/\//iu.test(url)) throw new Error(`only http and https addresses can be opened, not "${url}"`)
        try {
          await within(element.loadURL(url), request.timeoutMs, `loading ${url}`)
        } catch (error) {
          // A redirect or a client-side navigation aborts the original load; the page that
          // replaced it is the result.
          if (!/ERR_ABORTED|\(-3\)/u.test(messageOf(error))) throw error
          await this.settle(element, request.timeoutMs)
        }
        if (!this.navigated) {
          // The lease-bearing bootstrap document is not a page the agent visited.
          element.clearHistory()
          this.navigated = true
        }
        return {}
      }
      case 'evaluate': {
        const value = await within(element.executeJavaScript(request.script ?? 'undefined'), request.timeoutMs, 'running a page script')
        return { value: JSON.stringify(value ?? null) }
      }
      case 'click': {
        const x = Math.round(request.x ?? 0)
        const y = Math.round(request.y ?? 0)
        element.sendInputEvent({ type: 'mouseMove', x, y })
        element.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 })
        element.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 })
        await this.settle(element, request.timeoutMs)
        return {}
      }
      case 'insertText': {
        await this.withGuestFocus(element, () => { void element.insertText(request.text ?? '') })
        await delay(50)
        return {}
      }
      case 'key': {
        const events = keyEvents(request.key ?? '')
        await this.withGuestFocus(element, () => { for (const event of events) element.sendInputEvent(event) })
        await this.settle(element, request.timeoutMs)
        return {}
      }
      case 'back':
      case 'forward': {
        const can = request.op === 'back' ? element.canGoBack() : element.canGoForward()
        if (can) {
          if (request.op === 'back') element.goBack()
          else element.goForward()
          await this.settle(element, request.timeoutMs)
        }
        return {}
      }
      case 'settle':
        await this.settle(element, request.timeoutMs)
        return {}
      case 'screenshot': {
        const image = await capture(element, request.timeoutMs)
        if (image.isEmpty()) throw new Error('the page has not painted yet; try again once it has loaded')
        const size = image.getSize()
        const data = image.toDataURL()
        const comma = data.indexOf(',')
        return { png: comma < 0 ? '' : data.slice(comma + 1), width: size.width, height: size.height }
      }
    }
  }

  /**
   * Give the guest keyboard focus for one input, then hand focus back to whatever the
   * operator was using, so the agent's keys do not take the operator's caret away.
   */
  private async withGuestFocus(element: WebviewElement, send: () => void): Promise<void> {
    const { document } = this.options
    const previous = document.activeElement
    element.focus()
    send()
    await delay(30)
    if (previous instanceof HTMLElement && previous !== element && previous !== document.body && previous.isConnected) {
      previous.focus({ preventScroll: true })
    }
  }

  /** Lay the page out at its Host size, invisible and inert. */
  park(): void {
    const element = this.element
    if (element === undefined) return
    Object.assign(element.style, {
      left: '0px', top: '0px', width: `${String(this.parked.width)}px`, height: `${String(this.parked.height)}px`,
      opacity: '0', pointerEvents: 'none', zIndex: '-1', visibility: 'visible',
    })
    element.dataset.agentBrowserShown = 'false'
  }

  /**
   * Lay the page over a viewport rectangle.
   * @param rect - the tab viewport's client rectangle.
   * @param zIndex - the stacking order that places the page just above the viewport's surface.
   */
  show(rect: DOMRectReadOnly, zIndex: number): void {
    const element = this.element
    if (element === undefined) return
    Object.assign(element.style, {
      left: `${String(rect.left)}px`, top: `${String(rect.top)}px`,
      width: `${String(rect.width)}px`, height: `${String(rect.height)}px`,
      opacity: '1', pointerEvents: '', zIndex: String(zIndex), visibility: 'visible',
    })
    element.dataset.agentBrowserShown = 'true'
  }

  /** Whether the page has a guest to show. */
  hasGuest(): boolean {
    return this.element !== undefined
  }

  /** Navigate from the operator's toolbar. @param url - an HTTP(S) address. */
  load(url: string): void {
    void this.element?.loadURL(url).catch(() => { /* observed through did-fail-load */ })
  }

  /** @param command - toolbar history or reload command. */
  command(command: 'back' | 'forward' | 'reload'): void {
    const element = this.element
    if (element === undefined) return
    if (command === 'back' && element.canGoBack()) element.goBack()
    else if (command === 'forward' && element.canGoForward()) element.goForward()
    else if (command === 'reload') element.reload()
  }

  /** Destroy the guest; the next operation creates a fresh one. */
  async drop(): Promise<void> {
    const lease = this.lease
    this.stopOpen?.()
    this.stopOpen = undefined
    this.element?.remove()
    this.element = undefined
    this.ready = undefined
    this.lease = undefined
    this.navigated = false
    this.state.set({ ...EMPTY_TAB, pageId: this.pageId })
    if (lease !== undefined) await this.options.bridge.release(lease).catch(() => { /* the guest is already gone */ })
  }

  /** Destroy the page for good. */
  async dispose(): Promise<void> {
    this.disposed = true
    await this.drop()
  }
}

/** Every agent page this window carries, and which one each conversation's tab shows. */
export class AgentPages {
  private readonly pages = new Map<string, AgentPage>()
  private readonly layer: HTMLElement
  /** The page each conversation's tab shows: the one whose agent acted most recently. */
  private readonly shown = new Map<string, SnapshotStore<AgentTabState>>()
  private readonly following = new Map<string, () => void>()
  private attached: { sessionId: string; stop: () => void } | undefined

  /** @param options - guest bridge, storage accounts, document, and activity callback. */
  constructor(private readonly options: AgentPagesOptions) {
    this.layer = options.document.createElement('div')
    this.layer.className = css.layer ?? ''
    this.layer.dataset.agentBrowserLayer = ''
    options.document.body.append(this.layer)
  }

  /**
   * Perform one Host operation.
   * @param request - the operation and the page it addresses.
   * @returns the reply to send back.
   */
  perform(request: AgentBrowserRequest): Promise<AgentBrowserReply> {
    let page = this.pages.get(request.pageId)
    if (page === undefined) {
      if (request.op === 'close') return Promise.resolve({ id: request.id, ok: true })
      page = new AgentPage(request.pageId, request.displaySessionId, this.options, this.layer)
      this.pages.set(request.pageId, page)
    }
    if (request.op !== 'close') this.display(request.displaySessionId, page)
    return page.enqueue(request)
  }

  /**
   * The state of the page a conversation's tab shows.
   * @param sessionId - the conversation.
   * @returns a stable observable for that conversation.
   */
  tabState(sessionId: string): SnapshotStore<AgentTabState> {
    let store = this.shown.get(sessionId)
    if (store === undefined) {
      store = createSnapshotStore<AgentTabState>(EMPTY_TAB)
      this.shown.set(sessionId, store)
    }
    return store
  }

  /**
   * Whether a conversation's tab has a page to show.
   * @param sessionId - the conversation.
   * @returns true once an agent opened a page there.
   */
  hasPage(sessionId: string): boolean {
    return this.tabState(sessionId).getSnapshot().pageId !== undefined
  }

  /** Point a conversation's tab at the page that just acted, following its state. */
  private display(sessionId: string, page: AgentPage): void {
    const store = this.tabState(sessionId)
    if (store.getSnapshot().pageId === page.pageId && this.following.has(sessionId)) return
    this.following.get(sessionId)?.()
    const copy = (): void => { store.set(page.state.getSnapshot()) }
    this.following.set(sessionId, page.state.subscribe(copy))
    // An attached tab reads the shown page on every frame, so a switch reaches it unprompted.
    copy()
  }

  /**
   * Lay a conversation's page over its tab viewport while the tab is visible.
   * @param sessionId - the conversation whose tab is visible.
   * @param viewport - the tab's content element.
   * @returns ends the attachment and parks the page again.
   */
  attach(sessionId: string, viewport: HTMLElement): () => void {
    this.attached?.stop()
    let frame = 0
    let current: AgentPage | undefined
    const view = viewport.ownerDocument.defaultView
    const tick = (): void => {
      const pageId = this.tabState(sessionId).getSnapshot().pageId
      const page = pageId === undefined ? undefined : this.pages.get(pageId)
      if (current !== undefined && current !== page) current.park()
      current = page
      const rect = viewport.getBoundingClientRect()
      if (page !== undefined && page.hasGuest()) {
        if (rect.width > 0 && rect.height > 0 && viewport.isConnected) page.show(rect, stackingOrder(viewport))
        else page.park()
      }
      frame = view?.requestAnimationFrame(tick) ?? 0
    }
    tick()
    const stop = (): void => {
      view?.cancelAnimationFrame(frame)
      current?.park()
      if (this.attached?.stop === stop) this.attached = undefined
    }
    this.attached = { sessionId, stop }
    return stop
  }

  /** The page a conversation's tab shows, for its toolbar commands. */
  private shownPage(sessionId: string): AgentPage | undefined {
    const pageId = this.tabState(sessionId).getSnapshot().pageId
    return pageId === undefined ? undefined : this.pages.get(pageId)
  }

  /**
   * Navigate a conversation's shown page to an address the operator typed.
   * @param sessionId - the conversation.
   * @param url - an HTTP(S) address.
   */
  load(sessionId: string, url: string): void {
    this.shownPage(sessionId)?.load(url)
  }

  /**
   * Run a toolbar command on a conversation's shown page.
   * @param sessionId - the conversation.
   * @param command - back, forward, or reload.
   */
  command(sessionId: string, command: 'back' | 'forward' | 'reload'): void {
    this.shownPage(sessionId)?.command(command)
  }

  /** Destroy every page and the layer. */
  async dispose(): Promise<void> {
    this.attached?.stop()
    for (const stop of this.following.values()) stop()
    this.following.clear()
    const pages = [...this.pages.values()]
    this.pages.clear()
    await Promise.all(pages.map(page => page.dispose()))
    this.layer.remove()
  }
}

/**
 * The stacking order that puts a page just above the surface a viewport is drawn on.
 *
 * The page sits in a root-level layer, so it competes with the viewport's outermost
 * ancestor that sets a `z-index` — positioned, or a flex or grid item, which stacks
 * without being positioned. One above that ancestor covers the viewport and stays
 * below menus and dialogs, which stack higher still.
 * @param viewport - the tab's content element.
 * @returns the z-index for the page.
 */
export function stackingOrder(viewport: HTMLElement): number {
  let order = 0
  const view = viewport.ownerDocument.defaultView
  for (let node: HTMLElement | null = viewport; node !== null; node = node.parentElement) {
    const style = view?.getComputedStyle(node)
    if (style === undefined) continue
    const parent = node.parentElement === null ? undefined : view?.getComputedStyle(node.parentElement)
    const stacks = style.position !== 'static' || /flex|grid/u.test(parent?.display ?? '')
    const z = Number.parseInt(style.zIndex, 10)
    if (stacks && Number.isFinite(z)) order = z
  }
  return order + 1
}
