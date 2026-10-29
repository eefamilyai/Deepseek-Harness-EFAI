/**
 * Running one assistant turn.
 *
 * The engine owns the parts that are the same for every client: choosing an
 * account, building the prompt, streaming the reply while separating prose from
 * tool calls, failing over between accounts, and repairing a turn whose tool
 * markup could not be read.
 *
 * @module dswg/engine/turn
 */

import type { AccountRepo, AccountRecord } from '../store/accounts.ts'
import type { ApiKey } from '../store/keys.ts'
import type { BrowserPool } from '../browser/pool.ts'
import type { SearchResult } from '../upstream/stream.ts'
import type { WireLog } from '../store/wirelog.ts'
import { redactHeaders } from '../store/wirelog.ts'
import type { Corpus } from '../store/corpus.ts'
import type { PatternStore } from '../tools/learn.ts'
import { looksLikeCall, salvageCalls } from '../tools/salvage.ts'
import type { Config } from '../config.ts'
import type { CanonicalRequest, CanonicalToolCall, FinishReason, TurnOutcome } from '../api/canonical.ts'
import { StreamDecoder } from '../upstream/stream.ts'
import { ToolCallExtractor } from '../tools/envelope.ts'
import { repairInstruction } from '../tools/protocol.ts'
import { looksLikeRoleplay } from '../tools/roleplay.ts'
import { lastToolResult } from './prompt.ts'
import { buildPrompt, clipPrompt, estimateTokens } from './prompt.ts'
import { AccountSelector, type Selection } from './accounts.ts'
import { HealthTracker } from './health.ts'
import { looksLikeChallenge, readVerdict, readVerdictText, type Verdict } from '../upstream/verdict.ts'
import { GatewayError, asGatewayError, type FailureKind } from '../util/errors.ts'
import { logger } from '../util/log.ts'
import { randomToken, sha256 } from '../util/ids.ts'
import { sleep } from '../util/async.ts'
import { StopFilter } from '../util/stop.ts'

const log = logger('turn')

/** How many accounts one request may try before giving up. */
const MAX_ACCOUNT_ATTEMPTS = 3

/**
 * Failures worth retrying on the *same* account.
 *
 * They describe a condition that clears on its own — a busy backend, a momentary
 * rate-limit window, an edge interception — so the correct answer is "wait a
 * moment and ask again", not "this request failed". A dead token and a bad
 * request are deliberately absent: retrying those only adds load.
 */
const TRANSIENT: ReadonlySet<string> = new Set(['busy', 'rate_limit', 'upstream', 'network', 'waf'])

/**
 * How a failure reported by the browser worker maps onto a verdict.
 *
 * The worker describes *where* the turn failed (a page-level refusal, a dropped
 * connection, a stalled reader), not what DeepSeek meant — so the mapping lives
 * here, in one table, rather than being guessed at per call site. Anything not
 * listed is a transient upstream condition: it is not a dead credential and not
 * a bad request, so retrying is the right first answer.
 */
const FAILURE_TO_VERDICT: Record<string, FailureKind> = {
  auth: 'auth',
  session: 'auth',
  aborted: 'auth',
  waf: 'waf',
  rate_limit: 'rate_limit',
  busy: 'busy',
  response: 'busy',
  network: 'busy',
  browser: 'busy',
  pow: 'busy',
}

/** Streaming callbacks a client adapter supplies. */
export interface TurnHooks {
  onText?(text: string): void
  onThinking?(text: string): void
  onToolCall?(call: CanonicalToolCall): void
  onSearch?(results: SearchResult[]): void
}

/** What the caller must supply. */
export interface TurnCall {
  request: CanonicalRequest
  key: ApiKey
  hooks: TurnHooks
  signal?: AbortSignal
}

/** Runs turns against the account pool. */
export class TurnEngine {
  #selector: AccountSelector
  #health: HealthTracker

  /**
   * @param config - gateway configuration.
   * @param accounts - account storage.
   * @param pool - browser pool.
   */
  readonly config: Config
  readonly accounts: AccountRepo
  readonly pool: BrowserPool
  readonly wire: WireLog | null
  readonly corpus: Corpus | null
  readonly patterns: PatternStore | null

  /**
   * @param config - gateway configuration.
   * @param accounts - account storage.
   * @param pool - browser pool.
   * @param deps - forensic log, corpus and learned patterns; omitted in tests.
   */
  constructor(
    config: Config,
    accounts: AccountRepo,
    pool: BrowserPool,
    deps: { wire?: WireLog | null; corpus?: Corpus | null; patterns?: PatternStore | null } = {},
  ) {
    this.config = config
    this.accounts = accounts
    this.pool = pool
    this.wire = deps.wire ?? null
    this.corpus = deps.corpus ?? null
    this.patterns = deps.patterns ?? null
    this.#selector = new AccountSelector(accounts)
    this.#health = new HealthTracker(accounts, this.wire)
  }

  /**
   * Run one turn, failing over between accounts when the failure is about the
   * account rather than the request.
   * @param call - the request, key, hooks and cancellation.
   * @returns the completed outcome.
   */
  async run(call: TurnCall): Promise<TurnOutcome> {
    const selection = await this.#awaitAccount(call)
    if (selection.candidates.length === 0) throw this.#selector.noCandidateError(selection, call.key.accountIds.length)

    const built = buildPrompt(call.request)
    const clipped = clipPrompt(built, this.config.maxPromptChars)
    if (clipped.clipped) log.warn('prompt clipped to fit the context budget', { chars: built.length })

    const failures: GatewayError[] = []
    for (const account of selection.candidates.slice(0, MAX_ACCOUNT_ATTEMPTS)) {
      if (call.signal?.aborted) throw new GatewayError('cancelled', 'client disconnected')
      try {
        return await this.#attempt(account, call, this.#promptText(clipped.prompt, call.request))
      } catch (error) {
        const gateway = asGatewayError(error)
        failures.push(gateway)
        const canFailOver =
          gateway.kind === 'auth' ||
          gateway.kind === 'muted' ||
          gateway.kind === 'rate_limit' ||
          gateway.kind === 'busy' ||
          gateway.kind === 'waf' ||
          gateway.kind === 'upstream' ||
          gateway.kind === 'network'
        log.warn('turn failed on account', { account: account.id, kind: gateway.kind, message: gateway.message })
        if (!canFailOver) throw gateway
      }
    }
    const primary = failures[0] ?? new GatewayError('upstream', 'every eligible account failed')
    if (clipped.clipped && (primary.kind === 'busy' || primary.kind === 'rate_limit' || primary.kind === 'upstream')) {
      // A prompt that had to be clipped is both slower to serve and closer to the
      // limits, so it belongs in the message the operator reads.
      throw new GatewayError(
        primary.kind,
        `${primary.message} (the transcript was ${built.length.toLocaleString()} characters and was clipped to ${clipped.prompt.length.toLocaleString()}; a shorter conversation is more likely to be served)`,
        {
          status: primary.status,
          code: primary.code,
          retryable: primary.retryable,
          ...(primary.retryAfterMs === undefined ? {} : { retryAfterMs: primary.retryAfterMs }),
          details: primary.details,
        },
      )
    }
    throw primary
  }

  /**
   * Assemble the prompt text, adding the tool-choice instruction the client asked for.
   * @param prompt - the rendered prompt.
   * @param request - the normalised request.
   * @returns the prompt to send.
   */
  #promptText(prompt: string, request: CanonicalRequest): string {
    if (request.tools.length === 0) return prompt
    if (request.toolChoice === 'required' && request.requiredTool) {
      return `${prompt}\n(Call the tool \`${request.requiredTool}\` now.)\n`
    }
    if (request.toolChoice === 'required') {
      return `${prompt}\n(Call one of the available tools now.)\n`
    }
    return prompt
  }

  /**
   * Run one turn on one account.
   * @param account - the account.
   * @param call - the caller's request.
   * @param prompt - the fully rendered prompt.
   * @returns the outcome.
   */
  async #attempt(account: AccountRecord, call: TurnCall, prompt: string): Promise<TurnOutcome> {
    // Transient refusals are retried here, on the account that produced them,
    // because that is what the refusal asks for. The budget is measured in time:
    // the site throttles in windows of minutes, and an attempt count would give
    // up long before the window closes. The loop stops the moment any text has
    // reached the client — restarting then would duplicate output.
    const turnId = randomToken(9)
    const deadline = Date.now() + this.config.retryBudgetMs
    let attempt = await this.#execute(account, call, prompt, null, turnId)
    for (let retry = 0; retry < this.config.transientRetries && Date.now() < deadline; retry += 1) {
      if (attempt.outcome) return attempt.outcome
      const error = attempt.error
      if (!error || !TRANSIENT.has(error.kind) || !attempt.safeToRetry) break
      const delay = Math.min(this.config.retryMaxMs, this.config.retryBaseMs * 2 ** retry)
      // Jitter is a fraction of the delay, not a fixed window: a constant one can
      // exceed a short budget and end the loop before it retried anything.
      const jitter = Math.floor(Math.random() * Math.max(1, Math.min(250, delay * 0.25)))
      const wait = delay + jitter
      if (Date.now() + wait > deadline) break
      log.warn('retrying a transient upstream refusal', {
        account: account.id,
        kind: error.kind,
        delayMs: wait,
        attempt: retry + 1,
        remainingMs: Math.max(0, deadline - Date.now()),
      })
      this.wire?.record({
        kind: 'turn.retry',
        accountId: account.id,
        turnId,
        data: { reason: `transient ${error.kind}`, attempt: retry + 1, delayMs: wait, remainingMs: Math.max(0, deadline - Date.now()) },
      })
      await sleep(wait, call.signal)
      attempt = await this.#execute(account, call, prompt, null, turnId)
    }
    if (attempt.outcome) return attempt.outcome

    // A turn whose tool markup could not be read is worth one retry in a clean
    // context: that is the shape context rot produces, and it usually works.
    const retry = this.config.retryOnMalformedToolCall && call.request.tools.length > 0 && attempt.retryable
    if (retry) {
      log.warn('retrying a turn whose tool markup could not be parsed', { account: account.id, diagnostics: attempt.diagnostics })
      this.wire?.record({ kind: 'turn.retry', accountId: account.id, data: { diagnostics: attempt.diagnostics } })
      const reason = attempt.diagnostics.some((line) => line.includes('narrated a tool result')) ? 'roleplay' : 'malformed'
      const second = await this.#execute(account, call, prompt, repairInstruction(call.request.tools, reason), randomToken(9))
      if (second.outcome) return second.outcome
    }
    throw attempt.error ?? new GatewayError('protocol', 'the turn produced no readable output')
  }

  /**
   * Select an account, waiting out a window that ends soon enough.
   *
   * When every account a key allows is only resting — cooling down, muted until
   * a stated time, or paced — the request is not refused: the wait is known and
   * bounded, and the alternative is telling a client to come back for a turn it
   * asked for now. The loop re-selects after each wait because the window can
   * shorten (another request may have proved the account healthy) and because
   * the account set can change while waiting.
   * @param call - the request, whose key scopes the accounts and whose signal cancels the wait.
   * @returns the selection, which may still be empty when waiting cannot help.
   */
  async #awaitAccount(call: TurnCall): Promise<Selection> {
    let selection = this.#selector.select(call.key.accountIds)
    if (selection.candidates.length > 0) return selection
    const deadline = Date.now() + this.config.waitForAccountMs
    for (;;) {
      const now = Date.now()
      const at = this.#selector.nextEligibleAt(call.key.accountIds, now)
      // Nothing to wait for: no account in scope, or every one of them needs a
      // human. Answering now is the only honest thing to do.
      if (at === null || at > deadline) return selection
      const wait = Math.min(Math.max(at - now, 0) + 250, Math.max(deadline - now, 250))
      const reasons = selection.unavailable.map((entry) => `${entry.account.label}: ${entry.reason}`).join('; ')
      log.info('waiting for an account to become available', { waitMs: wait, reasons })
      this.wire?.record({ kind: 'turn.wait', accountId: null, data: { waitMs: wait, until: new Date(now + wait).toISOString(), reasons } })
      try {
        await sleep(wait, call.signal)
      } catch {
        // The sleep rejects when the client goes away, which is a cancellation
        // like any other rather than an internal failure.
        throw new GatewayError('cancelled', 'client disconnected')
      }
      if (call.signal?.aborted) throw new GatewayError('cancelled', 'client disconnected')
      selection = this.#selector.select(call.key.accountIds)
      if (selection.candidates.length > 0) return selection
    }
  }

  /**
   * One upstream attempt, streaming into the client's hooks.
   * @param account - the account to use.
   * @param call - the caller's request.
   * @param prompt - the prompt to send.
   * @param correction - extra system text for a repair retry.
   * @returns the outcome, or the error when the attempt failed.
   */
  async #execute(
    account: AccountRecord,
    call: TurnCall,
    prompt: string,
    correction: string | null,
    turnId: string,
  ): Promise<{ outcome?: TurnOutcome; error?: GatewayError; retryable: boolean; safeToRetry: boolean; diagnostics: string[] }> {
    const request = call.request
    const startedAt = Date.now()
    // One controller owns the upstream turn: the client's disconnect, the wall
    // clock budget and a stalled stream all abort the same fetch, so a turn can
    // never outlive its usefulness and hold the account.
    const local = new AbortController()
    const linkOuter = (): void => local.abort()
    call.signal?.addEventListener('abort', linkOuter, { once: true })
    let lastEventAt = Date.now()
    const wallClock = setTimeout(() => local.abort(), this.config.turnTimeoutMs)
    const watchdog = setInterval(() => {
      if (Date.now() - lastEventAt > this.config.streamIdleTimeoutMs) local.abort()
    }, 5000)
    wallClock.unref?.()
    watchdog.unref?.()
    const decoder = new StreamDecoder()
    const learned = this.patterns?.list() ?? []
    const extractor = request.tools.length > 0 ? new ToolCallExtractor(request.tools, learned) : null
    let rawStream = ''
    const stop = new StopFilter(request.stop)
    const diagnostics: string[] = []
    const toolCalls: CanonicalToolCall[] = []
    let textOut = ''
    let thinkingOut = ''
    let tokens: number | null = null
    let verdict: Verdict | null = null
    let sessionId: string | null = null
    /**
     * Whether any text has reached the client.
     *
     * Producing text is not the same as delivering it: a non-streaming caller
     * gets one response at the end, so everything up to then can still be
     * replaced by a repair retry. Only a hook that exists means the bytes are
     * already out and a second attempt would duplicate them.
     */
    let emittedText = false

    const emitText = (chunk: string): void => {
      const safe = stop.push(chunk)
      if (safe.length === 0) return
      textOut += safe
      if (call.hooks.onText !== undefined) {
        emittedText = true
        call.hooks.onText(safe)
      }
    }

    const handleUpstream = (events: ReturnType<StreamDecoder['push']>): void => {
      for (const event of events) {
        switch (event.type) {
          case 'text': {
            if (extractor) {
              for (const item of extractor.push(event.text)) {
                if (item.type === 'text') emitText(item.text)
                else if (item.type === 'call') this.#emitCall(item.call, toolCalls, call)
                else diagnostics.push(`malformed(${item.source}): ${item.error}`)
              }
            } else {
              emitText(event.text)
            }
            break
          }
          case 'think': {
            thinkingOut += event.text
            call.hooks.onThinking?.(event.text)
            break
          }
          case 'search': {
            if (event.results.length > 0) call.hooks.onSearch?.(event.results)
            break
          }
          case 'usage': {
            tokens = event.total
            break
          }
          case 'error': {
            verdict = event.verdict
            break
          }
          default:
            break
        }
      }
    }

    this.wire?.record({
      kind: 'turn.start',
      accountId: account.id,
      turnId,
      data: {
        model: request.model,
        thinking: request.thinking,
        search: request.search,
        tools: request.tools.map((tool) => tool.name),
        messageCount: request.messages.length,
        promptChars: prompt.length,
        promptSha: sha256(prompt).slice(0, 16),
        promptHead: prompt.slice(0, 4000),
        promptTail: prompt.length > 4000 ? prompt.slice(-2000) : '',
        correction: correction !== null,
        retryOf: correction === null ? null : turnId,
        deviceId: account.deviceId,
        did: account.did,
        slug: account.slug,
        userAgent: account.userAgent,
        // How fast turns arrive on this account is one of the few things a mute
        // could correlate with, so it is recorded with every turn.
        gapMs: account.lastUsedAt === null ? null : startedAt - account.lastUsedAt,
      },
    })

    const result = await this.pool.turn(account, {
      id: turnId,
      prompt: correction ? `${prompt}\n\n${correction}\n` : prompt,
      modelType: 'default',
      thinking: request.thinking,
      search: request.search,
      onEvent: (event) => {
        lastEventAt = Date.now()
        if (event.t === 'chunk') {
          if (rawStream.length < 4_000_000) rawStream += event.v
          handleUpstream(decoder.push(event.v))
        }
        else if (event.t === 'session') sessionId = event.sessionId
        else if (event.t === 'http') {
          const entry = event.entry
          this.wire?.record({
            kind: 'turn.http',
            accountId: account.id,
            turnId,
            data: {
              path: entry.path ?? null,
              method: entry.method ?? null,
              status: entry.status ?? null,
              ms: entry.ms ?? null,
              requestHeaders: redactHeaders(entry.requestHeaders ?? {}),
              responseHeaders: entry.responseHeaders ?? {},
              requestBytes: entry.requestBytes ?? null,
              responseBytes: entry.responseBytes ?? null,
              responseBody: entry.responseBody ? entry.responseBody.slice(0, 6000) : null,
              streaming: entry.streaming === true,
              refused: entry.refused === true,
            },
          })
        } else if (event.t === 'done' && event.ok) handleUpstream(decoder.end())
      },
      signal: local.signal,
    })
    clearTimeout(wallClock)
    clearInterval(watchdog)
    call.signal?.removeEventListener('abort', linkOuter)

    handleUpstream(decoder.end())

    // A turn that produced no text but whose stream carried a challenge page is
    // a human-verification gate, not an empty answer.
    if (!verdict && toolCalls.length === 0 && textOut.trim().length === 0 && looksLikeChallenge(rawStream)) {
      verdict = { kind: 'waf', message: 'DeepSeek is asking for human verification (captcha); solve it in the account window', raw: rawStream.slice(0, 4000) }
    }

    if (extractor) {
      for (const item of extractor.finish()) {
        if (item.type === 'text') emitText(item.text)
        else if (item.type === 'call') this.#emitCall(item.call, toolCalls, call)
        else diagnostics.push(`malformed(${item.source}): ${item.error}`)
      }
    }
    emitText(stop.flush())

    // The primary reader saw no call. If the reply still carries a call-shaped
    // signal, this is the leak case: recover what can be recovered, record what
    // cannot so the corpus learns the shape, and never claim a call that the
    // tools did not declare.
    let salvaged = false
    let leakedUnrecovered = false
    if (extractor !== null && toolCalls.length === 0 && looksLikeCall(textOut, request.tools)) {
      const recovery = salvageCalls(textOut, request.tools)
      if (recovery.calls.length > 0) {
        salvaged = true
        textOut = recovery.text
        for (const recovered of recovery.calls) this.#emitCall(recovered, toolCalls, call)
        diagnostics.push(`salvaged ${recovery.calls.length} call(s): ${recovery.notes.join(', ')}`)
        this.wire?.record({
          kind: 'turn.salvage',
          accountId: account.id,
          turnId,
          data: {
            calls: recovery.calls.map((entry) => ({ name: entry.name, shape: entry.shape, repairs: entry.repairs })),
            notes: recovery.notes,
          },
        })
      } else {
        this.corpus?.recordLeak({
          turnId,
          accountId: account.id,
          kind: 'unrecognised',
          evidence: recovery.notes.join('; ').slice(0, 400) || 'call-shaped text with no recoverable object',
          text: textOut,
        })
        this.wire?.record({ kind: 'turn.leak', accountId: account.id, turnId, data: { chars: textOut.length, head: textOut.slice(0, 400) } })
        diagnostics.push('unrecognised call-shaped text')
        leakedUnrecovered = recovery.unrecovered
      }
    }

    if (verdict) {
      this.wire?.record({
        kind: 'turn.verdict',
        accountId: account.id,
        turnId,
        data: { verdict, sessionId, textChars: textOut.length, emittedText },
      })
      this.#capture(rawStream, turnId, account, request, prompt, textOut, thinkingOut, true, salvaged)
      const error = this.#health.apply(account, verdict)
      return { error, retryable: false, safeToRetry: !emittedText && toolCalls.length === 0, diagnostics }
    }

    if (!result.ok) {
      const failure = result.failure ?? { kind: 'unknown' }
      this.wire?.record({
        kind: 'turn.end',
        accountId: account.id,
        turnId,
        data: { ok: false, failure, diagnostics, textChars: textOut.length },
      })
      this.#capture(rawStream, turnId, account, request, prompt, textOut, thinkingOut, false, salvaged)
      if (failure.kind === 'aborted' && call.signal?.aborted) {
        return { error: new GatewayError('cancelled', 'the client disconnected'), retryable: false, safeToRetry: false, diagnostics }
      }
      if (failure.kind === 'aborted') {
        return {
          error: new GatewayError('upstream', 'the upstream turn stalled or exceeded its time budget', { retryable: true }),
          retryable: false,
          safeToRetry: !emittedText && toolCalls.length === 0,
          diagnostics,
        }
      }
      // A challenge page carries no code the envelope parser knows: it is HTML,
      // or JSON that names nothing. Reading its text is what stops it being
      // reported as an unexplained busy and retried against a wall.
      const fromBody = failure.body
        ? (readVerdict(parseJson(failure.body)) ?? readVerdictText(failure.body))
        : null
      if (fromBody) {
        const error = this.#health.apply(account, fromBody)
        return { error, retryable: false, safeToRetry: !emittedText && toolCalls.length === 0, diagnostics }
      }
      if (failure.kind === 'auth' || failure.kind === 'session') {
        const error = this.#health.apply(account, { kind: 'auth', message: failure.message ?? 'the session was refused' })
        return { error, retryable: false, safeToRetry: false, diagnostics }
      }
      // The browser worker reports transport-level outcomes; map them onto the
      // domain verdicts so one refusal class does not surface as two different
      // statuses depending on which layer noticed it.
      const verdictKind = FAILURE_TO_VERDICT[failure.kind] ?? 'busy'
      const error = this.#health.apply(account, {
        kind: verdictKind,
        message: failure.message ?? `the upstream turn failed (${failure.kind})`,
      })
      return { error, retryable: false, safeToRetry: !emittedText && toolCalls.length === 0, diagnostics }
    }

    this.#health.recover(account)
    this.accounts.touch(account.id)
    if (this.config.sessionCleanup && sessionId) {
      const id = sessionId
      void this.pool.browser(account).then((browser) => browser.deleteSession(id)).catch(() => undefined)
    }

    if (stop.stopped) {
      return {
        outcome: this.#outcome(textOut, thinkingOut, toolCalls, 'stop', tokens, account, sessionId, diagnostics),
        retryable: false,
        safeToRetry: false,
        diagnostics,
      }
    }

    // Nothing readable at all — an empty turn, markup that parsed into nothing,
    // or a call-shaped reply nothing could be recovered from — is worth one
    // clean retry in a fresh context. So is a reply that answered in the tool's
    // voice: it declared tools and then wrote the result itself, which is the
    // shape long-context rotation produces and which the user must never be
    // shown as if the tool had run.
    const producedNothing = textOut.trim().length === 0 && toolCalls.length === 0
    const onlyMalformed = extractor !== null && extractor.malformed > 0 && !emittedText
    const narratedResult =
      toolCalls.length === 0 &&
      request.tools.length > 0 &&
      !emittedText &&
      looksLikeRoleplay(textOut, lastToolResult(request.messages))
    if (narratedResult) {
      this.wire?.record({ kind: 'turn.leak', accountId: account.id, turnId, data: { kind: 'roleplay', chars: textOut.length, head: textOut.slice(0, 400) } })
      diagnostics.push('the reply narrated a tool result instead of calling the tool')
    }
    if (producedNothing || onlyMalformed || leakedUnrecovered || narratedResult) {
      const message = leakedUnrecovered
        ? 'the reply named a tool but no call could be read from it'
        : narratedResult
          ? 'the model described a tool result instead of calling the tool'
          : onlyMalformed
            ? 'the tool-call markup could not be parsed'
            : 'the model returned no content'
      return {
        error: new GatewayError('protocol', message),
        retryable: !emittedText,
        safeToRetry: !emittedText,
        diagnostics,
      }
    }

    const finish: FinishReason = toolCalls.length > 0 ? 'tool_calls' : 'stop'
    this.#capture(rawStream, turnId, account, request, prompt, textOut, thinkingOut, false, salvaged)
    this.wire?.record({
      kind: 'turn.end',
      accountId: account.id,
      turnId,
      data: {
        ok: true,
        sessionId,
        tokens,
        finish,
        textChars: textOut.length,
        thinkingChars: thinkingOut.length,
        textHead: textOut.slice(0, 500),
        toolCalls: toolCalls.map((call) => ({ name: call.name, args: Object.keys(call.arguments) })),
        diagnostics,
        elapsedMs: Date.now() - startedAt,
      },
    })
    return {
      outcome: this.#outcome(textOut, thinkingOut, toolCalls, finish, tokens, account, sessionId, diagnostics),
      retryable: false,
      safeToRetry: false,
      diagnostics,
    }
  }

  /**
   * Store one turn's raw output in the corpus.
   *
   * Best effort by construction: a corpus write must never fail a turn that
   * already produced an answer.
   * @param rawStream - the SSE text as received.
   * @param turnId - the turn id.
   * @param account - the serving account.
   * @param request - the normalised request.
   * @param text - the assembled visible text.
   * @param thinking - the assembled reasoning text.
   * @param leaked - true when the reply looked like a call that did not register.
   * @param salvaged - true when a call was recovered from the text.
   */
  #capture(
    rawStream: string,
    turnId: string,
    account: AccountRecord,
    request: CanonicalRequest,
    prompt: string,
    text: string,
    thinking: string,
    leaked: boolean,
    salvaged: boolean,
  ): void {
    if (!this.corpus || rawStream.length === 0) return
    try {
      this.corpus.recordTurn({
        turnId,
        accountId: account.id,
        model: request.model,
        tools: request.tools.map((tool) => tool.name),
        rawStream,
        prompt,
        text,
        thinking,
        leaked,
        salvaged,
      })
    } catch {
      // Recording is best effort.
    }
  }

  /**
   * Publish one parsed call to the client and record it.
   * @param call - the parsed call.
   * @param sink - the accumulated call list.
   * @param ctx - the caller's hooks.
   */
  #emitCall(call: { name: string; arguments: Record<string, unknown> }, sink: CanonicalToolCall[], ctx: TurnCall): void {
    const entry: CanonicalToolCall = {
      id: `call_${randomToken(12)}`,
      name: call.name,
      arguments: call.arguments,
    }
    sink.push(entry)
    ctx.hooks.onToolCall?.(entry)
  }

  /**
   * Assemble the outcome.
   * @param text - visible text.
   * @param thinking - reasoning text.
   * @param toolCalls - parsed calls.
   * @param finishReason - stop reason.
   * @param tokens - upstream token count.
   * @param account - serving account.
   * @param sessionId - upstream chat id.
   * @param diagnostics - reader notes.
   * @returns the outcome.
   */
  #outcome(
    text: string,
    thinking: string,
    toolCalls: CanonicalToolCall[],
    finishReason: FinishReason,
    tokens: number | null,
    account: AccountRecord,
    sessionId: string | null,
    diagnostics: string[],
  ): TurnOutcome {
    return {
      text,
      thinking,
      toolCalls,
      finishReason,
      tokens: tokens ?? estimateTokens(text) + estimateTokens(thinking),
      accountId: account.id,
      sessionId,
      diagnostics,
    }
  }
}

/**
 * Parse JSON without throwing.
 * @param text - candidate text.
 * @returns the value, or null.
 */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}
