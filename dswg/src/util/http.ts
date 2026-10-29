/**
 * A very small HTTP router.
 *
 * The gateway has two API surfaces and a handful of admin routes, so a
 * dependency-free router is less code than wiring a framework would be, and it
 * keeps the streaming paths explicit.
 *
 * @module dswg/util/http
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

/** Maximum request body accepted, in bytes. */
const MAX_BODY = 32 * 1024 * 1024

/** One matched request. */
export interface Ctx {
  req: IncomingMessage
  res: ServerResponse
  url: URL
  params: Record<string, string>
  /** Parsed JSON body, when the request had one. */
  body: unknown
  /** Raw body text. */
  raw: string
}

/** A route handler. */
export type Handler = (ctx: Ctx) => Promise<void> | void

/** A registered route. */
interface Route {
  method: string
  parts: string[]
  handler: Handler
}

/** Minimal path router with `:param` segments. */
export class Router {
  #routes: Route[] = []

  /**
   * Register a route.
   * @param method - HTTP method.
   * @param path - `/a/:id/b` style pattern.
   * @param handler - the handler.
   */
  add(method: string, path: string, handler: Handler): void {
    this.#routes.push({ method: method.toUpperCase(), parts: path.split('/').filter((part) => part.length > 0), handler })
  }

  /**
   * Register a GET route.
   * @param path - pattern.
   * @param handler - handler.
   */
  get(path: string, handler: Handler): void {
    this.add('GET', path, handler)
  }

  /**
   * Register a POST route.
   * @param path - pattern.
   * @param handler - handler.
   */
  post(path: string, handler: Handler): void {
    this.add('POST', path, handler)
  }

  /**
   * Register a PATCH route.
   * @param path - pattern.
   * @param handler - handler.
   */
  patch(path: string, handler: Handler): void {
    this.add('PATCH', path, handler)
  }

  /**
   * Register a DELETE route.
   * @param path - pattern.
   * @param handler - handler.
   */
  delete(path: string, handler: Handler): void {
    this.add('DELETE', path, handler)
  }

  /**
   * Find a handler for a request.
   * @param method - HTTP method.
   * @param pathname - request path.
   * @returns the handler and its path params.
   */
  match(method: string, pathname: string): { handler: Handler; params: Record<string, string> } | null {
    const parts = pathname.split('/').filter((part) => part.length > 0)
    for (const route of this.#routes) {
      if (route.method !== method.toUpperCase()) continue
      if (route.parts.length !== parts.length) continue
      const params: Record<string, string> = {}
      let matched = true
      for (let i = 0; i < route.parts.length; i += 1) {
        const pattern = route.parts[i] as string
        const actual = parts[i] as string
        if (pattern.startsWith(':')) params[pattern.slice(1)] = decodeURIComponent(actual)
        else if (pattern !== actual) {
          matched = false
          break
        }
      }
      if (matched) return { handler: route.handler, params }
    }
    return null
  }
}

/**
 * Read a request body as UTF-8 text.
 * @param req - the request.
 * @returns the body text.
 * @throws when the body exceeds {@link MAX_BODY}.
 */
export async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > MAX_BODY) throw new Error(`request body exceeds ${MAX_BODY} bytes`)
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * Send a JSON response.
 * @param res - the response.
 * @param status - HTTP status.
 * @param body - the value to serialize.
 */
export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  })
  res.end(text)
}

/**
 * Start an SSE response.
 * @param res - the response.
 * @param eventNames - whether the client expects `event:` lines (Anthropic) or bare `data:` (OpenAI).
 * @returns helpers to write and close the stream.
 */
export function startSse(res: ServerResponse, mode: 'openai' | 'anthropic'): {
  event: (name: string, data: unknown) => void
  data: (data: unknown) => void
  raw: (text: string) => void
  close: () => void
  closed: () => boolean
} {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  })
  if (typeof (res as { flushHeaders?: () => void }).flushHeaders === 'function') {
    ;(res as { flushHeaders: () => void }).flushHeaders()
  }
  let done = false
  res.on('close', () => {
    done = true
  })
  // A long turn can spend tens of seconds before the first token; a comment line
  // keeps intermediaries from closing an otherwise idle connection.
  const keepalive = setInterval(() => {
    if (done) return
    res.write(': keepalive\n\n')
  }, 15_000)
  keepalive.unref()
  return {
    event(name, data) {
      if (done) return
      res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`)
    },
    data(data) {
      if (done) return
      res.write(`data: ${JSON.stringify(data)}\n\n`)
    },
    raw(text) {
      if (done) return
      res.write(text)
    },
    close() {
      clearInterval(keepalive)
      if (done) return
      done = true
      res.end()
    },
    closed() {
      return done
    },
  }
}

/**
 * Read a header value.
 * @param req - the request.
 * @param name - lowercase header name.
 * @returns the value, or null.
 */
export function header(req: IncomingMessage, name: string): string | null {
  const value = req.headers[name]
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value[0] ?? null
  return null
}

/**
 * Best-effort client IP for loopback checks.
 * @param req - the request.
 * @returns the address, or null.
 */
export function remoteAddress(req: IncomingMessage): string | null {
  return req.socket.remoteAddress ?? null
}

/**
 * True when the request came from this machine.
 * @param address - the socket address.
 * @returns whether it is a loopback address.
 */
export function isLoopback(address: string | null): boolean {
  if (address === null) return false
  return address === '::1' || address === '127.0.0.1' || address.startsWith('::ffff:127.') || address === 'localhost'
}

/**
 * Send an error in the OpenAI envelope.
 * @param res - the response.
 * @param error - the gateway error.
 */
export function sendOpenAiError(res: ServerResponse, error: { status: number; toOpenAI(): unknown; retryAfterMs?: number }): void {
  if (res.headersSent) {
    res.end()
    return
  }
  const headers: Record<string, string> = { 'content-type': 'application/json; charset=utf-8' }
  if (error.retryAfterMs !== undefined) headers['retry-after'] = String(Math.ceil(error.retryAfterMs / 1000))
  res.writeHead(error.status, headers)
  res.end(JSON.stringify(error.toOpenAI()))
}
