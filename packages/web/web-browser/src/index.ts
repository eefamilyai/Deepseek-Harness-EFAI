/**
 * `@deepseek-ai/dsh-web-browser`: a self-hosted headless browser for the model.
 *
 * Registers two things. The `browser` tool lets a vision-less model drive a real
 * Chromium by text — read the page as text with numbered controls, then act by
 * ref. And, when the web seam is present, a browser-rendered `WebFetchProvider`
 * so `web_fetch` returns JS-executed content instead of raw HTML. Both share one
 * lazily launched browser; the Chromium binary is a one-time
 * `npx playwright install chromium`, and a launch without it fails with that
 * exact instruction rather than a stack trace.
 *
 * @module @deepseek-ai/dsh-web-browser
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-web'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { BrowserManager } from './browser.ts'
import { BrowserFetchProvider } from './provider.ts'
import { browserTool } from './tool.ts'

export { BrowserManager } from './browser.ts'
export type { BrowserLimits, RenderedPage } from './browser.ts'
export { BrowserFetchProvider, BROWSER_FETCH_PROVIDER_ID } from './provider.ts'
export { browserTool, BROWSER_ACTIONS } from './tool.ts'
export { formatSnapshot } from './serialize.ts'
export { snapshotScript } from './page-script.ts'
export type { RawElement, RawSnapshot } from './page-script.ts'

/** A recent desktop Chrome UA, so sites serve their normal (not bot) markup. */
export const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'web-browser'

/** The tool, web, and system-prompt seams this plugin registers into. */
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
}

export const Config: z<Config> = z.object({
  navigationTimeoutMs: z.number().default(30_000),
  actionTimeoutMs: z.number().default(15_000),
  maxTextChars: z.number().default(20_000),
  maxOutputChars: z.number().default(40_000),
  headless: z.boolean().default(true),
  userAgent: z.string().default(DEFAULT_USER_AGENT),
  fetchProvider: z.boolean().default(true),
})

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
      'You have a `browser` tool that drives a real headless browser. It is for pages a plain',
      'fetch cannot read — sites that render with JavaScript, or that need clicking, typing, and',
      'navigating. You never see pixels: every action returns the page as TEXT — its readable',
      'content, then a numbered list of the interactive elements as `[n] role: name`.',
      '',
      'Work the loop: `navigate` to a url, read the returned snapshot, then act by ref — `click`',
      'with the `[n]` of a link or button, `type` with a ref and text, `press` a key like Enter,',
      '`scroll`, or `back`. Each action returns a FRESH snapshot with new refs, so always act on',
      'the refs from the most recent result, never an older one.',
    ].join('\n'),
  })

  ctx.tools.register(browserTool(browser, resolved.maxOutputChars))

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
