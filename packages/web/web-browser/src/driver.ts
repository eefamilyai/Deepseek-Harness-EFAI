/**
 * The page operations the `browser` tool performs, independent of which browser
 * carries the page.
 *
 * Two drivers implement it: the headless {@link BrowserManager} (Playwright Chromium in
 * the Host process) and {@link SidebarBrowserDriver} (the agent's page in the Desktop
 * window's right sidebar). The tool resolves one per call, so a Desktop window that
 * connects or disconnects between two calls changes which browser the next call uses.
 *
 * @module @deepseek-ai/dsh-web-browser/driver
 */

import type { CapturedScreenshot } from './browser.ts'
import type { RawSnapshot } from './page-script.ts'

/** Which page an operation addresses, and the conversation that shows it. */
export interface BrowserPageTarget {
  /** One page per owning Session, so parallel conversations do not share a tab. */
  readonly pageId: string
  /** The conversation whose sidebar shows the page: the owner, or its root for a subagent. */
  readonly displaySessionId: string
  /** Abandons the wait for the operation. */
  readonly signal?: AbortSignal | undefined
}

/** The operations behind the tool's actions; each acting one returns the page afterwards. */
export interface BrowserDriver {
  /** Where the page is shown, stated in the tool result so the model can tell the operator. */
  readonly surface: 'sidebar' | 'headless'
  navigate(target: BrowserPageTarget, url: string): Promise<RawSnapshot>
  read(target: BrowserPageTarget): Promise<RawSnapshot>
  click(target: BrowserPageTarget, ref: number): Promise<RawSnapshot>
  type(target: BrowserPageTarget, ref: number, text: string): Promise<RawSnapshot>
  press(target: BrowserPageTarget, key: string): Promise<RawSnapshot>
  scroll(target: BrowserPageTarget, direction: 'up' | 'down'): Promise<RawSnapshot>
  back(target: BrowserPageTarget): Promise<RawSnapshot>
  screenshot(target: BrowserPageTarget): Promise<CapturedScreenshot>
  /**
   * Run one script in the page's main world and return its JSON text.
   *
   * The script builders in `inspect.ts` return JSON text rather than a value so
   * one serialization rule serves both surfaces: a page value can be a DOM
   * node, a function, a `BigInt`, or a cycle, none of which survive a structured
   * clone the same way on Playwright and on the sidebar's CDP bridge.
   * @param target - the page to run in.
   * @param script - a JS expression whose completion value is JSON text.
   * @returns the script's JSON text.
   */
  evaluateScript(target: BrowserPageTarget, script: string): Promise<string>
}
