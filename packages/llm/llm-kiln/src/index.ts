/**
 * The Kiln multi-provider adapter: every provider KilnKernel ships, including
 * `ds_direct` (DeepSeek's free web session), registered as harness LLM routes.
 *
 * Sixteen presets come across — Anthropic, OpenAI, Gemini, OpenRouter, the
 * DeepSeek paid API, Groq, xAI, Mistral, Together, Fireworks, Perplexity,
 * Cerebras, NVIDIA, Ollama, LM Studio, and the free DeepSeek web session — plus
 * any custom OpenAI-compatible provider the Kiln settings document adds. Routes
 * are named `<prefix><kiln id>` (default `kiln-`) so they cannot collide with
 * `deepseek-official` or with the pi-ai catalog names.
 *
 * Keys are never configuration here. Each preset names the environment variable
 * holding its key, and the sidecar resolves that variable per request; the
 * catalog reports only whether a key is present.
 *
 * None of these providers has a `tools` field, so the tool channel is text in
 * both directions: `./protocol.ts` writes the harness's own tool schemas into
 * the system slot as one `<tool_calls>` format, and `./dsml.ts` reads exactly
 * that format back as native harness tool calls. Both sides are generated from
 * `GenerateOptions.tools`, so the roster the harness composed is the roster the
 * model is told about, and no tool is described in prose anywhere.
 *
 * The system slot carries the harness's prompt plus that format statement, and
 * nothing else. No provider in the Python runtime contributes prompt text of
 * its own.
 *
 * ```yaml
 * - id: llm-kiln
 *   name: '@deepseek-ai/dsh-llm-kiln'
 *   config:
 *     routePrefix: kiln-
 *     onlyConfigured: false   # true registers only routes that already have a key
 * ```
 *
 * @module @deepseek-ai/dsh-llm-kiln
 */

import { existsSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { LlmError } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-settings'
import type { AdapterRegistrationHandle, DirectoryRegistrationHandle, LlmAccountAdder } from '@deepseek-ai/dsh-llm'
import { KilnAdapter } from './adapter.ts'
import { KilnBridge } from './bridge.ts'
import type { KilnProvider } from './bridge.ts'

export { KilnAdapter, buildTurns, flattenMessage, isRateLimit, mintCallId, RATE_LIMIT_RETRY_MS, renderToolCall, requestOptions, toolIndex } from './adapter.ts'
export type { KilnAdapterOptions } from './adapter.ts'
export { KilnBridge } from './bridge.ts'
export type { KilnBridgeOptions, KilnMessage, KilnModel, KilnProvider, KilnStreamEvent, KilnStreamRequest } from './bridge.ts'
export { DsmlTranslator, invokeArguments, trailingReasoningCalls } from './dsml.ts'
export type { DsmlEvent } from './dsml.ts'
export { coerceParameter, DSML_CLOSE, DSML_OPEN, escapeXml, parameterNames, requiredNames, toolProtocolPrompt, unescapeXml } from './protocol.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'llm-kiln'

/** Services required before the adapter can register. */
export const inject = ['llm']

/** Settings namespace for the Kiln adapter (deepseek-web credentials + routing knobs). */
export const LLM_KILN_SETTINGS_NAMESPACE = 'llm-kiln'

/** Default prefix keeping Kiln routes clear of every other adapter's names. */
export const DEFAULT_ROUTE_PREFIX = 'kiln-'

/** Plugin config. */
export interface Config {
  /** Prefix applied to every Kiln provider id to form the harness route name. */
  routePrefix?: string
  /**
   * Register only routes the registry reports as usable — a key present, or a
   * keyless local endpoint. Default false: an unconfigured route stays visible
   * so it can be selected and configured, and fails per request with the
   * registry's own message naming the variable to set.
   */
  onlyConfigured?: boolean
  /** Interpreter for the sidecar. Omitted = `$DSH_KERNEL_PYTHON`, then a platform probe. */
  python?: string
  /** Working directory for the sidecar. Omitted = the harness working directory. */
  cwd?: string
  /** Directory for the sidecar's mutable state. Omitted = `<cwd>/.kiln_kernel_state`. */
  stateDir?: string
  /** The `python/kiln` directory. Omitted = the copy shipped with this repo. */
  bridgeDir?: string
  /**
   * DeepSeek web (ds_direct) credentials, editable from the Models page.
   *
   * `token` + `cookie` are the live bearer/WAF pair. The optional login fields
   * let ds_direct refresh those credentials itself when DeepSeek rotates them,
   * so the bridge keeps working without a new copy-paste from devtools.
   */
  deepseek?: {
    /** DeepSeek web bearer token. */
    token?: string
    /** DeepSeek web WAF cookie. */
    cookie?: string
    /** Login email for automatic token refresh. */
    email?: string
    /** Login mobile for automatic token refresh. */
    mobile?: string
    /** Login area code (for mobile). */
    areaCode?: string
    /** Login password for automatic token refresh. */
    password?: string
  }
}

export const Config: z<Config> = z.object({
  routePrefix: z.string().default(DEFAULT_ROUTE_PREFIX),
  onlyConfigured: z.boolean().default(false),
  python: z.string(),
  cwd: z.string(),
  stateDir: z.string(),
  bridgeDir: z.string(),
  deepseek: z.object({
    token: z.string().role('secret'),
    cookie: z.string().role('secret'),
    email: z.string(),
    mobile: z.string(),
    areaCode: z.string(),
    password: z.string().role('secret'),
  }),
})

/** The bridge shipped with this repository: `python/kiln`. */
export function defaultBridgeDir(): string {
  return resolve(import.meta.dirname, '..', '..', '..', '..', 'python', 'kiln')
}

/**
 * The interpreter inside the uv-managed bundle under `python/kiln/runtime/.venv`,
 * once `uv sync` has provisioned it. Preferring it keeps the DeepSeek `ds_direct`
 * bridge on the same bundled Python (with `curl_cffi`) as the kernel, even for a
 * direct `dsh web` that never set `$DSH_KERNEL_PYTHON`. Undefined until provisioned.
 */
export function bundledVenvPython(): string | undefined {
  const runtime = join(defaultBridgeDir(), 'runtime')
  const venv = process.platform === 'win32'
    ? join(runtime, '.venv', 'Scripts', 'python.exe')
    : join(runtime, '.venv', 'bin', 'python')
  return existsSync(venv) ? venv : undefined
}

/**
 * The route name binding one Kiln provider to one of its pooled logins.
 *
 * `@` separates them because it cannot occur in a Kiln provider id, so the
 * provider part of the name stays unambiguous however the account is labelled.
 * @param prefix - the configured route prefix.
 * @param providerId - the Kiln provider id.
 * @param account - the login id to pin.
 * @returns the harness route name.
 */
export function accountRoute(prefix: string, providerId: string, account: string): string {
  return `${prefix}${providerId}@${account}`
}

/**
 * Whether a route can currently serve a request: a key is present, or the
 * endpoint is a keyless local one (Ollama, LM Studio), or the free DeepSeek web
 * session is already enabled.
 * @param entry - one catalog entry.
 * @returns true when the registry could dispatch to it right now.
 */
export function isConfigured(entry: KilnProvider): boolean {
  if (entry.local) return true
  if (entry.api_key_env.length === 0) return entry.enabled
  return entry.has_key
}

/** The three route lookups the adapter reads, kept as one mutable set. */
interface RouteTables {
  /** route id -> the catalog entry it dispatches to. */
  readonly routes: Map<string, KilnProvider>
  /** route id -> the underlying Kiln provider id. */
  readonly kilnIds: Map<string, string>
  /** route id -> the pinned login, for account-bound routes only. */
  readonly accounts: Map<string, string>
}

/**
 * Rebuild the route tables from a catalog IN PLACE, so the adapter's live
 * `() => routes` getter sees the new set without being handed new Map objects.
 *
 * One route per provider. A provider that pools logins keeps one route for all
 * of them and lets the sidecar's account ring choose per request, so a second
 * DeepSeek login is another account behind one entry rather than a second entry
 * in the picker. This is re-run after {@link KilnBridge.addAccount} because a
 * new login can make an unconfigured provider configured.
 * @param tables - the mutable lookups the adapter closes over.
 * @param catalog - the freshly read provider catalog.
 * @param prefix - the configured route prefix.
 * @param onlyConfigured - drop routes that cannot serve a request yet.
 */
export function rebuildRoutes(
  tables: RouteTables,
  catalog: readonly KilnProvider[],
  prefix: string,
  onlyConfigured: boolean,
): void {
  tables.routes.clear()
  tables.kilnIds.clear()
  tables.accounts.clear()
  for (const entry of catalog) {
    if (onlyConfigured && !isConfigured(entry)) continue
    const route = `${prefix}${entry.id}`
    tables.routes.set(route, entry)
    tables.kilnIds.set(route, entry.id)
  }
}

/**
 * Start the sidecar, read its catalog once, and register every route.
 *
 * The catalog is read at load rather than per request because the harness route
 * set is registration-shaped: adding or removing a route is a registry
 * operation, not a request-time decision. Which routes exist is composition;
 * which of them have keys stays a per-request fact the sidecar resolves.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  let current: () => Config = () => config
  const bridgeDir = config.bridgeDir ?? defaultBridgeDir()
  const script = join(bridgeDir, 'provider_bridge.py')
  if (!existsSync(script)) {
    throw new LlmError(`the Kiln provider bridge is missing: no provider_bridge.py under "${bridgeDir}"`, 'TRANSPORT')
  }
  const python = await resolveBridgePython(config.python)
  const cwd = config.cwd ?? process.cwd()
  // Whoever NAMES the state directory creates it. ds_direct persists its
  // kiln-conversation -> DeepSeek-chat pin through a writer wrapped in
  // `except: pass`, so a directory that does not exist is not an error there —
  // the pin silently fails to save, and every restart re-primes a brand-new
  // DeepSeek chat from a transcript clipped to 48k characters.
  const stateDir = config.stateDir ?? join(cwd, '.kiln_kernel_state')
  mkdirSync(stateDir, { recursive: true })
  const bridge = new KilnBridge({
    python,
    script,
    cwd,
    env: { KILN_STATE_DIR: stateDir },
  })

  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.installSection(ctx, LLM_KILN_SETTINGS_NAMESPACE, Config, config, {
      setSource: (source) => {
        current = source
      },
      // Credentials are applied to the long-lived sidecar process; the route
      // graph does not change for a token/cookie edit, so no re-registration
      // is required here.
      onChange: () => {
        const next = current()
        const ds = next.deepseek
        if (ds !== undefined) {
          void bridge.configure('deepseek', {
            token: ds.token ?? '',
            cookie: ds.cookie ?? '',
            email: ds.email ?? '',
            mobile: ds.mobile ?? '',
            area_code: ds.areaCode ?? '',
            password: ds.password ?? '',
          })
        }
      },
    })
  })
  // Seed the sidecar with any stored credentials from launch/settings.
  {
    const seeded = current()
    const ds = seeded.deepseek
    if (ds !== undefined) {
      void bridge.configure('deepseek', {
        token: ds.token ?? '',
        cookie: ds.cookie ?? '',
        email: ds.email ?? '',
        mobile: ds.mobile ?? '',
        area_code: ds.areaCode ?? '',
        password: ds.password ?? '',
      })
    }
  }

  const prefix = config.routePrefix ?? DEFAULT_ROUTE_PREFIX
  // One base route per provider, plus one per pooled login. Which ACCOUNT serves
  // a request is not a per-request choice a model or user makes mid-conversation
  // — it decides which DeepSeek chat history the turn lands in — so it is bound
  // to the route, selected the way any model is. That is what lets a subagent
  // preset name a login its parent is not on, and what makes a freshly added
  // account become selectable once the routes are rebuilt (see addAccount).
  const tables: RouteTables = { routes: new Map(), kilnIds: new Map(), accounts: new Map() }
  rebuildRoutes(tables, await bridge.catalog(), prefix, config.onlyConfigured === true)
  const { routes, kilnIds, accounts } = tables
  if (routes.size === 0) {
    bridge.dispose()
    throw new LlmError('the Kiln registry reported no usable providers', 'TRANSPORT')
  }

  // The free DeepSeek web route is configurable from the Models page. Its
  // settings section carries the bearer token + WAF cookie pair only; no key
  // value is ever sent back in descriptors.
  let directory: DirectoryRegistrationHandle | undefined
  {
    const dsRoute = `${prefix}deepseek`
    const dsEntry = routes.get(dsRoute)
    if (dsEntry !== undefined) {
      directory = ctx.llm.registerConfigurableProviders([{
        provider: dsRoute,
        displayName: dsEntry.name,
        settingsNs: LLM_KILN_SETTINGS_NAMESPACE,
        settingsPath: ['deepseek'],
      }])
    }
  }

  const adapter = new KilnAdapter({
    bridge,
    routes: () => routes,
    kilnId: route => kilnIds.get(route) ?? route,
    account: route => accounts.get(route),
  })
  const handle: AdapterRegistrationHandle = ctx.llm.registerAdapter([...routes.keys()], adapter)

  /**
   * Test a login and, on success, make it selectable. The sidecar persists the
   * account, then the catalog is re-read and the routes atomically replaced, so
   * the new per-login route appears immediately — `handle.replace` publishes
   * `llm/adapters-updated`, which is what refreshes the picker. Bound to a route
   * only ever happens through the adapter that owns it.
   * @param provider - the Kiln provider route (only the DeepSeek base route pools accounts).
   * @param account - the login to test: email or mobile, plus the password.
   * @returns the added account id and its new route, or the failure reason.
   */
  const addAccount: LlmAccountAdder = async (account) => {
    const kilnId = 'deepseek'                 // registered only for the DeepSeek route
    const result = await bridge.addAccount(kilnId, account)
    if (!result.ok || result.account === undefined) {
      return { ok: false, ...result.message === undefined ? {} : { message: result.message } }
    }
    rebuildRoutes(tables, await bridge.catalog(), prefix, config.onlyConfigured === true)
    handle.replace([...routes.keys()])        // publishes llm/adapters-updated → picker refreshes
    return { ok: true, account: result.account, route: `${prefix}${kilnId}` }
  }
  const accountHandle = ctx.llm.registerAccountProvider(`${prefix}deepseek`, addAccount)

  // Releasing the routes does not stop the sidecar, so all three are torn down
  // in one fiber-scoped effect: routes first, so no request can arrive at a
  // process that is already going away.
  ctx.effect(function* () {
    yield () => {
      handle()
      accountHandle()
      directory?.()
      bridge.dispose()
    }
  }, 'llm-kiln bridge')
}

/** Probe timeout for one interpreter candidate. */
const PROBE_TIMEOUT_MS = 10_000

/**
 * Find an interpreter for the sidecar, mirroring the kernel backend's probe:
 * a name on PATH is not enough, because the Windows Store shim answers
 * `--version` with an advertisement rather than running Python.
 * @param configured - an explicitly configured interpreter, tried alone.
 * @returns the first working interpreter.
 */
export async function resolveBridgePython(configured?: string): Promise<string> {
  const { execFileSync } = await import('node:child_process')
  const explicit = configured ?? process.env.DSH_KERNEL_PYTHON
  const candidates = explicit !== undefined && explicit.length > 0
    ? [explicit]
    : [bundledVenvPython(), ...(process.platform === 'win32' ? ['py', 'python', 'python3'] : ['python3', 'python'])]
      .filter((candidate): candidate is string => candidate !== undefined)
  for (const candidate of candidates) {
    try {
      const stdout = execFileSync(candidate, ['-c', 'print("ok")'], {
        encoding: 'utf8',
        timeout: PROBE_TIMEOUT_MS,
        windowsHide: true,
      })
      if (stdout.includes('ok')) return candidate
    } catch {
      // Next candidate; a probe failure is normal for a name this machine lacks.
    }
  }
  throw new LlmError(
    'no working Python interpreter was found for the Kiln provider bridge; set `python` on the llm-kiln row or $DSH_KERNEL_PYTHON',
    'TRANSPORT',
  )
}
