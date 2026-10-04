/**
 * Harness-introspection seam operations for the Kiln kernel.
 *
 * `seam.ts` carries the *capability* seams a cell acts through (filesystem, shell, web,
 * subprocess, subagents, goals, tools). This module carries the *observation* seams: what
 * the harness currently is — its agents, sessions and their recorded events, its settings,
 * its loader rows, its model routes, its workspaces, its background jobs and scheduled
 * tasks, its token accounting, its preset composition — plus the op catalog that makes the
 * whole table discoverable from inside a cell.
 *
 * Everything here is an EXTERNAL consumer of those seams, exactly like `seam.ts`: each
 * service is reached by its runtime `ctx.<name>` property, every shape is mirrored locally
 * rather than imported, and a missing service becomes `unavailable` so the Python helper
 * degrades instead of failing. Reads prefer the seams a reader is *supposed* to use:
 * session history comes from `ctx.sessionQuery` (its own live/prepared corpus) rather than
 * from the synchronous `Session` readers, which new production code may not call.
 *
 * @module @deepseek-ai/dsh-kernel-python/seam-harness
 */

import type { Context } from '@deepseek-ai/cordis'
import type { KernelAgent } from '@deepseek-ai/dsh-kernel'
import type { SeamRequest, SeamResponse } from './seam.ts'

/** One operation this module answers, with the arguments it reads. */
export interface HarnessOp {
  /** The `op` string a cell sends. */
  readonly op: string
  /** Argument names, positional-free, as the Python helper spells them. */
  readonly args: readonly string[]
  /** One line: what the op returns. */
  readonly summary: string
}

/**
 * The ops this module answers. `seam.ops` returns this table, so it is the single source of
 * truth for what a cell can ask for — a helper in `kernel_child.py` that is not here is a
 * helper that cannot work, and an op added here is discoverable the moment it lands.
 */
export const HARNESS_OPS: readonly HarnessOp[] = [
  { op: 'agents.list', args: [], summary: 'live agents this harness holds, each with whether it is a root and whether it is this cell\'s own' },
  { op: 'agents.current', args: [], summary: 'the agent that dispatched this cell, or null when the cell has no owner' },

  { op: 'sessions.list', args: [], summary: 'live sessions known to `ctx.sessions`, as {id, header}' },
  { op: 'sessions.get', args: ['id'], summary: 'one live session as {id, header}, or null' },
  { op: 'sessions.corpus', args: [], summary: 'every session of the logical corpus (live preferred), as {id, live, persisted, cwd, createdAt}' },
  { op: 'sessions.events', args: ['sessionId', 'limit', 'type'], summary: 'the newest recorded events of one session, as {seq, type, time, surface}' },
  { op: 'sessions.surface', args: ['sessionId', 'limit'], summary: 'the events currently on one session\'s model surface, oldest first, each with a one-line summary' },
  { op: 'sessions.window', args: ['sessionId', 'seq', 'before', 'after'], summary: 'the events around one seq of one session, with the same per-event summary' },
  { op: 'sessions.trace', args: ['sessionId'], summary: 'the ancestry and descendants of one session, ids only' },

  { op: 'settings.describe', args: [], summary: 'every settings namespace with its effective value and revision' },
  { op: 'settings.update', args: ['ns', 'patch'], summary: 'merge one patch into a settings namespace and return its new revision' },

  { op: 'plugins.list', args: [], summary: 'the loader\'s plugin inventory: entry id, module, local name, enablement, fiber phase' },

  { op: 'models.providers', args: [], summary: 'registered model providers as {id, name}' },
  { op: 'models.list', args: ['provider'], summary: 'the models one provider offers, as {id, name, description}' },

  { op: 'workspaces.list', args: [], summary: 'the workspace registry: {id, path, name, status}' },

  { op: 'jobs.list', args: [], summary: 'background jobs of this session, as {id, kind, label, state}' },
  { op: 'schedules.list', args: [], summary: 'scheduled tasks bound to this session' },

  { op: 'context.state', args: [], summary: 'token accounting for this session: log revision, baseline, and the surface delta' },

  { op: 'presets.list', args: [], summary: 'the composed agent presets and their plugin rows' },
  { op: 'presets.current', args: [], summary: 'the preset name this session runs under, and the composed context name' },

  { op: 'projections.read', args: ['sessionId', 'keys'], summary: 'current session-projection values for this session (or one named session)' },

  { op: 'sessions.title', args: ['sessionId'], summary: 'the durable title of one live session, or null' },
  { op: 'tools.search', args: ['query', 'limit', 'scope'], summary: 'the visible tools whose name or description matches a substring' },
  { op: 'terminals.list', args: [], summary: 'the persistent terminals this agent owns: {id, name, type, pid, status}' },
  { op: 'prompt.sections', args: ['full'], summary: 'the assembled system prompt as section names and sizes, with their text when full is true' },
  { op: 'storage.backends', args: [], summary: 'the storage backends this deployment registered' },

]

/** Mirrored `ctx.agents` surface. */
interface AgentsSeam {
  list(): readonly unknown[]
  roots(): readonly unknown[]
  currentInitiator(): unknown
}

/** The window one event read asks for around a seq. */
interface EventWindowRequest {
  readonly sessionId: string
  readonly seq: number
  readonly before?: number
  readonly after?: number
}

/** Mirrored `ctx.sessionQuery` surface. */
interface SessionQuerySeam {
  listSessions(signal?: AbortSignal): Promise<readonly unknown[]>
  listEvents(sessionId: string): Promise<readonly unknown[]>
  readSurface(sessionId: string): Promise<{ readonly events: readonly unknown[] }>
  readEvent(request: EventWindowRequest, signal?: AbortSignal): Promise<unknown>
  traceSession(sessionId: string, signal?: AbortSignal): Promise<unknown>
}

/** Mirrored `ctx.settings` surface. */
interface SettingsSeam {
  describe(options?: unknown): readonly unknown[]
  update(ns: string, patch: object, expectedRevision?: number): Promise<void>
}

/** Mirrored `ctx.pluginInventory` surface. */
interface PluginInventorySeam {
  list(): Promise<unknown>
}

/** Mirrored `ctx.llm` surface. */
interface LlmSeam {
  listProviders(): readonly unknown[]
  listModels(provider: string): Promise<readonly unknown[]>
}

/** Mirrored `ctx.workspaceRegistry` surface. */
interface WorkspacesSeam {
  list(): readonly unknown[]
}

/** Mirrored `ctx.jobs` surface. */
interface JobsSeam {
  list(caller?: string): readonly unknown[]
}

/** Mirrored `ctx.schedule` surface. */
interface ScheduleSeam {
  list(request: { readonly sessionId: string }): Promise<readonly unknown[]>
}

/** Mirrored `ctx.tokenMeter` surface. */
interface TokenMeterSeam {
  measure(session: unknown, requestHeader?: unknown): unknown
}

/** Mirrored `ctx.agentPresets` surface. */
interface AgentPresetsSeam {
  compositionInventory(): Promise<readonly unknown[]>
  composedPreset(ctx: Context): string | undefined
}

/** Mirrored `ctx.sessionProjections` surface. */
interface SessionProjectionsSeam {
  snapshot(session: unknown, keys?: readonly string[]): unknown
}

/** Mirrored `ctx.sessions` surface (the live registry). */
interface SessionsSeam {
  list(): readonly unknown[]
  get(id: unknown): unknown
}

/** Mirrored `ctx.sessionTitle` surface. */
interface SessionTitleSeam {
  get(session: unknown): unknown
}

/** Mirrored `ctx.tools` surface, for searching the visible schemas. */
interface ToolsSeam {
  schemas(scope?: unknown): readonly unknown[]
}

/** Mirrored `ctx.terminals` surface. */
interface TerminalsSeam {
  list(owner: unknown): readonly unknown[]
}

/** Mirrored `ctx.systemPrompt` surface. */
interface SystemPromptSeam {
  assemble(context?: unknown): Promise<{ readonly sections: readonly unknown[] }>
}

/** Mirrored `ctx.storage` surface, read-only: the hub's backend registry. */
interface StorageSeam {
  readonly backends: { names(): readonly string[] }
}

/** Every service this module reads, by its `ctx` property name. */
interface HarnessServices {
  agents: AgentsSeam
  sessionQuery: SessionQuerySeam
  settings: SettingsSeam
  pluginInventory: PluginInventorySeam
  llm: LlmSeam
  workspaceRegistry: WorkspacesSeam
  jobs: JobsSeam
  schedule: ScheduleSeam
  tokenMeter: TokenMeterSeam
  agentPresets: AgentPresetsSeam
  sessionProjections: SessionProjectionsSeam
  sessions: SessionsSeam
  sessionTitle: SessionTitleSeam
  tools: ToolsSeam
  terminals: TerminalsSeam
  systemPrompt: SystemPromptSeam
  storage: StorageSeam
}

/**
 * One service off the agent-scoped context, or undefined when it is not mounted.
 * @param ctx - the agent-scoped context a cell runs with.
 * @param name - the service's `ctx` property name.
 * @returns the service as its mirrored interface, or undefined.
 */
function serviceOf<K extends keyof HarnessServices>(ctx: Context | undefined, name: K): HarnessServices[K] | undefined {
  if (ctx === undefined) return undefined
  // `ctx.get` is the strict read: the property proxy refuses a service the reading
  // fiber did not declare, and a cell dispatches with an agent's context, which
  // injects a handful. Reading the global store is what lets an op answer with a
  // value or with "not mounted" instead of an inject error.
  const service: unknown = ctx.get(name)
  return service === undefined || service === null ? undefined : service as HarnessServices[K]
}

/**
 * Whether the observation family owns one op.
 *
 * The router asks this before its capability prefixes, so an op that shares a
 * prefix with a capability seam (`tools.search` beside `tools.call`) reaches the
 * dispatcher that answers it. The catalog is the authority, which is what keeps
 * the table a cell reads and the routing that answers it from drifting apart.
 * @param op - the request op.
 * @returns whether {@link dispatchHarness} answers it.
 */
export function isHarnessOp(op: string): boolean {
  return HARNESS_OPS.some(entry => entry.op === op)
}

/** Narrow an unknown value to a property bag without asserting its contents. */
function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
}

/**
 * The first present string among these keys.
 * @param source - the property bag to read.
 * @param keys - candidate property names, in preference order.
 * @returns the string, or undefined.
 */
function stringOf(source: Record<string, unknown>, ...keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = source[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return undefined
}

/**
 * The first present finite number among these keys.
 * @param source - the property bag to read.
 * @param keys - candidate property names, in preference order.
 * @returns the number, or undefined.
 */
function numberOf(source: Record<string, unknown>, ...keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = source[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  return undefined
}

/** Longest text a per-event summary carries before it is ellipsized. */
const SUMMARY_LIMIT = 160

/**
 * A one-line summary of one recorded event, for a cell that wants to see shape rather than
 * payload. Text blocks and tool calls are the two an operator asks about; everything else
 * reports its own type.
 * @param event - one session event.
 * @returns the bounded summary.
 */
function summarizeEvent(event: unknown): string {
  const record = asRecord(event)
  const data = asRecord(record['data'])
  const message = asRecord(data['message'])
  const content = Array.isArray(message['content']) ? message['content'] : []
  const text = content
    .map(block => asRecord(block))
    .filter(block => stringOf(block, 'type') === 'text')
    .map(block => stringOf(block, 'text') ?? '')
    .join('')
  if (text.length > 0) return `${JSON.stringify(text.slice(0, SUMMARY_LIMIT))}${text.length > SUMMARY_LIMIT ? '…' : ''}`
  const tool = stringOf(data, 'name', 'toolName')
  if (tool !== undefined) return `tool ${tool}`
  const title = stringOf(data, 'title')
  if (title !== undefined) return `title ${JSON.stringify(title.slice(0, SUMMARY_LIMIT))}`
  return ''
}

/**
 * Project one recorded event to what a cell reads: where it sits, what it is, and a bounded
 * summary.
 * @param event - one session event.
 * @returns the projection.
 */
function projectEvent(event: unknown): Record<string, unknown> {
  const record = asRecord(event)
  const summary = summarizeEvent(event)
  return {
    seq: numberOf(record, 'seq') ?? null,
    type: stringOf(record, 'type') ?? 'unknown',
    time: numberOf(record, 'time') ?? null,
    ...summary.length > 0 ? { summary } : {},
  }
}

/** How many events one read returns before the answer stops growing. */
const EVENT_PAGE_LIMIT = 40

/**
 * The owning session id of this cell, which every session-scoped op defaults to.
 * @param agent - the agent that dispatched the cell, when it has one.
 * @returns the id, or undefined.
 */
function owningSessionId(agent: KernelAgent | undefined): string | undefined {
  const session = (agent as { session?: { id?: unknown } } | undefined)?.session
  return typeof session?.id === 'string' ? session.id : undefined
}

/**
 * The session id an op names, or this cell's own.
 * @param args - the request arguments.
 * @param agent - the agent that dispatched the cell.
 * @returns the id, or undefined when neither exists.
 */
function requestedSessionId(args: Record<string, unknown>, agent: KernelAgent | undefined): string | undefined {
  const named = args['sessionId'] ?? args['id']
  return typeof named === 'string' && named.length > 0 ? named : owningSessionId(agent)
}

/** The slice of a newest-first event list an op asked for. */
function pageLimit(args: Record<string, unknown>): number {
  const limit = args['limit']
  if (typeof limit !== 'number' || !Number.isFinite(limit) || limit <= 0) return EVENT_PAGE_LIMIT
  return Math.min(Math.floor(limit), 500)
}

function ok(id: string, value: unknown): SeamResponse {
  return { id, ok: true, value: JSON.parse(JSON.stringify(value ?? null)) as unknown }
}
function unavailable(id: string, reason: string): SeamResponse {
  return { id, ok: false, unavailable: true, error: reason }
}
function failed(id: string, error: unknown): SeamResponse {
  return { id, ok: false, error: error instanceof Error ? error.message : String(error) }
}

/**
 * Dispatch one harness-introspection op.
 * @param agentCtx - the agent-scoped context the cell runs with.
 * @param agent - the agent that dispatched the cell, when it has one.
 * @param request - the decoded seam request.
 * @param signal - the cell's cancellation signal.
 * @returns the seam response.
 */
export async function dispatchHarness(
  agentCtx: Context | undefined,
  agent: KernelAgent | undefined,
  request: SeamRequest,
  signal?: AbortSignal,
): Promise<SeamResponse> {
  const args = (request.args ?? {}) as Record<string, unknown>
  try {
    if (request.op.startsWith('agents.')) return dispatchAgents(agentCtx, agent, request)
    if (request.op.startsWith('sessions.')) return await dispatchSessions(agentCtx, agent, request, signal)
    if (request.op.startsWith('settings.')) return await dispatchSettings(agentCtx, request)
    if (request.op === 'plugins.list') return await dispatchPlugins(agentCtx, request)
    if (request.op.startsWith('models.')) return await dispatchModels(agentCtx, request)
    if (request.op === 'workspaces.list') return dispatchWorkspaces(agentCtx, request)
    if (request.op === 'jobs.list') return dispatchJobs(agentCtx, agent, request)
    if (request.op === 'schedules.list') return await dispatchSchedules(agentCtx, agent, request)
    if (request.op === 'context.state') return dispatchContext(agentCtx, agent, request)
    if (request.op.startsWith('presets.')) return await dispatchPresets(agentCtx, agent, request)
    if (request.op === 'projections.read') return dispatchProjections(agentCtx, agent, request, args)
    if (request.op === 'tools.search') return dispatchToolSearch(agentCtx, request, args)
    if (request.op === 'terminals.list') return dispatchTerminals(agentCtx, agent, request)
    if (request.op === 'prompt.sections') return await dispatchPrompt(agentCtx, request, args)
    if (request.op === 'plugins.failures') return dispatchPluginFailures(agentCtx, request)
    if (request.op === 'storage.backends') return dispatchStorage(agentCtx, request)
    return unavailable(request.id, `unknown seam operation: ${request.op}`)
  } catch (error) {
    return failed(request.id, error)
  }
}

function dispatchAgents(
  agentCtx: Context | undefined,
  agent: KernelAgent | undefined,
  request: SeamRequest,
): SeamResponse {
  const agents = serviceOf(agentCtx, 'agents')
  if (agents === undefined) return unavailable(request.id, 'ctx.agents is not mounted for this agent')
  const own = agent?.id
  if (request.op === 'agents.current') {
    const current = agents.currentInitiator()
    const record = asRecord(current)
    const id = stringOf(record, 'id')
    return ok(request.id, id === undefined ? null : { id })
  }
  const roots = new Set(agents.roots().map(root => stringOf(asRecord(root), 'id')).filter((id): id is string => id !== undefined))
  const list = agents.list().map((entry) => {
    const id = stringOf(asRecord(entry), 'id') ?? 'unknown'
    return { id, root: roots.has(id), current: own !== undefined && id === own }
  })
  return ok(request.id, list)
}

async function dispatchSessions(
  agentCtx: Context | undefined,
  agent: KernelAgent | undefined,
  request: SeamRequest,
  signal?: AbortSignal,
): Promise<SeamResponse> {
  const args = (request.args ?? {}) as Record<string, unknown>

  // The live registry answers the two identity ops and the title; everything else is
  // history, which is `ctx.sessionQuery`'s job (and it covers stored sessions the registry
  // never opened).
  if (request.op === 'sessions.title') {
    return dispatchSessionsTitle(agentCtx, agent, request, args)
  }
  if (request.op === 'sessions.list' || request.op === 'sessions.get') {
    const sessions = serviceOf(agentCtx, 'sessions')
    if (sessions === undefined) return unavailable(request.id, 'ctx.sessions is not mounted for this agent')
    if (request.op === 'sessions.list') {
      return ok(request.id, sessions.list().map((entry) => {
        const record = asRecord(entry)
        return { id: record['id'], header: projectHeader(record['header']) }
      }))
    }
    const id = args['id']
    if (id === undefined) return failed(request.id, new Error('sessions.get requires an "id" argument'))
    const session = asRecord(sessions.get(id))
    if (Object.keys(session).length === 0) return ok(request.id, null)
    return ok(request.id, { id: session['id'], header: projectHeader(session['header']) })
  }

  const query = serviceOf(agentCtx, 'sessionQuery')
  if (query === undefined) return unavailable(request.id, 'ctx.sessionQuery is not mounted for this agent')

  if (request.op === 'sessions.corpus') {
    const records = await query.listSessions(signal)
    return ok(request.id, records.map((entry) => {
      const record = asRecord(entry)
      const header = asRecord(record['header'])
      return {
        id: record['id'] ?? header['id'],
        live: record['live'] === true,
        persisted: record['persisted'] === true,
        ...stringOf(header, 'cwd') !== undefined ? { cwd: stringOf(header, 'cwd') } : {},
        ...numberOf(header, 'createdAt') !== undefined ? { createdAt: numberOf(header, 'createdAt') } : {},
        ...stringOf(header, 'agentPreset') !== undefined ? { agentPreset: stringOf(header, 'agentPreset') } : {},
      }
    }))
  }

  const sessionId = requestedSessionId(args, agent)
  if (sessionId === undefined) {
    return unavailable(request.id, 'no session id was given and this cell has no owning session')
  }

  if (request.op === 'sessions.events') {
    const events = await query.listEvents(sessionId)
    const wanted = typeof args['type'] === 'string' ? args['type'] : undefined
    const filtered = wanted === undefined
      ? events
      : events.filter(event => stringOf(asRecord(event), 'type') === wanted)
    const newest = [...filtered].reverse().slice(0, pageLimit(args))
    return ok(request.id, { sessionId, total: filtered.length, events: newest.map(projectEvent) })
  }

  if (request.op === 'sessions.surface') {
    const snapshot = await query.readSurface(sessionId)
    const events = snapshot.events
    const limit = pageLimit(args)
    const tail = events.slice(Math.max(0, events.length - limit))
    return ok(request.id, { sessionId, total: events.length, events: tail.map(projectEvent) })
  }

  if (request.op === 'sessions.window') {
    const seq = args['seq']
    if (typeof seq !== 'number') return failed(request.id, new Error('sessions.window requires a numeric "seq"'))
    const before = typeof args['before'] === 'number' ? args['before'] : 5
    const after = typeof args['after'] === 'number' ? args['after'] : 5
    const window = asRecord(await query.readEvent({ sessionId, seq, before, after }, signal))
    const events = Array.isArray(window['events']) ? window['events'] : []
    return ok(request.id, { sessionId, seq, events: events.map(projectEvent) })
  }

  if (request.op === 'sessions.trace') {
    const trace = asRecord(await query.traceSession(sessionId, signal))
    const ids = (value: unknown): readonly unknown[] =>
      (Array.isArray(value) ? value : []).map(entry => asRecord(entry)['id'] ?? asRecord(asRecord(entry)['session'])['id'] ?? null)
    return ok(request.id, {
      sessionId,
      ancestors: ids(trace['ancestors']),
      descendants: ids(trace['descendants']),
      complete: trace['complete'] === true,
      ...trace['root'] !== undefined ? { root: asRecord(trace['root'])['id'] ?? null } : {},
    })
  }

  return unavailable(request.id, `unknown seam operation: ${request.op}`)
}

/** The session header fields a cell reads. */
function projectHeader(header: unknown): Record<string, unknown> {
  const record = asRecord(header)
  const cwd = stringOf(record, 'cwd')
  const parent = record['parentSession']
  const origin = stringOf(record, 'origin')
  const preset = stringOf(record, 'agentPreset')
  return {
    id: record['id'],
    createdAt: numberOf(record, 'createdAt') ?? null,
    ...cwd !== undefined ? { cwd } : {},
    ...parent !== undefined ? { parentSession: parent } : {},
    ...origin !== undefined ? { origin } : {},
    ...preset !== undefined ? { agentPreset: preset } : {},
  }
}

async function dispatchSettings(agentCtx: Context | undefined, request: SeamRequest): Promise<SeamResponse> {
  const settings = serviceOf(agentCtx, 'settings')
  if (settings === undefined) return unavailable(request.id, 'ctx.settings is not mounted for this agent')
  const args = (request.args ?? {}) as Record<string, unknown>

  if (request.op === 'settings.describe') {
    const descriptors = settings.describe()
    return ok(request.id, descriptors.map((entry) => {
      const record = asRecord(entry)
      return {
        ns: record['ns'],
        revision: numberOf(record, 'revision') ?? null,
        value: record['value'],
        ...record['user'] !== undefined ? { user: record['user'] } : {},
        ...Array.isArray(record['secrets']) && record['secrets'].length > 0 ? { secrets: record['secrets'] } : {},
      }
    }))
  }

  if (request.op === 'settings.update') {
    const ns = args['ns']
    const patch = args['patch']
    if (typeof ns !== 'string' || ns.length === 0) {
      return failed(request.id, new Error('settings.update requires a string "ns"'))
    }
    if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
      return failed(request.id, new Error('settings.update requires an object "patch"'))
    }
    const revision = typeof args['expectedRevision'] === 'number' ? args['expectedRevision'] : undefined
    await settings.update(ns, patch, revision)
    return ok(request.id, { ns, updated: true })
  }

  return unavailable(request.id, `unknown seam operation: ${request.op}`)
}

async function dispatchPlugins(agentCtx: Context | undefined, request: SeamRequest): Promise<SeamResponse> {
  const inventory = serviceOf(agentCtx, 'pluginInventory')
  if (inventory === undefined) return unavailable(request.id, 'ctx.pluginInventory is not mounted for this agent')
  const snapshot = asRecord(await inventory.list())
  const entries = Array.isArray(snapshot['entries']) ? snapshot['entries'] : []
  return ok(request.id, {
    managementAvailable: snapshot['managementAvailable'] === true,
    entries: entries.map((entry) => {
      const record = asRecord(entry)
      const meta = asRecord(record['meta'])
      const name = stringOf(meta, 'name')
      const group = stringOf(meta, 'group')
      return {
        id: record['entryId'] ?? null,
        module: stringOf(record, 'moduleName') ?? null,
        ...name !== undefined ? { name } : {},
        ...group !== undefined ? { group } : {},
        enabled: record['enabled'] === true,
        phase: record['fiberPhase'] ?? null,
      }
    }),
  })
}

async function dispatchModels(agentCtx: Context | undefined, request: SeamRequest): Promise<SeamResponse> {
  const llm = serviceOf(agentCtx, 'llm')
  if (llm === undefined) return unavailable(request.id, 'ctx.llm is not mounted for this agent')
  const args = (request.args ?? {}) as Record<string, unknown>

  if (request.op === 'models.providers') {
    return ok(request.id, llm.listProviders().map((entry) => {
      const record = asRecord(entry)
      return { id: stringOf(record, 'id') ?? null, name: stringOf(record, 'name') ?? null }
    }))
  }

  if (request.op === 'models.list') {
    const provider = args['provider']
    if (typeof provider !== 'string' || provider.length === 0) {
      return failed(request.id, new Error('models.list requires a string "provider"'))
    }
    const models = await llm.listModels(provider)
    return ok(request.id, models.map((entry) => {
      const record = asRecord(entry)
      const description = stringOf(record, 'description')
      return {
        id: stringOf(record, 'id') ?? null,
        name: stringOf(record, 'name') ?? null,
        ...description !== undefined ? { description } : {},
      }
    }))
  }

  return unavailable(request.id, `unknown seam operation: ${request.op}`)
}

function dispatchWorkspaces(agentCtx: Context | undefined, request: SeamRequest): SeamResponse {
  const registry = serviceOf(agentCtx, 'workspaceRegistry')
  if (registry === undefined) return unavailable(request.id, 'ctx.workspaceRegistry is not mounted for this agent')
  return ok(request.id, registry.list().map((entry) => {
    const record = asRecord(entry)
    const name = stringOf(record, 'name')
    return {
      id: stringOf(record, 'id') ?? null,
      path: stringOf(record, 'path') ?? null,
      ...name !== undefined ? { name } : {},
      ...record['status'] !== undefined ? { status: record['status'] } : {},
    }
  }))
}

function dispatchJobs(
  agentCtx: Context | undefined,
  agent: KernelAgent | undefined,
  request: SeamRequest,
): SeamResponse {
  const jobs = serviceOf(agentCtx, 'jobs')
  if (jobs === undefined) return unavailable(request.id, 'ctx.jobs is not mounted for this agent')
  const caller = owningSessionId(agent)
  return ok(request.id, jobs.list(caller).map((entry) => {
    const record = asRecord(entry)
    return {
      id: stringOf(record, 'id') ?? null,
      kind: stringOf(record, 'kind') ?? null,
      label: stringOf(record, 'label') ?? null,
      state: stringOf(record, 'state', 'status') ?? null,
      ...stringOf(record, 'sessionId') !== undefined ? { sessionId: stringOf(record, 'sessionId') } : {},
    }
  }))
}

async function dispatchSchedules(
  agentCtx: Context | undefined,
  agent: KernelAgent | undefined,
  request: SeamRequest,
): Promise<SeamResponse> {
  const schedule = serviceOf(agentCtx, 'schedule')
  if (schedule === undefined) return unavailable(request.id, 'ctx.schedule is not mounted for this agent')
  const sessionId = owningSessionId(agent)
  if (sessionId === undefined) return unavailable(request.id, 'this cell has no owning session to list schedules for')
  const records = await schedule.list({ sessionId })
  return ok(request.id, records.map(entry => entry))
}

function dispatchContext(
  agentCtx: Context | undefined,
  agent: KernelAgent | undefined,
  request: SeamRequest,
): SeamResponse {
  const meter = serviceOf(agentCtx, 'tokenMeter')
  const sessions = serviceOf(agentCtx, 'sessions')
  const sessionId = owningSessionId(agent)
  if (meter === undefined || sessions === undefined || sessionId === undefined) {
    return unavailable(request.id, 'ctx.tokenMeter/ctx.sessions or an owning session is missing for this cell')
  }
  const session = sessions.get(sessionId)
  if (session === undefined) return unavailable(request.id, 'the owning session is no longer in the live registry')
  const measurement = asRecord(meter.measure(session))
  const baseline = asRecord(measurement['baseline'])
  return ok(request.id, {
    sessionId,
    logRevision: numberOf(measurement, 'logRevision') ?? null,
    surfaceDeltaTokens: numberOf(measurement, 'surfaceDeltaTokens') ?? null,
    baseline: {
      ...stringOf(baseline, 'kind') !== undefined ? { kind: stringOf(baseline, 'kind') } : {},
      ...numberOf(baseline, 'tokens') !== undefined ? { tokens: numberOf(baseline, 'tokens') } : {},
    },
  })
}

async function dispatchPresets(
  agentCtx: Context | undefined,
  agent: KernelAgent | undefined,
  request: SeamRequest,
): Promise<SeamResponse> {
  const presets = serviceOf(agentCtx, 'agentPresets')
  if (presets === undefined) return unavailable(request.id, 'ctx.agentPresets is not mounted for this agent')

  if (request.op === 'presets.current') {
    const header = asRecord((agent as { session?: { header?: unknown } } | undefined)?.session?.header)
    const composed = agentCtx === undefined ? undefined : presets.composedPreset(agentCtx)
    return ok(request.id, {
      preset: stringOf(header, 'agentPreset') ?? null,
      ...composed !== undefined ? { composed } : {},
    })
  }

  if (request.op === 'presets.list') {
    return ok(request.id, await presets.compositionInventory())
  }

  return unavailable(request.id, `unknown seam operation: ${request.op}`)
}

function dispatchProjections(
  agentCtx: Context | undefined,
  agent: KernelAgent | undefined,
  request: SeamRequest,
  args: Record<string, unknown>,
): SeamResponse {
  const projections = serviceOf(agentCtx, 'sessionProjections')
  const sessions = serviceOf(agentCtx, 'sessions')
  if (projections === undefined || sessions === undefined) {
    return unavailable(request.id, 'ctx.sessionProjections is not mounted for this agent')
  }
  const sessionId = requestedSessionId(args, agent)
  if (sessionId === undefined) return unavailable(request.id, 'no session id was given and this cell has no owning session')
  const session = sessions.get(sessionId)
  if (session === undefined) {
    return unavailable(request.id, `session ${sessionId} is not live, so its projections cannot be read here`)
  }
  const keys = Array.isArray(args['keys'])
    ? args['keys'].filter((key): key is string => typeof key === 'string')
    : undefined
  const snapshot = asRecord(projections.snapshot(session, keys))
  return ok(request.id, snapshot)
}

/** How many tool schemas one search returns before the answer stops growing. */
const TOOL_SEARCH_LIMIT = 25

function dispatchToolSearch(
  agentCtx: Context | undefined,
  request: SeamRequest,
  args: Record<string, unknown>,
): SeamResponse {
  const tools = serviceOf(agentCtx, 'tools')
  if (tools === undefined) return unavailable(request.id, 'ctx.tools is not mounted for this agent')
  const query = typeof args['query'] === 'string' ? args['query'].toLowerCase() : ''
  const limit = typeof args['limit'] === 'number' && Number.isFinite(args['limit']) && args['limit'] > 0
    ? Math.min(Math.floor(args['limit']), 200)
    : TOOL_SEARCH_LIMIT
  const schemas = tools.schemas(typeof args['scope'] === 'string' ? args['scope'] : undefined)
  const matched = schemas
    .map(entry => asRecord(entry))
    .filter((record) => {
      if (query === '') return true
      const name = (stringOf(record, 'name') ?? '').toLowerCase()
      const description = (stringOf(record, 'description') ?? '').toLowerCase()
      return name.includes(query) || description.includes(query)
    })
  return ok(request.id, {
    total: matched.length,
    tools: matched.slice(0, limit).map(record => ({
      name: stringOf(record, 'name') ?? null,
      description: stringOf(record, 'description') ?? '',
      parameters: record['parameters'] ?? null,
    })),
  })
}

function dispatchTerminals(
  agentCtx: Context | undefined,
  agent: KernelAgent | undefined,
  request: SeamRequest,
): SeamResponse {
  const terminals = serviceOf(agentCtx, 'terminals')
  if (terminals === undefined) return unavailable(request.id, 'ctx.terminals is not mounted for this agent')
  if (agent === undefined) return unavailable(request.id, 'no owning agent is available for this cell')
  return ok(request.id, terminals.list(agent).map((entry) => {
    const record = asRecord(entry)
    const name = stringOf(record, 'name')
    const pid = numberOf(record, 'pid')
    return {
      id: stringOf(record, 'sessionId', 'id') ?? null,
      type: stringOf(record, 'type') ?? null,
      status: stringOf(record, 'status') ?? null,
      ...name !== undefined ? { name } : {},
      ...pid !== undefined ? { pid } : {},
    }
  }))
}

async function dispatchPrompt(
  agentCtx: Context | undefined,
  request: SeamRequest,
  args: Record<string, unknown>,
): Promise<SeamResponse> {
  const prompt = serviceOf(agentCtx, 'systemPrompt')
  if (prompt === undefined) return unavailable(request.id, 'ctx.systemPrompt is not mounted for this agent')
  const assembly = await prompt.assemble()
  const full = args['full'] === true
  const sections = (Array.isArray(assembly.sections) ? assembly.sections : []).map((entry) => {
    const record = asRecord(entry)
    const text = stringOf(record, 'text') ?? ''
    const name = stringOf(record, 'name', 'id') ?? null
    return full ? { name, chars: text.length, text } : { name, chars: text.length }
  })
  const total = sections.reduce((sum, section) => sum + section.chars, 0)
  return ok(request.id, { total, sections })
}

/**
 * The loader off one context, read through the service store.
 *
 * `get` is typed as a statement in this cordis build, so the read happens inside a
 * function rather than in the middle of an expression.
 * @param ctx - the dispatch context.
 * @returns the loader, or undefined when this deployment mounts none.
 */
function loaderOf(ctx: Context): unknown {
  return ctx.get('loader' as never)
}

/**
 * Why a composed row failed, which the plugin inventory reports only as a phase.
 *
 * `pluginInventory.list()` answers with a phase, and a failed row without its error
 * is the worst of both: Settings shows a row that says "failed" and says nothing
 * about what to fix. The error lives on the row's fiber, so this reads the loader's
 * own tree through the root context and reports each failure with its message.
 * @param agentCtx - the agent-scoped context a cell runs with.
 * @param request - the request to answer.
 * @returns each failed row's id and the message it raised, or why none is reachable.
 */
function dispatchPluginFailures(agentCtx: Context | undefined, request: SeamRequest): SeamResponse {
  // The loader is a service, so the strict read is `ctx.get`: the property proxy
  // refuses it on an agent's context and the root context does not carry it either.
  const loader = asRecord(agentCtx === undefined ? undefined : loaderOf(agentCtx))
  const list = loader['entries']
  const entries: Iterable<[unknown, unknown]> | undefined = typeof list === 'function'
    ? (list as () => Iterable<[unknown, unknown]>).call(loader)
    : list instanceof Map ? list : undefined
  if (entries === undefined) {
    return unavailable(request.id, 'the loader is not mounted in this deployment')
  }
  const failures: { id: string; error: string }[] = []
  for (const [id, entry] of entries) {
    // A failed fiber keeps its error on `_error`; the inventory reports only a phase,
    // which is why a row could say "failed" and nothing else.
    const error = asRecord(asRecord(entry)['fiber'])['_error']
    if (error === undefined || error === null) continue
    failures.push({
      id: typeof id === 'string' ? id : JSON.stringify(id),
      // A thrown value need not be an Error: name what it is rather than its
      // default stringification, which would read `[object Object]`.
      error: error instanceof Error ? error.message : `${typeof error}: ${JSON.stringify(error)}`,
    })
  }
  return ok(request.id, failures)
}

function dispatchStorage(agentCtx: Context | undefined, request: SeamRequest): SeamResponse {
  const storage = serviceOf(agentCtx, 'storage')
  if (storage === undefined) return unavailable(request.id, 'ctx.storage is not mounted for this agent')
  return ok(request.id, { backends: [...storage.backends.names()] })
}

function dispatchSessionsTitle(
  agentCtx: Context | undefined,
  agent: KernelAgent | undefined,
  request: SeamRequest,
  args: Record<string, unknown>,
): SeamResponse {
  const titles = serviceOf(agentCtx, 'sessionTitle')
  const sessions = serviceOf(agentCtx, 'sessions')
  if (titles === undefined || sessions === undefined) {
    return unavailable(request.id, 'ctx.sessionTitle is not mounted for this agent')
  }
  const sessionId = requestedSessionId(args, agent)
  if (sessionId === undefined) return unavailable(request.id, 'no session id was given and this cell has no owning session')
  const session = sessions.get(sessionId)
  if (session === undefined) return unavailable(request.id, `session ${sessionId} is not live, so it carries no title here`)
  const snapshot = asRecord(titles.get(session))
  if (Object.keys(snapshot).length === 0) return ok(request.id, null)
  return ok(request.id, {
    sessionId,
    title: stringOf(snapshot, 'title', 'text') ?? null,
    ...numberOf(snapshot, 'updatedAt') !== undefined ? { updatedAt: numberOf(snapshot, 'updatedAt') } : {},
  })
}
