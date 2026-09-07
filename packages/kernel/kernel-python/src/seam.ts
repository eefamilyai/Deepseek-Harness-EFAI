/**
 * Kiln-side deep bridge: dispatch seam requests from the Python kernel onto the
 * harness's real capability seams reached through the per-agent scoped context.
 *
 * This module is an EXTERNAL consumer of the harness seams. It mirrors only the
 * method signatures the kernel actually calls (read verbatim from the seam
 * Service Definitions) and feature-detects each at runtime; it never
 * re-implements a seam. A missing seam or a seam error becomes an
 * `unavailable`/`error` response so the Python helper falls back to its local
 * implementation — the kernel revolves around the harness, but degrades to
 * standalone when a seam is not mounted.
 *
 * Nothing in the harness core is imported or edited: the agent-scoped
 * `Context` arrives over `KernelExecuteRequest.agentCtx`, and the seams on it
 * are reached by their runtime `ctx.<name>` properties.
 *
 * @module @deepseek-ai/dsh-kernel-python/seam
 */

import type { Context } from '@deepseek-ai/cordis'

/** One Python→TS seam request, decoded from a `seam` frame. */
export interface SeamRequest {
  readonly id: string
  readonly op: string
  readonly args: unknown
}

/** The TS→Python seam response. `ok` value xor `error`/`unavailable`. */
export interface SeamResponse {
  /** The request id this answers, echoed so the Python side can correlate it. */
  readonly id?: string
  readonly ok: boolean
  readonly value?: unknown
  readonly error?: string
  readonly unavailable?: boolean
}

/** Filesystem shapes the kernel consumes, mirrored from `packages/fs/fs/src/types.ts`. */
interface FsTarget { readonly targetKey: unknown; readonly displayPath: string }
interface FsEditRequest { readonly oldString: string; readonly newString: string; readonly replaceAll: boolean }
interface FileSystemSeam {
  resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget>
  readText(target: FsTarget, signal?: AbortSignal): Promise<string>
  writeText(target: FsTarget, content: string, expected?: unknown, signal?: AbortSignal): Promise<unknown>
  editText(target: FsTarget, edit: FsEditRequest, expected?: unknown, signal?: AbortSignal): Promise<unknown>
  listDir(target: FsTarget, signal?: AbortSignal): Promise<readonly unknown[]>
}

/** Shell shapes the kernel consumes, mirrored from `packages/shell/shell/src/types.ts`. */
interface ShellExecRequest {
  command: string
  workdir?: string | undefined
  timeoutMs?: number | undefined
  signal?: AbortSignal | undefined
}
interface CollectedOutputShape {
  text: string
  truncated: boolean
  spillPath?: string
}
interface ShellRunSpec { command: string }
interface ShellRunResultShape {
  exitCode: number | null
  signal: NodeJS.Signals | null
  timedOut: boolean
  aborted: boolean
  timeoutMs: number
  stdout: CollectedOutputShape
  stderr: CollectedOutputShape
}
interface ShellExecutorSeam {
  resolve(request: ShellExecRequest): ShellRunSpec
  run(spec: ShellRunSpec): Promise<ShellRunResultShape>
}

function fsOf(ctx: Context | undefined): FileSystemSeam | undefined {
  if (ctx === undefined) return undefined
  const c = (ctx as Context & { fs?: unknown }).fs
  return c === undefined || c === null ? undefined : c as FileSystemSeam
}

function shellOf(ctx: Context | undefined): ShellExecutorSeam | undefined {
  if (ctx === undefined) return undefined
  const c = (ctx as Context & { shell?: unknown }).shell
  return c === undefined || c === null ? undefined : c as ShellExecutorSeam
}

/** Web shapes the kernel consumes, mirrored from `packages/web/web/src/types.ts`. */
interface WebSearchSourceShape { readonly url: string; readonly title?: string; readonly snippet?: string }
interface WebSearchResultShape {
  readonly content?: string
  readonly sources: readonly WebSearchSourceShape[]
  readonly truncated: boolean
}
interface WebFetchResultShape {
  readonly url: string
  readonly statusCode: number
  readonly body: { readonly kind: 'html' | 'text'; readonly content: string }
  readonly truncated: boolean
}
interface WebRuntimeSeam {
  search(request: { query: string; maxResults?: number }, signal?: AbortSignal): Promise<WebSearchResultShape>
  fetch(request: { url: string }, signal?: AbortSignal): Promise<WebFetchResultShape>
}

function webOf(ctx: Context | undefined): WebRuntimeSeam | undefined {
  if (ctx === undefined) return undefined
  const c = (ctx as Context & { web?: unknown }).web
  return c === undefined || c === null ? undefined : c as WebRuntimeSeam
}

function toValue(value: unknown): unknown {
  if (value === undefined || value === null) return null
  try { return JSON.parse(JSON.stringify(value)) } catch { return JSON.stringify(value) }
}

function ok(id: string, value: unknown): SeamResponse {
  return { id, ok: true, value: toValue(value) }
}
function unavailable(id: string, reason: string): SeamResponse {
  return { id, ok: false, unavailable: true, error: reason }
}
function failed(id: string, error: unknown): SeamResponse {
  return { id, ok: false, error: error instanceof Error ? error.message : String(error) }
}

function asArgs(args: unknown): Record<string, unknown> {
  return (args ?? {}) as Record<string, unknown>
}

/** Subagent shapes the kernel consumes, mirrored from `packages/subagent/subagent/src/types.ts`. */
interface SubagentContentBlockShape { readonly type: string; readonly text?: string }
interface SubagentRunResultShape {
  readonly output: readonly SubagentContentBlockShape[]
  readonly structured?: unknown
  readonly stopReason: string
}
interface SubagentRunShape {
  readonly id: unknown
  readonly result: Promise<SubagentRunResultShape>
  dispose(): Promise<void>
}
interface SubagentStartRequestShape {
  readonly label?: string
  readonly prompt: readonly SubagentContentBlockShape[]
  readonly parent: unknown
  readonly signal: AbortSignal
  readonly maxDepth?: number
  readonly toolFilter?: unknown
  readonly persona?: string
}
interface SubagentRuntimeSeamShape {
  list(): string[]
  start(name: string, request: SubagentStartRequestShape): Promise<SubagentRunShape>
  listChildren(parentSessionId: unknown, signal?: AbortSignal): Promise<readonly unknown[]>
  listDescendants(rootSessionId: unknown, signal?: AbortSignal): Promise<readonly unknown[]>
}

function subagentsOf(ctx: Context | undefined): SubagentRuntimeSeamShape | undefined {
  if (ctx === undefined) return undefined
  const c = (ctx as Context & { subagents?: unknown }).subagents
  return c === undefined || c === null ? undefined : c as SubagentRuntimeSeamShape
}

/** Goal shapes the kernel consumes, mirrored from `packages/goal/goal/src/types.ts`. */
interface GoalRefShape { readonly id: unknown; readonly revision: number }
interface GoalViewShape {
  readonly id: unknown
  readonly revision: number
  readonly objective: string
  readonly phase: string
  readonly blockedReason?: { readonly code: string; readonly message: string }
  readonly maxGoalRounds: number
  readonly roundsStarted: number
  readonly createdAt: number
  readonly updatedAt: number
  readonly activation: string
}
interface GoalsSeamShape {
  get(agent: unknown): GoalViewShape | undefined
  disarm(agent: unknown): GoalViewShape | undefined
  create(agent: unknown, request: { objective: string; maxGoalRounds?: number }): GoalViewShape
  edit(agent: unknown, ref: GoalRefShape, request: { objective?: string; maxGoalRounds?: number }): GoalViewShape
  pause(agent: unknown, ref: GoalRefShape): GoalViewShape
  resume(agent: unknown, ref: GoalRefShape): GoalViewShape
  complete(agent: unknown, ref: GoalRefShape): GoalViewShape
  block(agent: unknown, ref: GoalRefShape, reason: { code: string; message: string }): GoalViewShape
  clear(agent: unknown, ref: GoalRefShape): GoalRefShape
}

function goalsOf(ctx: Context | undefined): GoalsSeamShape | undefined {
  if (ctx === undefined) return undefined
  const c = (ctx as Context & { goals?: unknown }).goals
  return c === undefined || c === null ? undefined : c as GoalsSeamShape
}

function currentAgent(ctx: Context | undefined): unknown {
  return (ctx as Context & { agent?: unknown }).agent
}

/** Tool registry shapes the kernel consumes, mirrored from `packages/core/tools/src/index.ts`. */
interface ToolSchemaShape { readonly name: string; readonly description: string; readonly parameters: Record<string, unknown> }
interface ToolsSeamShape {
  schemas(scope?: unknown): ToolSchemaShape[]
  get(name: string, scope?: unknown): ToolSchemaShape | undefined
}

function toolsOf(ctx: Context | undefined): ToolsSeamShape | undefined {
  if (ctx === undefined) return undefined
  const c = (ctx as Context & { tools?: unknown }).tools
  return c === undefined || c === null ? undefined : c as ToolsSeamShape
}

/** Session shapes the kernel consumes, mirrored from `packages/core/session/src/types.ts`. */
interface SessionHeaderShape {
  readonly id: unknown
  readonly createdAt: number
  readonly cwd?: string
  readonly parentSession?: unknown
  readonly origin?: string
}
interface SessionShape { readonly id: unknown; readonly header: SessionHeaderShape }
interface SessionsSeamShape {
  list(): SessionShape[]
  get(id: unknown): SessionShape | undefined
}

function sessionsOf(ctx: Context | undefined): SessionsSeamShape | undefined {
  if (ctx === undefined) return undefined
  const c = (ctx as Context & { sessions?: unknown }).sessions
  return c === undefined || c === null ? undefined : c as SessionsSeamShape
}

function projectSessionHeader(header: SessionHeaderShape): SessionHeaderShape {
  return {
    id: header.id,
    createdAt: header.createdAt,
    ...header.cwd !== undefined ? { cwd: header.cwd } : {},
    ...header.parentSession !== undefined ? { parentSession: header.parentSession } : {},
    ...header.origin !== undefined ? { origin: header.origin } : {},
  }
}

/** Skill shapes the kernel consumes, mirrored from `packages/skill/skill/src/index.ts`. */
interface SkillSummaryShape { readonly name: string; readonly description: string; readonly whenToUse?: string }
interface SkillDefinitionShape extends SkillSummaryShape {
  readonly content: string
  readonly path?: string
}
interface SkillLookupShape { readonly cwd?: string; readonly signal?: AbortSignal }
interface SkillsSeamShape {
  list(options?: SkillLookupShape): Promise<SkillSummaryShape[]>
  get(name: string, options?: SkillLookupShape): Promise<SkillDefinitionShape | undefined>
}

function skillsOf(ctx: Context | undefined): SkillsSeamShape | undefined {
  if (ctx === undefined) return undefined
  const c = (ctx as Context & { skills?: unknown }).skills
  return c === undefined || c === null ? undefined : c as SkillsSeamShape
}

/** Subprocess shapes the kernel consumes, mirrored from `packages/subprocess/subprocess/src/types.ts`. */
interface SubprocessCollectShape { readonly maxBytes: number }
interface SubprocessReaderShape {
  readFrom(fromByte: number): { readonly text: string; readonly lossy: boolean; readonly spillPath?: string }
}
interface SubprocessHandleShape {
  readonly done: Promise<{ readonly exitCode: number | null; readonly signal: string | null }>
  readonly collected: {
    readonly stdout?: SubprocessReaderShape
    readonly stderr?: SubprocessReaderShape
  }
}
interface SubprocessSpawnSpecShape {
  readonly argv: readonly string[]
  readonly cwd: string
  readonly stdio: {
    readonly stdin: 'ignore' | { readonly data: string }
    readonly stdout: SubprocessCollectShape
    readonly stderr: SubprocessCollectShape
  }
  readonly graceMs: number
  readonly signal: AbortSignal
  readonly env?: Readonly<Record<string, string>>
}
interface SubprocessSeamShape {
  resolveExecutable(command: string, env?: Readonly<Record<string, string>>, signal?: AbortSignal): Promise<string>
  spawn(spec: SubprocessSpawnSpecShape): SubprocessHandleShape
}

function subprocessOf(ctx: Context | undefined): SubprocessSeamShape | undefined {
  if (ctx === undefined) return undefined
  const c = (ctx as Context & { subprocess?: unknown }).subprocess
  return c === undefined || c === null ? undefined : c as SubprocessSeamShape
}

/** Dispatch one seam request against the current cell's agent-scoped ctx. */
export async function dispatchSeam(
  agentCtx: Context | undefined,
  request: SeamRequest,
  signal?: AbortSignal,
): Promise<SeamResponse> {
  if (request.op.startsWith('fs.')) return dispatchFs(agentCtx, request, signal)
  if (request.op === 'shell.run') return dispatchShell(agentCtx, request, signal)
  if (request.op === 'web.search' || request.op === 'web.fetch') return dispatchWeb(agentCtx, request, signal)
  if (request.op.startsWith('subagents.')) return dispatchSubagents(agentCtx, request, signal)
  if (request.op.startsWith('goals.')) return dispatchGoals(agentCtx, request, signal)
  if (request.op.startsWith('rlm.')) return dispatchRlm(agentCtx, request, signal)
  if (request.op.startsWith('tools.')) return dispatchTools(agentCtx, request)
  if (request.op.startsWith('sessions.')) return dispatchSessions(agentCtx, request)
  if (request.op.startsWith('skills.')) return dispatchSkills(agentCtx, request, signal)
  if (request.op.startsWith('subprocess.')) return dispatchSubprocess(agentCtx, request, signal)
  return unavailable(request.id, `unknown seam operation: ${request.op}`)
}

async function dispatchFs(
  agentCtx: Context | undefined,
  request: SeamRequest,
  signal?: AbortSignal,
): Promise<SeamResponse> {
  const fs = fsOf(agentCtx)
  if (fs === undefined) return unavailable(request.id, 'ctx.fs is not mounted for this agent')
  const args = asArgs(request.args)
  const path = typeof args.path === 'string' ? args.path : undefined
  if (path === undefined) return failed(request.id, new Error(`fs.${request.op} requires a string "path" argument`))
  try {
    const target = await fs.resolve(path, signal !== undefined ? { signal } : undefined)
    switch (request.op) {
      case 'fs.readText':
        return ok(request.id, await fs.readText(target, signal))
      case 'fs.writeText':
        return ok(request.id, await fs.writeText(target, typeof args.content === 'string' ? args.content : '', undefined, signal))
      case 'fs.editText': {
        const oldString = typeof args.old === 'string' ? args.old : undefined
        const newString = typeof args.new === 'string' ? args.new : undefined
        if (oldString === undefined || newString === undefined) {
          return failed(request.id, new Error('fs.editText requires string "old" and "new" arguments'))
        }
        return ok(request.id, await fs.editText(target, { oldString, newString, replaceAll: false }, undefined, signal))
      }
      case 'fs.listDir':
        return ok(request.id, await fs.listDir(target, signal))
      default:
        return unavailable(request.id, `unknown seam operation: ${request.op}`)
    }
  } catch (error) {
    return failed(request.id, error)
  }
}

async function dispatchWeb(
  agentCtx: Context | undefined,
  request: SeamRequest,
  signal?: AbortSignal,
): Promise<SeamResponse> {
  const web = webOf(agentCtx)
  if (web === undefined) return unavailable(request.id, 'ctx.web is not mounted for this agent')
  const args = asArgs(request.args)
  try {
    if (request.op === 'web.search') {
      const query = typeof args.query === 'string' ? args.query : undefined
      if (query === undefined) return failed(request.id, new Error('web.search requires a string "query" argument'))
      const maxResults = typeof args.limit === 'number' ? args.limit : undefined
      const result = await web.search({ query, ...maxResults !== undefined ? { maxResults } : {} }, signal)
      return ok(request.id, { sources: result.sources, content: result.content, truncated: result.truncated })
    }
    const url = typeof args.url === 'string' ? args.url : undefined
    if (url === undefined) return failed(request.id, new Error('web.fetch requires a string "url" argument'))
    const result = await web.fetch({ url }, signal)
    return ok(request.id, { url: result.url, statusCode: result.statusCode, body: result.body, truncated: result.truncated })
  } catch (error) {
    return failed(request.id, error)
  }
}

async function dispatchShell(
  agentCtx: Context | undefined,
  request: SeamRequest,
  signal?: AbortSignal,
): Promise<SeamResponse> {
  const shell = shellOf(agentCtx)
  if (shell === undefined) return unavailable(request.id, 'ctx.shell is not mounted for this agent')
  const args = asArgs(request.args)
  const command = typeof args.command === 'string' ? args.command : undefined
  if (command === undefined) return failed(request.id, new Error('shell.run requires a string "command" argument'))
  const timeoutMs = typeof args.timeoutMs === 'number' ? args.timeoutMs : undefined
  try {
    const spec = shell.resolve({
      command,
      ...timeoutMs !== undefined ? { timeoutMs } : {},
      ...signal !== undefined ? { signal } : {},
    })
    const result = await shell.run(spec)
    return ok(request.id, {
      exitCode: result.exitCode,
      signal: result.signal,
      timedOut: result.timedOut,
      aborted: result.aborted,
      timeoutMs: result.timeoutMs,
      stdout: result.stdout.text,
      stderr: result.stderr.text,
      truncated: result.stdout.truncated || result.stderr.truncated,
    })
  } catch (error) {
    return failed(request.id, error)
  }
}

async function dispatchSubagents(
  agentCtx: Context | undefined,
  request: SeamRequest,
  signal?: AbortSignal,
): Promise<SeamResponse> {
  const subagents = subagentsOf(agentCtx)
  if (subagents === undefined) return unavailable(request.id, 'ctx.subagents is not mounted for this agent')
  const args = asArgs(request.args)
  if (request.op === 'subagents.list') {
    return ok(request.id, subagents.list())
  }
  // Children/descendants discovery resolves the current agent's own session id.
  if (request.op === 'subagents.children' || request.op === 'subagents.descendants') {
    const parent = (agentCtx as Context & { agent?: unknown }).agent
    const sessionId = (parent as { session?: { id?: unknown } } | undefined)?.session?.id
    if (sessionId === undefined) return unavailable(request.id, 'ctx.agent.session is not available for this agent')
    try {
      const items = request.op === 'subagents.children'
        ? await subagents.listChildren(sessionId, signal)
        : await subagents.listDescendants(sessionId, signal)
      return ok(request.id, items)
    } catch (error) {
      return failed(request.id, error)
    }
  }
  if (request.op !== 'subagents.start') return unavailable(request.id, `unknown seam operation: ${request.op}`)
  const prompt = typeof args.prompt === 'string' ? args.prompt : undefined
  if (prompt === undefined) return failed(request.id, new Error('subagents.start requires a string "prompt" argument'))
  const parent = (agentCtx as Context & { agent?: unknown }).agent
  if (parent === undefined || parent === null) {
    return unavailable(request.id, 'ctx.agent is not available for this agent')
  }
  let provider = typeof args.provider === 'string' && args.provider.length > 0 ? args.provider : undefined
  if (provider === undefined) {
    const names = subagents.list()
    if (names.length === 0) return unavailable(request.id, 'no subagent provider is registered')
    provider = names[0]
  }
  if (provider === undefined) return unavailable(request.id, 'no subagent provider is registered')
  try {
    const run = await subagents.start(provider, {
      prompt: [{ type: 'text', text: prompt }],
      parent,
      signal: signal ?? new AbortController().signal,
      ...typeof args.label === 'string' && args.label.length > 0 ? { label: args.label } : {},
      ...typeof args.maxDepth === 'number' ? { maxDepth: args.maxDepth } : {},
    })
    try {
      const result = await run.result
      const text = result.output
        .filter((block): block is SubagentContentBlockShape & { type: 'text'; text: string } => block.type === 'text' && typeof block.text === 'string')
        .map(block => block.text)
        .join('')
      return ok(request.id, { id: run.id, stopReason: result.stopReason, text, structured: result.structured })
    } finally {
      await run.dispose()
    }
  } catch (error) {
    return failed(request.id, error)
  }
}

async function dispatchRlm(
  agentCtx: Context | undefined,
  request: SeamRequest,
  signal?: AbortSignal,
): Promise<SeamResponse> {
  const args = asArgs(request.args)
  if (request.op === 'rlm.answer') {
    // The `answer`/`ready` variable lives in the Python kernel; this seam only
    // confirms the RLM facet is mounted so the kernel never hard-blocks on it.
    return ok(request.id, { mounted: true })
  }
  if (request.op !== 'rlm.llm_batch') return unavailable(request.id, `unknown seam operation: ${request.op}`)
  const subagents = subagentsOf(agentCtx)
  if (subagents === undefined) return unavailable(request.id, 'ctx.subagents is not mounted for this agent')
  const parent = (agentCtx as Context & { agent?: unknown }).agent
  if (parent === undefined || parent === null) return unavailable(request.id, 'ctx.agent is not available for this agent')
  const prompts = Array.isArray(args.prompts)
    ? args.prompts.filter((entry): entry is string => typeof entry === 'string')
    : []
  if (prompts.length === 0) return failed(request.id, new Error('rlm.llm_batch requires a non-empty array of string "prompts"'))
  const names = subagents.list()
  if (names.length === 0) return unavailable(request.id, 'no subagent provider is registered')
  const provider = typeof args.provider === 'string' && args.provider.length > 0 ? args.provider : names[0]
  if (provider === undefined) return unavailable(request.id, 'no subagent provider is registered')
  const sig = signal ?? new AbortController().signal
  try {
    const results = await Promise.all(prompts.map(async (prompt) => {
      const run = await subagents.start(provider, {
        prompt: [{ type: 'text', text: prompt }],
        parent,
        signal: sig,
      })
      try {
        const result = await run.result
        return result.output
          .filter((block): block is SubagentContentBlockShape & { type: 'text'; text: string } => block.type === 'text' && typeof block.text === 'string')
          .map(block => block.text)
          .join('')
      } finally {
        await run.dispose()
      }
    }))
    return ok(request.id, { results })
  } catch (error) {
    return failed(request.id, error)
  }
}

function dispatchGoals(
  agentCtx: Context | undefined,
  request: SeamRequest,
  signal?: AbortSignal,
): SeamResponse {
  void signal
  const goals = goalsOf(agentCtx)
  if (goals === undefined) return unavailable(request.id, 'ctx.goals is not mounted for this agent')
  const agent = currentAgent(agentCtx)
  if (agent === undefined || agent === null) return unavailable(request.id, 'ctx.agent is not available for this agent')
  const args = asArgs(request.args)

  if (request.op === 'goals.get' || request.op === 'goals.disarm') {
    const view = request.op === 'goals.get' ? goals.get(agent) : goals.disarm(agent)
    return ok(request.id, view ?? null)
  }

  if (request.op === 'goals.create') {
    const objective = typeof args.objective === 'string' ? args.objective : undefined
    if (objective === undefined) return failed(request.id, new Error('goals.create requires a string "objective" argument'))
    try {
      return ok(request.id, goals.create(agent, {
        objective,
        ...typeof args.maxGoalRounds === 'number' ? { maxGoalRounds: args.maxGoalRounds } : {},
      }))
    } catch (error) {
      return failed(request.id, error)
    }
  }

  const id = (args as { id?: unknown }).id
  const revision = typeof (args as { revision?: unknown }).revision === 'number' ? (args as { revision?: number }).revision : undefined
  if (id === undefined || revision === undefined) {
    return failed(request.id, new Error(`${request.op} requires "id" and "revision" arguments`))
  }
  const ref: GoalRefShape = { id, revision }

  try {
    switch (request.op) {
      case 'goals.edit': {
        const edit: { objective?: string; maxGoalRounds?: number } = {}
        if (typeof args.objective === 'string') edit.objective = args.objective
        if (typeof args.maxGoalRounds === 'number') edit.maxGoalRounds = args.maxGoalRounds
        return ok(request.id, goals.edit(agent, ref, edit))
      }
      case 'goals.pause':
        return ok(request.id, goals.pause(agent, ref))
      case 'goals.resume':
        return ok(request.id, goals.resume(agent, ref))
      case 'goals.complete':
        return ok(request.id, goals.complete(agent, ref))
      case 'goals.block': {
        const code = typeof args.code === 'string' ? args.code : undefined
        const message = typeof args.message === 'string' ? args.message : undefined
        if (code === undefined || message === undefined) {
          return failed(request.id, new Error('goals.block requires "code" and "message" string arguments'))
        }
        return ok(request.id, goals.block(agent, ref, { code, message }))
      }
      case 'goals.clear':
        return ok(request.id, goals.clear(agent, ref))
      default:
        return unavailable(request.id, `unknown seam operation: ${request.op}`)
    }
  } catch (error) {
    return failed(request.id, error)
  }
}

function dispatchTools(agentCtx: Context | undefined, request: SeamRequest): SeamResponse {
  const tools = toolsOf(agentCtx)
  if (tools === undefined) return unavailable(request.id, 'ctx.tools is not mounted for this agent')
  const args = asArgs(request.args)

  if (request.op === 'tools.schemas') {
    try {
      const schemas = tools.schemas(typeof args.scope === 'string' ? args.scope : undefined)
      return ok(request.id, schemas.map(({ name, description, parameters }) => ({ name, description, parameters })))
    } catch (error) {
      return failed(request.id, error)
    }
  }

  if (request.op === 'tools.get') {
    const name = typeof args.name === 'string' ? args.name : undefined
    if (name === undefined) return failed(request.id, new Error('tools.get requires a string "name" argument'))
    try {
      const definition = tools.get(name, typeof args.scope === 'string' ? args.scope : undefined)
      if (definition === undefined) return ok(request.id, null)
      return ok(request.id, { name: definition.name, description: definition.description, parameters: definition.parameters })
    } catch (error) {
      return failed(request.id, error)
    }
  }

  return unavailable(request.id, `unknown seam operation: ${request.op}`)
}

function dispatchSessions(agentCtx: Context | undefined, request: SeamRequest): SeamResponse {
  const sessions = sessionsOf(agentCtx)
  if (sessions === undefined) return unavailable(request.id, 'ctx.sessions is not mounted for this agent')
  const args = asArgs(request.args)
  try {
    if (request.op === 'sessions.list') {
      return ok(request.id, sessions.list().map(s => ({ id: s.id, header: projectSessionHeader(s.header) })))
    }
    if (request.op === 'sessions.get') {
      const id = (args as { id?: unknown }).id
      if (id === undefined) return failed(request.id, new Error('sessions.get requires an "id" argument'))
      const session = sessions.get(id)
      if (session === undefined) return ok(request.id, null)
      return ok(request.id, { id: session.id, header: projectSessionHeader(session.header) })
    }
    return unavailable(request.id, `unknown seam operation: ${request.op}`)
  } catch (error) {
    return failed(request.id, error)
  }
}

async function dispatchSkills(
  agentCtx: Context | undefined,
  request: SeamRequest,
  signal?: AbortSignal,
): Promise<SeamResponse> {
  const skills = skillsOf(agentCtx)
  if (skills === undefined) return unavailable(request.id, 'ctx.skills is not mounted for this agent')
  const args = asArgs(request.args)
  const options: SkillLookupShape = signal !== undefined ? { signal } : {}
  try {
    if (request.op === 'skills.list') {
      const summaries = await skills.list(options)
      return ok(request.id, summaries.map(s => ({ name: s.name, description: s.description })))
    }
    if (request.op === 'skills.get') {
      const name = typeof args.name === 'string' ? args.name : undefined
      if (name === undefined) return failed(request.id, new Error('skills.get requires a string "name" argument'))
      const definition = await skills.get(name, options)
      if (definition === undefined) return ok(request.id, null)
      return ok(request.id, {
        name: definition.name,
        description: definition.description,
        content: definition.content,
        ...definition.path !== undefined ? { path: definition.path } : {},
      })
    }
    return unavailable(request.id, `unknown seam operation: ${request.op}`)
  } catch (error) {
    return failed(request.id, error)
  }
}

async function dispatchSubprocess(
  agentCtx: Context | undefined,
  request: SeamRequest,
  signal?: AbortSignal,
): Promise<SeamResponse> {
  const subprocess = subprocessOf(agentCtx)
  if (subprocess === undefined) return unavailable(request.id, 'ctx.subprocess is not mounted for this agent')
  const args = asArgs(request.args)

  if (request.op === 'subprocess.resolve') {
    const command = typeof args.command === 'string' ? args.command : undefined
    if (command === undefined) return failed(request.id, new Error('subprocess.resolve requires a string "command"'))
    const env = typeof args.env === 'object' && args.env !== null ? args.env as Record<string, string> : undefined
    try {
      return ok(request.id, await subprocess.resolveExecutable(command, env, signal))
    } catch (error) {
      return failed(request.id, error)
    }
  }

  if (request.op !== 'subprocess.run') return unavailable(request.id, `unknown seam operation: ${request.op}`)
  const argv = Array.isArray(args.argv) ? args.argv.filter((v): v is string => typeof v === 'string') : undefined
  if (argv === undefined || argv.length === 0) {
    return failed(request.id, new Error('subprocess.run requires a non-empty string[] "argv"'))
  }
  const cwd = typeof args.cwd === 'string' ? args.cwd : undefined
  if (cwd === undefined) return failed(request.id, new Error('subprocess.run requires a string "cwd"'))
  const input = typeof args.input === 'string' ? args.input : undefined
  const maxBytes = typeof args.maxBytes === 'number' && args.maxBytes > 0 ? args.maxBytes : 1024 * 1024
  const graceMs = typeof args.graceMs === 'number' && args.graceMs > 0 ? args.graceMs : 10000
  const env = typeof args.env === 'object' && args.env !== null ? args.env as Record<string, string> : undefined
  const timeoutMs = typeof args.timeoutMs === 'number' && args.timeoutMs > 0 ? args.timeoutMs : undefined

  const controller = new AbortController()
  const onAbort = (): void => { controller.abort() }
  signal?.addEventListener('abort', onAbort, { once: true })
  const timer = timeoutMs !== undefined ? setTimeout(() => { controller.abort() }, timeoutMs) : undefined
  try {
    const handle = subprocess.spawn({
      argv,
      cwd,
      stdio: {
        stdin: input !== undefined ? { data: input } : 'ignore',
        stdout: { maxBytes },
        stderr: { maxBytes },
      },
      graceMs,
      signal: controller.signal,
      ...env !== undefined ? { env } : {},
    })
    const outcome = await handle.done
    const stdout = handle.collected.stdout?.readFrom(0)
    const stderr = handle.collected.stderr?.readFrom(0)
    return ok(request.id, {
      exitCode: outcome.exitCode,
      signal: outcome.signal,
      stdout: stdout?.text ?? '',
      stderr: stderr?.text ?? '',
      stdoutTruncated: stdout?.lossy ?? false,
      stderrTruncated: stderr?.lossy ?? false,
      ...stdout?.spillPath !== undefined ? { stdoutSpillPath: stdout.spillPath } : {},
      ...stderr?.spillPath !== undefined ? { stderrSpillPath: stderr.spillPath } : {},
    })
  } catch (error) {
    return failed(request.id, error)
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}
