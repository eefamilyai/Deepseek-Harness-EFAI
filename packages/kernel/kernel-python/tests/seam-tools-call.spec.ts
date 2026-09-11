/**
 * `tools.call` — the kernel's door onto the harness tool registry.
 *
 * Before this op existed the kernel could READ the tool inventory
 * (`tools.schemas`, `tools.get`) but execute nothing, so Python code was
 * limited to the handful of hand-written local helpers. These tests pin the
 * contract that makes the general door correct:
 *
 *  - the call goes through `ctx.tools.execute`, so every registry stage
 *    (pre-execute policy, approval, guards, post-execute, output validation)
 *    applies exactly as it does to a model-issued call;
 *  - the canonical lossless-JSON value comes back as `value`, and the
 *    model-facing `content` alongside it;
 *  - a failed call is reported as a failure, never as a successful empty
 *    result — the distinction the Python side turns into `ToolCallError`.
 *
 * The owning Agent arrives as `dispatchSeam`'s explicit second argument, never
 * read off the scoped `Context`: `Context` carries no reverse Agent property,
 * and a property read that resolves in no fiber's store throws rather than
 * returning undefined.
 */
import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { KernelAgent } from '@deepseek-ai/dsh-kernel'
import { dispatchSeam } from '../src/seam.ts'
import type { SeamRequest } from '../src/seam.ts'

/**
 * The one argument every `ctx.tools.execute` stand-in receives. Typing it is
 * what makes `mock.calls[0]?.[0]` a real element rather than an empty-tuple
 * index, so the assertions below can read the fields without a cast.
 */
interface ExecArg {
  readonly callId?: unknown
  readonly name?: unknown
  readonly arguments?: unknown
  readonly agent?: unknown
  readonly signal?: AbortSignal
}

/** A request envelope for `tools.call` with a fixed correlation id. */
function callRequest(name: unknown, args?: unknown): SeamRequest {
  return { id: 'req-1', op: 'tools.call', args: { name, arguments: args } }
}

/** A ctx whose `ctx.tools` is the supplied stand-in. */
function ctxWithTools(tools: unknown): Context {
  return { tools } as unknown as Context
}

/** A successful registry outcome for `value`. */
function okResult(value: unknown, meta?: unknown) {
  return {
    isError: false as const,
    value,
    content: [{ type: 'text', text: 'rendered' }],
    ...meta !== undefined ? { meta } : {},
  }
}

/** A `ctx.tools.execute` stand-in that always resolves with `value`. */
function executeReturning(value: unknown, meta?: unknown) {
  return vi.fn(async (_exec: ExecArg) => okResult(value, meta))
}

describe('dispatchSeam tools.call', () => {
  it('executes through ctx.tools.execute and returns the canonical value', async () => {
    const execute = executeReturning({ rows: 2 })
    const response = await dispatchSeam(ctxWithTools({ execute }), undefined, callRequest('db_query', { sql: 'select 1' }))

    expect(response).toEqual({
      id: 'req-1',
      ok: true,
      value: { isError: false, value: { rows: 2 }, content: [{ type: 'text', text: 'rendered' }] },
    })
    // The registry is the ONLY path: a tool's own `execute` must not be reached
    // directly, or every policy stage in front of it would be skipped.
    expect(execute).toHaveBeenCalledTimes(1)
    const exec = execute.mock.calls[0]?.[0]
    expect(exec?.name).toBe('db_query')
    expect(exec?.arguments).toEqual({ sql: 'select 1' })
    // A call id the registry can log and derive a root id from.
    expect(typeof exec?.callId).toBe('string')
    expect((exec?.callId as string).startsWith('kernel:')).toBe(true)
  })

  it('carries cancellation through, never leaving the registry without a signal', async () => {
    const execute = executeReturning(1)
    const controller = new AbortController()
    await dispatchSeam(ctxWithTools({ execute }), undefined, callRequest('t'), controller.signal)
    expect(execute.mock.calls[0]?.[0]?.signal).toBe(controller.signal)

    // With no caller signal the registry still receives a real, usable one:
    // `undefined` would make the fuse in `createExecution` throw.
    execute.mockClear()
    await dispatchSeam(ctxWithTools({ execute }), undefined, callRequest('t'))
    const bare = execute.mock.calls[0]?.[0]?.signal
    expect(bare).toBeInstanceOf(AbortSignal)
    expect(bare?.aborted).toBe(false)
  })

  it('defaults arguments to an empty object so a no-argument tool stays callable', async () => {
    const execute = executeReturning(null)
    await dispatchSeam(ctxWithTools({ execute }), undefined, { id: 'r', op: 'tools.call', args: { name: 'ping' } })
    expect(execute.mock.calls[0]?.[0]?.arguments).toEqual({})
  })

  it('reports a failed call as a failure, preserving the model-facing text and code', async () => {
    const execute = vi.fn(async (_exec: ExecArg) => ({
      isError: true as const,
      content: [{ type: 'text', text: 'permission denied by policy' }],
      error: { message: 'denied', info: { name: 'HarnessError', code: 'DENIED' } },
    }))
    const response = await dispatchSeam(ctxWithTools({ execute }), undefined, callRequest('danger'))

    expect(response.ok).toBe(true)
    expect(response.value).toEqual({
      isError: true,
      content: [{ type: 'text', text: 'permission denied by policy' }],
      error: { message: 'denied', info: { name: 'HarnessError', code: 'DENIED' } },
    })
    // `value` must be absent on failure: Python raises rather than returning it.
    expect(response.value as Record<string, unknown>).not.toHaveProperty('value')
  })

  it('forwards presentation metadata when the tool supplies it', async () => {
    const execute = executeReturning({ n: 1 }, { diff: '+x' })
    const response = await dispatchSeam(ctxWithTools({ execute }), undefined, callRequest('edit'))
    expect((response.value as { meta?: unknown }).meta).toEqual({ diff: '+x' })
  })

  it('fails loudly on a missing or empty name instead of calling something unnamed', async () => {
    const execute = executeReturning(1)
    for (const bad of [undefined, null, '', 42]) {
      const response = await dispatchSeam(ctxWithTools({ execute }), undefined, callRequest(bad))
      expect(response.ok).toBe(false)
      expect(response.error).toContain('"name"')
    }
    expect(execute).not.toHaveBeenCalled()
  })

  it('reports an unmounted registry as unavailable so Python degrades explicitly', async () => {
    const response = await dispatchSeam({} as unknown as Context, undefined, callRequest('read'))
    expect(response).toEqual({
      id: 'req-1',
      ok: false,
      unavailable: true,
      error: 'ctx.tools is not mounted for this agent',
    })
  })

  it('turns a throwing registry into a reportable error, never a silent success', async () => {
    const execute = vi.fn(async (_exec: ExecArg) => { throw new Error('registry exploded') })
    const response = await dispatchSeam(ctxWithTools({ execute }), undefined, callRequest('read'))
    expect(response.ok).toBe(false)
    expect(response.error).toBe('registry exploded')
  })

  it('passes the calling agent so scoped policy sees the real caller', async () => {
    const execute = executeReturning(1)
    const agent: KernelAgent = { id: 'session-a', session: { id: 'session-a' } }
    await dispatchSeam(ctxWithTools({ execute }), agent, callRequest('read'))
    expect(execute.mock.calls[0]?.[0]?.agent).toBe(agent)
  })

  it('takes the agent from the argument, never from a reverse Context property', async () => {
    // The regression this pins: the seam once read `ctx.agent`, which the
    // Context property proxy throws on rather than answering — the whole cell
    // died with `cannot get property "agent" without inject`. A Context that
    // happens to carry an `agent` field must not be consulted at all.
    const execute = executeReturning(1)
    const explicit: KernelAgent = { id: 'explicit', session: { id: 'explicit' } }
    const decoy = { id: 'decoy', session: { id: 'decoy' } }
    await dispatchSeam(
      { tools: { execute }, agent: decoy } as unknown as Context,
      explicit,
      callRequest('read'),
    )
    expect(execute.mock.calls[0]?.[0]?.agent).toBe(explicit)
  })

  it('omits the agent entirely when the cell has no owner', async () => {
    const execute = executeReturning(1)
    await dispatchSeam(ctxWithTools({ execute }), undefined, callRequest('read'))
    // Absent, not `undefined`: the registry distinguishes the two.
    expect(execute.mock.calls[0]?.[0]).not.toHaveProperty('agent')
  })

  it('leaves the read-only ops on their existing contract', async () => {
    const schemas = vi.fn(() => [{ name: 'read', description: 'r', parameters: {} }])
    const get = vi.fn(() => undefined)
    const ctx = ctxWithTools({ execute: vi.fn(), schemas, get })

    const listed = await dispatchSeam(ctx, undefined, { id: 'a', op: 'tools.schemas', args: {} })
    expect(listed.value).toEqual([{ name: 'read', description: 'r', parameters: {} }])

    const missing = await dispatchSeam(ctx, undefined, { id: 'b', op: 'tools.get', args: { name: 'nope' } })
    expect(missing).toEqual({ id: 'b', ok: true, value: null })
  })
})
