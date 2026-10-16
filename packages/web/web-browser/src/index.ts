/**
 * `@deepseek-ai/dsh-web-browser`: a real browser for the model.
 *
 * Registers two things. The `browser` tool drives a real browser — the model
 * reads the page as text with numbered controls and acts by ref, and can ask for
 * a `screenshot` when it needs to look at the page instead of read it. And, when
 * the web seam is present, a browser-rendered `WebFetchProvider` so `web_fetch`
 * returns JS-executed content instead of raw HTML.
 *
 * Which browser carries the tool's page is the `driver` field. `sidebar` uses the
 * `agentBrowser` service from `@deepseek-ai/dsh-web-browser-sidebar`: the page
 * lives in the Desktop window's right sidebar, where the operator can watch and
 * use it. `headless` uses one lazily launched Playwright Chromium, which the
 * fetch provider always uses; its binary is a one-time
 * `npx playwright install chromium`, and a launch without it fails with that exact
 * instruction rather than a stack trace. `auto` picks the sidebar whenever a
 * Desktop window is connected and headless otherwise, per call.
 *
 * @module @deepseek-ai/dsh-web-browser
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-web'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-web-browser-sidebar'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { BrowserManager } from './browser.ts'
import type { BrowserDriver } from './driver.ts'
import { SidebarBrowserDriver } from './sidebar-driver.ts'
import { BrowserFetchProvider } from './provider.ts'
import { browserTool } from './tool.ts'

export { BrowserManager } from './browser.ts'
export type { BrowserLimits, CapturedScreenshot, RenderedPage } from './browser.ts'
export { BrowserFetchProvider, BROWSER_FETCH_PROVIDER_ID } from './provider.ts'
export { browserTool, BROWSER_ACTIONS } from './tool.ts'
export type { BrowserCallTarget } from './tool.ts'
export type { BrowserDriver, BrowserPageTarget } from './driver.ts'
export { SidebarBrowserDriver } from './sidebar-driver.ts'
export type { SidebarDriverLimits } from './sidebar-driver.ts'
export { formatSnapshot } from './serialize.ts'
export { snapshotScript } from './page-script.ts'
export type { RawElement, RawSnapshot } from './page-script.ts'

/** A recent desktop Chrome UA, so sites serve their normal (not bot) markup. */
export const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'web-browser'

/**
 * The seams this plugin registers into.
 *
 * `attachments` and `llm` are deliberately absent: only the `screenshot` action
 * needs them, and requiring them here would keep the whole plugin — including
 * `web_fetch` — out of a composition that has no durable store. Execution
 * resolves them and refuses a screenshot with a message saying which is missing.
 * `agentBrowser` is absent for the same reason: only the sidebar driver needs it,
 * and each call resolves it.
 */
export const inject = ['tools', 'web', 'systemPrompt']

/** Plugin config (all defaulted). */
export interface Config {
  /** Timeout for a page load (ms). */
  navigationTimeoutMs?: number
  /** Timeout for a click/type/press (ms). */
  actionTimeoutMs?: number
  /** Cap on the page text captured per snapshot (chars). */
  maxTextChars?: number
  /** Cap on the text returned for one tool call (chars). */
  maxOutputChars?: number
  /** Launch Chromium headless (true) or headed (false, for debugging). */
  headless?: boolean
  /** `User-Agent` presented to sites. */
  userAgent?: string
  /** Register the browser-rendered fetch provider with `ctx.web` when present (default true). */
  fetchProvider?: boolean
  /** Which browser carries the tool's page: the Desktop sidebar, headless Chromium, or `auto` (default). */
  driver?: 'auto' | 'sidebar' | 'headless'
  /** CSS pixel width a sidebar page lays out at while its tab is hidden. */
  viewportWidth?: number
  /** CSS pixel height a sidebar page lays out at while its tab is hidden. */
  viewportHeight?: number
}

export const Config: z<Config> = z.object({
  navigationTimeoutMs: z.number().default(30_000),
  actionTimeoutMs: z.number().default(15_000),
  maxTextChars: z.number().default(20_000),
  maxOutputChars: z.number().default(40_000),
  headless: z.boolean().default(true),
  userAgent: z.string().default(DEFAULT_USER_AGENT),
  fetchProvider: z.boolean().default(true),
  driver: z.union(['auto', 'sidebar', 'headless']).default('auto')
    .description('Which browser carries the browser tool\'s page. "sidebar" is the Desktop window\'s right sidebar, where the operator can watch it; "headless" is a Playwright Chromium in the Host; "auto" uses the sidebar whenever a Desktop window is connected.'),
  viewportWidth: z.natural().min(320).default(1280)
    .description('CSS pixel width a sidebar page lays out at while its tab is hidden.'),
  viewportHeight: z.natural().min(240).default(800)
    .description('CSS pixel height a sidebar page lays out at while its tab is hidden.'),
})

/** Upper bound on the subagent ancestry walked to find the conversation that shows a page. */
const MAX_DELEGATION_DEPTH = 32

/** Complete config after schemastery applies every field default. */
type ResolvedConfig = Required<Config>

/** Register the `browser` tool, its prompt guidance, and (optionally) the fetch provider. */
export function apply(ctx: Context, config: Config): void {
  const resolved = config as ResolvedConfig
  const browser = new BrowserManager({
    navigationTimeoutMs: resolved.navigationTimeoutMs,
    actionTimeoutMs: resolved.actionTimeoutMs,
    maxTextChars: resolved.maxTextChars,
    headless: resolved.headless,
    userAgent: resolved.userAgent,
  })

  ctx.systemPrompt.section({
    name: 'tool:browser',
    order: 101,
    text: [
      'You have a `browser` tool that drives a real browser. It is for pages a plain',
      'fetch cannot read — sites that render with JavaScript, or that need clicking, typing, and',
      'navigating. Most actions return the page as TEXT — its readable content, then a numbered',
      'list of the interactive elements as `[n] role: name`.',
      '',
      'Work the loop: `navigate` to a url, read the returned snapshot, then act by ref — `click`',
      'with the `[n]` of a link or button, `type` with a ref and text, `press` a key like Enter,',
      '`scroll`, or `back`. Each action returns a FRESH snapshot with new refs, so always act on',
      'the refs from the most recent result, never an older one.',
      '',
      'When the text projection is not enough — you need to see layout, styling, a chart, or a',
      'canvas the DOM does not describe — call `screenshot`. It returns the page as an image you',
      'can look at, with the page URL and title in the caption. Reach for it only when reading is',
      'insufficient: the text snapshot is cheaper and gives you the refs you act on.',
      '',
      'When the user is in the desktop app, the page is shown to them live while you use it, and',
      'they can act on it too — so they can sign in or solve a check for you if a page needs it.',
    ].join('\n'),
  })

  const sidebarLimits = {
    navigationTimeoutMs: resolved.navigationTimeoutMs,
    actionTimeoutMs: resolved.actionTimeoutMs,
    maxTextChars: resolved.maxTextChars,
    viewportWidth: resolved.viewportWidth,
    viewportHeight: resolved.viewportHeight,
  }
  const resolveDriver = (): BrowserDriver => {
    if (resolved.driver === 'headless') return browser
    const service = ctx.get('agentBrowser')
    if (service !== undefined && service.available()) return new SidebarBrowserDriver(service, sidebarLimits)
    if (resolved.driver === 'auto') return browser
    throw new Error(service === undefined
      ? 'the browser is set to the desktop sidebar, but this harness has no sidebar browser'
      : 'the browser is set to the desktop sidebar, but no desktop window is open to show it; ask the user to open the app')
  }
  const resolveTarget = (exec: ToolExecution): { pageId: string; displaySessionId: string } => {
    const session = exec.agent?.session
    // One page per session, so parallel conversations do not share a tab.
    const pageId = String(session?.id ?? 'default')
    // A subagent's page shows in the conversation the operator is looking at: its root.
    let header = session?.header
    const agents = ctx.get('agents')
    for (let depth = 0; header?.origin === 'subagent' && header.parentSession !== undefined && depth < MAX_DELEGATION_DEPTH; depth++) {
      const parent = agents?.get(header.parentSession)?.session.header
      if (parent === undefined) return { pageId, displaySessionId: header.parentSession }
      header = parent
    }
    return { pageId, displaySessionId: header?.id ?? pageId }
  }
  ctx.tools.register(browserTool(ctx, resolveDriver, resolveTarget, resolved.maxOutputChars))

  // A browser-rendered fetch provider for the web seam. Off via config for a
  // composition that wants the interactive tool without changing web_fetch.
  if (resolved.fetchProvider) {
    ctx.web.registerFetchProvider(new BrowserFetchProvider(browser))
  }

  // One browser outlives every call; close it when the plugin's scope tears down.
  ctx.effect(function* () {
    yield async () => { await browser.dispose() }
  }, 'web-browser lifecycle')
}
