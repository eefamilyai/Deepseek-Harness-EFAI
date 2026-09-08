/**
 * A real Chromium-style browser surface with its own persistent session, tab
 * set, and per-tab history — fully separate from the agent-facing browser.
 *
 * The surface is one process-wide Playwright Chromium instance mounted on the
 * webserver carrier under `/chromium`. The agent's `browser` tool (and the
 * dock's shared browser) never touch this context, so a user can browse here
 * without disturbing, or being disturbed by, what the model is doing.
 *
 * Routes:
 *   GET      /chromium/state          full session snapshot (tabs + histories)
 *   POST     /chromium/act            one action: navigate/open/close/activate/back/forward/reload/read/click/type/press/scroll
 *   WS       /chromium/stream         change-driven push of the same snapshot
 *
 * @module @deepseek-ai/dsh-host-chromium-surface
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { readFileSync, writeFileSync } from 'node:fs'
import { mkdirSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import type { Duplex } from 'node:stream'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import { WebSocketServer, type WebSocket } from 'ws'
import { EMPTY_HISTORY, goBack, goForward, pushNavigation, type TabHistory } from './history.ts'
import { formatSnapshot, snapshotScript, type RawSnapshot } from './page-script.ts'

/** Stable Cordis plugin name. */
export const name = 'chromium-surface'

/** Only the carrier is required; the surface degrades to "no browser installed" otherwise. */
export const inject = ['webServer']

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

/** One tab's durable, JSON-serializable state. */
export interface ChromiumTabState {
  id: number
  active: boolean
  title: string
  url: string
  history: TabHistory
}

/** The whole session snapshot the UI consumes. */
export interface ChromiumState {
  tabs: ChromiumTabState[]
  activeTabId: number | null
}

/** What one `/chromium/act` call can do. */
export type ChromiumAction =
  | 'navigate' | 'open' | 'close' | 'activate' | 'back' | 'forward'
  | 'reload' | 'read' | 'click' | 'type' | 'press' | 'scroll'

/** A live tab: the Playwright page plus the history model it mirrors. */
interface LiveTab {
  tab: ChromiumTabState
  page: Page
}

function defaultStatePath(): string {
  const env = process.env.DSH_CHROMIUM_STATE
  return env !== undefined && env.length > 0 ? env : join(homedir(), '.dsh', 'chromium-state.json')
}

function loadState(path: string): ChromiumState {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (typeof parsed === 'object' && parsed !== null && Array.isArray((parsed as { tabs?: unknown }).tabs)) {
      return parsed as ChromiumState
    }
  } catch { /* absent or malformed: start fresh */ }
  return { tabs: [], activeTabId: null }
}

/** The Playwright-backed surface. */
export class ChromiumSurface {
  private browser: Browser | undefined
  private context: BrowserContext | undefined
  private readonly live = new Map<number, LiveTab>()
  private nextId = 1
  private state: ChromiumState

  constructor(private readonly statePath: string = defaultStatePath(), private readonly headless = true) {
    this.state = loadState(statePath)
    // Re-seed ids above whatever was persisted, and reset persisted state to
    // closed tabs (the browser process never survives a restart).
    let max = 0
    for (const tab of this.state.tabs) if (tab.id > max) max = tab.id
    this.nextId = max + 1
    this.state = { tabs: [], activeTabId: null }
  }

  private ensureDir(): void {
    try { mkdirSync(this.statePath.split(/[\\/]/).slice(0, -1).join('/') || '.', { recursive: true }) } catch { /* best effort */ }
  }

  private async ensureContext(): Promise<BrowserContext> {
    if (this.context !== undefined && this.browser?.isConnected()) return this.context
    const browser = await chromium.launch({ headless: this.headless })
    this.browser = browser
    this.context = await browser.newContext({ userAgent: DEFAULT_USER_AGENT })
    return this.context
  }

  private async page(tabId: number): Promise<Page> {
    const existing = this.live.get(tabId)
    if (existing !== undefined && !existing.page.isClosed()) return existing.page
    const context = await this.ensureContext()
    const page = await context.newPage()
    page.setDefaultTimeout(15_000)
    page.setDefaultNavigationTimeout(30_000)
    this.live.set(tabId, { tab: this.tab(tabId), page })
    return page
  }

  private tab(tabId: number): ChromiumTabState {
    const found = this.state.tabs.find(tab => tab.id === tabId)
    if (found !== undefined) return found
    const created: ChromiumTabState = { id: tabId, active: false, title: '', url: '', history: EMPTY_HISTORY }
    this.state.tabs.push(created)
    return created
  }

  private async snap(page: Page): Promise<RawSnapshot> {
    return await page.evaluate(snapshotScript(20_000)) as RawSnapshot
  }

  private applyHistory(tabId: number, history: TabHistory, title: string, url: string): void {
    const tab = this.tab(tabId)
    tab.history = history
    tab.title = title
    tab.url = url
  }

  private persist(): void {
    this.ensureDir()
    try { writeFileSync(this.statePath, JSON.stringify(this.state)) } catch { /* best effort */ }
  }

  /** The current session snapshot, as plain data (no browser types). */
  snapshot(): ChromiumState {
    return JSON.parse(JSON.stringify(this.state)) as ChromiumState
  }

  /** Whether this surface has never navigated anywhere. */
  get empty(): boolean {
    return this.state.activeTabId === null
  }

  /** Run one named action; returns the resulting snapshot data plus formatted text. */
  async act(action: ChromiumAction, args: Record<string, unknown>): Promise<{ state: ChromiumState; text: string }> {
    const tabId = (args.tabId as number | undefined) ?? this.state.activeTabId
    switch (action) {
      case 'open': {
        const id = this.nextId++
        const fresh = this.tab(id)
        fresh.active = this.state.tabs.length === 1
        if (fresh.active) this.state.activeTabId = id
        else for (const tab of this.state.tabs) if (tab.id !== id) tab.active = false
        this.persist()
        return { state: this.snapshot(), text: '' }
      }
      case 'activate': {
        if (tabId !== undefined) {
          for (const tab of this.state.tabs) tab.active = tab.id === tabId
          this.state.activeTabId = tabId
          this.persist()
        }
        return { state: this.snapshot(), text: '' }
      }
      case 'close': {
        if (typeof tabId === 'number') {
          this.state.tabs = this.state.tabs.filter(tab => tab.id !== tabId)
          const page = this.live.get(tabId)?.page
          if (page !== undefined) { this.live.delete(tabId); void page.close().catch(() => {}) }
          if (this.state.activeTabId === tabId) this.state.activeTabId = this.state.tabs[0]?.id ?? null
          if (this.state.activeTabId !== null) for (const tab of this.state.tabs) tab.active = tab.id === this.state.activeTabId
          this.persist()
        }
        return { state: this.snapshot(), text: '' }
      }
    }
    if (typeof tabId !== 'number') {
      return { state: this.snapshot(), text: '(no tab is open yet — open or navigate first)' }
    }
    const page = await this.page(tabId)
    let snap: RawSnapshot
    switch (action) {
      case 'navigate': {
        const url = String(args.url ?? '')
        if (url === '') throw new Error('navigate needs a "url"')
        await page.goto(url, { waitUntil: 'domcontentloaded' })
        snap = await this.snap(page)
        this.applyHistory(tabId, pushNavigation(this.tab(tabId).history, { url: snap.url, title: snap.title }), snap.title, snap.url)
        break
      }
      case 'back':
        await page.goBack({ waitUntil: 'domcontentloaded' }).catch(() => {})
        snap = await this.snap(page)
        this.applyHistory(tabId, goBack(this.tab(tabId).history), snap.title, snap.url)
        break
      case 'forward':
        await page.goForward({ waitUntil: 'domcontentloaded' }).catch(() => {})
        snap = await this.snap(page)
        this.applyHistory(tabId, goForward(this.tab(tabId).history), snap.title, snap.url)
        break
      case 'reload':
        await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {})
        snap = await this.snap(page)
        this.applyHistory(tabId, this.tab(tabId).history, snap.title, snap.url)
        break
      case 'read':
        snap = await this.snap(page)
        break
      case 'click': {
        const ref = args.ref as number | undefined
        if (ref === undefined) throw new Error('click needs a "ref"')
        await page.click(`[data-ai-ref="${ref}"]`)
        await page.waitForLoadState('domcontentloaded').catch(() => {})
        snap = await this.snap(page)
        this.applyHistory(tabId, pushNavigation(this.tab(tabId).history, { url: snap.url, title: snap.title }), snap.title, snap.url)
        break
      }
      case 'type': {
        const ref = args.ref as number | undefined
        const text = String(args.text ?? '')
        if (ref === undefined) throw new Error('type needs a "ref"')
        await page.fill(`[data-ai-ref="${ref}"]`, text)
        snap = await this.snap(page)
        break
      }
      case 'press':
        await page.keyboard.press(String(args.key ?? 'Enter'))
        await page.waitForLoadState('domcontentloaded').catch(() => {})
        snap = await this.snap(page)
        break
      case 'scroll':
        await page.mouse.wheel(0, String(args.text) === 'up' ? -800 : 800)
        snap = await this.snap(page)
        break
      default:
        throw new Error(`unknown chromium action "${String(action)}"`)
    }
    this.persist()
    return { state: this.snapshot(), text: formatSnapshot(snap) }
  }

  /** Close the browser and every tab. */
  async dispose(): Promise<void> {
    for (const { page } of this.live.values()) await page.close().catch(() => {})
    this.live.clear()
    await this.context?.close().catch(() => {})
    this.context = undefined
    await this.browser?.close().catch(() => {})
    this.browser = undefined
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

/** Read a JSON request body, bounded. */
async function readBody(req: IncomingMessage, limit = 1_000_000): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buf = chunk as Buffer
    size += buf.length
    if (size > limit) throw new Error('request body too large')
    chunks.push(buf)
  }
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('body must be an object')
  return parsed as Record<string, unknown>
}

/** The plugin config. */
export interface Config {
  /** State file path; defaults to $DSH_CHROMIUM_STATE or ~/.dsh/chromium-state.json. */
  statePath?: string
  /** Launch headless (true) or headed (false, for debugging). */
  headless?: boolean
}

export const Config: z<Config> = z.object({
  statePath: z.string().default(''),
  headless: z.boolean().default(true),
})

/** Mount `/chromium` HTTP + WebSocket routes on the webserver carrier. */
export function apply(ctx: Context, config: Config = {}): void {
  const surface = new ChromiumSurface(config.statePath === '' ? defaultStatePath() : config.statePath, config.headless)
  const wss = new WebSocketServer({ noServer: true })

  const push = (ws: WebSocket): void => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'state', state: surface.snapshot() }))
  }

  ctx.effect(() => {
    const state = ctx.webServer.register({
      kind: 'exact',
      path: '/chromium/state',
      handler: (req, res) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return }
        sendJson(res, 200, surface.snapshot())
      },
    })
    const act = ctx.webServer.register({
      kind: 'exact',
      path: '/chromium/act',
      handler: async (req, res) => {
        if (req.method !== 'POST') { res.writeHead(405); res.end(); return }
        try {
          const body = await readBody(req)
          const action = String(body.action ?? '')
          delete body.action
          const result = await surface.act(action as ChromiumAction, body)
          for (const client of wss.clients) push(client)
          sendJson(res, 200, { ok: true, ...result })
        } catch (error) {
          sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      },
    })
    const upgrade = ctx.webServer.registerUpgrade({
      path: '/chromium/stream',
      handler: (_req, socket: Duplex, head) => {
        wss.handleUpgrade(_req, socket as unknown as Socket, head, (ws) => {
          push(ws)
          ws.on('close', () => {})
        })
      },
    })
    return () => {
      state()
      act()
      upgrade()
      for (const client of wss.clients) client.close()
      wss.close()
      void surface.dispose()
    }
  }, 'chromium-surface: routes')
}

export { EMPTY_HISTORY, goBack, goForward, pushNavigation, type TabHistory } from './history.ts'
export { formatSnapshot, snapshotScript, type RawSnapshot, type RawElement } from './page-script.ts'
