/**
 * Turning a hand login into a captured credential.
 *
 * Adding an account opens that account's own profile in a visible window and
 * waits. Everything the gateway later replays — the bearer token, the device
 * ids, the user id, the user agent — is read back out of the profile after the
 * operator (or a scripted form fill) has signed in. Nothing is invented: a
 * derived fingerprint is a device DeepSeek has never seen, which is worse than
 * not sending one.
 *
 * @module dswg/browser/capture
 */

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Config } from '../config.ts'
import type { Page } from 'playwright'
import type { AccountRecord } from '../store/accounts.ts'
import { logger } from '../util/log.ts'
import { browserUserAgent } from '../util/text.ts'
import { AccountBrowser, ORIGIN, type Identity } from './worker.ts'

const log = logger('capture')

/** What a successful capture produced. */
export interface CapturedIdentity extends Identity {
  userAgent: string | null
  cookie: string | null
  capturedAt: number
}

/** Progress reports for the dashboard's add-account dialog. */
export type CapturePhase = 'opening' | 'waiting' | 'detected' | 'verifying' | 'done' | 'failed'

/** A live capture, so the UI can report progress and the operator can cancel. */
export interface CaptureJob {
  id: string
  accountId: string
  phase: CapturePhase
  message: string
  startedAt: number
  finishedAt: number | null
  result: CapturedIdentity | null
  error: string | null
}

/** Live captures by account id. */
export const captures = new Map<string, CaptureJob>()

/**
 * Whether the page in front of the operator is a human-verification challenge.
 *
 * The site shows one when it doubts the session, and it will not pass while the
 * window is being driven: the widget scores the browser it is running in. So the
 * capture reports it rather than waiting silently, and the address bar is the
 * answer — a sign-in done in a browser this gateway did not launch.
 * @param page - the page the operator is looking at.
 * @returns true when a challenge is on screen.
 */
async function showsChallenge(page: Page): Promise<boolean> {
  try {
    const result = await page.evaluate(`
      (() => {
        const text = (document.body && document.body.innerText) || ''
        if (/captcha|verify you are human|are you a robot|安全验证|人机验证|请完成验证/i.test(text)) return true
        return document.querySelector('iframe[src*="captcha" i], iframe[src*="hcaptcha" i], iframe[src*="recaptcha" i], [class*="captcha" i], [id*="captcha" i]') !== null
      })()
    `)
    return result === true
  } catch {
    // A navigating page cannot be read; that is not a challenge.
    return false
  }
}

/**
 * Wait for the profile to hold a signed-in session.
 * @param browser - the account's browser.
 * @param page - the page the operator is using.
 * @param timeoutMs - how long to wait.
 * @param signal - cancellation.
 * @param report - progress sink, told when a challenge is on screen.
 * @returns the identity, or null on timeout.
 */
async function waitForLogin(
  browser: AccountBrowser,
  page: Page,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  report: (phase: CapturePhase, message: string) => void,
): Promise<Identity | null> {
  const deadline = Date.now() + timeoutMs
  let challenged = false
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error('capture cancelled')
    const identity = await browser.identity()
    if (identity.token) return identity
    if (await showsChallenge(page)) {
      if (!challenged) {
        challenged = true
        log.warn('the sign-in window is showing a human-verification challenge', { account: browser.accountId })
      }
      report('verifying', 'the site is asking for human verification — solve it in the window, or use "Sign in with Chrome" for a browser this gateway did not launch')
    }
    await new Promise((resolve) => setTimeout(resolve, 1500))
  }
  return null
}

/**
 * Open the account's profile and capture whatever it signs in as.
 * @param config - gateway configuration.
 * @param account - the account row being completed.
 * @param options - prefill credentials, timeout, cancellation, progress.
 * @returns the captured identity.
 */
export async function captureLogin(
  config: Config,
  account: AccountRecord,
  options: {
    email?: string | null
    password?: string | null
    timeoutMs?: number
    signal?: AbortSignal
    onPhase?: (phase: CapturePhase, message: string) => void
  } = {},
): Promise<CapturedIdentity> {
  const timeoutMs = options.timeoutMs ?? 15 * 60 * 1000
  const report = (phase: CapturePhase, message: string): void => {
    const job = captures.get(account.id)
    if (job) {
      job.phase = phase
      job.message = message
    }
    options.onPhase?.(phase, message)
  }

  const job: CaptureJob = {
    id: account.id,
    accountId: account.id,
    phase: 'opening',
    message: 'opening the profile',
    startedAt: Date.now(),
    finishedAt: null,
    result: null,
    error: null,
  }
  captures.set(account.id, job)

  const browser = new AccountBrowser(config, account)
  try {
    report('opening', 'opening a visible browser window')
    const page = await browser.page({ visible: true })
    await page.goto(`${ORIGIN}/sign_in`, { waitUntil: 'domcontentloaded', timeout: 60_000 })
    await page.waitForTimeout(2000)

    if (options.email && options.password) {
      report('waiting', 'filling the sign-in form')
      try {
        await page.fill('input[placeholder="Phone number / email address"]', options.email, { timeout: 15_000 })
        await page.fill('input[type=password]', options.password, { timeout: 15_000 })
        await page.waitForTimeout(400)
        await page.getByText('Log in', { exact: true }).first().click({ timeout: 10_000 })
      } catch (error) {
        log.debug('form prefill failed; waiting for a hand login', { error: String(error) })
      }
    }

    report('waiting', 'sign in in the browser window (a verification code may be requested)')
    const identity = await waitForLogin(browser, page, timeoutMs, options.signal, report)
    if (!identity) throw new Error('timed out waiting for a signed-in session')

    report('detected', 'session detected, reading identity')
    const user = await browser.currentUser()
    const cookies = await page.context().cookies(ORIGIN)
    const userAgent = browserUserAgent(await page.evaluate(() => navigator.userAgent))

    const captured: CapturedIdentity = {
      ...identity,
      userId: identity.userId ?? readUserId(user.json),
      userAgent,
      cookie: cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; '),
      capturedAt: Date.now(),
    }

    // Mirror the identity beside the profile for humans and for recovery.
    const recordPath = join(config.home, 'identities', `${account.slug}.json`)
    writeFileSync(
      recordPath,
      JSON.stringify(
        {
          accountId: account.id,
          slug: account.slug,
          deviceId: captured.deviceId,
          did: captured.did,
          userId: captured.userId,
          userAgent: captured.userAgent,
          tokenLength: captured.token?.length ?? 0,
          capturedAt: new Date(captured.capturedAt).toISOString(),
        },
        null,
        2,
      ),
    )

    report('verifying', 'checking the captured session')
    const probe = await browser.probe()
    if (!probe.ok) {
      throw new Error(`the captured session did not pass a settings read (HTTP ${probe.status ?? '?'})`)
    }

    report('done', 'account ready')
    job.phase = 'done'
    job.finishedAt = Date.now()
    job.result = captured
    await browser.close()
    return captured
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    job.phase = options.signal?.aborted ? 'failed' : 'failed'
    job.error = message
    job.finishedAt = Date.now()
    await browser.close()
    throw error
  } finally {
    setTimeout(() => captures.delete(account.id), 60_000).unref()
  }
}

/**
 * Read the user id out of a `/users/current` payload.
 * @param payload - parsed JSON.
 * @returns the id, or null.
 */
function readUserId(payload: unknown): string | null {
  if (payload === null || typeof payload !== 'object') return null
  const data = (payload as { data?: { biz_data?: { id?: unknown } } }).data
  const id = data?.biz_data?.id
  return typeof id === 'string' ? id : null
}
