/**
 * Dashboard API.
 *
 * Everything the management UI does goes through here: adding an account (which
 * opens that account's own browser profile for a real login), checking a
 * session, scoping API keys to accounts, and reading usage.
 *
 * @module dswg/api/admin
 */

import { join } from 'node:path'
import type { Ctx } from '../util/http.ts'
import type { Services } from './services.ts'
import type { AccountRecord } from '../store/accounts.ts'
import { captureLogin, captures } from '../browser/capture.ts'
import { openNativeSignIn, readProfileIdentity } from '../browser/native.ts'
import { readVerdict } from '../upstream/verdict.ts'
import { GatewayError } from '../util/errors.ts'
import { sendJson } from '../util/http.ts'
import { slug, uuid } from '../util/ids.ts'
import { MODES } from '../engine/models.ts'
import { minePatterns } from '../tools/learn.ts'
import { isEligible, ineligibilityReason } from '../engine/accounts.ts'
import { logger } from '../util/log.ts'
import { browserUserAgent } from '../util/text.ts'

const log = logger('admin')

/** Abort controllers for in-flight captures. */
const captureAborts = new Map<string, AbortController>()

/**
 * Serialize an account for the dashboard, without secrets.
 * @param account - the stored account.
 * @param warm - whether a browser is live for it.
 * @returns the public view.
 */
function viewAccount(account: AccountRecord, warm: boolean): Record<string, unknown> {
  return {
    id: account.id,
    label: account.label,
    email: account.email,
    status: account.disabled ? 'disabled' : account.status,
    deviceId: account.deviceId,
    did: account.did,
    userId: account.userId,
    warm,
    hasPassword: account.password !== null,
    mutedUntil: account.mutedUntil,
    cooldownUntil: account.cooldownUntil,
    createdAt: account.createdAt,
    lastUsedAt: account.lastUsedAt,
    lastError: account.lastError,
    notes: account.notes,
    eligible: isEligible(account),
    reason: ineligibilityReason(account),
  }
}

/**
 * Read one account or fail.
 * @param services - wired services.
 * @param id - account id.
 * @returns the account.
 * @throws GatewayError when it does not exist.
 */
function requireAccount(services: Services, id: string): AccountRecord {
  const account = services.accounts.get(id)
  if (!account) throw new GatewayError('not_found', `no account with id ${id}`, { status: 404 })
  return account
}

/**
 * Read a string field from a request body.
 * @param body - the parsed body.
 * @param key - the field name.
 * @returns the trimmed value, or null.
 */
function stringField(body: unknown, key: string): string | null {
  if (body === null || typeof body !== 'object') return null
  const value = (body as Record<string, unknown>)[key]
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

/**
 * `GET /admin/api/overview`.
 * @param ctx - the request context.
 * @param services - wired services.
 */
export function handleOverview(ctx: Ctx, services: Services): void {
  const accounts = services.accounts.list()
  const keys = services.keys.list()
  const counts = { total: accounts.length, active: 0, muted: 0, reauth: 0, disabled: 0, warm: 0 }
  for (const account of accounts) {
    if (account.disabled || account.status === 'disabled') counts.disabled += 1
    else if (account.status === 'muted') counts.muted += 1
    else if (account.status === 'reauth') counts.reauth += 1
    else counts.active += 1
    if (services.pool.isWarm(account.id)) counts.warm += 1
  }
  sendJson(ctx.res, 200, {
    version: services.version,
    uptimeMs: Date.now() - services.startedAt,
    accounts: counts,
    keys: { total: keys.length, active: keys.filter((key) => key.revokedAt === null).length },
    usage: services.usage.summary(24),
    config: {
      port: services.config.port,
      host: services.config.host,
      headless: services.config.headless,
      accountRpm: services.config.accountRpm,
      accountMinGapMs: services.config.accountMinGapMs,
      sessionCleanup: services.config.sessionCleanup,
      home: services.config.home,
      maxPromptChars: services.config.maxPromptChars,
    },
    recent: services.usage.recent(20),
  })
}

/**
 * `GET /admin/api/accounts`.
 * @param ctx - the request context.
 * @param services - wired services.
 */
export function handleListAccounts(ctx: Ctx, services: Services): void {
  const accounts = services.accounts.list()
  sendJson(ctx.res, 200, accounts.map((account) => viewAccount(account, services.pool.isWarm(account.id))))
}

/**
 * Start a capture for an account, in the background.
 * @param services - wired services.
 * @param account - the account row to complete.
 * @param options - credentials and timeout.
 */
function startCapture(
  services: Services,
  account: AccountRecord,
  options: { email: string | null; password: string | null; timeoutMs: number },
): void {
  const controller = new AbortController()
  captureAborts.set(account.id, controller)
  void captureLogin(services.config, account, {
    email: options.email,
    password: options.password,
    timeoutMs: options.timeoutMs,
    signal: controller.signal,
  })
    .then((captured) => {
      services.accounts.update(account.id, {
        status: 'active',
        token: captured.token,
        cookie: captured.cookie,
        deviceId: captured.deviceId,
        did: captured.did,
        userId: captured.userId,
        userAgent: captured.userAgent,
        lastError: null,
        mutedUntil: null,
        cooldownUntil: null,
      })
      log.info('account captured', { account: account.id })
      services.wire.record({
        kind: 'account.identity',
        accountId: account.id,
        data: { deviceId: captured.deviceId, did: captured.did, userId: captured.userId, userAgent: captured.userAgent, token: captured.token ? 'present' : 'absent', origin: 'capture' },
      })
    })
    .catch((error: unknown) => {
      services.accounts.update(account.id, {
        status: 'reauth',
        lastError: error instanceof Error ? error.message : String(error),
      })
      log.warn('account capture failed', { account: account.id, error: String(error) })
      services.wire.record({ kind: 'account.state', accountId: account.id, data: { to: 'reauth', reason: `capture failed: ${error instanceof Error ? error.message : String(error)}` } })
    })
    .finally(() => {
      captureAborts.delete(account.id)
    })
}

/**
 * `POST /admin/api/accounts`.
 * @param ctx - the request context.
 * @param services - wired services.
 */
export function handleCreateAccount(ctx: Ctx, services: Services): void {
  const label = stringField(ctx.body, 'label') ?? stringField(ctx.body, 'email') ?? `account-${uuid().slice(0, 6)}`
  const email = stringField(ctx.body, 'email')
  const password = stringField(ctx.body, 'password')
  const timeoutMs = (() => {
    const raw = ctx.body !== null && typeof ctx.body === 'object' ? (ctx.body as { timeoutMs?: unknown }).timeoutMs : undefined
    return typeof raw === 'number' && raw > 0 ? Math.min(raw, 60 * 60 * 1000) : 15 * 60 * 1000
  })()

  const account = services.accounts.create({
    slug: slug(email ?? label),
    label,
    email,
    ...(password === null ? {} : { password }),
    status: 'reauth',
    notes: 'created from the dashboard',
  })
  if (captures.has(account.id) === false) {
    captures.set(account.id, {
      id: account.id,
      accountId: account.id,
      phase: 'opening',
      message: 'starting',
      startedAt: Date.now(),
      finishedAt: null,
      result: null,
      error: null,
    })
  }
  services.wire.record({ kind: 'account.state', accountId: account.id, data: { to: 'reauth', reason: 'created from the dashboard' } })
  // The site's captcha refuses a browser that is being driven, so the default is
  // a browser this gateway never touches; the controlled window is for a machine
  // with no browser installed at all.
  const wantsControlled = stringField(ctx.body, 'mode') === 'controlled'
  const native = !wantsControlled && startNativeSignIn(services, account)
  if (!native) startCapture(services, account, { email, password, timeoutMs })
  sendJson(ctx.res, 201, {
    account: viewAccount(services.accounts.get(account.id) as AccountRecord, false),
    capture: captures.get(account.id),
    native,
  })
}

/**
 * `GET /admin/api/accounts/:id/capture`.
 * @param ctx - the request context.
 * @param services - wired services.
 */
export function handleCaptureStatus(ctx: Ctx, services: Services): void {
  const account = requireAccount(services, ctx.params.id as string)
  const job = captures.get(account.id)
  if (!job) {
    sendJson(ctx.res, 200, { accountId: account.id, phase: 'idle', message: '', startedAt: null, finishedAt: null })
    return
  }
  sendJson(ctx.res, 200, {
    accountId: job.accountId,
    phase: job.phase,
    message: job.message,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    error: job.error,
  })
}

/**
 * `POST /admin/api/accounts/:id/cancel-capture`.
 * @param ctx - the request context.
 * @param services - wired services.
 */
export function handleCancelCapture(ctx: Ctx, services: Services): void {
  const account = requireAccount(services, ctx.params.id as string)
  const controller = captureAborts.get(account.id)
  if (controller) controller.abort()
  sendJson(ctx.res, 200, { cancelled: controller !== undefined })
}

/**
 * `POST /admin/api/accounts/:id/relogin`.
 * @param ctx - the request context.
 * @param services - wired services.
 */
export function handleRelogin(ctx: Ctx, services: Services): void {
  const account = requireAccount(services, ctx.params.id as string)
  const email = stringField(ctx.body, 'email') ?? account.email
  const password = stringField(ctx.body, 'password') ?? account.password
  services.accounts.update(account.id, { status: 'reauth' })
  services.wire.record({ kind: 'account.state', accountId: account.id, data: { to: 'reauth', reason: 'relogin requested' } })
  const updated = services.accounts.get(account.id) as AccountRecord
  startCapture(services, updated, { email, password, timeoutMs: 15 * 60 * 1000 })
  sendJson(ctx.res, 202, { accountId: account.id, started: true })
}

/**
 * `POST /admin/api/accounts/:id/sign-in-native`.
 *
 * Opens the account's own profile in the installed browser, with no automation
 * attached, and reads the session back after the window closes. This is the path
 * for a sign-in the site gates behind human verification: the check scores the
 * browser it runs in, and this one is not being driven.
 * @param ctx - the request context.
 * @param services - wired services.
 */
export function handleNativeSignIn(ctx: Ctx, services: Services): void {
  const account = requireAccount(services, ctx.params.id as string)
  if (!startNativeSignIn(services, account)) {
    throw new GatewayError('protocol', 'no installed Chrome or Edge was found to open; set DSWG_CHROME_CHANNEL to its path', { status: 400 })
  }
  sendJson(ctx.res, 202, { accountId: account.id, started: true, native: true })
}

/**
 * Open a profile in the installed browser and read the session when it closes.
 *
 * This is the sign-in path that passes a human-verification check: the profile is
 * the same one turns use, but nothing drives the window, so the check has nothing
 * to score. The caller gets a job entry immediately and the account turns active
 * on its own once the operator finishes.
 * @param services - wired services.
 * @param account - the account whose profile to open.
 * @returns true when a browser window was opened.
 */
function startNativeSignIn(services: Services, account: AccountRecord): boolean {
  const profileDir = join(services.config.home, 'profiles', account.slug)
  const opened = openNativeSignIn(services.config, profileDir, 'https://chat.deepseek.com/sign_in')
  if (opened === null) return false
  services.accounts.update(account.id, { status: 'reauth', lastError: 'waiting for the sign-in window' })
  services.wire.record({ kind: 'account.state', accountId: account.id, data: { to: 'reauth', reason: 'native sign-in opened', pid: opened.pid } })
  captures.set(account.id, {
    id: account.id,
    accountId: account.id,
    phase: 'waiting',
    message: 'Chrome is open — sign in there',
    startedAt: Date.now(),
    finishedAt: null,
    result: null,
    error: null,
  })

  // The window belongs to the operator, so the profile on disk is the only
  // progress signal there is — and it is enough. A sign-in writes the token plus
  // both device ids into local storage, which is everything a turn needs, so the
  // account is adopted the moment they appear. The window is then just a window:
  // it can stay open, and nothing is waited on.
  let adopted = false
  const poll = setInterval(() => {
    const identity = readProfileIdentity(profileDir)
    if (identity.token === null) return
    const job = captures.get(account.id)
    if (!adopted) {
      adopted = true
      services.accounts.update(account.id, {
        status: 'active',
        token: identity.token,
        lastError: null,
        cooldownUntil: null,
        ...(identity.deviceId === null ? {} : { deviceId: identity.deviceId }),
        ...(identity.did === null ? {} : { did: identity.did }),
      })
      services.wire.record({
        kind: 'account.identity',
        accountId: account.id,
        data: { deviceId: identity.deviceId, did: identity.did, origin: 'native-sign-in' },
      })
      log.info('native sign-in adopted', { account: account.id, label: account.label })
      if (job) {
        job.phase = 'done'
        job.message = 'signed in — the account is ready, the window can stay open'
        job.finishedAt = Date.now()
        job.result = { token: identity.token, deviceId: identity.deviceId, did: identity.did, userId: null, smid: null, userAgent: null, cookie: null, capturedAt: Date.now() }
      }
    } else if (job && job.phase === 'done') {
      // A refreshed token replaces the one that was adopted.
      const current = services.accounts.get(account.id)
      if (current && current.token !== identity.token) {
        services.accounts.update(account.id, { token: identity.token })
        services.wire.record({ kind: 'account.state', accountId: account.id, data: { to: 'active', reason: 'session token refreshed by the profile' } })
      }
    }
  }, 1500)
  poll.unref?.()

  void opened.closed.then(async () => {
    clearInterval(poll)
    try {
      // The window is gone, so the profile is free: read the parts a browser is
      // needed for — the user id and the user agent the site saw — and leave
      // whatever was adopted in place when that is not possible.
      const browser = await services.pool.browser(account)
      const identity = await browser.identity()
      const job = captures.get(account.id)
      if (identity.token === null && !adopted) {
        services.accounts.update(account.id, { lastError: 'the sign-in window closed without a session' })
        services.wire.record({ kind: 'account.state', accountId: account.id, data: { to: 'reauth', reason: 'native sign-in produced no session' } })
        if (job) {
          job.phase = 'failed'
          job.message = 'the window closed without a session'
          job.error = 'no session was found in the profile'
          job.finishedAt = Date.now()
        }
        return
      }
      const page = await browser.page()
      const userAgent = browserUserAgent(await page.evaluate(() => navigator.userAgent))
      const user = await browser.currentUser()
      const verdict = user.json === undefined ? null : readVerdict(user.json)
      services.accounts.update(account.id, {
        status: verdict?.kind === 'muted' ? 'muted' : 'active',
        lastError: verdict?.kind === 'muted' ? verdict.message : null,
        ...(verdict?.kind === 'muted' && verdict.muteUntil !== undefined ? { mutedUntil: verdict.muteUntil } : {}),
        ...(identity.token === null ? {} : { token: identity.token }),
        ...(userAgent === null ? {} : { userAgent }),
        ...(identity.deviceId === null ? {} : { deviceId: identity.deviceId }),
        ...(identity.did === null ? {} : { did: identity.did }),
        ...(identity.userId === null ? {} : { userId: identity.userId }),
      })
      services.wire.record({
        kind: 'account.identity',
        accountId: account.id,
        data: { deviceId: identity.deviceId, did: identity.did, userId: identity.userId, origin: 'native-sign-in-close', user: user.status },
      })
    } catch (error) {
      // A profile that will not open yet is not a failed sign-in: the session was
      // already adopted from the files.
      log.debug('could not finish reading the profile after the sign-in window closed', { account: account.id, error: String(error) })
    }
  })
  return true
}

/**
 * `POST /admin/api/accounts/:id/check`.
 * @param ctx - the request context.
 * @param services - wired services.
 */
export async function handleCheckAccount(ctx: Ctx, services: Services): Promise<void> {
  const account = requireAccount(services, ctx.params.id as string)
  try {
    const browser = await services.pool.browser(account)
    const probe = await browser.probe()
    if (probe.ok) {
      // A working profile already holds the identity the gateway must replay;
      // reading it here is what makes "import an existing profile" complete
      // without another login.
      const identity = await browser.identity()
      const page = await browser.page()
      const userAgent = browserUserAgent(await page.evaluate(() => navigator.userAgent))
      services.wire.record({
        kind: 'account.identity',
        accountId: account.id,
        data: { deviceId: identity.deviceId, did: identity.did, userId: identity.userId, userAgent, origin: 'profile-import' },
      })
      services.accounts.update(account.id, {
        status: 'active',
        lastError: null,
        ...(identity.token === null ? {} : { token: identity.token }),
        ...(identity.deviceId === null ? {} : { deviceId: identity.deviceId }),
        ...(identity.did === null ? {} : { did: identity.did }),
        ...(identity.userId === null ? {} : { userId: identity.userId }),
        userAgent,
      })
      sendJson(ctx.res, 200, { ok: true, status: probe.status ?? 200, identity: { deviceId: identity.deviceId, did: identity.did, userId: identity.userId } })
      return
    }
    services.accounts.update(account.id, { status: 'reauth', lastError: probe.message ?? `HTTP ${probe.status ?? '?'}` })
    sendJson(ctx.res, 200, { ok: false, status: probe.status ?? null, message: probe.message ?? 'the session was refused' })
  } catch (error) {
    sendJson(ctx.res, 200, { ok: false, message: error instanceof Error ? error.message : String(error) })
  }
}

/**
 * `PATCH /admin/api/accounts/:id`.
 * @param ctx - the request context.
 * @param services - wired services.
 */
export function handlePatchAccount(ctx: Ctx, services: Services): void {
  const account = requireAccount(services, ctx.params.id as string)
  const body = (ctx.body ?? {}) as Record<string, unknown>
  const patch: Record<string, unknown> = {}
  if (typeof body.label === 'string' && body.label.trim().length > 0) patch.label = body.label.trim()
  if (typeof body.disabled === 'boolean') {
    patch.disabled = body.disabled
    patch.status = body.disabled ? 'disabled' : 'active'
  }
  if (body.rpmLimit === null || typeof body.rpmLimit === 'number') patch.rpmLimit = body.rpmLimit
  const updated = services.accounts.update(account.id, patch)
  sendJson(ctx.res, 200, viewAccount(updated as AccountRecord, services.pool.isWarm(account.id)))
}

/**
 * `DELETE /admin/api/accounts/:id`.
 * @param ctx - the request context.
 * @param services - wired services.
 */
export async function handleDeleteAccount(ctx: Ctx, services: Services): Promise<void> {
  const account = requireAccount(services, ctx.params.id as string)
  services.wire.record({ kind: 'account.state', accountId: account.id, data: { to: 'deleted', reason: 'removed from the dashboard' } })
  await services.pool.close(account.id)
  services.accounts.delete(account.id)
  sendJson(ctx.res, 200, { deleted: true })
}

/**
 * `GET /admin/api/accounts/:id/screenshot`.
 * @param ctx - the request context.
 * @param services - wired services.
 */
export async function handleScreenshot(ctx: Ctx, services: Services): Promise<void> {
  const account = requireAccount(services, ctx.params.id as string)
  if (!services.pool.isWarm(account.id)) {
    throw new GatewayError('not_found', 'this account has no live browser window', { status: 404 })
  }
  try {
    const browser = await services.pool.browser(account)
    const png = await browser.screenshot()
    ctx.res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' })
    ctx.res.end(png)
  } catch (error) {
    throw new GatewayError('upstream', `screenshot failed: ${error instanceof Error ? error.message : String(error)}`, { status: 500 })
  }
}

/**
 * `GET /admin/api/keys`.
 * @param ctx - the request context.
 * @param services - wired services.
 */
export function handleListKeys(ctx: Ctx, services: Services): void {
  sendJson(ctx.res, 200, services.keys.list())
}

/**
 * `POST /admin/api/keys`.
 * @param ctx - the request context.
 * @param services - wired services.
 */
export function handleCreateKey(ctx: Ctx, services: Services): void {
  const body = (ctx.body ?? {}) as Record<string, unknown>
  const name = typeof body.name === 'string' && body.name.trim().length > 0 ? body.name.trim() : 'api key'
  const accountIds = Array.isArray(body.accountIds) ? body.accountIds.filter((entry): entry is string => typeof entry === 'string') : []
  for (const id of accountIds) {
    if (!services.accounts.get(id)) throw new GatewayError('invalid_request', `no account with id ${id}`, { status: 400 })
  }
  const models = Array.isArray(body.models) ? body.models.filter((entry): entry is string => typeof entry === 'string') : []
  const rpm = typeof body.rpm === 'number' && body.rpm > 0 ? Math.trunc(body.rpm) : null
  const { key, secret } = services.keys.create({ name, accountIds, models, rpm })
  sendJson(ctx.res, 201, { key, secret })
}

/**
 * `PATCH /admin/api/keys/:id`.
 * @param ctx - the request context.
 * @param services - wired services.
 */
export function handlePatchKey(ctx: Ctx, services: Services): void {
  const id = ctx.params.id as string
  const existing = services.keys.get(id)
  if (!existing) throw new GatewayError('not_found', `no key with id ${id}`, { status: 404 })
  const body = (ctx.body ?? {}) as Record<string, unknown>
  const patch: Record<string, unknown> = {}
  if (typeof body.name === 'string' && body.name.trim().length > 0) patch.name = body.name.trim()
  if (Array.isArray(body.accountIds)) patch.accountIds = body.accountIds.filter((entry): entry is string => typeof entry === 'string')
  if (Array.isArray(body.models)) patch.models = body.models.filter((entry): entry is string => typeof entry === 'string')
  if (body.rpm === null || typeof body.rpm === 'number') patch.rpm = body.rpm
  sendJson(ctx.res, 200, services.keys.update(id, patch))
}

/**
 * `POST /admin/api/keys/:id/revoke`.
 * @param ctx - the request context.
 * @param services - wired services.
 */
export function handleRevokeKey(ctx: Ctx, services: Services): void {
  const id = ctx.params.id as string
  sendJson(ctx.res, 200, { revoked: services.keys.revoke(id) })
}

/**
 * `DELETE /admin/api/keys/:id` — remove a key row entirely.
 * @param ctx - the request context.
 * @param services - wired services.
 */
export function handleDeleteKey(ctx: Ctx, services: Services): void {
  const id = ctx.params.id as string
  if (!services.keys.get(id)) throw new GatewayError('not_found', `no key with id ${id}`, { status: 404 })
  sendJson(ctx.res, 200, { deleted: services.keys.delete(id) })
}

/**
 * `POST /admin/api/keys/clear-revoked` — drop every revoked key at once.
 * @param ctx - the request context.
 * @param services - wired services.
 */
export function handleClearRevokedKeys(ctx: Ctx, services: Services): void {
  const deleted = services.keys.deleteRevoked()
  services.wire.record({ kind: 'error', data: { clearedRevokedKeys: deleted } })
  sendJson(ctx.res, 200, { deleted })
}

/**
 * `GET /admin/api/usage`.
 * @param ctx - the request context.
 * @param services - wired services.
 */
export function handleUsage(ctx: Ctx, services: Services): void {
  const hours = Number(ctx.url.searchParams.get('hours') ?? '24')
  const limit = Number(ctx.url.searchParams.get('limit') ?? '100')
  sendJson(ctx.res, 200, {
    summary: services.usage.summary(Number.isFinite(hours) && hours > 0 ? hours : 24),
    recent: services.usage.recent(Number.isFinite(limit) && limit > 0 ? Math.min(limit, 500) : 100),
  })
}

/**
 * `GET /admin/api/logs` — the forensic record.
 *
 * Filters: `limit`, `accountId`, `kind`, `turnId`, `minutes`.
 * @param ctx - the request context.
 * @param services - wired services.
 */
export function handleLogs(ctx: Ctx, services: Services): void {
  const params = ctx.url.searchParams
  const limit = Number(params.get('limit') ?? '200')
  const minutes = Number(params.get('minutes') ?? '1440')
  const accountId = params.get('accountId')
  const kind = params.get('kind')
  const turnId = params.get('turnId')
  const since = Number.isFinite(minutes) && minutes > 0 ? Date.now() - minutes * 60_000 : null
  const rows = services.wire.query({
    limit: Number.isFinite(limit) ? limit : 200,
    accountId: accountId === null ? null : accountId,
    kind: kind === null ? null : (kind as never),
    turnId,
    since,
  })
  sendJson(ctx.res, 200, {
    counts: services.wire.counts(since ?? Date.now() - 86_400_000),
    events: rows,
  })
}

/**
 * `GET /admin/api/logs/export` — the raw JSONL for offline analysis.
 *
 * The point of the record is finding a pattern, and a pattern is easier to find
 * in a file the operator can grep, sort and diff than in a paginated table.
 * @param ctx - the request context.
 * @param services - wired services.
 */
export function handleLogsExport(ctx: Ctx, services: Services): void {
  const minutes = Number(ctx.url.searchParams.get('minutes') ?? '1440')
  const limit = Number(ctx.url.searchParams.get('limit') ?? '5000')
  const since = Number.isFinite(minutes) && minutes > 0 ? Date.now() - minutes * 60_000 : null
  const rows = services.wire
    .query({ limit: Number.isFinite(limit) ? Math.min(limit, 20000) : 5000, since })
    .slice()
    .reverse()
  const body = rows.map((row) => JSON.stringify({ ts: row.ts, iso: new Date(row.ts).toISOString(), kind: row.kind, accountId: row.accountId, turnId: row.turnId, ...row.data })).join('\n')
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  ctx.res.writeHead(200, {
    'content-type': 'application/x-ndjson; charset=utf-8',
    'content-disposition': `attachment; filename="dswg-log-${stamp}.jsonl"`,
    'cache-control': 'no-store',
  })
  ctx.res.end(`${body}\n`)
}

/**
 * `GET /admin/api/corpus` — captured model outputs.
 * @param ctx - the request context.
 * @param services - wired services.
 */
export function handleCorpus(ctx: Ctx, services: Services): void {
  const limit = Number(ctx.url.searchParams.get('limit') ?? '100')
  sendJson(ctx.res, 200, {
    turns: services.corpus.recent(Number.isFinite(limit) ? Math.min(limit, 500) : 100),
  })
}

/**
 * `GET /admin/api/corpus/:turnId` — one captured turn, raw and assembled.
 * @param ctx - the request context.
 * @param services - wired services.
 */
export function handleCorpusTurn(ctx: Ctx, services: Services): void {
  const payload = services.corpus.read(ctx.params.turnId as string)
  if (!payload) throw new GatewayError('not_found', 'no captured turn with that id', { status: 404 })
  sendJson(ctx.res, 200, payload)
}

/**
 * `GET /admin/api/leaks` — replies that looked like calls but registered none.
 * @param ctx - the request context.
 * @param services - wired services.
 */
export function handleLeaks(ctx: Ctx, services: Services): void {
  const limit = Number(ctx.url.searchParams.get('limit') ?? '50')
  sendJson(ctx.res, 200, { leaks: services.corpus.leaks(Number.isFinite(limit) ? Math.min(limit, 500) : 50) })
}

/**
 * `GET /admin/api/patterns` — learned delimiter pairs.
 * @param ctx - the request context.
 * @param services - wired services.
 */
export function handlePatterns(ctx: Ctx, services: Services): void {
  sendJson(ctx.res, 200, { patterns: services.patterns.list() })
}

/**
 * `DELETE /admin/api/patterns/:id` — forget one learned pattern.
 * @param ctx - the request context.
 * @param services - wired services.
 */
export function handleDeletePattern(ctx: Ctx, services: Services): void {
  sendJson(ctx.res, 200, { deleted: services.patterns.remove(ctx.params.id as string) })
}

/**
 * `POST /admin/api/mine` — induce delimiter pairs from the corpus.
 *
 * Runs over recorded leaks (positives) and prose replies (negatives), keeps only
 * pairs that recover at least `minSamples` leaks without matching prose, and
 * stores them so the reader uses them from the next turn on.
 * @param ctx - the request context.
 * @param services - wired services.
 */
export function handleMine(ctx: Ctx, services: Services): void {
  const body = (ctx.body ?? {}) as { minSamples?: unknown; apply?: unknown; limit?: unknown }
  const minimumHits = typeof body.minSamples === 'number' && body.minSamples > 0 ? Math.trunc(body.minSamples) : 2
  const apply = body.apply !== false
  const limit = typeof body.limit === 'number' && body.limit > 0 ? Math.min(Math.trunc(body.limit), 1000) : 300

  const leakRows = services.corpus.leakSamples(limit)
  const known = services.corpus.knownToolNames()
  const toolNames = new Set<string>(known)
  for (const row of leakRows) for (const name of row.tools) toolNames.add(name)
  const tools = [...toolNames].map((name) => ({ name, parameters: { type: 'object', properties: {} } }))
  const prose = services.corpus.proseSamples(limit)
  const proposed = minePatterns(
    leakRows.map((row) => row.text),
    prose,
    tools,
    minimumHits,
  )
  const stored = apply ? proposed.map((pattern) => services.patterns.add(pattern, 'corpus')) : []
  if (stored.length > 0) {
    for (const pattern of stored) {
      services.wire.record({
        kind: 'pattern.learned',
        data: { opener: pattern.opener, closer: pattern.closer, score: pattern.score },
      })
    }
  }
  sendJson(ctx.res, 200, {
    leaks: leakRows.length,
    prose: prose.length,
    proposals: proposed,
    stored: stored.map((pattern) => ({ id: pattern.id, opener: pattern.opener, closer: pattern.closer, score: pattern.score })),
  })
}

/**
 * `GET /admin/api/models`.
 * @param ctx - the request context.
 */
export function handleModels(ctx: Ctx): void {
  sendJson(ctx.res, 200, MODES.map((mode) => ({ id: mode.id, label: mode.label, thinking: mode.thinking, search: mode.search, default: mode.default })))
}

/**
 * Whether a request may use the admin API.
 * @param services - wired services.
 * @param presented - the token the client sent.
 * @param loopback - whether the request came from this machine.
 * @returns true when allowed.
 */
export function adminAllowed(services: Services, presented: string | null, loopback: boolean): boolean {
  const configured = services.config.adminToken
  if (configured === null) return loopback
  return presented !== null && presented === configured
}
