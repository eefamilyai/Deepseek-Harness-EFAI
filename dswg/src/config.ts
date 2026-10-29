/**
 * Runtime configuration.
 *
 * Everything deployment-varying is read here once and validated, so a
 * misconfiguration fails at boot with a named value rather than halfway through
 * a request.
 *
 * @module dswg/config
 */

import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Resolved, validated gateway settings. */
export interface Config {
  /** Directory holding the database, browser profiles, identities and logs. */
  home: string
  /** TCP port for the HTTP API. */
  port: number
  /** Bind address; loopback by default so the gateway is not exposed by accident. */
  host: string
  /** Token accepted on `/admin` routes. Generated and printed on first boot when unset. */
  adminToken: string | null
  /** Chromium channel or executable used for every account profile. */
  chromeChannel: string
  /** Extra Chromium flags appended to every launch. */
  chromeArgs: string[]
  /** Run browser profiles headless. Adding an account always opens a window. */
  headless: boolean
  /** Per-account minimum spacing between upstream turns, in milliseconds. */
  accountMinGapMs: number
  /** Per-account upstream turns allowed per rolling minute. */
  accountRpm: number
  /** Warm browser profiles evicted after this many idle milliseconds. */
  browserIdleMs: number
  /** Maximum turns that may wait on one account before the pool refuses. */
  maxQueuePerAccount: number
  /** Default upstream turn wall clock budget, in milliseconds. */
  turnTimeoutMs: number
  /** Idle time between received SSE chunks before the upstream is considered stalled. */
  streamIdleTimeoutMs: number
  /**
   * Delete each turn's upstream chat session once it finishes.
   *
   * Every request opens a fresh chat (a long accumulated context is exactly where
   * tool-call formatting degrades), so without this the account's sidebar fills
   * with one-turn conversations. Deleting costs one extra upstream request per
   * turn, which is why it is configurable.
   */
  sessionCleanup: boolean
  /**
   * Safety ceiling for one prompt, in characters.
   *
   * The site's own per-mode limit is 2,621,440 characters, so this exists to stop
   * a runaway transcript, not to truncate a real one: a ceiling below what the
   * client actually sends silently drops the middle of the conversation on every
   * turn, which is both a quality loss and, because the model then re-reads a
   * chopped transcript, a slower and less predictable one.
   */
  maxPromptChars: number
  /** Interval for the warm-profile liveness check; 0 disables it. */
  healthCheckMs: number
  /** Retry a turn once when the model's tool-call markup cannot be parsed. */
  retryOnMalformedToolCall: boolean
  /**
   * How long a request may wait for an account that is only resting.
   *
   * The site throttles by account in windows of minutes, so the only account a
   * key allows is regularly "cooling down until …" for a while. Failing the
   * request there is the wrong answer for a client that wanted a turn: the wait
   * is known, it is short, and nothing else can happen in the meantime. A request
   * therefore waits out a cooldown, mute or pacing window that ends inside this
   * budget and runs as soon as the account is eligible again. Set 0 to fail fast.
   */
  waitForAccountMs: number
  /**
   * Maximum extra attempts for a transient refusal, on the same account.
   *
   * A second bound next to `retryBudgetMs`: the budget decides how long the
   * gateway is willing to wait, this decides how many requests it is willing to
   * spend doing so. Whichever runs out first ends the loop.
   */
  transientRetries: number
  /** Base delay for the exponential backoff between transient retries. */
  retryBaseMs: number
  /** Ceiling for one retry delay. */
  retryMaxMs: number
  /**
   * Total time a turn may spend riding out a transient refusal.
   *
   * The site throttles in windows of roughly three minutes, so an attempt count
   * is the wrong unit: what matters is whether the gateway is still willing to
   * wait. A request that gives up after two seconds cannot survive a window that
   * lasts two minutes, and one that waits forever blocks an agent's turn.
   */
  retryBudgetMs: number
}

/**
 * Read an integer environment value.
 * @param name - variable name.
 * @param fallback - value used when unset.
 * @returns the parsed value.
 * @throws when the variable is set but is not a positive integer.
 */
function int(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const value = Number(raw)
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a non-negative number, got "${raw}"`)
  return Math.trunc(value)
}

/**
 * Read a boolean environment value.
 * @param name - variable name.
 * @param fallback - value used when unset.
 * @returns the parsed flag.
 */
function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  return /^(1|true|yes|on)$/i.test(raw)
}

/**
 * Resolve and validate the configuration.
 * @param overrides - values that win over the environment, used by tests.
 * @returns the configuration.
 */
export function loadConfig(overrides: Partial<Config> = {}): Config {
  // Default to the package's own `data/` directory, so the gateway keeps its
  // state with itself no matter which directory the launcher ran from.
  const rawHome = process.env.DSWG_HOME ?? fileURLToPath(new URL('../data', import.meta.url))
  const home = isAbsolute(rawHome) ? rawHome : join(homedir(), rawHome)
  mkdirSync(home, { recursive: true })

  const chromeArgs = (process.env.DSWG_CHROME_ARGS ?? '')
    .split(/\s+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)

  const config: Config = {
    home,
    port: int('DSWG_PORT', 8787),
    host: process.env.DSWG_HOST ?? '127.0.0.1',
    adminToken: process.env.DSWG_ADMIN_TOKEN?.trim() || null,
    chromeChannel: process.env.DSWG_CHROME_CHANNEL ?? 'chrome',
    chromeArgs: ['--disable-blink-features=AutomationControlled', ...chromeArgs],
    headless: bool('DSWG_HEADLESS', true),
    accountMinGapMs: int('DSWG_ACCOUNT_MIN_GAP_MS', 1500),
    accountRpm: int('DSWG_ACCOUNT_RPM', 20),
    browserIdleMs: int('DSWG_BROWSER_IDLE_MS', 10 * 60 * 1000),
    maxQueuePerAccount: int('DSWG_MAX_QUEUE', 8),
    turnTimeoutMs: int('DSWG_TURN_TIMEOUT_MS', 10 * 60 * 1000),
    streamIdleTimeoutMs: int('DSWG_STREAM_IDLE_MS', 150 * 1000),
    sessionCleanup: bool('DSWG_SESSION_CLEANUP', false),
    maxPromptChars: int('DSWG_MAX_PROMPT_CHARS', 1_000_000),
    retryOnMalformedToolCall: bool('DSWG_RETRY_MALFORMED_TOOL_CALL', true),
    waitForAccountMs: int('DSWG_WAIT_FOR_ACCOUNT_MS', 5 * 60 * 1000),
    healthCheckMs: int('DSWG_HEALTH_CHECK_MS', 10 * 60 * 1000),
    transientRetries: int('DSWG_TRANSIENT_RETRIES', 8),
    retryBaseMs: int('DSWG_RETRY_BASE_MS', 700),
    retryMaxMs: int('DSWG_RETRY_MAX_MS', 15000),
    retryBudgetMs: int('DSWG_RETRY_BUDGET_MS', 90000),
    ...overrides,
  }

  if (config.port < 1 || config.port > 65535) throw new Error(`DSWG_PORT out of range: ${config.port}`)
  return config
}

/**
 * The Chrome executable or channel label to launch.
 *
 * A channel name (`chrome`, `msedge`, `chromium`) lets Playwright pick the
 * installed build; an absolute path pins a specific binary.
 * @param config - gateway configuration.
 * @returns the channel or executable path.
 */
export function chromeTarget(config: Config): { channel?: string; executablePath?: string } {
  const candidate = config.chromeChannel
  if (candidate.includes('/') || candidate.includes('\\') || candidate.toLowerCase().endsWith('.exe')) {
    if (!existsSync(candidate)) throw new Error(`DSWG_CHROME_CHANNEL points at a missing executable: ${candidate}`)
    return { executablePath: candidate }
  }
  return { channel: candidate }
}
