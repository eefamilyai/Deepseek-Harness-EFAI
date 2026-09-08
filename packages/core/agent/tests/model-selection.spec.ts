import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import {
  agentEvents,
  installModelSelection,
  type Agent,
  type ModelSelectionRef,
} from '../src/index.ts'
import { ReasoningEffortId, type LlmCallConfig } from '@deepseek-ai/dsh-llm'

describe('installModelSelection()', () => {
  it('snapshots prompt variables and request routing together, then disposes both listeners', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    const selection: ModelSelectionRef = { current: undefined, assembled: undefined }
    const dispose = installModelSelection(ctx, selection)
    const agent = {} as Agent
    const seed: LlmCallConfig = { provider: 'seed', model: 'seed', temperature: 0.2 }
    const signal = new AbortController().signal

    expect((await ctx.systemPrompt.assemble()).variables).toEqual({})
    await expect(agentEvents(ctx, agent).waterfall(
      'agent/request', { turn: 1, step: 0, signal }, () => Promise.resolve(seed),
    )).resolves.toBe(seed)

    selection.current = {
      provider: 'alpha',
      model: 'a1',
      reasoningEffort: ReasoningEffortId('high'),
    }
    expect((await ctx.systemPrompt.assemble()).variables).toMatchObject({ provider: 'alpha', model: 'a1' })
    selection.current = { provider: 'beta', model: 'b1' }
    await expect(agentEvents(ctx, agent).waterfall(
      'agent/request', { turn: 1, step: 0, signal }, () => Promise.resolve(seed),
    )).resolves.toEqual({
      provider: 'alpha',
      model: 'a1',
      reasoningEffort: ReasoningEffortId('high'),
      temperature: 0.2,
    })

    expect((await ctx.systemPrompt.assemble()).variables).toMatchObject({ provider: 'beta', model: 'b1' })
    const inherited: LlmCallConfig = {
      provider: 'alpha',
      model: 'a1',
      reasoningEffort: ReasoningEffortId('max'),
      temperature: 0.2,
    }
    await expect(agentEvents(ctx, agent).waterfall(
      'agent/request', { turn: 1, step: 1, signal }, () => Promise.resolve(inherited),
    )).resolves.toEqual({ provider: 'beta', model: 'b1', temperature: 0.2 })

    dispose()
    expect((await ctx.systemPrompt.assemble()).variables).toEqual({})
    await expect(agentEvents(ctx, agent).waterfall(
      'agent/request', { turn: 2, step: 0, signal }, () => Promise.resolve(seed),
    )).resolves.toBe(seed)
    await ctx.fiber.dispose()
  })

  it('rebinds prompt variables and request routing when a re-entrant install replaces the ref', async () => {
    // A resume/reconnect re-enters setup on the same agent context before the
    // first attempt's fiber unwound; a second raw accessor declaration throws
    // `already declared`, which failed the whole resume. The second install must
    // not throw AND must govern: the caller holds the new ref and sets the picked
    // model on it, so wiring that still read the first ref would route every
    // request to a model the picker no longer shows.
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    const agent = {} as Agent
    const signal = new AbortController().signal
    const seed: LlmCallConfig = { provider: 'seed', model: 'seed', temperature: 0.2 }
    const first: ModelSelectionRef = { current: { provider: 'alpha', model: 'a1' }, assembled: undefined }
    const disposeFirst = installModelSelection(ctx, first)

    const second: ModelSelectionRef = { current: { provider: 'beta', model: 'b1' }, assembled: undefined }
    let disposeSecond: (() => void) | undefined
    expect(() => { disposeSecond = installModelSelection(ctx, second) }).not.toThrow()
    expect(ctx.modelSelection).toEqual({ provider: 'beta', model: 'b1' })
    expect((await ctx.systemPrompt.assemble()).variables).toMatchObject({ provider: 'beta', model: 'b1' })
    await expect(agentEvents(ctx, agent).waterfall(
      'agent/request', { turn: 1, step: 0, signal }, () => Promise.resolve(seed),
    )).resolves.toMatchObject({ provider: 'beta', model: 'b1' })

    // A later pick on the ref the caller holds reaches both surfaces.
    second.current = { provider: 'gamma', model: 'g1' }
    expect((await ctx.systemPrompt.assemble()).variables).toMatchObject({ provider: 'gamma', model: 'g1' })

    // Unwinding the re-entrant install restores the ref it replaced.
    disposeSecond?.()
    expect(ctx.modelSelection).toEqual({ provider: 'alpha', model: 'a1' })

    disposeFirst()
    expect((await ctx.systemPrompt.assemble()).variables).toEqual({})
    await ctx.fiber.dispose()
  })
})
