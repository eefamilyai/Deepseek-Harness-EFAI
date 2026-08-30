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

/** The filesystem shapes the kernel consumes, mirrored from `packages/fs/fs/src/types.ts`. */
interface FsTarget { readonly targetKey: unknown; readonly displayPath: string }
interface FsEditRequest { readonly oldString: string; readonly newString: string; readonly replaceAll: boolean }
interface FileSystemSeam {
  resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget>
  readText(target: FsTarget, signal?: AbortSignal): Promise<string>
  writeText(target: FsTarget, content: string, expected?: unknown, signal?: AbortSignal): Promise<unknown>
  editText(target: FsTarget, edit: FsEditRequest, expected?: unknown, signal?: AbortSignal): Promise<unknown>
  listDir(target: FsTarget, signal?: AbortSignal): Promise<readonly unknown[]>
}

function fsOf(ctx: Context | undefined): FileSystemSeam | undefined {
  if (ctx === undefined) return undefined
  const c = (ctx as Context & { fs?: unknown }).fs
  return c === undefined || c === null ? undefined : c as FileSystemSeam
}

function toValue(value: unknown): unknown {
  if (value === undefined || value === null) return null
  try { return JSON.parse(JSON.stringify(value)) } catch { return JSON.stringify(value) }
}

function ok(id: string, value: unknown): SeamResponse { return { id, ok: true, value: toValue(value) } }
function unavailable(id: string, reason: string): SeamResponse {
  return { id, ok: false, unavailable: true, error: reason }
}
function failed(id: string, error: unknown): SeamResponse {
  return { id, ok: false, error: error instanceof Error ? error.message : String(error) }
}

/** Dispatch one seam request against the current cell's agent-scoped ctx (Phase 1: fs.*). */
export async function dispatchSeam(
  agentCtx: Context | undefined,
  request: SeamRequest,
  signal?: AbortSignal,
): Promise<SeamResponse> {
  const fs = fsOf(agentCtx)
  if (fs === undefined) return unavailable(request.id, 'ctx.fs is not mounted for this agent')
  const args = (request.args ?? {}) as Record<string, unknown>
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
