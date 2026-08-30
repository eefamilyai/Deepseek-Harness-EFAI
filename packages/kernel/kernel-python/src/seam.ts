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
