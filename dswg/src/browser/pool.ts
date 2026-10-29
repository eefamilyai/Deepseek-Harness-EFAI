/**
 * Per-account browser lifecycle, concurrency and pacing.
 *
 * Two rules keep the accounts healthy:
 *
 * 1. **One turn at a time per account.** A web chat session is a conversation,
 *    not a stateless endpoint; two turns interleaved on one login share a chat
 *    history and the site's per-account limits.
 * 2. **A minimum gap between turns.** The site throttles by account, and a
 *    client that answers faster than a human is the cheapest signal to notice.
 *    The gap is configuration, not a constant, because the right value depends
 *    on how the operator uses the gateway.
 *
 * @module dswg/browser/pool
 */

import type { Config } from '../config.ts'
import type { AccountRecord } from '../store/accounts.ts'
import { GatewayError } from '../util/errors.ts'
import { logger } from '../util/log.ts'
import { Semaphore, sleep } from '../util/async.ts'
import { AccountBrowser, type TurnOptions, type TurnResult } from './worker.ts'

const log = logger('pool')

/** Live state for one account. */
interface Entry {
  browser: AccountBrowser
  gate: Semaphore
  lastTurnAt: number
  /** Timestamps of turns inside the rolling minute. */
  recent: number[]
  pending: number
}

/** Handle returned to a turn caller. */
export interface Lease {
  browser: AccountBrowser
  account: AccountRecord
  release: () => void
}

/** Manages one warm browser per account. */
export class BrowserPool {
  #entries = new Map<string, Entry>()
  #reaper: NodeJS.Timeout | null = null

  readonly config: Config
  readonly #create: (config: Config, account: AccountRecord) => AccountBrowser

  /**
   * @param config - gateway configuration.
   * @param createBrowser - factory for an account's browser, replaced in tests.
   */
  constructor(
    config: Config,
    createBrowser: (config: Config, account: AccountRecord) => AccountBrowser = (inner, account) => new AccountBrowser(inner, account),
  ) {
    this.config = config
    this.#create = createBrowser
    this.#reaper = setInterval(() => {
      void this.evictIdle()
    }, 60_000)
    this.#reaper.unref()
  }

  /**
   * Take the per-account gate, launching the profile on demand.
   * @param account - the account to use.
   * @param options - `visible` forces a window.
   * @returns the lease; the caller must call `release`.
   */
  async lease(account: AccountRecord, options: { visible?: boolean } = {}): Promise<Lease> {
    const entry = this.#entry(account)
    if (entry.pending >= this.config.maxQueuePerAccount) {
      throw new GatewayError('busy', `account ${account.label} already has ${entry.pending} queued turns`, {
        retryAfterMs: 5000,
      })
    }
    entry.pending += 1
    try {
      await entry.gate.acquire()
    } finally {
      entry.pending -= 1
    }
    let released = false
    const release = (): void => {
      if (released) return
      released = true
      entry.lastTurnAt = Date.now()
      entry.recent.push(Date.now())
      entry.gate.release()
    }
    try {
      await entry.browser.page(options)
    } catch (error) {
      release()
      throw new GatewayError('upstream', `could not open the browser profile for ${account.label}: ${error instanceof Error ? error.message : String(error)}`, {
        retryable: true,
        cause: error,
      })
    }
    return { browser: entry.browser, account, release }
  }

  /**
   * Run one turn on an account, honouring the pacing rules.
   * @param account - the account.
   * @param options - turn options minus the lease.
   * @returns the turn result.
   */
  async turn(
    account: AccountRecord,
    options: Omit<TurnOptions, 'signal'> & { signal?: AbortSignal },
  ): Promise<TurnResult> {
    const entry = this.#entry(account)
    await this.#pace(entry, options.signal)
    const lease = await this.lease(account)
    try {
      return await lease.browser.turn(options)
    } finally {
      lease.release()
    }
  }

  /**
   * Wait until the account's pacing window allows another turn.
   * @param entry - the account entry.
   * @param signal - cancellation.
   */
  async #pace(entry: Entry, signal?: AbortSignal): Promise<void> {
    for (;;) {
      const now = Date.now()
      const gaps = now - entry.lastTurnAt
      const waitGap = Math.max(0, this.config.accountMinGapMs - gaps)
      entry.recent = entry.recent.filter((ts) => now - ts < 60_000)
      let waitRate = 0
      if (entry.recent.length >= this.config.accountRpm) {
        const oldest = entry.recent[0] as number
        waitRate = Math.max(0, 60_000 - (now - oldest))
      }
      const wait = Math.max(waitGap, waitRate)
      if (wait <= 0) return
      log.debug('pacing', { waitMs: wait, queued: entry.recent.length })
      await sleep(Math.min(wait, 5000), signal)
    }
  }

  /**
   * Get or create the entry for an account.
   * @param account - the account.
   * @returns its live state.
   */
  #entry(account: AccountRecord): Entry {
    let entry = this.#entries.get(account.id)
    if (!entry) {
      entry = {
        browser: this.#create(this.config, account),
        gate: new Semaphore(1),
        lastTurnAt: 0,
        recent: [],
        pending: 0,
      }
      this.#entries.set(account.id, entry)
    }
    return entry
  }

  /**
   * Open a profile without taking the turn gate, for admin actions.
   * @param account - the account.
   * @param options - `visible` forces a window.
   * @returns the browser.
   */
  async browser(account: AccountRecord, options: { visible?: boolean } = {}): Promise<AccountBrowser> {
    const entry = this.#entry(account)
    await entry.browser.page(options)
    return entry.browser
  }

  /**
   * Whether a warm browser exists for the account.
   * @param accountId - account id.
   * @returns true when a browser is live.
   */
  isWarm(accountId: string): boolean {
    return this.#entries.get(accountId)?.browser.isOpen ?? false
  }

  /**
   * Close profiles that have been idle beyond the configured window.
   */
  async evictIdle(): Promise<void> {
    const now = Date.now()
    for (const [id, entry] of this.#entries) {
      if (!entry.browser.isOpen) {
        this.#entries.delete(id)
        continue
      }
      if (entry.gate.available < 1) continue
      if (now - entry.browser.lastUsed < this.config.browserIdleMs) continue
      log.info('evicting idle profile', { account: id })
      await entry.browser.close()
      this.#entries.delete(id)
    }
  }

  /**
   * Close one account's browser.
   * @param accountId - account id.
   */
  async close(accountId: string): Promise<void> {
    const entry = this.#entries.get(accountId)
    if (!entry) return
    await entry.browser.close()
    this.#entries.delete(accountId)
  }

  /** Close every browser and stop the reaper. */
  async closeAll(): Promise<void> {
    if (this.#reaper) clearInterval(this.#reaper)
    this.#reaper = null
    await Promise.all([...this.#entries.values()].map((entry) => entry.browser.close()))
    this.#entries.clear()
  }
}
