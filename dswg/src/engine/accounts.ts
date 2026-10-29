/**
 * Choosing which account serves a request.
 *
 * A key names the accounts it may use. Within that set the gateway prefers the
 * account that has been idle longest, skips anything muted, cooling down, or
 * waiting for a re-login, and keeps a conversation on the account that already
 * holds its upstream chat (when session reuse is enabled).
 *
 * @module dswg/engine/accounts
 */

import type { AccountRecord } from '../store/accounts.ts'
import type { AccountRepo } from '../store/accounts.ts'
import { GatewayError } from '../util/errors.ts'
import { logger } from '../util/log.ts'

const log = logger('accounts')

/** Whether an account may serve a request right now. */
export function isEligible(account: AccountRecord, now = Date.now()): boolean {
  if (account.disabled) return false
  if (account.status === 'disabled') return false
  if (account.status === 'reauth') return false
  if (account.mutedUntil !== null && account.mutedUntil > now) return false
  if (account.cooldownUntil !== null && account.cooldownUntil > now) return false
  if (account.status === 'muted' && (account.mutedUntil === null || account.mutedUntil > now)) return false
  return true
}

/**
 * Why an account is currently unavailable, for a client-facing message.
 * @param account - the account.
 * @param now - current time.
 * @returns a short reason, or null when the account is eligible.
 */
export function ineligibilityReason(account: AccountRecord, now = Date.now()): string | null {
  if (account.disabled || account.status === 'disabled') return 'disabled'
  if (account.status === 'reauth') return 'waiting for re-login'
  if (account.mutedUntil !== null && account.mutedUntil > now) return `muted until ${new Date(account.mutedUntil).toISOString()}`
  if (account.cooldownUntil !== null && account.cooldownUntil > now) return `cooling down until ${new Date(account.cooldownUntil).toISOString()}`
  return null
}

/**
 * When an account becomes usable again, or null when only a human can fix it.
 *
 * An account that is cooling down, muted for a stated time, or skipped for
 * pacing is not broken — it is resting, and the instant it wakes is knowable.
 * A disabled account and one waiting for a re-login are the opposite: no amount
 * of waiting ends those, so they must never hold a request open.
 * @param account - the account.
 * @returns the epoch millisecond it becomes eligible, or null when waiting cannot help.
 */
export function becomesEligibleAt(account: AccountRecord): number | null {
  if (account.disabled || account.status === 'disabled' || account.status === 'reauth') return null
  // A mute with no stated end is indefinite; it is not a wait, it is a wall.
  if (account.status === 'muted' && account.mutedUntil === null) return null
  const times = [account.cooldownUntil ?? 0, account.mutedUntil ?? 0]
  const at = Math.max(...times)
  return at > 0 ? at : 0
}

/** Result of a selection. */
export interface Selection {
  /** Accounts to try, best first. */
  candidates: AccountRecord[]
  /** Accounts the key allows but that cannot serve right now. */
  unavailable: Array<{ account: AccountRecord; reason: string }>
}

/** Picks accounts for one request. */
export class AccountSelector {
  readonly repo: AccountRepo
  /** Round-robin cursor per key scope, so consecutive requests alternate. */
  #cursors = new Map<string, number>()

  /**
   * @param repo - account storage.
   */
  constructor(repo: AccountRepo) {
    this.repo = repo
  }

  /**
   * Choose candidates for a key's allowed account set.
   * @param accountIds - ids the key allows; empty means every account.
   * @param stickyAccountId - the account that already holds a reused chat, if any.
   * @returns the ordered candidates and the rejected ones.
   */
  select(accountIds: string[], stickyAccountId: string | null = null): Selection {
    const all = this.repo.list()
    const scoped = accountIds.length === 0 ? all : all.filter((account) => accountIds.includes(account.id))
    const now = Date.now()
    const unavailable: Array<{ account: AccountRecord; reason: string }> = []
    const eligible: AccountRecord[] = []
    for (const account of scoped) {
      const reason = ineligibilityReason(account, now)
      if (reason === null) eligible.push(account)
      else unavailable.push({ account, reason })
    }
    if (eligible.length === 0) return { candidates: [], unavailable }

    const cursorKey = accountIds.join(',') || '*'
    const cursor = this.#cursors.get(cursorKey) ?? 0
    this.#cursors.set(cursorKey, (cursor + 1) % eligible.length)

    const ordered = [...eligible.slice(cursor), ...eligible.slice(0, cursor)]
    if (stickyAccountId) {
      const sticky = ordered.find((account) => account.id === stickyAccountId)
      if (sticky) ordered.splice(ordered.indexOf(sticky), 1)
      if (sticky) ordered.unshift(sticky)
    }
    return { candidates: ordered, unavailable }
  }

  /**
   * The soonest a key's account set comes back by itself.
   * @param accountIds - ids the key allows; empty means every account.
   * @param now - current time.
   * @returns the epoch millisecond, or null when waiting cannot help.
   */
  nextEligibleAt(accountIds: string[], now = Date.now()): number | null {
    const all = this.repo.list()
    const scoped = accountIds.length === 0 ? all : all.filter((account) => accountIds.includes(account.id))
    let best: number | null = null
    for (const account of scoped) {
      const at = becomesEligibleAt(account)
      if (at === null) continue
      const when = Math.max(at, now)
      if (best === null || when < best) best = when
    }
    return best
  }

  /**
   * Build the error a client sees when nothing can serve the request.
   * @param selection - the failed selection.
   * @param requested - how many accounts the key named, 0 meaning "all".
   * @returns the error to throw.
   */
  noCandidateError(selection: Selection, requested: number): GatewayError {
    if (selection.unavailable.length === 0) {
      return new GatewayError('permission', requested === 0 ? 'no accounts are configured on this gateway' : 'this API key has no accounts assigned', {
        status: 403,
        code: 'no_accounts',
      })
    }
    const reasons = selection.unavailable.map((entry) => `${entry.account.label}: ${entry.reason}`).join('; ')
    const retryAfter = Math.min(
      ...selection.unavailable
        .map((entry) => Math.max(0, (entry.account.mutedUntil ?? entry.account.cooldownUntil ?? 0) - Date.now()))
        .filter((value) => value > 0),
    )
    log.warn('no eligible account', { reasons })
    return new GatewayError('rate_limit', `no account is available for this key right now (${reasons})`, {
      status: 429,
      code: 'no_account_available',
      retryAfterMs: Number.isFinite(retryAfter) ? Math.max(1000, retryAfter) : 10_000,
    })
  }
}
