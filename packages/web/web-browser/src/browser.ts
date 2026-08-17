/**
 * The headless-browser manager: one lazily launched Chromium, one page per
 * session key, and the small set of actions the `browser` tool and the fetch
 * provider drive.
 *
 * Everything returns a {@link RawSnapshot}, because the model's only view of the
 * page is text: after every action it gets a fresh snapshot with new refs, and
 * acts on those. The refs are only valid until the next action reshapes the DOM,
 * which is exactly the read-act-read loop the tool prompt describes.
 *
 * @module @deepseek-ai/dsh-web-browser/browser
 */

import { chromium } from 'playwright'
import type { Browser, BrowserContext, Page } from 'playwright'
import { snapshotScript } from './page-script.ts'
import type { RawSnapshot } from './page-script.ts'

/** Resolved manager limits (the plugin's schemastery Config supplies defaults). */
export interface BrowserLimits {
  /** Timeout for a page load (ms). */
  navigationTimeoutMs: number
  /** Timeout for a click/type/press (ms). */
  actionTimeoutMs: number
  /** Cap on the page text returned in a snapshot (chars). */
  maxTextChars: number
  /** Launch Chromium headless (true) or headed (false, for debugging). */
  headless: boolean
  /** `User-Agent` presented to sites. */
  userAgent: string
}

/** What a rendered fetch returns to the web seam. */
export interface RenderedPage {
  url: string
  title: string
  text: string
  statusCode: number
}

/** The dedicated session key the fetch provider renders under, kept off the tool's pages. */
const FETCH_KEY = '__fetch__'

/** Advice attached to a launch failure — the browser binary is a separate one-time install. */
const INSTALL_HINT =
  'no headless browser is installed — run `npx playwright install chromium` once in the harness directory, then retry'

/** One Chromium instance shared across sessions, each session isolated in its own context. */
export class BrowserManager {
  private browser: Browser | undefined
  private readonly sessions = new Map<string, { context: BrowserContext; page: Page }>()

  constructor(private readonly limits: BrowserLimits) {}

  /** Launch (once) and return the shared browser, with a clear message when Chromium is absent. */
  private async ensureBrowser(): Promise<Browser> {
    const running = this.browser
    if (running !== undefined && running.isConnected()) return running
    let launched: Browser
    try {
      launched = await chromium.launch({ headless: this.limits.headless })
    } catch (error: unknown) {
      throw new Error(`${INSTALL_HINT} (${error instanceof Error ? error.message : String(error)})`)
    }
    this.browser = launched
    return launched
  }

  /** The live page for one session, created on first use. */
  private async pageFor(key: string): Promise<Page> {
    const existing = this.sessions.get(key)
    if (existing !== undefined && !existing.page.isClosed()) return existing.page
    const browser = await this.ensureBrowser()
    const context = await browser.newContext({ userAgent: this.limits.userAgent })
    const page = await context.newPage()
    page.setDefaultTimeout(this.limits.actionTimeoutMs)
    page.setDefaultNavigationTimeout(this.limits.navigationTimeoutMs)
    this.sessions.set(key, { context, page })
    return page
  }

  /** Collect the page's text projection. */
  private async snapshot(page: Page): Promise<RawSnapshot> {
    return (await page.evaluate(snapshotScript(this.limits.maxTextChars))) as RawSnapshot
  }

  /** Open a URL and return the resulting page. */
  async navigate(key: string, url: string): Promise<RawSnapshot> {
    const page = await this.pageFor(key)
    await page.goto(url, { waitUntil: 'domcontentloaded' })
    return this.snapshot(page)
  }

  /** Re-read the current page without acting. */
  async read(key: string): Promise<RawSnapshot> {
    return this.snapshot(await this.pageFor(key))
  }

  /** Click the element with the given ref, then snapshot whatever the click produced. */
  async click(key: string, ref: number): Promise<RawSnapshot> {
    const page = await this.pageFor(key)
    await page.click(`[data-ai-ref="${ref}"]`)
    await page.waitForLoadState('domcontentloaded').catch(() => { /* SPA navigations need no full load */ })
    return this.snapshot(page)
  }

  /** Fill the input with the given ref, then snapshot. */
  async type(key: string, ref: number, text: string): Promise<RawSnapshot> {
    const page = await this.pageFor(key)
    await page.fill(`[data-ai-ref="${ref}"]`, text)
    return this.snapshot(page)
  }

  /** Press one keyboard key (Enter, Tab, ArrowDown, …) on the focused element, then snapshot. */
  async press(key: string, keyName: string): Promise<RawSnapshot> {
    const page = await this.pageFor(key)
    await page.keyboard.press(keyName)
    await page.waitForLoadState('domcontentloaded').catch(() => { /* a keypress rarely triggers a full load */ })
    return this.snapshot(page)
  }

  /** Scroll the page up or down one viewport-ish step, then snapshot. */
  async scroll(key: string, direction: 'up' | 'down'): Promise<RawSnapshot> {
    const page = await this.pageFor(key)
    await page.mouse.wheel(0, direction === 'up' ? -800 : 800)
    return this.snapshot(page)
  }

  /** Go back one entry in history, then snapshot. */
  async back(key: string): Promise<RawSnapshot> {
    const page = await this.pageFor(key)
    await page.goBack({ waitUntil: 'domcontentloaded' }).catch(() => { /* nothing to go back to is not an error */ })
    return this.snapshot(page)
  }

  /** Render a URL for the fetch provider: navigate on the dedicated fetch page and return its text. */
  async render(url: string): Promise<RenderedPage> {
    const page = await this.pageFor(FETCH_KEY)
    const response = await page.goto(url, { waitUntil: 'domcontentloaded' })
    const snap = await this.snapshot(page)
    return { url: snap.url, title: snap.title, text: snap.text, statusCode: response?.status() ?? 200 }
  }

  /** Close every context and the browser; safe to call more than once. */
  async dispose(): Promise<void> {
    for (const { context } of this.sessions.values()) await context.close().catch(() => { /* best effort */ })
    this.sessions.clear()
    const browser = this.browser
    this.browser = undefined
    await browser?.close().catch(() => { /* best effort */ })
  }
}
