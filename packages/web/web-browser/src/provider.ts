/**
 * A `WebFetchProvider` that renders a URL in the headless browser before
 * reading it, so `web_fetch` returns what a real browser sees — JavaScript run,
 * client-rendered content present — instead of the raw HTML the plain HTTP
 * provider gets. Registered into `ctx.web` alongside (or ahead of) the `http`
 * provider; the seam's `fetchProvider` config picks which one serves.
 *
 * @module @deepseek-ai/dsh-web-browser/provider
 */

import { WebError } from '@deepseek-ai/dsh-web'
import type { WebFetchProvider, WebFetchRequest, WebFetchResult } from '@deepseek-ai/dsh-web'
import type { BrowserManager } from './browser.ts'

/** Stable id this provider registers under. */
export const BROWSER_FETCH_PROVIDER_ID = 'browser'

/** Browser-rendered fetch: JS executed, content returned as clean text. */
export class BrowserFetchProvider implements WebFetchProvider {
  readonly id = BROWSER_FETCH_PROVIDER_ID

  constructor(private readonly browser: BrowserManager) {}

  /** The browser is launched lazily, so this provider is always nominally usable. */
  available(): boolean {
    return true
  }

  async fetch(request: WebFetchRequest, signal?: AbortSignal): Promise<WebFetchResult> {
    if (signal?.aborted) throw new WebError('web fetch aborted', 'WEB_ABORTED')
    try {
      const rendered = await this.browser.render(request.url)
      const content = rendered.title.length > 0 ? `# ${rendered.title}\n\n${rendered.text}` : rendered.text
      return { url: rendered.url, statusCode: rendered.statusCode, body: { kind: 'text', content }, truncated: false }
    } catch (error: unknown) {
      throw new WebError(
        `browser fetch failed: ${error instanceof Error ? error.message : String(error)}`,
        'WEB_PROVIDER_ERROR',
        { cause: error },
      )
    }
  }
}
