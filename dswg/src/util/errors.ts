/**
 * The gateway's failure taxonomy.
 *
 * Every failure that can reach a client is one of a small number of kinds. Each
 * kind owns three things: the HTTP status it becomes, the OpenAI/Anthropic error
 * type and code it reports, and whether retrying can help. Keeping the mapping
 * in one place is what stops an upstream quirk from surfacing as a generic 500
 * with no actionable text.
 *
 * @module dswg/util/errors
 */

/** How a failure should be answered and whether it is worth retrying. */
export type FailureKind =
  | 'invalid_request'
  | 'auth'
  | 'permission'
  | 'not_found'
  | 'muted'
  | 'rate_limit'
  | 'device_risk'
  | 'busy'
  | 'waf'
  | 'context_length'
  | 'upstream'
  | 'network'
  | 'protocol'
  | 'config'
  | 'cancelled'

/** A failure with a known meaning at the API edge. */
export class GatewayError extends Error {
  readonly kind: FailureKind
  readonly status: number
  readonly type: string
  readonly code: string
  readonly retryable: boolean
  readonly retryAfterMs?: number
  readonly details?: Record<string, unknown>

  /**
   * @param kind - the failure kind.
   * @param message - operator-facing explanation; also the client-visible message when nothing better exists.
   * @param options - status/code overrides and retry metadata.
   */
  constructor(
    kind: FailureKind,
    message: string,
    options: {
      status?: number
      type?: string
      code?: string
      retryable?: boolean
      retryAfterMs?: number
      details?: Record<string, unknown>
      cause?: unknown
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'GatewayError'
    this.kind = kind
    this.status = options.status ?? STATUS[kind]
    this.type = options.type ?? TYPE[kind]
    this.code = options.code ?? CODE[kind]
    this.retryable = options.retryable ?? RETRYABLE[kind]
    this.retryAfterMs = options.retryAfterMs
    this.details = options.details
  }

  /**
   * Render this failure in OpenAI's error envelope.
   * @returns `{error: {...}}`.
   */
  toOpenAI(): { error: { message: string; type: string; code: string; param: string | null } } {
    return {
      error: {
        message: this.message,
        type: this.type,
        code: this.code,
        param: null,
      },
    }
  }

  /**
   * Render this failure in Anthropic's error envelope.
   * @returns `{type:'error', error:{...}}`.
   */
  toAnthropic(): { type: 'error'; error: { type: string; message: string } } {
    return { type: 'error', error: { type: ANTHROPIC_TYPE[this.kind], message: this.message } }
  }
}

/** Default HTTP status per kind. */
const STATUS: Record<FailureKind, number> = {
  invalid_request: 400,
  auth: 401,
  permission: 403,
  not_found: 404,
  muted: 429,
  rate_limit: 429,
  device_risk: 429,
  busy: 503,
  waf: 503,
  context_length: 400,
  upstream: 502,
  network: 502,
  protocol: 502,
  config: 500,
  cancelled: 499,
}

/** OpenAI error `type` per kind. */
const TYPE: Record<FailureKind, string> = {
  invalid_request: 'invalid_request_error',
  auth: 'authentication_error',
  permission: 'permission_error',
  not_found: 'not_found_error',
  muted: 'rate_limit_error',
  rate_limit: 'rate_limit_error',
  device_risk: 'rate_limit_error',
  busy: 'api_error',
  waf: 'api_error',
  context_length: 'invalid_request_error',
  upstream: 'api_error',
  network: 'api_error',
  protocol: 'api_error',
  config: 'api_error',
  cancelled: 'api_error',
}

/** OpenAI error `code` per kind; the stable machine-readable part. */
const CODE: Record<FailureKind, string> = {
  invalid_request: 'invalid_request',
  auth: 'invalid_api_key',
  permission: 'insufficient_permissions',
  not_found: 'not_found',
  muted: 'account_muted',
  rate_limit: 'rate_limit_exceeded',
  device_risk: 'device_risk_refused',
  busy: 'upstream_busy',
  waf: 'upstream_waf_challenge',
  context_length: 'context_length_exceeded',
  upstream: 'upstream_error',
  network: 'upstream_unreachable',
  protocol: 'upstream_protocol_error',
  config: 'gateway_misconfigured',
  cancelled: 'request_cancelled',
}

/** Anthropic error `type` per kind. */
const ANTHROPIC_TYPE: Record<FailureKind, string> = {
  invalid_request: 'invalid_request_error',
  auth: 'authentication_error',
  permission: 'permission_error',
  not_found: 'not_found_error',
  muted: 'rate_limit_error',
  rate_limit: 'rate_limit_error',
  device_risk: 'rate_limit_error',
  busy: 'overloaded_error',
  waf: 'api_error',
  context_length: 'invalid_request_error',
  upstream: 'api_error',
  network: 'api_error',
  protocol: 'api_error',
  config: 'api_error',
  cancelled: 'api_error',
}

/** Whether the gateway may retry the same request elsewhere. */
const RETRYABLE: Record<FailureKind, boolean> = {
  invalid_request: false,
  auth: false,
  permission: false,
  not_found: false,
  muted: false,
  rate_limit: true,
  device_risk: false,
  busy: true,
  waf: true,
  context_length: false,
  upstream: true,
  network: true,
  protocol: false,
  config: false,
  cancelled: false,
}

/**
 * Narrow unknown thrown values into a GatewayError.
 * @param error - whatever was thrown.
 * @param fallbackMessage - message used when the value carries none.
 * @returns a GatewayError.
 */
export function asGatewayError(error: unknown, fallbackMessage = 'internal error'): GatewayError {
  if (error instanceof GatewayError) return error
  if (error instanceof Error) {
    return new GatewayError('protocol', error.message, { cause: error })
  }
  return new GatewayError('protocol', fallbackMessage)
}
