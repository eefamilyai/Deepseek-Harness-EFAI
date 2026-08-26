/**
 * @deepseek-ai/dsh-host-sidebar-bridge — a self-contained host surface for the
 * sidebar panels, served over the `webServer` carrier so it needs none of the
 * RPC protocol:
 *
 *   - WS   /kiln/terminal            a DEDICATED user shell (a real PTY via
 *                                    `ctx.subprocess`) in the chat's cwd — its
 *                                    own session, independent of whatever the
 *                                    model runs in its terminal tool.
 *   - GET  /kiln/browser/state       the agent's live browser `state.json`.
 *   - GET  /kiln/browser/shot/<name> a screenshot PNG.
 *   - POST /kiln/browser/act         drive `browser_use` on the SHARED browser.
 *
 * The browser is one process-wide `KilnBrowser` inside the kernel, so the model
 * and the user drive the SAME browser: the pane reads its state straight off
 * disk (no kernel round-trip, so it never queues behind a model cell) and posts
 * actions through the kernel only when the user actually does something. When
 * the model is idle it is, to the user, just a normal browser.
 *
 * @module @deepseek-ai/dsh-host-sidebar-bridge
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import type { Duplex } from 'node:stream'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { WebSocketServer } from 'ws'
import type { WebSocket } from 'ws'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-subprocess'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import type {} from '@deepseek-ai/dsh-kernel'

/** Stable Cordis plugin name. */
export const name = 'sidebar-bridge'

/**
 * Only the carrier is required. `subprocess` (the PTY substrate) and `kernel`
 * (the browser's home) are read opportunistically per request, so the terminal
 * and the browser pane each degrade on their own: a build without the kernel
 * still gets a working terminal, and one without a subprocess backend still
 * gets a working browser pane.
 */
export const inject = ['webServer']

/** The empty browser state served when nothing has been captured yet. */
const EMPTY_STATE = JSON.stringify({ url: '', title: '', screenshot: '', text_preview: '', links: [] })

/** A screenshot filename must be a plain basename ending in .png (no traversal). */
const SHOT_NAME = /^[\w.-]+\.png$/

/** Minimal view of the kernel service, read opportunistically for browser actions. */
interface KernelLike {
  execute(request: { code: string; timeoutMs?: number }, signal?: AbortSignal): Promise<{ output: string }>
}

/** Plugin config: where the browser writes, and which shell the terminal runs. */
export interface Config {
  /**
   * Directory browser_tools writes its `state.json` + screenshots to — the same
   * `KILN_BROWSER_DIR` the kernel passes to the Python runtime. Defaults to
   * `$KILN_BROWSER_DIR`, then `~/.dsh/browser`.
   */
  browserDir?: string
  /** Shell for the sidebar terminal. Empty = the platform default (COMSPEC / $SHELL). */
  shell?: string
}

export const Config: z<Config> = z.object({
  browserDir: z.string().default(''),
  shell: z.string().default(''),
})

/** Complete config after schemastery applies defaults. */
type ResolvedConfig = Required<Config>

/** The browser directory this bridge reads — config first, then env, then the home default. */
function resolveBrowserDir(config: ResolvedConfig): string {
  if (config.browserDir.length > 0) return config.browserDir
  const fromEnv = process.env.KILN_BROWSER_DIR
  return fromEnv !== undefined && fromEnv.length > 0 ? fromEnv : join(homedir(), '.dsh', 'browser')
}

/** The shell argv for a sidebar terminal: an explicit config shell, else the platform default. */
function shellArgv(config: ResolvedConfig): string[] {
  if (config.shell.length > 0) return [config.shell]
  // cmd.exe reads commands line by line from a piped stdin and echoes its own
  // prompt + command, so the scrollback reads like a normal terminal.
  if (process.platform === 'win32') return [process.env.COMSPEC ?? 'cmd.exe']
  // `-i` makes bash print a prompt (and try to echo) even over a pipe.
  return [process.env.SHELL ?? '/bin/bash', '-i']
}

/** Collect a request body as UTF-8, rejecting anything over `limit` bytes. */
async function readBody(req: IncomingMessage, limit = 1_000_000): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buf = chunk as Buffer
    size += buf.length
    if (size > limit) throw new Error('request body too large')
    chunks.push(buf)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** Write a JSON response with no-store caching (the state is live and changes constantly). */
function sendJson(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(body)
}

/** GET /kiln/browser/state — the agent's live browser state, or an empty state before first use. */
async function serveState(browserDir: string, res: ServerResponse): Promise<void> {
  try {
    const raw = await readFile(join(browserDir, 'state.json'), 'utf8')
    sendJson(res, 200, raw)
  } catch {
    // Absent/unparsed state is not an error to the pane: the browser simply has
    // not been used yet, so it shows an empty page rather than a failure.
    sendJson(res, 200, EMPTY_STATE)
  }
}

/** GET /kiln/browser/shot/<name> — one captured screenshot, traversal-guarded. */
async function serveShot(browserDir: string, pathname: string, res: ServerResponse): Promise<void> {
  const name = basename(decodeURIComponent(pathname.slice('/kiln/browser/shot/'.length)))
  if (!SHOT_NAME.test(name)) {
    res.writeHead(400)
    res.end()
    return
  }
  try {
    const png = await readFile(join(browserDir, name))
    res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' })
    res.end(png)
  } catch {
    res.writeHead(404)
    res.end()
  }
}

/**
 * POST /kiln/browser/act — drive `browser_use` on the shared browser.
 *
 * The body is `{ "action": "navigate", "url": "…" }` (any browser_use action
 * plus its keyword args). It is handed to Python base64-encoded, so a URL or
 * selector carrying quotes can never break out of the generated cell.
 */
async function serveAct(ctx: Context, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const kernel = ctx.get('kernel') as unknown as KernelLike | undefined
  if (kernel === undefined) {
    sendJson(res, 503, JSON.stringify({ error: 'the kernel (and its browser) is not available' }))
    return
  }
  let request: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(await readBody(req))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('body must be an object')
    request = parsed as Record<string, unknown>
  } catch (error) {
    sendJson(res, 400, JSON.stringify({ error: error instanceof Error ? error.message : 'invalid JSON body' }))
    return
  }
  const payload = Buffer.from(JSON.stringify(request), 'utf8').toString('base64')
  const code = [
    'import json as _j, base64 as _b',
    `_r = _j.loads(_b.b64decode(${JSON.stringify(payload)}).decode("utf-8"))`,
    '_act = _r.pop("action", "navigate")',
    'print(browser_use(_act, **_r))',
  ].join('\n')
  try {
    const result = await kernel.execute({ code, timeoutMs: 45_000 })
    sendJson(res, 200, JSON.stringify({ ok: true, output: result.output }))
  } catch (error) {
    sendJson(res, 500, JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
  }
}

/**
 * Bridge one WebSocket to a fresh piped shell in the requested cwd.
 *
 * There is no OS PTY here — the primitive is unavailable on Windows — so this is
 * a piped child: the shell reads commands line by line from stdin and prints
 * its own prompt/echo plus output. `?cwd=` is the chat's workspace. stdout and
 * stderr stream to the socket; socket messages are written to stdin verbatim.
 * Closing either side tears down the other, so a closed pane never leaks a
 * shell. Full-screen TUIs (vim/htop) are out of scope for a piped fallback.
 */
function openTerminal(ctx: Context, config: ResolvedConfig, req: IncomingMessage, ws: WebSocket): void {
  const url = new URL(req.url ?? '/', 'http://x')
  const cwd = url.searchParams.get('cwd') ?? process.cwd()

  const subprocess = ctx.get('subprocess')
  if (subprocess === undefined) {
    if (ws.readyState === ws.OPEN) ws.send('\r\n[terminal unavailable: no subprocess backend in this build]\r\n')
    ws.close()
    return
  }
  let handle: SubprocessHandle
  try {
    handle = subprocess.spawn({
      argv: shellArgv(config),
      cwd,
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
      graceMs: 3_000,
    })
  } catch (error) {
    if (ws.readyState === ws.OPEN) ws.send(`\r\n[terminal failed to start: ${error instanceof Error ? error.message : String(error)}]\r\n`)
    ws.close()
    return
  }
  const stdin = handle.stdin
  if (handle.pid === -1 || stdin === undefined) {
    if (ws.readyState === ws.OPEN) ws.send('\r\n[terminal failed to start: the shell did not spawn]\r\n')
    ws.close()
    return
  }
  const forward = (chunk: Buffer | string): void => {
    if (ws.readyState === ws.OPEN) ws.send(typeof chunk === 'string' ? chunk : chunk.toString('utf8'))
  }
  handle.stdout?.on('data', forward)
  handle.stderr?.on('data', forward)
  ws.on('message', (data: unknown) => {
    const text = typeof data === 'string' ? data : Buffer.isBuffer(data) ? data.toString('utf8') : String(data)
    stdin.write(text)
  })
  ws.on('close', () => { handle.terminate() })
  void handle.done.finally(() => { if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) ws.close() })
}

/**
 * Mount the sidebar bridge routes on the web carrier.
 * @param ctx - host context providing `webServer`, `subprocess`, and (optionally) `kernel`.
 * @param config - browser directory and shell overrides.
 */
export function apply(ctx: Context, config: ResolvedConfig): void {
  const browserDir = resolveBrowserDir(config)
  const wss = new WebSocketServer({ noServer: true })

  ctx.effect(() => {
    const disposers = [
      ctx.webServer.register({
        kind: 'exact',
        path: '/kiln/browser/state',
        handler: async (req, res) => {
          if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return }
          await serveState(browserDir, res)
        },
      }),
      ctx.webServer.register({
        kind: 'prefix',
        path: '/kiln/browser/shot',
        handler: async (req, res) => {
          if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return }
          const pathname = new URL(req.url ?? '/', 'http://x').pathname
          await serveShot(browserDir, pathname, res)
        },
      }),
      ctx.webServer.register({
        kind: 'exact',
        path: '/kiln/browser/act',
        handler: async (req, res) => {
          if (req.method !== 'POST') { res.writeHead(405); res.end(); return }
          await serveAct(ctx, req, res)
        },
      }),
      ctx.webServer.registerUpgrade({
        path: '/kiln/terminal',
        handler: (req, socket: Duplex, head) => {
          // The carrier types the upgrade socket as a Duplex; ws wants the
          // net.Socket it actually is at runtime.
          wss.handleUpgrade(req, socket as unknown as Socket, head, (ws) => {
            void openTerminal(ctx, config, req, ws)
          })
        },
      }),
    ]
    return () => {
      for (const dispose of disposers) dispose()
      wss.close()
    }
  }, 'sidebar-bridge routes')
}
