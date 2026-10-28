/**
 * The runtime roster: visibility, the prompt/execution pair, and the turn
 * boundary that holds a change back.
 *
 * The three properties worth pinning are the ones a reader cannot check by
 * inspection: that the two category switches are genuinely independent, that
 * filtering the assembled prompt and refusing to execute agree on every name,
 * and that a settings change does not reach the model mid-turn.
 */
import { Context } from '@deepseek-ai/cordis'
import { createScope, scopeOf } from '@deepseek-ai/dsh-scope'
import type { Scope } from '@deepseek-ai/dsh-scope'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { liveConfig } from '../../../settings/settings/tests/live-config.ts'
import {
  Config,
  apply,
  hiddenToolNames,
  resolveRoster,
  sameRoster,
  sectionHidden,
  toolVisible,
} from '../src/index.ts'

const signal = new AbortController().signal

/** A stand-in subject: the roster is global and ignores which agent stopped. */
const subject = {} as Agent

/** A minimal registrable tool. */
function tool(name: string, reply = `ran:${name}`): ToolDefinition {
  return {
    name,
    description: `tool ${name}`,
    parameters: { type: 'object', properties: {} },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value as string }],
    },
    execute: () => Promise.resolve(reply),
  }
}

/** Execute one tool and return its text, or the denial reason. */
async function run(ctx: Context, name: string): Promise<string> {
  const batch = await ctx.tools.execute({ calls: [{ type: 'tool-call', id: ToolCallId('c1'), name, arguments: '{}' }], signal })
  const settled = batch.results[0]?.result
  if (settled === undefined) throw new Error('the batch settled no result for the single call')
  const first = settled.content[0]
  return first?.type === 'text' ? first.text : JSON.stringify(settled.content)
}

/**
 * Mount the roster behind a Loader over real tools and prompt services, so an
 * edit travels the same path a Settings write does.
 */
async function mount(initial: Record<string, unknown> = {}) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  ctx.tools.register(tool('read'))
  ctx.tools.register(tool('bash'))
  ctx.tools.register(tool('kernel', 'ran:kernel'))
  const live = await liveConfig(ctx, { name: 'tool-roster', apply, Config }, initial)
  return { ctx, live }
}

/** One assembled prompt, as the model would receive it. */
async function assemble(ctx: Context): Promise<{ tools: string[]; sections: string[] }> {
  const assembly = await ctx.systemPrompt.assemble({})
  return {
    tools: assembly.tools.map(entry => entry.name),
    sections: assembly.sections.map(entry => entry.name),
  }
}

describe('the per-tool map is learned from what an agent is offered', () => {
  /**
   * The Tools page renders one switch per entry of `tools`, so the entries have to
   * exist before the page can offer them. `ctx.tools.schemas()` reads the global
   * view and misses every agent-scoped registration, which is why the list comes
   * from the assembled prompt instead.
   */
  it('records every assembled tool as enabled, except the ones no switch governs', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt, {})
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(NativeToolExecutor)
    ctx.tools.register(tool('read'))
    ctx.tools.register(tool('bash'))
    ctx.tools.register(tool('kernel'))
    const writes: { ns: string; ops: { path: string[]; value: unknown }[] }[] = []
    const mutate = (ns: string, ops: { path: string[]; value: unknown }[]): Promise<void> => {
      writes.push({ ns, ops })
      return Promise.resolve()
    }
    ctx.provide('settings', { configure: () => () => {}, mutate } as never)
    await ctx.plugin({ name: 'tool-roster', apply, Config }, {})
    await ctx.fiber.await()
    await assemble(ctx)

    // One write per unseen name, additive: the map is a list, never a rewrite.
    expect(writes.every(write => write.ns === 'tool-roster')).toBe(true)
    const paths = writes.flatMap(write => write.ops.map(op => op.path.join('.')))
    expect(paths).toContain('tools.read')
    expect(paths).toContain('tools.bash')
    expect(writes.flatMap(write => write.ops).every(op => op.value === true)).toBe(true)
    // The kernel tool has its own category switch; the run-code alias, whose name the
    // registry reserves, has none either (`toolVisible` always answers yes for it).
    expect(paths).not.toContain('tools.kernel')
    expect(paths).not.toContain('tools.run_code')
  })

  it('leaves an entry whose switch the operator already set alone', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt, {})
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(NativeToolExecutor)
    ctx.tools.register(tool('read'))
    const writes: { path: string[] }[] = []
    const mutate = (_ns: string, ops: { path: string[] }[]): Promise<void> => {
      writes.push(...ops)
      return Promise.resolve()
    }
    ctx.provide('settings', { configure: () => () => {}, mutate } as never)
    await ctx.plugin({ name: 'tool-roster', apply, Config }, { tools: { read: false } })
    await ctx.fiber.await()
    await assemble(ctx)

    // A known name is never rewritten, which is what keeps a write from racing a flip.
    expect(writes.map(op => op.path.join('.'))).not.toContain('tools.read')
  })

  it('learns a tool only an agent scope registers, which the global view cannot see', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt, {})
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(NativeToolExecutor)
    const key = { id: 'agent-a' as SessionId } as Agent
    let scope!: Scope
    await ctx.plugin(Object.assign((inner: Context) => { scope = createScope(inner, key) }, {
      inject: ['tools', 'systemPrompt'],
    }))
    scope.ctx.tools.register(tool('scoped_only'))
    const writes: { path: string[] }[] = []
    const mutate = (_ns: string, ops: { path: string[] }[]): Promise<void> => {
      writes.push(...ops)
      return Promise.resolve()
    }
    ctx.provide('settings', { configure: () => () => {}, mutate } as never)
    await ctx.plugin({ name: 'tool-roster', apply, Config }, {})
    await ctx.fiber.await()

    // The registry's global view cannot see a preset's tool...
    expect(ctx.tools.schemas().map(schema => schema.name)).not.toContain('scoped_only')
    // ...but the prompt assembled for that agent can, and that is the list the page shows.
    await ctx.systemPrompt.assemble({ scope: key })
    expect(writes.map(op => op.path.join('.'))).toContain('tools.scoped_only')
  })
})


describe('the roster is two independent categories', () => {
  it('keeps the kernel and the conventional tools separable', () => {
    const on = resolveRoster({ enabled: true, tools: {} }, true)
    expect(toolVisible(on, 'kernel')).toBe(true)
    expect(toolVisible(on, 'read')).toBe(true)

    // Either category alone.
    const kernelOnly = resolveRoster({ enabled: false, tools: {} }, true)
    expect(toolVisible(kernelOnly, 'kernel')).toBe(true)
    expect(toolVisible(kernelOnly, 'read')).toBe(false)

    const toolsOnly = resolveRoster({ enabled: true, tools: {} }, false)
    expect(toolVisible(toolsOnly, 'kernel')).toBe(false)
    expect(toolVisible(toolsOnly, 'read')).toBe(true)
  })

  it('treats an absent per-tool entry as enabled and an explicit false as off', () => {
    const roster = resolveRoster({ enabled: true, tools: { bash: false } }, true)
    expect(toolVisible(roster, 'read')).toBe(true)
    expect(toolVisible(roster, 'bash')).toBe(false)
  })

  it('never gates the PTC transport, whatever the switches say', () => {
    const off = resolveRoster({ enabled: false, tools: {} }, false)
    expect(toolVisible(off, 'run_code')).toBe(true)
  })

  it('compares rosters by effect, not by key order or redundant entries', () => {
    const base = resolveRoster({ enabled: true, tools: { bash: true } }, true)
    expect(sameRoster(base, resolveRoster({ enabled: true, tools: {} }, true))).toBe(true)
    expect(sameRoster(base, resolveRoster({ enabled: true, tools: { bash: false } }, true))).toBe(false)
    expect(sameRoster(base, resolveRoster({ enabled: true, tools: {} }, false))).toBe(false)
  })
})

describe('a hidden tool loses its schema and its guidance together', () => {
  it('names the hidden tools and the sections that belong to them', () => {
    const roster = resolveRoster({ enabled: true, tools: { bash: false } }, true)
    const hidden = hiddenToolNames(roster, ['read', 'bash', 'kernel'])
    expect([...hidden]).toEqual(['bash'])

    expect(sectionHidden(hidden, 'tool:bash')).toBe(true)
    expect(sectionHidden(hidden, 'tool:read')).toBe(false)
    // A section named after something that is not a registered tool is left
    // alone: several packages name a section after a capability, not a tool.
    expect(sectionHidden(hidden, 'tool:unknown-capability')).toBe(false)
    expect(sectionHidden(hidden, 'harness:identity')).toBe(false)
  })

  it('matches a dashed section against an underscored tool name', () => {
    const roster = resolveRoster({ enabled: true, tools: { web_fetch: false } }, true)
    const hidden = hiddenToolNames(roster, ['web-fetch'])
    expect(sectionHidden(hidden, 'tool:web_fetch')).toBe(true)
  })

  it('drops the hidden tool\'s guidance section from the assembled prompt', async () => {
    const { ctx, live } = await mount()
    ctx.effect(() => ctx.systemPrompt.section({ name: 'tool:bash', order: 10, text: 'Run a shell command.' }))
    await live.update({ tools: { bash: false } })

    // The change is held until the turn boundary, so the section stays until the
    // model stops generating.
    expect((await assemble(ctx)).sections).toContain('tool:bash')
    await ctx.parallel('agent/turn-stopping', { agent: subject, turn: 1, signal })
    expect((await assemble(ctx)).sections).not.toContain('tool:bash')
    await ctx.fiber.dispose()
  })

  it('masks the hidden tool out of the agent\'s admitted set at the next step', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt, {})
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(NativeToolExecutor)
    ctx.tools.register(tool('read'))
    ctx.tools.register(tool('bash'))
    const key = { id: 'agent-a' as SessionId } as Agent
    let scope!: Scope
    await ctx.plugin(Object.assign((inner: Context) => { scope = createScope(inner, key) }, {
      inject: ['tools', 'systemPrompt'],
    }))
    const agent = { id: key.id, ctx: scope.ctx } as Agent
    ctx.provide('settings', { configure: () => () => {}, mutate: () => Promise.resolve() } as never)
    await ctx.plugin({ name: 'tool-roster', apply, Config }, { tools: { bash: false } })
    await ctx.fiber.await()
    const admitted = (): string[] => scope.ctx.tools.schemas(scopeOf(scope.ctx)).map(schema => schema.name)
    expect(admitted()).toContain('bash')

    // The mask is installed where an agent is in hand, which is the step.
    await ctx.waterfall('agent/pre-step', {
      agent, messages: [], turn: 1, step: 1, signal, modelSelection: { provider: 'test', model: 'test' },
    }, () => Promise.resolve({ kind: 'enter', messages: [] }))
    expect(admitted()).not.toContain('bash')
    expect(admitted()).toContain('read')
    await ctx.fiber.dispose()
  })
})

describe('visibility is not enforcement', () => {
  it('refuses to execute a tool the roster withdrew', async () => {
    const { ctx, live } = await mount()
    expect(await run(ctx, 'bash')).toBe('ran:bash')

    await live.update({ tools: { bash: false } })
    await ctx.parallel('agent/turn-stopping', { agent: subject, turn: 1, signal })

    expect(await run(ctx, 'bash')).toContain('switched off in settings')
    // Its neighbour is untouched.
    expect(await run(ctx, 'read')).toBe('ran:read')
    await ctx.fiber.dispose()
  })

  it('denies every non-kernel tool when the category switch is off', async () => {
    const { ctx, live } = await mount()
    await live.update({ enabled: false })
    await ctx.parallel('agent/turn-stopping', { agent: subject, turn: 1, signal })

    expect(await run(ctx, 'bash')).toContain('switched off in settings')
    expect(await run(ctx, 'read')).toContain('switched off in settings')
    expect(await run(ctx, 'kernel')).toBe('ran:kernel')
    await ctx.fiber.dispose()
  })
})

describe('a change lands when the model stops generating', () => {
  it('holds a mid-turn toggle back until the turn boundary', async () => {
    const { ctx, live } = await mount()
    await live.update({ tools: { bash: false } })
    // Mid-turn: the roster in force is still the one the turn started under.
    expect(await run(ctx, 'bash')).toBe('ran:bash')

    await ctx.parallel('agent/turn-stopping', { agent: subject, turn: 1, signal })

    // After the boundary the change is in force, on both halves.
    expect(await run(ctx, 'bash')).toContain('switched off in settings')
    await ctx.fiber.dispose()
  })

  it('starts under what the profile already said, without waiting for a boundary', async () => {
    // The hold is for a change made while the model is generating. A switch
    // the operator set before boot is in force on the first turn.
    const { ctx } = await mount({ kernel: false })
    expect(await run(ctx, 'kernel')).toContain('switched off in settings')
    await ctx.fiber.dispose()
  })

  it('declares every switch as a live field, so Settings edits it without a remount', () => {
    for (const field of ['kernel', 'enabled', 'tools'] as const) {
      expect(Config.dict?.[field]?.meta.volatile).toBe(true)
    }
    const defaults = Config({})
    expect(defaults.kernel.get()).toBe(true)
    expect(defaults.enabled.get()).toBe(true)
    expect(defaults.tools.get()).toEqual({})
  })
})
