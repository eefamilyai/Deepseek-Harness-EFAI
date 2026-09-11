/**
 * `@deepseek-ai/dsh-web-browser`: a self-hosted headless browser for the harness.
 *
 * Registers one thing: a browser-rendered `WebFetchProvider` for the web seam,
 * so `web_fetch` returns what a real browser sees — JavaScript run,
 * client-rendered content present — instead of the raw HTML the plain HTTP
 * provider gets. The Chromium binary is a one-time
 * `npx playwright install chromium`, and a launch without it fails with that
 * exact instruction rather than a stack trace.
 *
 * @module @deepseek-ai/dsh-web-browser
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-web'
import { BrowserManager } from './browser.ts'
import { BrowserFetchProvider } from './provider.ts'

export { BrowserManager } from './browser.ts'
export type { BrowserLimits, RenderedPage } from './browser.ts'
export { BrowserFetchProvider, BROWSER_FETCH_PROVIDER_ID } from './provider.ts'

/** A recent desktop Chrome UA, so sites serve their normal (not bot) markup. */
export const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'web-browser'

/** The web seam this plugin registers into. */
export const inject = ['web']

/** Plugin config (all defaulted). */
export interface Config {
  /** Timeout for a page load (ms). */
  navigationTimeoutMs?: number
  /** Cap on the page text captured per render (chars). */
  maxTextChars?: number
  /** Launch Chromium headless (true) or headed (false, for debugging). */
  headless?: boolean
  /** `User-Agent` presented to sites. */
  userAgent?: string
  /** Register the browser-rendered fetch provider with `ctx.web` when present (default true). */
  fetchProvider?: boolean
}

export const Config: z<Config> = z.object({
  navigationTimeoutMs: z.number().default(30_000),
  maxTextChars: z.number().default(20_000),
  headless: z.boolean().default(true),
  userAgent: z.string().default(DEFAULT_USER_AGENT),
  fetchProvider: z.boolean().default(true),
})

/** Complete config after schemastery applies every field default. */
type ResolvedConfig = Required<Config>

/** Register the browser-rendered fetch provider with the web seam. */
export function apply(ctx: Context, config: Config): void {
  const resolved = config as ResolvedConfig
  const browser = new BrowserManager({
    navigationTimeoutMs: resolved.navigationTimeoutMs,
    maxTextChars: resolved.maxTextChars,
    headless: resolved.headless,
    userAgent: resolved.userAgent,
  })

  // Off via config for a composition that wants the web seam untouched.
  if (resolved.fetchProvider) {
    ctx.web.registerFetchProvider(new BrowserFetchProvider(browser))
  }

  // One browser outlives every fetch; close it when the plugin's scope tears down.
  ctx.effect(function* () {
    yield async () => { await browser.dispose() }
  }, 'web-browser lifecycle')
}
