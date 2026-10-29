import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadConfig, type Config } from '../src/config.ts'
import { openDatabase, type Db } from '../src/store/db.ts'
import { AccountRepo, type AccountRecord } from '../src/store/accounts.ts'
import { SecretBox } from '../src/util/crypto.ts'
import { BrowserPool, type Lease } from '../src/browser/pool.ts'
import type { AccountBrowser } from '../src/browser/worker.ts'

/** A browser double that records how many turns ran at once. */
function fakeBrowser(state: { active: number; peak: number; closed: number; turnMs: number }): AccountBrowser {
  const browser = {
    isOpen: true,
    lastUsed: Date.now(),
    async page() {
      return {}
    },
    async turn(options: { onEvent: (event: unknown) => void; signal?: AbortSignal }) {
      state.active += 1
      state.peak = Math.max(state.peak, state.active)
      try {
        await new Promise((resolve) => setTimeout(resolve, state.turnMs))
        options.onEvent({ t: 'done', ok: true })
        return { ok: true }
      } finally {
        state.active -= 1
      }
    },
    async deleteSession() {
      return undefined
    },
    async close() {
      state.closed += 1
      browser.isOpen = false
    },
  }
  return browser as unknown as AccountBrowser
}

describe('browser pool', () => {
  let home: string
  let db: Db
  let accounts: AccountRepo
  let config: Config

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'dswg-pool-'))
    config = loadConfig({ home, accountMinGapMs: 0, accountRpm: 1000, maxQueuePerAccount: 2 })
    db = openDatabase(home)
    accounts = new AccountRepo(db, new SecretBox(join(home, 'secret.key')))
  })

  afterEach(() => {
    db.sql.close()
    rmSync(home, { recursive: true, force: true })
  })

  /**
   * Store an account.
   * @returns the record.
   */
  function account(): AccountRecord {
    return accounts.create({ slug: 'a', label: 'main', email: 'a@b.c', token: 't', status: 'active' })
  }

  /**
   * Build a pool over the fake browser.
   * @param state - the shared counters.
   * @returns the pool.
   */
  function pool(state: { active: number; peak: number; closed: number; turnMs: number }): BrowserPool {
    return new BrowserPool(config, () => fakeBrowser(state))
  }

  it('never runs two turns at once on one account', async () => {
    const one = account()
    const state = { active: 0, peak: 0, closed: 0, turnMs: 25 }
    const subject = new BrowserPool(loadConfig({ home, accountMinGapMs: 0, accountRpm: 1000, maxQueuePerAccount: 8 }), () => fakeBrowser(state))
    await Promise.all(
      Array.from({ length: 4 }, (_unused, index) =>
        subject.turn(one, { id: `t${index}`, prompt: 'x', onEvent: () => undefined }),
      ),
    )
    assert.equal(state.peak, 1, 'turns must serialise per account')
    await subject.closeAll()
  })

  it('refuses more queued turns than the limit', async () => {
    const one = account()
    const state = { active: 0, peak: 0, closed: 0, turnMs: 120 }
    const subject = pool(state)
    const first = subject.turn(one, { id: 't0', prompt: 'x', onEvent: () => undefined })
    // Let the first turn take the gate.
    await new Promise((resolve) => setTimeout(resolve, 20))
    const waiting = Array.from({ length: 4 }, (_unused, index) =>
      subject.turn(one, { id: `t${index + 1}`, prompt: 'x', onEvent: () => undefined }).then(
        () => 'ran',
        (error: unknown) => ((error as { kind?: string }).kind === 'busy' ? 'busy' : 'other'),
      ),
    )
    const results = await Promise.all(waiting)
    await first
    assert.ok(results.includes('busy'), `expected a busy refusal, got ${results.join(',')}`)
    await subject.closeAll()
  })

  it('spaces consecutive turns by the configured gap', async () => {
    const one = account()
    const state = { active: 0, peak: 0, closed: 0, turnMs: 1 }
    const cfg = loadConfig({ home, accountMinGapMs: 150, accountRpm: 1000 })
    const subject = new BrowserPool(cfg, () => fakeBrowser(state))
    const started = Date.now()
    await subject.turn(one, { id: 'a', prompt: 'x', onEvent: () => undefined })
    await subject.turn(one, { id: 'b', prompt: 'x', onEvent: () => undefined })
    const elapsed = Date.now() - started
    assert.ok(elapsed >= 140, `expected pacing to add ~150ms, got ${elapsed}ms`)
    await subject.closeAll()
  })

  it('evicts an idle browser and closes it once', async () => {
    const one = account()
    const state = { active: 0, peak: 0, closed: 0, turnMs: 1 }
    const cfg = loadConfig({ home, accountMinGapMs: 0, accountRpm: 1000, browserIdleMs: 0 })
    const subject = new BrowserPool(cfg, () => fakeBrowser(state))
    await subject.turn(one, { id: 'a', prompt: 'x', onEvent: () => undefined })
    assert.equal(subject.isWarm(one.id), true)
    await subject.evictIdle()
    assert.equal(subject.isWarm(one.id), false)
    assert.equal(state.closed, 1)
    await subject.closeAll()
  })

  it('releases the gate when a turn throws', async () => {
    const one = account()
    const state = { active: 0, peak: 0, closed: 0, turnMs: 1 }
    const subject = new BrowserPool(config, () => {
      const browser = fakeBrowser(state)
      return {
        ...(browser as unknown as Record<string, unknown>),
        isOpen: true,
        lastUsed: Date.now(),
        async page() {
          return {}
        },
        async turn() {
          throw new Error('boom')
        },
        async close() {
          return undefined
        },
      } as unknown as AccountBrowser
    })
    await assert.rejects(() => subject.turn(one, { id: 'a', prompt: 'x', onEvent: () => undefined }), /boom/)
    // The gate must be free again, so the next turn proceeds.
    await new Promise((resolve) => setTimeout(resolve, 10))
    const lease: Lease = await subject.lease(one)
    lease.release()
    await subject.closeAll()
  })
})
