/**
 * Gateway entry point.
 *
 * Wires configuration, storage, the browser pool and the HTTP surface together,
 * then serves until interrupted.
 *
 * @module dswg/main
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { extname, join } from 'node:path'
import { loadConfig, type Config } from './config.ts'
import { openDatabase, type Db } from './store/db.ts'
import { AccountRepo } from './store/accounts.ts'
import { KeyRepo } from './store/keys.ts'
import { UsageRepo } from './store/usage.ts'
import { WireLog } from './store/wirelog.ts'
import { Corpus } from './store/corpus.ts'
import { PatternStore } from './tools/learn.ts'
import { SecretBox } from './util/crypto.ts'
import { BrowserPool } from './browser/pool.ts'
import { readProfileIdentity } from './browser/native.ts'
import { TurnEngine } from './engine/turn.ts'
import { AccountSelector } from './engine/accounts.ts'
import { Router, header, isLoopback, remoteAddress, sendJson, type Ctx } from './util/http.ts'
import { GatewayError, asGatewayError } from './util/errors.ts'
import { readVerdict } from './upstream/verdict.ts'
import { logger, setLogLevel, type LogLevel } from './util/log.ts'
import { bearer, handleChatCompletions, handleListModels, readJsonBody } from './api/openai.ts'
import { handleMessages } from './api/anthropic.ts'
import * as admin from './api/admin.ts'
import type { Services } from './api/services.ts'
import type { ApiKey } from './store/keys.ts'

const VERSION = '0.1.0'
const log = logger('main')
const UI_DIR = fileURLToPath(new URL('../ui/', import.meta.url))

/** Per-key request budget, refilled by a rolling minute. */
const keyWindows = new Map<string, number[]>()

/**
 * Enforce a key's requests-per-minute budget.
 * @param keyId - the key id.
 * @param rpm - the key's limit, or null for unlimited.
 * @throws GatewayError when the budget is spent.
 */
function enforceKeyRate(keyId: string, rpm: number | null): void {
  if (rpm === null || rpm <= 0) return
  const now = Date.now()
  const window = (keyWindows.get(keyId) ?? []).filter((ts) => now - ts < 60_000)
  if (window.length >= rpm) {
    const retryAfter = Math.max(250, 60_000 - (now - (window[0] as number)))
    keyWindows.set(keyId, window)
    throw new GatewayError('rate_limit', `this API key is limited to ${rpm} requests per minute`, {
      status: 429,
      code: 'rate_limit_exceeded',
      retryAfterMs: retryAfter,
    })
  }
  window.push(now)
  keyWindows.set(keyId, window)
}

/**
 * Whether a failure should be rendered in the Anthropic envelope.
 * @param path - the request path.
 * @returns true for the messages endpoint.
 */
function wantsAnthropicEnvelope(path: string): boolean {
  return path.startsWith('/v1/messages')
}

/**
 * Boot the gateway.
 * @returns a handle that stops the server.
 */
/**
 * Build the services the HTTP surface needs.
 *
 * Injectable so a test can supply a scripted pool and exercise the real server,
 * the real adapters and the real error rendering without touching a browser.
 * @param config - resolved configuration.
 * @param overrides - services to replace.
 * @returns the services plus a shutdown hook.
 */
export function buildServices(
  config: Config,
  overrides: { pool?: BrowserPool; engine?: TurnEngine } = {},
): { services: Services; db: Db } {
  if (process.env.DSWG_LOG_LEVEL) setLogLevel(process.env.DSWG_LOG_LEVEL as LogLevel)
  const db = openDatabase(config.home)
  const box = new SecretBox(join(config.home, 'secret.key'))
  const accounts = new AccountRepo(db, box)
  const keys = new KeyRepo(db)
  const usage = new UsageRepo(db)
  const wire = new WireLog(db, config.home)
  const corpus = new Corpus(db, config.home)
  const patterns = new PatternStore(db)
  const pool = overrides.pool ?? new BrowserPool(config)
  const engine = overrides.engine ?? new TurnEngine(config, accounts, pool, { wire, corpus, patterns })
  const services: Services = {
    config,
    accounts,
    keys,
    usage,
    pool,
    engine,
    selector: new AccountSelector(accounts),
    wire,
    corpus,
    patterns,
    startedAt: Date.now(),
    version: VERSION,
  }
  return { services, db }
}

/**
 * Build the HTTP application for a set of services.
 * @param services - wired services.
 * @returns the router and a request listener.
 */
export function createApp(services: Services): { router: Router; listener: (req: IncomingMessage, res: ServerResponse) => void } {
  const router = new Router()

  router.get('/health', (ctx) => {
    const memory = process.memoryUsage()
    sendJson(ctx.res, 200, {
      ok: true,
      version: VERSION,
      uptimeMs: Date.now() - services.startedAt,
      // Watched during a soak: a gateway that leaks a handle per turn shows here
      // long before it shows in a failed request.
      memory: {
        rssMb: Math.round(memory.rss / 1e6),
        heapMb: Math.round(memory.heapUsed / 1e6),
        // Node keeps the handle list behind an undocumented accessor; it is the
        // cheapest signal for "a browser or socket per turn is not being closed".
        handles: typeof (process as unknown as { _getActiveHandles?: () => unknown[] })._getActiveHandles === 'function'
          ? ((process as unknown as { _getActiveHandles: () => unknown[] })._getActiveHandles().length)
          : -1,
      },
    })
  })

  router.post('/v1/chat/completions', async (ctx) => {
    const key = authenticateApi(services, ctx)
    enforceKeyRate(key.id, key.rpm)
    ctx.body = await readJsonBody(ctx.req)
    await handleChatCompletions(ctx, services, key)
  })

  router.post('/v1/messages', async (ctx) => {
    const key = authenticateApi(services, ctx)
    enforceKeyRate(key.id, key.rpm)
    ctx.body = await readJsonBody(ctx.req)
    await handleMessages(ctx, services, key)
  })

  router.get('/v1/models', (ctx) => {
    authenticateApi(services, ctx)
    handleListModels(ctx)
  })

  // --- admin -------------------------------------------------------------
  const adminGuard = (ctx: Ctx): void => {
    const presented = header(ctx.req, 'x-admin-token') ?? bearer(ctx.req)
    if (!admin.adminAllowed(services, presented, isLoopback(remoteAddress(ctx.req)))) {
      throw new GatewayError('auth', 'admin token required', { status: 401, code: 'admin_token_required' })
    }
  }
  const adminPost = (path: string, handler: (ctx: Ctx, services: Services) => Promise<void> | void): void => {
    router.post(path, async (ctx) => {
      adminGuard(ctx)
      ctx.body = await readJsonBody(ctx.req)
      await handler(ctx, services)
    })
  }
  const adminPatch = (path: string, handler: (ctx: Ctx, services: Services) => void): void => {
    router.patch(path, async (ctx) => {
      adminGuard(ctx)
      ctx.body = await readJsonBody(ctx.req)
      handler(ctx, services)
    })
  }
  const adminGet = (path: string, handler: (ctx: Ctx, services: Services) => Promise<void> | void): void => {
    router.get(path, async (ctx) => {
      adminGuard(ctx)
      await handler(ctx, services)
    })
  }
  const adminDelete = (path: string, handler: (ctx: Ctx, services: Services) => Promise<void> | void): void => {
    router.delete(path, async (ctx) => {
      adminGuard(ctx)
      await handler(ctx, services)
    })
  }

  adminGet('/admin/api/overview', (ctx) => admin.handleOverview(ctx, services))
  adminGet('/admin/api/accounts', (ctx) => admin.handleListAccounts(ctx, services))
  adminPost('/admin/api/accounts', (ctx) => admin.handleCreateAccount(ctx, services))
  adminGet('/admin/api/accounts/:id/capture', (ctx) => admin.handleCaptureStatus(ctx, services))
  adminPost('/admin/api/accounts/:id/cancel-capture', (ctx) => admin.handleCancelCapture(ctx, services))
  adminPost('/admin/api/accounts/:id/relogin', (ctx) => admin.handleRelogin(ctx, services))
  adminPost('/admin/api/accounts/:id/sign-in-native', (ctx) => admin.handleNativeSignIn(ctx, services))
  adminPost('/admin/api/accounts/:id/check', (ctx) => admin.handleCheckAccount(ctx, services))
  adminGet('/admin/api/accounts/:id/screenshot', (ctx) => admin.handleScreenshot(ctx, services))
  adminPatch('/admin/api/accounts/:id', (ctx) => admin.handlePatchAccount(ctx, services))
  adminDelete('/admin/api/accounts/:id', (ctx) => admin.handleDeleteAccount(ctx, services))
  adminGet('/admin/api/keys', (ctx) => admin.handleListKeys(ctx, services))
  adminPost('/admin/api/keys', (ctx) => admin.handleCreateKey(ctx, services))
  adminPatch('/admin/api/keys/:id', (ctx) => admin.handlePatchKey(ctx, services))
  adminPost('/admin/api/keys/:id/revoke', (ctx) => admin.handleRevokeKey(ctx, services))
  adminPost('/admin/api/keys/clear-revoked', (ctx) => admin.handleClearRevokedKeys(ctx, services))
  adminDelete('/admin/api/keys/:id', (ctx) => admin.handleDeleteKey(ctx, services))
  adminGet('/admin/api/usage', (ctx) => admin.handleUsage(ctx, services))
  adminGet('/admin/api/logs', (ctx) => admin.handleLogs(ctx, services))
  adminGet('/admin/api/logs/export', (ctx) => admin.handleLogsExport(ctx, services))
  adminGet('/admin/api/corpus', (ctx) => admin.handleCorpus(ctx, services))
  adminGet('/admin/api/corpus/:turnId', (ctx) => admin.handleCorpusTurn(ctx, services))
  adminGet('/admin/api/leaks', (ctx) => admin.handleLeaks(ctx, services))
  adminGet('/admin/api/patterns', (ctx) => admin.handlePatterns(ctx, services))
  adminDelete('/admin/api/patterns/:id', (ctx) => admin.handleDeletePattern(ctx, services))
  adminPost('/admin/api/mine', (ctx) => admin.handleMine(ctx, services))
  adminGet('/admin/api/models', (ctx) => { adminGuard(ctx); admin.handleModels(ctx) })

  // --- dashboard ---------------------------------------------------------
  const staticFiles: Record<string, string> = {
    '/admin': 'index.html',
    '/admin/': 'index.html',
    '/admin/app.js': 'app.js',
    '/admin/styles.css': 'styles.css',
  }
  for (const [path, file] of Object.entries(staticFiles)) {
    router.get(path, (ctx) => {
      try {
        const body = readFileSync(join(UI_DIR, file))
        const type = extname(file) === '.css' ? 'text/css; charset=utf-8' : extname(file) === '.js' ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8'
        ctx.res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' })
        ctx.res.end(body)
      } catch {
        ctx.res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
        ctx.res.end(`dashboard asset missing: ${file}`)
      }
    })
  }

  const listener = (req: IncomingMessage, res: ServerResponse): void => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    const found = router.match(req.method ?? 'GET', url.pathname)
    if (!found) {
      res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: { message: `no route for ${req.method} ${url.pathname}`, type: 'not_found_error', code: 'not_found' } }))
      return
    }
    // A client that disconnects mid-response makes `write` throw asynchronously;
    // without a listener that becomes an uncaught 'error' event and kills the
    // process, which for a gateway means every account goes cold.
    res.on('error', () => undefined)
    const ctx: Ctx = { req, res, url, params: found.params, body: null, raw: '' }
    // `Promise.resolve(handler(ctx))` evaluates the call first, so a handler that
    // throws synchronously — every admin route that rejects a missing account —
    // escaped the catch entirely and left the request with no response at all.
    // Deferring the call is what makes a sync throw a rejection.
    Promise.resolve()
      .then(() => found.handler(ctx))
      .catch((error: unknown) => {
      const gateway = asGatewayError(error)
      if (gateway.kind !== 'cancelled') {
        log.warn('request failed', { path: url.pathname, kind: gateway.kind, status: gateway.status, message: gateway.message })
      }
      if (res.writableEnded || res.destroyed) return
      if (res.headersSent) {
        // A stream already started; make the failure visible inside it.
        try {
          res.write(`\n\n${JSON.stringify({ error: { message: gateway.message, type: gateway.type, code: gateway.code } })}\n\n`)
          res.end()
        } catch {
          // The socket is gone; the log line above is the record.
        }
        return
      }
      const headers: Record<string, string> = { 'content-type': 'application/json; charset=utf-8' }
      if (gateway.retryAfterMs !== undefined) headers['retry-after'] = String(Math.ceil(gateway.retryAfterMs / 1000))
      res.writeHead(gateway.status, headers)
        res.end(JSON.stringify(wantsAnthropicEnvelope(url.pathname) ? gateway.toAnthropic() : gateway.toOpenAI()))
      })
  }
  return { router, listener }
}

/**
 * Boot the gateway on the configured port.
 * @param overrides - services to replace, used by tests.
 * @returns a handle that stops the server.
 */
export async function start(
  overrides: { pool?: BrowserPool; engine?: TurnEngine; port?: number; config?: Config } = {},
): Promise<{
  close: () => Promise<void>
  port: number
  services: Services
}> {
  const config = overrides.config ?? loadConfig()
  const { services, db } = buildServices(config, overrides)
  const { listener } = createApp(services)
  const server = createServer(listener)

  // Sessions expire on DeepSeek's clock, not ours. Checking warm profiles on an
  // interval turns "every request 401s until someone notices" into a dashboard
  // that already says re-login.
  let healthTimer: NodeJS.Timeout | null = null
  if (config.healthCheckMs > 0) {
    healthTimer = setInterval(() => {
      void (async () => {
        for (const account of services.accounts.list()) {
          if (!services.pool.isWarm(account.id) || account.status !== 'active' || account.disabled) continue
          try {
            const browser = await services.pool.browser(account)
            // The user record carries the account's own state — a mute included —
            // so a mute is noticed before a turn is spent discovering it.
            const user = await browser.currentUser()
            const userVerdict = user.json === undefined ? null : readVerdict(user.json)
            if (userVerdict && userVerdict.kind === 'muted') {
              services.accounts.update(account.id, {
                status: 'muted',
                mutedUntil: userVerdict.muteUntil ?? null,
                lastError: userVerdict.message,
              })
              services.wire.record({ kind: 'account.state', accountId: account.id, data: { to: 'muted', reason: `health check: ${userVerdict.message}`, muteUntil: userVerdict.muteUntil ?? null } })
              log.warn('account is muted', { account: account.id, until: userVerdict.muteUntil ?? null })
              continue
            }
            const probe = await browser.probe()
            const verdict = probe.json === undefined ? null : readVerdict(probe.json)
            if (verdict && verdict.kind === 'auth') {
              services.accounts.update(account.id, { status: 'reauth', lastError: verdict.message })
              services.wire.record({ kind: 'account.state', accountId: account.id, data: { to: 'reauth', reason: `health check: ${verdict.message}` } })
            } else if (probe.ok) {
              services.accounts.update(account.id, { status: 'active', lastError: null, cooldownUntil: null })
            }
          } catch {
            // A profile that will not open is reported by the next turn.
          }
        }
      })()
    }, config.healthCheckMs)
    healthTimer.unref()
  }

  // A profile can hold a session the database does not: a sign-in done in the
  // operator's own browser, a restart in the middle of a capture, a token that
  // was refreshed. Adopting it here is what keeps the dashboard from reporting
  // "waiting for re-login" for an account that is already signed in.
  for (const account of services.accounts.list()) {
    if (account.status === 'active' || account.disabled) continue
    const identity = readProfileIdentity(join(config.home, 'profiles', account.slug))
    if (identity.token === null || identity.token === account.token) continue
    services.accounts.update(account.id, {
      token: identity.token,
      status: 'active',
      lastError: null,
      cooldownUntil: null,
      ...(identity.deviceId === null ? {} : { deviceId: identity.deviceId }),
      ...(identity.did === null ? {} : { did: identity.did }),
    })
    services.wire.record({ kind: 'account.state', accountId: account.id, data: { to: 'active', reason: 'adopted the session already present in the profile' } })
    log.info('adopted a session found in the profile', { account: account.id, label: account.label })
  }

  await new Promise<void>((resolve) => server.listen(overrides.port ?? config.port, config.host, resolve))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : config.port
  log.info('gateway listening', {
    url: `http://${config.host}:${port}`,
    dashboard: `http://${config.host}:${port}/admin`,
    home: config.home,
    adminToken: config.adminToken === null ? 'loopback-only' : 'configured',
  })

  const close = async (): Promise<void> => {
    if (healthTimer) clearInterval(healthTimer)
    await services.pool.closeAll()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    // Releasing SQLite matters: an open handle keeps the file locked on Windows
    // and a second start against the same data directory then fails.
    try {
      db.sql.close()
    } catch {
      // Already closed by an earlier call.
    }
  }
  return { close, port, services }
}

/**
 * Authenticate an API request.
 * @param services - wired services.
 * @param ctx - the request context.
 * @returns the key.
 * @throws GatewayError when unauthenticated.
 */
function authenticateApi(services: Services, ctx: Ctx): ApiKey {
  const secret = bearer(ctx.req)
  if (secret === null) {
    throw new GatewayError('auth', 'missing API key: send `Authorization: Bearer sk-dswg-…` or `x-api-key`', { status: 401 })
  }
  const key = services.keys.authenticate(secret)
  if (!key) throw new GatewayError('auth', 'invalid or revoked API key', { status: 401 })
  return key
}

/**
 * CLI entry point.
 */
async function main(): Promise<void> {
  const handle = await start()
  const shutdown = (): void => {
    log.info('shutting down')
    void handle.close().then(() => process.exit(0))
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    log.error('failed to start', { error: error instanceof Error ? error.message : String(error) })
    process.exit(1)
  })
}
