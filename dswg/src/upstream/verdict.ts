/**
 * Reading DeepSeek's verdicts.
 *
 * DeepSeek answers HTTP 200 for most refusals: the refusal lives in a JSON
 * envelope (`code`/`msg`, and one level down `data.biz_code`/`data.biz_msg`).
 * A client that classifies on HTTP status alone reads a dead token, a muted
 * account, or a rate limit as success, then fails somewhere unrelated and
 * blames the wrong thing. This module is the single place a verdict is read.
 *
 * @module dswg/upstream/verdict
 */

import type { FailureKind } from '../util/errors.ts'

/** A parsed verdict from any DeepSeek response body or stream frame. */
export interface Verdict {
  /** Which failure kind the verdict describes. */
  kind: FailureKind
  /** Human-readable explanation, safe to log and to show. */
  message: string
  /** Numeric code, when the payload carried one. */
  code?: number
  /** Unix milliseconds until which a mute is known to last. */
  muteUntil?: number
  /** Raw payload, for the request log. */
  raw?: unknown
}

/** Envelope fields, at either nesting level. */
interface Envelope {
  code?: unknown
  msg?: unknown
  data?: { biz_code?: unknown; biz_msg?: unknown; biz_data?: unknown } | null
}

const AUTH_CODES = new Set([40001, 40002, 40003, 40100])
const DEVICE_CODES = new Set([40029])
const HEADER_CODES = new Set([40300])

/**
 * Pull `code`/`message` out of one envelope level.
 * @param envelope - the envelope.
 * @returns the numeric code and text message when present.
 */
function level(envelope: Envelope): { code?: number; message: string } {
  const code = typeof envelope.code === 'number' ? envelope.code : undefined
  const message = typeof envelope.msg === 'string' ? envelope.msg : ''
  const biz = envelope.data
  const bizCode = typeof biz?.biz_code === 'number' ? biz.biz_code : undefined
  const bizMessage = typeof biz?.biz_msg === 'string' ? biz.biz_msg : ''
  return { code: bizCode ?? code, message: bizMessage || message }
}

/** Text patterns that name a condition regardless of the numeric code. */
const TEXT_RULES: Array<{ pattern: RegExp; kind: FailureKind }> = [
  { pattern: /authorization failed|invalid token|token (?:is )?(?:invalid|expired)|not logged in/i, kind: 'auth' },
  { pattern: /has been muted|account (?:is )?muted|muted until|您(?:的)?账号.*(?:禁言|封禁)/i, kind: 'muted' },
  { pattern: /too many requests|too frequent|rate limit|请求过于频繁/i, kind: 'rate_limit' },
  {
    // The site words the same condition several ways, and each of them is a
    // "wait and try again" — not a dead credential and not a bad request.
    pattern:
      /server is busy|system is busy|temporarily unavailable|service unavailable|server (?:is )?(?:overloaded|unavailable)|try again later|please (?:retry|try again)|temporarily (?:busy|failed)|服务繁忙|服务器繁忙|系统繁忙|服务不可用|服务暂时不可用|服务器不可用|稍后再试|请求繁忙|请求失败，请稍后重试/i,
    kind: 'busy',
  },
  { pattern: /bad gateway|gateway time-?out|internal server error|502 bad|503 service|504 gateway/i, kind: 'busy' },
  { pattern: /length limit|context (?:length|window)|maximum context|内容过长|长度限制/i, kind: 'context_length' },
  { pattern: /missing_header/i, kind: 'protocol' },
]

/** Conditions that end by waiting rather than by fixing the credential. */
const TRANSIENT = new Set<FailureKind>(['busy', 'rate_limit', 'muted'])

/**
 * Match a message against the text rules.
 * @param text - the message.
 * @returns the verdict the wording describes, or null.
 */
function matchText(text: string): Omit<Verdict, 'raw'> | null {
  for (const rule of TEXT_RULES) {
    if (rule.pattern.test(text)) return { kind: rule.kind, message: text }
  }
  return null
}

/**
 * Read a verdict from one parsed JSON value.
 *
 * The function is deliberately tolerant: a refusal can arrive as the top-level
 * envelope, as the nested `biz_*` pair, as a bare string message, or wrapped in
 * an SSE `hint` event. Only a recognised condition produces a verdict; anything
 * else returns `null` so the caller keeps the success path.
 * @param payload - any parsed JSON value from a DeepSeek response.
 * @returns the verdict, or `null` when the payload is not a refusal.
 */
export function readVerdict(payload: unknown): Verdict | null {
  if (typeof payload === 'string') return readVerdictText(payload)
  if (payload === null || typeof payload !== 'object') return null
  const envelope = payload as Envelope

  const { code, message } = level(envelope)
  const text = message.trim()

  // Wording first, and only for the conditions that end by waiting. A site that
  // reports "Server is temporarily unavailable" under one of the authorization
  // codes is telling the caller to try again, not to buy a new credential; read
  // as auth it parks a working account until a human logs in again.
  // A mute also arrives as state rather than as prose: `/users/current` reports
  // `chat.is_muted` with the instant it ends. That is the only place the gateway
  // can learn an account is muted *before* spending a turn on it, so it is read
  // here rather than left to whichever failure the mute eventually produces.
  const chat = (envelope.data?.biz_data as { chat?: { is_muted?: unknown; mute_until?: unknown } } | undefined)?.chat
  if (chat !== undefined && chat !== null && (chat.is_muted === 1 || chat.is_muted === true)) {
    const seconds = typeof chat.mute_until === 'number' ? chat.mute_until : null
    const message = seconds === null
      ? 'this account is muted'
      : `this account is muted until ${new Date(seconds * 1000).toISOString()}`
    return { kind: 'muted', message, ...(seconds === null ? {} : { muteUntil: seconds * 1000 }), raw: payload }
  }

  const wording = text.length > 0 ? matchText(text) : null
  if (wording !== null && TRANSIENT.has(wording.kind)) {
    return withMuteDeadline({ ...wording, ...(code === undefined ? {} : { code }), raw: payload })
  }

  if (code !== undefined) {
    if (AUTH_CODES.has(code)) return { kind: 'auth', message: text || `authorization failed (code ${code})`, code, raw: payload }
    if (DEVICE_CODES.has(code)) return { kind: 'device_risk', message: text || 'the device was refused', code, raw: payload }
    if (HEADER_CODES.has(code)) return { kind: 'protocol', message: text || 'a required header was missing', code, raw: payload }
  }

  if (wording !== null) {
    return withMuteDeadline({ ...wording, ...(code === undefined ? {} : { code }), raw: payload })
  }

  // A mute can also hide in `biz_data` while the outer envelope reads success.
  const bizData = envelope.data?.biz_data
  if (bizData !== null && typeof bizData === 'object') {
    const inner = readVerdict(bizData as Record<string, unknown>)
    if (inner) return inner
  }

  return null
}

/**
 * Read a verdict from a message string alone.
 * @param text - message text.
 * @returns the verdict, or `null`.
 */
export function readVerdictText(text: string): Verdict | null {
  const trimmed = text.trim()
  if (!trimmed) return null
  // A challenge page names no condition the rules know, and it is the one
  // failure a retry cannot fix.
  if (looksLikeChallenge(trimmed)) {
    return { kind: 'waf', message: 'DeepSeek is asking for human verification (captcha); solve it in the account window' }
  }
  for (const rule of TEXT_RULES) {
    if (rule.pattern.test(trimmed)) {
      return withMuteDeadline({ kind: rule.kind, message: trimmed })
    }
  }
  return null
}

/**
 * Attach a mute deadline when the message states one.
 * @param verdict - the verdict to complete.
 * @returns the same verdict with `muteUntil` when derivable.
 */
function withMuteDeadline(verdict: Verdict): Verdict {
  if (verdict.kind !== 'muted') return verdict
  const epoch = /(\d{10})(?!\d)/.exec(verdict.message)
  if (epoch) {
    const seconds = Number(epoch[1])
    if (seconds > 1_600_000_000) return { ...verdict, muteUntil: seconds * 1000 }
  }
  return verdict
}

/** Text that only appears when the site is asking for a human. */
const CHALLENGE_MARKERS = [
  'captcha',
  'hcaptcha',
  'recaptcha',
  'cf-challenge',
  'cf_chl_opt',
  'challenge-platform',
  'verify you are human',
  'verifying you are human',
  'are you a robot',
  'unusual traffic',
  'complete the security check',
  '安全验证',
  '人机验证',
  '请完成验证',
  '完成以下验证',
]

/**
 * Whether a response body is a human-verification challenge.
 *
 * The site answers a challenge with an HTML page or an envelope that names none
 * of its refusal codes, so a caller that only reads `code`/`msg` sees a turn
 * fail for no stated reason. Recognising the page is what turns that into an
 * answerable failure: no retry will pass it, and the operator has to solve it.
 * @param body - the response body, HTML or JSON.
 * @returns true when the body is a challenge.
 */
export function looksLikeChallenge(body: string): boolean {
  if (body.length === 0) return false
  const lower = body.toLowerCase()
  return CHALLENGE_MARKERS.some((marker) => lower.includes(marker))
}

/**
 * Recognise the AWS WAF interception shape.
 * @param status - HTTP status of the response.
 * @param header - value of `x-amzn-waf-action`, when present.
 * @returns true when the response is a WAF challenge rather than an application answer.
 */
export function isWafChallenge(status: number, header: string | null | undefined): boolean {
  return status === 202 && typeof header === 'string' && header.length > 0
}
