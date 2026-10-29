/**
 * Turning upstream verdicts into account state.
 *
 * The distinction that matters: a *dead token* is fixed by logging in again, a
 * *mute* is fixed only by time, and a *busy* or *rate-limited* account is fixed
 * by waiting or by using another account. Conflating them is how a client ends
 * up retrying a mute until the account is locked, so each one writes different
 * state here.
 *
 * @module dswg/engine/health
 */

import type { AccountRepo, AccountRecord } from '../store/accounts.ts'
import type { Verdict } from '../upstream/verdict.ts'
import type { WireLog } from '../store/wirelog.ts'
import { GatewayError } from '../util/errors.ts'
import { logger } from '../util/log.ts'

const log = logger('health')

/** How long an account is skipped after a transient upstream refusal. */
const COOLDOWN_MS = {
  rate_limit: 60_000,
  busy: 15_000,
  waf: 120_000,
  network: 30_000,
  upstream: 20_000,
} as const

/**
 * How long an account is parked after one busy refusal, doubling per consecutive
 * refusal up to the observed throttle window.
 *
 * Fifteen seconds is right for a blip and useless for a window: the site's limit
 * clears on a roughly three-minute cycle, so an account that refuses three times
 * in a row is not busy, it is throttled, and asking again every fifteen seconds
 * just spends the retry budget on a refusal that cannot change yet.
 */
const BUSY_BASE_MS = 15_000
const BUSY_CEILING_MS = 180_000

/** Applies verdicts to stored account state. */
export class HealthTracker {
  readonly repo: AccountRepo
  readonly wire: WireLog | null
  /** Consecutive busy refusals per account, for the escalating cooldown. */
  #busyStreak = new Map<string, number>()

  /**
   * @param repo - account storage.
   * @param wire - forensic log; omitted in tests.
   */
  constructor(repo: AccountRepo, wire: WireLog | null = null) {
    this.repo = repo
    this.wire = wire
  }

  /**
   * Record a state transition, with the evidence that caused it.
   * @param account - the account.
   * @param from - previous status.
   * @param to - new status.
   * @param reason - why.
   * @param extra - additional context.
   */
  #transition(account: AccountRecord, from: string, to: string, reason: string, extra: Record<string, unknown> = {}): void {
    this.wire?.record({
      kind: 'account.state',
      accountId: account.id,
      data: { from, to, reason, label: account.label, ...extra },
    })
  }

  /**
   * Record a verdict against one account.
   * @param account - the account the verdict came from.
   * @param verdict - what the upstream said.
   * @returns the gateway error the caller should raise or fail over on.
   */
  apply(account: AccountRecord, verdict: Verdict): GatewayError {
    const now = Date.now()
    switch (verdict.kind) {
      case 'auth': {
        this.repo.update(account.id, { status: 'reauth', lastError: verdict.message })
        this.#transition(account, account.status, 'reauth', verdict.message, { verdictKind: verdict.kind, code: verdict.code })
        log.warn('account needs a re-login', { account: account.id, message: verdict.message })
        return new GatewayError('auth', `the DeepSeek session for "${account.label}" has expired; re-login from the dashboard`, {
          status: 401,
          code: 'account_session_expired',
        })
      }
      case 'muted': {
        const until = verdict.muteUntil ?? now + 72 * 3600_000
        this.repo.update(account.id, { status: 'muted', mutedUntil: until, lastError: verdict.message })
        this.#transition(account, account.status, 'muted', verdict.message, { verdictKind: verdict.kind, muteUntil: until })
        log.warn('account muted by the upstream', { account: account.id, until: new Date(until).toISOString(), message: verdict.message })
        return new GatewayError('muted', `"${account.label}" is muted by DeepSeek until ${new Date(until).toISOString()}: ${verdict.message}`, {
          status: 429,
          retryAfterMs: Math.max(1000, until - now),
        })
      }
      case 'device_risk': {
        // Never answered by rotating accounts: the same machine earns the same
        // verdict for every credential, and each attempt is another login.
        this.repo.update(account.id, { lastError: verdict.message, cooldownUntil: now + 600_000 })
        this.#transition(account, account.status, 'cooldown', verdict.message, { verdictKind: verdict.kind, cooldownMs: 600_000 })
        return new GatewayError('device_risk', `DeepSeek refused the device for "${account.label}": ${verdict.message}`, {
          status: 429,
          code: 'device_risk_refused',
          retryAfterMs: 600_000,
        })
      }
      case 'rate_limit': {
        this.repo.update(account.id, { cooldownUntil: now + COOLDOWN_MS.rate_limit, lastError: verdict.message })
        this.#transition(account, account.status, 'cooldown', verdict.message, { verdictKind: verdict.kind, cooldownMs: COOLDOWN_MS.rate_limit })
        return new GatewayError('rate_limit', `DeepSeek rate-limited "${account.label}": ${verdict.message}`, {
          status: 429,
          retryAfterMs: COOLDOWN_MS.rate_limit,
        })
      }
      case 'busy': {
        const streak = (this.#busyStreak.get(account.id) ?? 0) + 1
        this.#busyStreak.set(account.id, streak)
        const cooldown = Math.min(BUSY_CEILING_MS, BUSY_BASE_MS * 2 ** (streak - 1))
        this.repo.update(account.id, { cooldownUntil: now + cooldown, lastError: verdict.message })
        this.#transition(account, account.status, 'cooldown', verdict.message, {
          verdictKind: verdict.kind,
          cooldownMs: cooldown,
          streak,
        })
        return new GatewayError('busy', `DeepSeek is busy for "${account.label}": ${verdict.message}`, {
          status: 503,
          retryAfterMs: cooldown,
          details: { streak, cooldownMs: cooldown },
        })
      }
      case 'waf': {
        this.repo.update(account.id, { cooldownUntil: now + COOLDOWN_MS.waf, lastError: verdict.message })
        this.#transition(account, account.status, 'cooldown', verdict.message, { verdictKind: verdict.kind, cooldownMs: COOLDOWN_MS.waf })
        return new GatewayError('waf', `DeepSeek's edge refused "${account.label}": ${verdict.message}`, {
          status: 503,
          retryAfterMs: COOLDOWN_MS.waf,
        })
      }
      case 'context_length': {
        return new GatewayError('context_length', `the conversation is too long for DeepSeek: ${verdict.message}`, { status: 400 })
      }
      default: {
        this.repo.update(account.id, { cooldownUntil: now + COOLDOWN_MS.upstream, lastError: verdict.message })
        this.#transition(account, account.status, 'cooldown', verdict.message, { verdictKind: verdict.kind, cooldownMs: COOLDOWN_MS.upstream })
        return new GatewayError('upstream', `DeepSeek refused "${account.label}": ${verdict.message}`, {
          status: 502,
          retryAfterMs: COOLDOWN_MS.upstream,
        })
      }
    }
  }

  /**
   * Clear transient state after a successful turn.
   *
   * The record passed in was read when the turn started, so it does not carry a
   * cooldown this same turn wrote: a busy refusal that the retry then recovered
   * from would otherwise leave a working account parked until its cooldown
   * expired, and every request in that window would answer "no account is
   * available" for no reason. Recovery therefore writes the cleared state
   * unconditionally rather than checking the stale row first.
   * @param account - the account that just worked.
   */
  recover(account: AccountRecord): void {
    this.#busyStreak.delete(account.id)
    const current = this.repo.get(account.id) ?? account
    if (current.status === 'disabled' || current.disabled) return
    this.repo.update(account.id, {
      status: 'active',
      cooldownUntil: null,
      lastError: null,
      ...(current.status === 'muted' ? { mutedUntil: null } : {}),
    })
  }
}
