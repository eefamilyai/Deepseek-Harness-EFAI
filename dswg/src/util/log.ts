/**
 * Structured logging with secret redaction.
 *
 * Every log line is one JSON object so a request can be followed by `reqId`
 * across the browser worker, the upstream stream, and the HTTP response.
 *
 * @module dswg/util/log
 */

/** Log severities, lowest to highest. */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

/** Substrings whose values are never written to a log line. */
const SECRET_KEYS = /^(token|password|cookie|authorization|secret|apikey|api_key|x-api-key|set-cookie|x-ds-pow-response)$/i

/** Keys whose values are shortened rather than dropped, because the prefix identifies the row. */
const PREFIXED_KEYS = /^(email|did|userId|user_id)$/i

let threshold: LogLevel = (process.env.DSWG_LOG_LEVEL as LogLevel) || 'info'

/**
 * Set the minimum severity that reaches stdout.
 * @param level - the new threshold.
 */
export function setLogLevel(level: LogLevel): void {
  threshold = level
}

/**
 * Redact sensitive fields from a value, recursively, without mutating it.
 * @param value - arbitrary log payload.
 * @returns a copy safe to serialize.
 */
export function redact(value: unknown): unknown {
  if (value === null || value === undefined) return value
  if (Array.isArray(value)) return value.map(redact)
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEYS.test(key)) out[key] = '<redacted>'
      else if (PREFIXED_KEYS.test(key) && typeof inner === 'string') {
        out[key] = inner.length > 6 ? `${inner.slice(0, 3)}***${inner.slice(-2)}` : '***'
      } else out[key] = redact(inner)
    }
    return out
  }
  if (typeof value === 'string' && value.length > 4000) return `${value.slice(0, 4000)}…(${value.length} chars)`
  return value
}

/** A logger bound to a module name and optionally a request id. */
export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void
  info(message: string, fields?: Record<string, unknown>): void
  warn(message: string, fields?: Record<string, unknown>): void
  error(message: string, fields?: Record<string, unknown>): void
  child(fields: Record<string, unknown>): Logger
}

/**
 * Build a logger.
 * @param scope - module name written on every line.
 * @param bound - fields merged into every line.
 * @returns the logger.
 */
export function logger(scope: string, bound: Record<string, unknown> = {}): Logger {
  const emit = (level: LogLevel, message: string, fields?: Record<string, unknown>): void => {
    if (ORDER[level] < ORDER[threshold]) return
    const line = {
      t: new Date().toISOString(),
      level,
      scope,
      msg: message,
      ...(redact({ ...bound, ...(fields ?? {}) }) as Record<string, unknown>),
    }
    const text = JSON.stringify(line)
    if (level === 'error' || level === 'warn') process.stderr.write(`${text}\n`)
    else process.stdout.write(`${text}\n`)
  }
  return {
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
    child: (fields) => logger(scope, { ...bound, ...fields }),
  }
}
