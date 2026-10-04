/**
 * The harness-observation ops — what the kernel can see of the harness itself.
 *
 * Before this family existed a cell could act on the harness (files, shell, web,
 * subagents, tools) but barely read it: the whole of that was `sessions.list` and
 * `sessions.get` off the live registry. These tests pin the properties that make the
 * wider family trustworthy:
 *
 *  - every op answers `unavailable` when its service is not mounted, so a cell in a
 *    deployment without (say) `ctx.sessionQuery` degrades instead of throwing;
 *  - session history is read through `ctx.sessionQuery`, never the synchronous
 *    `Session` readers that new production code may not call;
 *  - a service that throws becomes `ok: false` with its message, never a silent empty
 *    result;
 *  - `seam.ops` lists every op the dispatcher answers, so the table a cell discovers is
 *    the table that exists.
 */
import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { KernelAgent } from '@deepseek-ai/dsh-kernel'
import { HARNESS_OPS, dispatchHarness } from '../src/seam-harness.ts'
import { CAPABILITY_OPS, dispatchSeam } from '../src/seam.ts'
import type { SeamRequest, SeamResponse } from '../src/seam.ts'

/** A request envelope for one op with a fixed correlation id. */
function request(op: string, args?: unknown): SeamRequest {
  return { id: 'req-1', op, args: args ?? {} }
}

/** A context whose named services are the supplied stand-ins. */
function ctxWith(services: Record<string, unknown>): Context {
  return services as unknown as Context
}

/** A cell owner, keyed by session id. */
function agentOwning(id: string): KernelAgent {
  return { id, session: { id, header: { agentPreset: 'standard' } } } as unknown as KernelAgent
}

/** Dispatch one op and await its response. */
async function run(op: string, ctx: Context | undefined, agent?: KernelAgent, args?: unknown): Promise<SeamResponse> {
  return await dispatchHarness(ctx, agent, request(op, args), undefined)
}

/** The `value` of a response that must have succeeded. */
function valueOf(response: SeamResponse): unknown {
  expect(response.ok, response.error ?? 'expected ok').toBe(true)
  return response.value
}

describe('seam.ops', () => {
  it('lists both tables, and every op in them answers something other than "unknown op"', async () => {
    // The catalog is what a cell discovers the bridge with, so it has to cover the
    // capability seams a cell acts through as well as the observation family: a list
    // that stopped at half the bridge would send a cell looking for a capability that
    // is already there.
    const response = await dispatchSeam(undefined, undefined, request('seam.ops'))
    const catalog = valueOf(response) as readonly { op: string }[]
    expect(catalog.length).toBe(CAPABILITY_OPS.length + HARNESS_OPS.length)
    for (const entry of ['shell.run', 'tools.call', 'goals.block', 'sessions.events', 'storage.backends']) {
      expect(catalog.map(row => row.op)).toContain(entry)
    }
    for (const entry of catalog) {
      const answered = await dispatchSeam(undefined, undefined, request(entry.op))
      expect(answered.error ?? '', `${entry.op} is not routed`).not.toContain('unknown seam operation')
    }
  })

  it('names every op exactly once', async () => {
    const catalog = valueOf(await dispatchSeam(undefined, undefined, request('seam.ops'))) as readonly { op: string }[]
    const names = catalog.map(entry => entry.op)
    expect(new Set(names).size).toBe(names.length)
  })

  it('names an unknown op instead of answering it', async () => {
    const response = await run('nope.nothing', undefined)
    expect(response.unavailable).toBe(true)
    expect(response.error).toContain('unknown seam operation: nope.nothing')
  })

  it('reports a service that throws as a failure with its message', async () => {
    const response = await run('agents.list', ctxWith({
      agents: { list: () => { throw new Error('registry exploded') }, roots: () => [], currentInitiator: () => undefined },
    }))
    expect(response.ok).toBe(false)
    expect(response.error).toBe('registry exploded')
  })
})

describe('agents', () => {
  it('is unavailable without ctx.agents', async () => {
    const response = await run('agents.list', undefined)
    expect(response.unavailable).toBe(true)
    expect(response.error).toContain('ctx.agents')
  })

  it('marks the roots and the dispatching agent', async () => {
    const ctx = ctxWith({
      agents: {
        list: () => [{ id: 'root' }, { id: 'child' }, {}],
        roots: () => [{ id: 'root' }],
        currentInitiator: () => ({ id: 'child' }),
      },
    })
    expect(valueOf(await run('agents.list', ctx, agentOwning('child')))).toEqual([
      { id: 'root', root: true, current: false },
      { id: 'child', root: false, current: true },
      { id: 'unknown', root: false, current: false },
    ])
    expect(valueOf(await run('agents.current', ctx))).toEqual({ id: 'child' })
  })

  it('answers null when no agent is the current initiator', async () => {
    const ctx = ctxWith({ agents: { list: () => [], roots: () => [], currentInitiator: () => undefined } })
    expect(valueOf(await run('agents.current', ctx))).toBeNull()
  })
})

describe('sessions', () => {
  it('reads the live registry for identity', async () => {
    const ctx = ctxWith({
      sessions: {
        list: () => [{ id: 'a', header: { id: 'a', createdAt: 5, cwd: 'C:\\w', origin: 'chat', extra: true } }],
        get: (id: unknown) => id === 'a' ? { id: 'a', header: { id: 'a', createdAt: 5 } } : undefined,
      },
    })
    expect(valueOf(await run('sessions.list', ctx))).toEqual([
      { id: 'a', header: { id: 'a', createdAt: 5, cwd: 'C:\\w', origin: 'chat' } },
    ])
    expect(valueOf(await run('sessions.get', ctx, undefined, { id: 'a' }))).toEqual({ id: 'a', header: { id: 'a', createdAt: 5 } })
    expect(valueOf(await run('sessions.get', ctx, undefined, { id: 'zz' }))).toBeNull()
  })

  it('requires an id for sessions.get and reports a missing registry', async () => {
    const noId = await run('sessions.get', ctxWith({ sessions: { list: () => [], get: () => undefined } }))
    expect(noId.ok).toBe(false)
    expect(noId.error).toContain('requires an "id"')
    const missing = await run('sessions.list', undefined)
    expect(missing.unavailable).toBe(true)
    expect(missing.error).toContain('ctx.sessions')
  })

  it('reads the corpus through sessionQuery', async () => {
    const ctx = ctxWith({
      sessionQuery: {
        listSessions: async () => [
          { header: { id: 'a', createdAt: 1, cwd: '/w', agentPreset: 'standard' }, live: true, persisted: true },
          { header: { id: 'b', createdAt: 2 }, live: false, persisted: true },
        ],
      },
    })
    expect(valueOf(await run('sessions.corpus', ctx))).toEqual([
      { id: 'a', live: true, persisted: true, cwd: '/w', createdAt: 1, agentPreset: 'standard' },
      { id: 'b', live: false, persisted: true, createdAt: 2 },
    ])
  })

  it('is unavailable without ctx.sessionQuery', async () => {
    const response = await run('sessions.events', ctxWith({ sessions: { list: () => [], get: () => undefined } }), agentOwning('a'))
    expect(response.unavailable).toBe(true)
    expect(response.error).toContain('ctx.sessionQuery')
  })

  it('needs a session id when the cell has no owner', async () => {
    const response = await run('sessions.events', ctxWith({ sessionQuery: {} }))
    expect(response.unavailable).toBe(true)
    expect(response.error).toContain('no session id')
  })

  it('returns the newest events, filtered and bounded', async () => {
    const events = [
      { seq: 0, type: 'turn/start', time: 1, data: {} },
      { seq: 1, type: 'assistant/message', time: 2, data: { message: { content: [{ type: 'text', text: 'hello there' }] } } },
      { seq: 2, type: 'tool/call', time: 3, data: { name: 'kernel' } },
      { seq: 3, type: 'session/title', time: 4, data: { title: 'A title' } },
      { seq: 4, type: 'unknown/thing', time: 5, data: {} },
    ]
    const ctx = ctxWith({ sessionQuery: { listEvents: async () => events } })
    const value = valueOf(await run('sessions.events', ctx, agentOwning('own'), { limit: 2 })) as {
      sessionId: string
      total: number
      events: readonly Record<string, unknown>[]
    }
    expect(value.sessionId).toBe('own')
    expect(value.total).toBe(5)
    expect(value.events.map(event => event.seq)).toEqual([4, 3])
    expect(value.events.map(event => event.summary)).toEqual([undefined, `title ${JSON.stringify('A title')}`])

    const filtered = valueOf(await run('sessions.events', ctx, agentOwning('own'), { type: 'tool/call' })) as {
      total: number
      events: readonly Record<string, unknown>[]
    }
    expect(filtered.total).toBe(1)
    expect(filtered.events[0]).toMatchObject({ seq: 2, type: 'tool/call', summary: 'tool kernel' })

    const texted = valueOf(await run('sessions.events', ctx, agentOwning('own'), { type: 'assistant/message', limit: 0 })) as {
      events: readonly Record<string, unknown>[]
    }
    expect(texted.events[0]?.summary).toBe(JSON.stringify('hello there'))
  })

  it('returns the newest tail of the model surface', async () => {
    const ctx = ctxWith({
      sessionQuery: {
        readSurface: async () => ({ events: [{ seq: 0, type: 'a', time: 1, data: {} }, { seq: 1, type: 'b', time: 2, data: {} }] }),
      },
    })
    const value = valueOf(await run('sessions.surface', ctx, agentOwning('own'), { limit: 1 })) as {
      total: number
      events: readonly Record<string, unknown>[]
    }
    expect(value.total).toBe(2)
    expect(value.events.map(event => event.seq)).toEqual([1])
  })

  it('reads a window around one seq', async () => {
    const ctx = ctxWith({
      sessionQuery: {
        readEvent: async (ask: { seq: number; before?: number; after?: number }) => {
          expect(ask).toEqual({ sessionId: 'own', seq: 7, before: 2, after: 3 })
          return { events: [{ seq: 7, type: 'tool/result', time: 9, data: {} }] }
        },
      },
    })
    const value = valueOf(await run('sessions.window', ctx, agentOwning('own'), { seq: 7, before: 2, after: 3 })) as {
      events: readonly Record<string, unknown>[]
    }
    expect(value.events[0]).toMatchObject({ seq: 7, type: 'tool/result' })

    const missing = await run('sessions.window', ctx, agentOwning('own'), {})
    expect(missing.ok).toBe(false)
    expect(missing.error).toContain('numeric "seq"')
  })

  it('traces lineage to ids', async () => {
    const ctx = ctxWith({
      sessionQuery: {
        traceSession: async () => ({
          ancestors: [{ id: 'p' }, { session: { id: 'q' } }],
          descendants: [{ id: 'c' }],
          complete: true,
          root: { id: 'p' },
        }),
      },
    })
    expect(valueOf(await run('sessions.trace', ctx, agentOwning('own')))).toEqual({
      sessionId: 'own', ancestors: ['p', 'q'], descendants: ['c'], complete: true, root: 'p',
    })
  })

  it('answers an unknown session op', async () => {
    const response = await run('sessions.bogus', ctxWith({ sessionQuery: {} }), agentOwning('own'))
    expect(response.error).toContain('unknown seam operation')
  })
})

describe('settings', () => {
  it('is unavailable without ctx.settings', async () => {
    expect((await run('settings.describe', undefined)).unavailable).toBe(true)
  })

  it('describes namespaces, keeping the user layer and redacted secrets', async () => {
    const ctx = ctxWith({
      settings: {
        describe: () => [
          { ns: 'kernel-python', revision: 3, value: { browserWindow: true }, user: { browserWindow: true }, secrets: [{ key: 'token' }], schema: {} },
          { ns: 'other', revision: 1, value: {} },
        ],
      },
    })
    expect(valueOf(await run('settings.describe', ctx))).toEqual([
      { ns: 'kernel-python', revision: 3, value: { browserWindow: true }, user: { browserWindow: true }, secrets: [{ key: 'token' }] },
      { ns: 'other', revision: 1, value: {} },
    ])
  })

  it('validates an update and forwards the expected revision', async () => {
    const update = vi.fn(async () => {})
    const ctx = ctxWith({ settings: { describe: () => [], update } })
    expect(valueOf(await run('settings.update', ctx, undefined, { ns: 'kernel-python', patch: { a: 1 }, expectedRevision: 2 })))
      .toEqual({ ns: 'kernel-python', updated: true })
    expect(update).toHaveBeenCalledWith('kernel-python', { a: 1 }, 2)

    const noNs = await run('settings.update', ctx, undefined, { patch: {} })
    expect(noNs.error).toContain('"ns"')
    const badPatch = await run('settings.update', ctx, undefined, { ns: 'x', patch: [] })
    expect(badPatch.error).toContain('object "patch"')
    const missingPatch = await run('settings.update', ctx, undefined, { ns: 'x' })
    expect(missingPatch.error).toContain('object "patch"')
    expect((await run('settings.nope', ctx)).error).toContain('unknown seam operation')
  })
})

describe('plugins, models, workspaces', () => {
  it('lists loader rows with their local metadata', async () => {
    const ctx = ctxWith({
      pluginInventory: {
        list: async () => ({
          managementAvailable: true,
          entries: [
            { entryId: 'llm-polish', moduleName: '@deepseek-ai/dsh-llm-markdown-fidelity', enabled: true, fiberPhase: 'active', meta: { name: 'Markdown fidelity', group: 'LLM' } },
            { entryId: 'bare', moduleName: 'x', enabled: false, fiberPhase: 'pending' },
          ],
        }),
      },
    })
    expect(valueOf(await run('plugins.list', ctx))).toEqual({
      managementAvailable: true,
      entries: [
        { id: 'llm-polish', module: '@deepseek-ai/dsh-llm-markdown-fidelity', name: 'Markdown fidelity', group: 'LLM', enabled: true, phase: 'active' },
        { id: 'bare', module: 'x', enabled: false, phase: 'pending' },
      ],
    })
    expect((await run('plugins.list', undefined)).unavailable).toBe(true)
  })

  it('lists providers and their models', async () => {
    const ctx = ctxWith({
      llm: {
        listProviders: () => [{ id: 'kiln', name: 'Kiln' }, { name: 'no id' }],
        listModels: async (provider: string) => provider === 'kiln'
          ? [{ id: 'deepseek', name: 'DeepSeek', description: 'free web' }, {}]
          : [],
      },
    })
    expect(valueOf(await run('models.providers', ctx))).toEqual([{ id: 'kiln', name: 'Kiln' }, { id: null, name: 'no id' }])
    expect(valueOf(await run('models.list', ctx, undefined, { provider: 'kiln' }))).toEqual([
      { id: 'deepseek', name: 'DeepSeek', description: 'free web' },
      { id: null, name: null },
    ])
    expect((await run('models.list', ctx, undefined, {})).error).toContain('"provider"')
    expect((await run('models.nope', ctx)).error).toContain('unknown seam operation')
    expect((await run('models.providers', undefined)).unavailable).toBe(true)
  })

  it('lists the storage backends this deployment registered', async () => {
    const ctx = ctxWith({ storage: { backends: { names: () => ['session-jsonl', 'session-projcache'] } } })
    expect(valueOf(await run('storage.backends', ctx))).toEqual({ backends: ['session-jsonl', 'session-projcache'] })
    expect((await run('storage.backends', undefined)).unavailable).toBe(true)
  })

  it('lists workspaces', async () => {
    const ctx = ctxWith({
      workspaceRegistry: { list: () => [{ id: 'w1', path: 'C:\\w', name: 'Work', status: 'ready' }, { path: '/x' }] },
    })
    expect(valueOf(await run('workspaces.list', ctx))).toEqual([
      { id: 'w1', path: 'C:\\w', name: 'Work', status: 'ready' },
      { id: null, path: '/x' },
    ])
    expect((await run('workspaces.list', undefined)).unavailable).toBe(true)
  })
})

describe('jobs, schedules, context', () => {
  it('lists this session\'s jobs', async () => {
    const list = vi.fn((caller?: string) => [{ id: 'shell-1', kind: 'shell', label: 'run tests', state: 'running', sessionId: caller }])
    const ctx = ctxWith({ jobs: { list } })
    expect(valueOf(await run('jobs.list', ctx, agentOwning('own')))).toEqual([
      { id: 'shell-1', kind: 'shell', label: 'run tests', state: 'running', sessionId: 'own' },
    ])
    expect(list).toHaveBeenCalledWith('own')
    expect((await run('jobs.list', undefined)).unavailable).toBe(true)
  })

  it('lists this session\'s scheduled tasks', async () => {
    const list = vi.fn(async (ask: { sessionId: string }) => [{ id: 's1', sessionId: ask.sessionId }])
    const ctx = ctxWith({ schedule: { list } })
    expect(valueOf(await run('schedules.list', ctx, agentOwning('own')))).toEqual([{ id: 's1', sessionId: 'own' }])
    expect((await run('schedules.list', ctx)).unavailable).toBe(true)
    expect((await run('schedules.list', undefined)).unavailable).toBe(true)
  })

  it('reports token accounting for the owning session', async () => {
    const ctx = ctxWith({
      sessions: { list: () => [], get: () => ({ id: 'own' }) },
      tokenMeter: { measure: () => ({ logRevision: 42, surfaceDeltaTokens: -7, baseline: { kind: 'provider', tokens: 1000 } }) },
    })
    expect(valueOf(await run('context.state', ctx, agentOwning('own')))).toEqual({
      sessionId: 'own', logRevision: 42, surfaceDeltaTokens: -7, baseline: { kind: 'provider', tokens: 1000 },
    })

    const noMeter = ctxWith({ sessions: { list: () => [], get: () => ({ id: 'own' }) } })
    expect((await run('context.state', noMeter, agentOwning('own'))).unavailable).toBe(true)
    const noSession = ctxWith({
      sessions: { list: () => [], get: () => undefined },
      tokenMeter: { measure: () => ({}) },
    })
    expect((await run('context.state', noSession, agentOwning('own'))).error).toContain('no longer in the live registry')
    expect((await run('context.state', ctx)).unavailable).toBe(true)
  })
})

describe('presets and projections', () => {
  it('names the preset this session runs under', async () => {
    const ctx = ctxWith({
      agentPresets: { compositionInventory: async () => [{ preset: 'standard' }], composedPreset: () => 'standard+efai' },
    })
    expect(valueOf(await run('presets.current', ctx, agentOwning('own')))).toEqual({ preset: 'standard', composed: 'standard+efai' })
    expect(valueOf(await run('presets.list', ctx))).toEqual([{ preset: 'standard' }])
    expect((await run('presets.nope', ctx)).error).toContain('unknown seam operation')
    expect((await run('presets.current', undefined)).unavailable).toBe(true)
  })

  it('answers a preset with no composed context and no header fields', async () => {
    const ctx = ctxWith({ agentPresets: { compositionInventory: async () => [], composedPreset: () => undefined } })
    expect(valueOf(await run('presets.current', ctx, { id: 'x' } as unknown as KernelAgent))).toEqual({ preset: null })
  })

  it('reads projections for a live session only', async () => {
    const snapshot = vi.fn((_session: unknown, keys?: readonly string[]) => ({ tokenUsage: { total: 5 }, keys }))
    const ctx = ctxWith({
      sessions: { list: () => [], get: () => ({ id: 'own' }) },
      sessionProjections: { snapshot },
    })
    expect(valueOf(await run('projections.read', ctx, agentOwning('own'), { keys: ['tokenUsage', 7] })))
      .toEqual({ tokenUsage: { total: 5 }, keys: ['tokenUsage'] })

    const notLive = ctxWith({ sessions: { list: () => [], get: () => undefined }, sessionProjections: { snapshot } })
    expect((await run('projections.read', notLive, agentOwning('own'))).error).toContain('not live')
    expect((await run('projections.read', ctx)).error).toContain('no session id')
    expect((await run('projections.read', undefined)).unavailable).toBe(true)
  })
})
