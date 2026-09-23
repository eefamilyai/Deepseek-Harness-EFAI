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
import { describe, expect, it } from 'vitest'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
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
  const result = await ctx.tools.execute({
    signal, callId: ToolCallId('c1'), name, arguments: {},
  })
  const first = result.content[0]
  return first?.type === 'text' ? first.text : JSON.stringify(result.content)
}

/**
 * Mount the roster behind a Loader over real tools and prompt services, so an
 * edit travels the same path a Settings write does.
 */
async function mount(initial: Record<string, unknown> = {}) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime)
  ctx.tools.register(tool('read'))
  ctx.tools.register(tool('bash'))
  ctx.tools.register(tool('kernel', 'ran:kernel'))
  ctx.tools.register(tool('rlm', 'ran:rlm'))
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

describe('the roster is two independent categories', () => {
  it('keeps the kernel and the conventional tools separable', () => {
    const on = resolveRoster({ enabled: true, tools: {} }, true, false)
    expect(toolVisible(on, 'kernel')).toBe(true)
    expect(toolVisible(on, 'read')).toBe(true)

    // Either category alone.
    const kernelOnly = resolveRoster({ enabled: false, tools: {} }, true, false)
    expect(toolVisible(kernelOnly, 'kernel')).toBe(true)
    expect(toolVisible(kernelOnly, 'read')).toBe(false)

    const toolsOnly = resolveRoster({ enabled: true, tools: {} }, false, false)
    expect(toolVisible(toolsOnly, 'kernel')).toBe(false)
    expect(toolVisible(toolsOnly, 'read')).toBe(true)
  })

  it('offers exactly one acting surface: the kernel tool, or the RLM engine', () => {
    const kernelActing = resolveRoster({ enabled: true, tools: {} }, true, false)
    expect(toolVisible(kernelActing, 'kernel')).toBe(true)
    expect(toolVisible(kernelActing, 'rlm')).toBe(false)

    const rlmActing = resolveRoster({ enabled: true, tools: {} }, true, true)
    expect(toolVisible(rlmActing, 'kernel')).toBe(false)
    expect(toolVisible(rlmActing, 'rlm')).toBe(true)

    // The engine runs ON the kernel seam, so kernel-off withdraws both.
    const kernelOff = resolveRoster({ enabled: true, tools: {} }, false, true)
    expect(toolVisible(kernelOff, 'kernel')).toBe(false)
    expect(toolVisible(kernelOff, 'rlm')).toBe(false)
  })

  it('counts the RLM switch when comparing two rosters', () => {
    const base = resolveRoster({ enabled: true, tools: {} }, true, false)
    expect(sameRoster(base, resolveRoster({ enabled: true, tools: {} }, true, true))).toBe(false)
  })

  it('treats an absent per-tool entry as enabled and an explicit false as off', () => {
    const roster = resolveRoster({ enabled: true, tools: { bash: false } }, true, false)
    expect(toolVisible(roster, 'read')).toBe(true)
    expect(toolVisible(roster, 'bash')).toBe(false)
  })

  it('never gates the PTC transport, whatever the switches say', () => {
    const off = resolveRoster({ enabled: false, tools: {} }, false, false)
    expect(toolVisible(off, 'run_code')).toBe(true)
  })

  it('compares rosters by effect, not by key order or redundant entries', () => {
    const base = resolveRoster({ enabled: true, tools: { bash: true } }, true, false)
    expect(sameRoster(base, resolveRoster({ enabled: true, tools: {} }, true, false))).toBe(true)
    expect(sameRoster(base, resolveRoster({ enabled: true, tools: { bash: false } }, true, false))).toBe(false)
    expect(sameRoster(base, resolveRoster({ enabled: true, tools: {} }, false, false))).toBe(false)
  })
})

describe('a hidden tool loses its schema and its guidance together', () => {
  it('names the hidden tools and the sections that belong to them', () => {
    const roster = resolveRoster({ enabled: true, tools: { bash: false } }, true, false)
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
    const roster = resolveRoster({ enabled: true, tools: { web_fetch: false } }, true, false)
    const hidden = hiddenToolNames(roster, ['web-fetch'])
    expect(sectionHidden(hidden, 'tool:web_fetch')).toBe(true)
  })

  it('drops the hidden tool and its section from the assembled prompt', async () => {
    const { ctx, live } = await mount()
    await live.update({ tools: { bash: false } })

    // The change is held until the turn boundary, so the assembly is unchanged
    // until the model stops generating.
    await ctx.parallel('agent/turn-stopping', { agent: subject, turn: 1, signal })
    const after = await assemble(ctx)
    expect(after.tools).not.toContain('bash')
    expect(after.tools).toContain('read')
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

describe('the acting surface follows the rlm switch', () => {
  it('withdraws the kernel tool and offers the engine when RLM is on at boot', async () => {
    const { ctx } = await mount({ rlm: true })
    const assembly = await assemble(ctx)
    expect(assembly.tools).toContain('rlm')
    expect(assembly.tools).not.toContain('kernel')
    expect(await run(ctx, 'kernel')).toContain('switched off in settings')
    expect(await run(ctx, 'rlm')).toBe('ran:rlm')
    await ctx.fiber.dispose()
  })

  it('swaps the two surfaces at the turn boundary when the switch is flipped', async () => {
    const { ctx, live } = await mount()
    expect(await run(ctx, 'kernel')).toBe('ran:kernel')
    expect(await run(ctx, 'rlm')).toContain('switched off in settings')

    await live.update({ rlm: true })
    await ctx.parallel('agent/turn-stopping', { agent: subject, turn: 1, signal })

    expect(await run(ctx, 'kernel')).toContain('switched off in settings')
    expect(await run(ctx, 'rlm')).toBe('ran:rlm')
    const assembly = await assemble(ctx)
    expect(assembly.tools).toContain('rlm')
    expect(assembly.tools).not.toContain('kernel')
    await ctx.fiber.dispose()
  })
})

describe('a change lands when the model stops generating', () => {
  it('holds a mid-turn toggle back until the turn boundary', async () => {
    const { ctx, live } = await mount()
    await live.update({ tools: { bash: false } })
    // Mid-turn: the roster in force is still the one the turn started under.
    expect(await run(ctx, 'bash')).toBe('ran:bash')
    expect((await assemble(ctx)).tools).toContain('bash')

    await ctx.parallel('agent/turn-stopping', { agent: subject, turn: 1, signal })

    // After the boundary the change is in force, on both halves.
    expect(await run(ctx, 'bash')).toContain('switched off in settings')
    expect((await assemble(ctx)).tools).not.toContain('bash')
    await ctx.fiber.dispose()
  })

  it('starts under what the profile already said, without waiting for a boundary', async () => {
    // The hold is for a change made while the model is generating. A switch
    // the operator set before boot is in force on the first turn.
    const { ctx } = await mount({ kernel: false })
    expect((await assemble(ctx)).tools).not.toContain('kernel')
    expect(await run(ctx, 'kernel')).toContain('switched off in settings')
    await ctx.fiber.dispose()
  })

  it('declares every switch as a live field, so Settings edits it without a remount', () => {
    for (const field of ['kernel', 'rlm', 'enabled', 'tools'] as const) {
      expect(Config.dict?.[field]?.meta.volatile).toBe(true)
    }
    const defaults = Config({})
    expect(defaults.kernel.get()).toBe(true)
    expect(defaults.rlm.get()).toBe(false)
    expect(defaults.enabled.get()).toBe(true)
    expect(defaults.tools.get()).toEqual({})
  })
})
