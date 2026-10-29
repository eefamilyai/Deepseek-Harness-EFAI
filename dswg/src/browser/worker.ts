/**
 * One Chromium profile per account.
 *
 * The profile is the account's identity: DeepSeek mints a device fingerprint
 * from the browser (canvas, GPU, audio entropy) and the web client replays it on
 * every login. A fresh browser context therefore looks like a brand-new device,
 * and several accounts sharing one context look like one device running several
 * logins — the exact pattern the anti-abuse stack watches. Keeping a real
 * persistent profile per account, and issuing every API request from inside it,
 * is what makes this gateway's traffic the profile's own.
 *
 * @module dswg/browser/worker
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { BrowserContext, Page } from 'playwright'
import { chromium } from 'playwright'
import type { Config } from '../config.ts'
import { chromeTarget } from '../config.ts'
import { logger } from '../util/log.ts'
import { browserUserAgent } from '../util/text.ts'
import type { AccountRecord } from '../store/accounts.ts'

const log = logger('browser')

/** Where the page-side runtime script lives. */
const RUNTIME_PATH = fileURLToPath(new URL('./page-runtime.js', import.meta.url))

/** The site origin every page in a profile is kept on. */
export const ORIGIN = 'https://chat.deepseek.com'

/** Identity values the browser profile minted. */
export interface Identity {
  token: string | null
  deviceId: string | null
  did: string | null
  userId: string | null
  smid: string | null
}

/** One upstream HTTP call as the page saw it. */
export interface HttpEntry {
  path?: string
  method?: string
  status?: number
  ms?: number
  requestHeaders?: Record<string, string>
  responseHeaders?: Record<string, string>
  requestBytes?: number
  responseBytes?: number
  responseBody?: string
  streaming?: boolean
  refused?: boolean
}

/** One chunk relayed from the page's SSE reader. */
export type TurnEvent =
  | { t: 'session'; sessionId: string }
  | { t: 'http'; entry: HttpEntry }
  | { t: 'ttfb'; ms: number }
  | { t: 'chunk'; v: string }
  | { t: 'done'; ok: boolean; sessionId?: string; bytes?: number; elapsedMs?: number }

/** Options for one upstream turn. */
export interface TurnOptions {
  /** Correlates events and cancellation. */
  id: string
  prompt: string
  sessionId?: string | null
  parentMessageId?: number | null
  modelType?: string
  thinking?: boolean
  search?: boolean
  refFileIds?: string[]
  /** Called for every streamed event. */
  onEvent: (event: TurnEvent) => void
  /** Cancel the in-page fetch when this aborts. */
  signal?: AbortSignal
}

/** What a turn resolved to. */
export interface TurnResult {
  ok: boolean
  sessionId?: string
  bytes?: number
  elapsedMs?: number
  /** Present when the turn failed. */
  failure?: { kind: string; status?: number; body?: string; message?: string }
}

/** A live browser bound to one account. */
export class AccountBrowser {
  readonly accountId: string
  readonly profileDir: string
  #context: BrowserContext | null = null
  #page: Page | null = null
  #launching: Promise<Page> | null = null
  #emitters = new Map<string, (event: TurnEvent) => void>()
  #closed = false
  lastUsed = Date.now()

  readonly config: Config
  readonly account: AccountRecord

  /**
   * @param config - gateway configuration.
   * @param account - the account this profile belongs to.
   */
  constructor(config: Config, account: AccountRecord) {
    this.config = config
    this.account = account
    this.accountId = account.id
    this.profileDir = join(config.home, 'profiles', account.slug)
  }

  /** True when a browser is live for this profile. */
  get isOpen(): boolean {
    return this.#context !== null && !this.#closed
  }

  /**
   * Launch the profile if needed and return a usable page on the site origin.
   * @param options - `visible` forces a window, which a hand login needs.
   * @returns the page.
   */
  async page(options: { visible?: boolean } = {}): Promise<Page> {
    if (this.#page && !this.#page.isClosed()) return this.#page
    if (this.#launching) return this.#launching
    this.#launching = this.#launch(options).finally(() => {
      this.#launching = null
    })
    return this.#launching
  }

  /**
   * Open the persistent context and park a page on the site.
   * @param options - `visible` overrides the configured headless mode.
   * @returns the page.
   */
  async #launch(options: { visible?: boolean }): Promise<Page> {
    mkdirSync(this.profileDir, { recursive: true })
    this.#closed = false
    const target = chromeTarget(this.config)
    log.info('launching profile', { account: this.accountId, slug: this.account.slug, headless: !options.visible && this.config.headless })
    let context: BrowserContext
    try {
      context = await chromium.launchPersistentContext(this.profileDir, {
        ...target,
        headless: options.visible ? false : this.config.headless,
        // A visible window is the window itself; a fixed viewport is one more
        // thing a real browser does not have.
        viewport: options.visible ? null : { width: 1280, height: 800 },
        locale: 'en-US',
        timezoneId: 'Asia/Singapore',
        args: this.config.chromeArgs,
        // A headless browser announces itself in the user agent, and the site
        // reads that string from the page and from every request header.
        ...(() => {
          const userAgent = browserUserAgent(this.account.userAgent)
          return userAgent === null ? {} : { userAgent }
        })(),
        // Playwright disables the sandbox by default, which both downgrades the
        // browser and makes it announce itself with an "unsupported flag"
        // banner across the top of every window.
        chromiumSandbox: true,
        // `--enable-automation` sets `navigator.webdriver` and raises the
        // "controlled by automated software" bar. The site's bot check reads
        // both, and a login that fails it is a login nobody can complete.
        ignoreDefaultArgs: ['--enable-automation'],
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // Two Chromium processes cannot share a user-data-dir. The Playwright error
      // for that is a wall of launch flags, which reads as a gateway bug rather
      // than "close the window you opened".
      if (/ProcessSingleton|SingletonLock|already in use|Target page, context or browser has been closed|profile directory/i.test(message)) {
        throw new Error(
          `the browser profile for "${this.account.label}" is already open in another Chrome window; close it (or the gateway's own window) and try again`,
        )
      }
      throw error
    }
    this.#context = context

    await context.exposeBinding('__dswgEmit', (source, id: unknown, event: unknown) => {
      if (typeof id !== 'string') return
      const emitter = this.#emitters.get(id)
      if (emitter) emitter(event as TurnEvent)
      void source
    })
    await context.addInitScript({ path: RUNTIME_PATH })

    const page = context.pages()[0] ?? (await context.newPage())
    context.on('close', () => {
      this.#closed = true
      this.#context = null
      this.#page = null
      for (const emitter of this.#emitters.values()) {
        emitter({ t: 'done', ok: false })
      }
      this.#emitters.clear()
    })
    page.on('crash', () => {
      log.warn('page crashed', { account: this.accountId })
      this.#page = null
    })
    this.#page = page
    await this.#ensureOnSite(page)
    return page
  }

  /**
   * Navigate to the site origin when the page is elsewhere, and make sure the
   * runtime script is present.
   * @param page - the page.
   */
  async #ensureOnSite(page: Page): Promise<void> {
    const url = page.url()
    if (!url.startsWith(ORIGIN)) {
      await page.goto(`${ORIGIN}/`, { waitUntil: 'domcontentloaded', timeout: 60_000 })
      await page.waitForTimeout(1500)
    }
    await page.evaluate(async () => {
      // The init script normally ran at document start; this covers a page that
      // was created before the script was registered.
      if (!(globalThis as unknown as { __dswg?: unknown }).__dswg) {
        await new Promise((resolve) => setTimeout(resolve, 250))
      }
    })
  }

  /**
   * Read the identity the profile minted.
   * @returns the identity values.
   */
  async identity(): Promise<Identity> {
    const page = await this.page()
    return (await page.evaluate(() => {
      const runtime = (globalThis as unknown as { __dswg: { identity(): Identity } }).__dswg
      return runtime.identity()
    })) as Identity
  }

  /**
   * Seed a token into the profile so the page's own client treats it as signed in.
   * @param token - the bearer token.
   */
  async seedToken(token: string): Promise<void> {
    const page = await this.page()
    await page.evaluate((value: string) => {
      const runtime = (globalThis as unknown as { __dswg: { seedToken(token: string): boolean } }).__dswg
      runtime.seedToken(value)
    }, token)
  }

  /**
   * Cheap liveness probe for the profile's session.
   * @returns the probe result.
   */
  async probe(): Promise<{ ok: boolean; status?: number; json?: unknown; text?: string; message?: string }> {
    const page = await this.page()
    return (await page.evaluate(() => {
      const runtime = (globalThis as unknown as { __dswg: { probe(): Promise<unknown> } }).__dswg
      return runtime.probe()
    })) as { ok: boolean; status?: number; json?: unknown; text?: string; message?: string }
  }

  /**
   * Read the current user record, which also confirms the token.
   * @returns the call result.
   */
  async currentUser(): Promise<{ ok: boolean; status?: number; json?: unknown; text?: string; message?: string }> {
    const page = await this.page()
    return (await page.evaluate(() => {
      const runtime = (globalThis as unknown as { __dswg: { currentUser(): Promise<unknown> } }).__dswg
      return runtime.currentUser()
    })) as { ok: boolean; status?: number; json?: unknown; text?: string; message?: string }
  }

  /**
   * Run one completion turn through the profile's own network stack.
   * @param options - prompt, session binding, toggles.
   * @returns the turn summary.
   */
  async turn(options: TurnOptions): Promise<TurnResult> {
    const page = await this.page()
    this.lastUsed = Date.now()
    this.#emitters.set(options.id, options.onEvent)
    const onAbort = (): void => {
      void page
        .evaluate((id: string) => {
          const runtime = (globalThis as unknown as { __dswg: { abort(id: string): boolean } }).__dswg
          return runtime.abort(id)
        }, options.id)
        .catch(() => undefined)
    }
    options.signal?.addEventListener('abort', onAbort, { once: true })
    try {
      const result = await page.evaluate(
        async (args: {
          id: string
          prompt: string
          modelType: string
          thinking: boolean
          search: boolean
          refFileIds: string[]
          parentMessageId: number | null
        }) => {
          const runtime = (globalThis as unknown as { __dswg: { turn(o: unknown): Promise<unknown> } }).__dswg
          return runtime.turn(args)
        },
        {
          id: options.id,
          prompt: options.prompt,
          modelType: options.modelType ?? 'default',
          thinking: options.thinking === true,
          search: options.search === true,
          refFileIds: options.refFileIds ?? [],
          parentMessageId: options.parentMessageId ?? null,
        },
      )
      const outcome = result as { ok: boolean; sessionId?: string; bytes?: number; elapsedMs?: number; kind?: string; status?: number; body?: string; message?: string }
      if (!outcome.ok) {
        return {
          ok: false,
          failure: {
            kind: outcome.kind ?? 'unknown',
            ...(outcome.status === undefined ? {} : { status: outcome.status }),
            ...(outcome.body === undefined ? {} : { body: outcome.body }),
            ...(outcome.message === undefined ? {} : { message: outcome.message }),
          },
        }
      }
      return { ok: true, sessionId: outcome.sessionId, bytes: outcome.bytes, elapsedMs: outcome.elapsedMs }
    } catch (error) {
      return { ok: false, failure: { kind: 'browser', message: error instanceof Error ? error.message : String(error) } }
    } finally {
      this.#emitters.delete(options.id)
      options.signal?.removeEventListener('abort', onAbort)
    }
  }

  /**
   * Delete an upstream chat session, keeping the account's sidebar clean.
   * @param sessionId - the upstream chat id.
   */
  async deleteSession(sessionId: string): Promise<void> {
    try {
      const page = await this.page()
      await page.evaluate((id: string) => {
        const runtime = (globalThis as unknown as { __dswg: { deleteSession(id: string): Promise<unknown> } }).__dswg
        return runtime.deleteSession(id)
      }, sessionId)
    } catch (error) {
      log.debug('session delete failed', { account: this.accountId, error: String(error) })
    }
  }

  /**
   * Take a screenshot of the profile's page, for the dashboard.
   * @returns PNG bytes.
   */
  async screenshot(): Promise<Buffer> {
    const page = await this.page({ visible: false })
    return page.screenshot({ type: 'png' })
  }

  /** Close the browser and release the profile. */
  async close(): Promise<void> {
    this.#closed = true
    const context = this.#context
    this.#context = null
    this.#page = null
    if (context) {
      try {
        await context.close()
      } catch {
        // A crash already released the OS resources; nothing else to do.
      }
    }
  }
}

/**
 * Read the bundled page runtime, for tests that evaluate it directly.
 * @returns the script source.
 */
export function pageRuntimeSource(): string {
  const path = RUNTIME_PATH
  if (!existsSync(path)) throw new Error(`page runtime missing at ${path}`)
  return readFileSync(path, 'utf8')
}
