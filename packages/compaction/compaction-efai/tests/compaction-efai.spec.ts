/**
 * The three differences this provider exists for.
 *
 * Each is invisible in the class body alone: what the summarization request
 * actually carries, that the manual path prunes before it summarizes, and that
 * a `/compact` typed mid-turn waits instead of failing.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ManualCompactionError } from '@deepseek-ai/dsh-compaction'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic'
import { COMPACTION_INSTRUCTION, COMPACTION_SYSTEM, EfaiCompactionEngine } from '../src/index.ts'

const signal = new AbortController().signal

/** One streamed text chunk plus a clean finish, as the assembler expects. */
function textStream(text: string): AsyncGenerator<unknown> {
  return (async function* () {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })() as AsyncGenerator<unknown>
}

/** A context carrying just the LLM seam the summarizer calls. */
function llmContext(captured: GenerateOptions[], text = '## Work Done\n- did a thing'): Context {
  const ctx = new Context()
  ctx.provide('llm', {
    stream: (options: GenerateOptions) => {
      captured.push(options)
      return textStream(text)
    },
  })
  return ctx
}

/** The minimum of an Agent the summarization path reads. */
function fakeAgent(routed?: { provider: string; model: string }): Agent {
  return {
    session: {
      id: 'session-1',
      requestHeader: () => (routed === undefined ? undefined : { config: routed }),
    },
    options: {},
    whenIdle: () => Promise.resolve(),
  } as unknown as Agent
}

/** Reach the protected hook the way the region transaction does. */
type Summarizer = {
  summarize: (input: unknown, agent: Agent, signal?: AbortSignal) => Promise<{ summary: { text: string }[] }>
}

afterEach(() => { vi.restoreAllMocks() })

describe('the summarization request', () => {
  it('sends the summarizer its own system prompt, which upstream does not send at all', async () => {
    const captured: GenerateOptions[] = []
    const engine = new EfaiCompactionEngine(llmContext(captured), {})
    await (engine as unknown as Summarizer).summarize(
      { messages: [], system: 'the conversation system prompt' },
      fakeAgent({ provider: 'kiln-ds_direct', model: 'deepseek-chat' }),
    )
    expect(captured).toHaveLength(1)
    expect(captured[0]!.system).toBe(COMPACTION_SYSTEM)
    // The conversation's own system prompt is deliberately NOT reused: keeping
    // the agent role is what made a text-only route answer with a tool call.
    expect(captured[0]!.system).not.toContain('the conversation system prompt')
  })

  it('appends the checkpoint instruction as the final user message', async () => {
    const captured: GenerateOptions[] = []
    const engine = new EfaiCompactionEngine(llmContext(captured), {})
    const earlier = { role: 'user', content: [{ type: 'text', text: 'earlier turn' }] }
    await (engine as unknown as Summarizer).summarize(
      { messages: [earlier] },
      fakeAgent({ provider: 'kiln-ds_direct', model: 'deepseek-chat' }),
    )
    const messages = captured[0]!.messages
    expect(messages).toHaveLength(2)
    expect(JSON.stringify(messages[1])).toContain(COMPACTION_INSTRUCTION.slice(0, 40))
    expect(captured[0]!.purpose).toBe('compaction')
  })

  it('routes to the model the latest request was durably sent to', async () => {
    const captured: GenerateOptions[] = []
    const engine = new EfaiCompactionEngine(llmContext(captured), {})
    await (engine as unknown as Summarizer).summarize(
      { messages: [] },
      fakeAgent({ provider: 'kiln-anthropic', model: 'claude' }),
    )
    expect(captured[0]!.provider).toBe('kiln-anthropic')
    expect(captured[0]!.model).toBe('claude')
  })

  it('fails loud when no route can be resolved at all', async () => {
    const engine = new EfaiCompactionEngine(llmContext([]), {})
    await expect((engine as unknown as Summarizer).summarize({ messages: [] }, fakeAgent()))
      .rejects.toThrow('no provider/model available for summarization')
  })

  it('refuses a reply that carries no text', async () => {
    const captured: GenerateOptions[] = []
    const engine = new EfaiCompactionEngine(llmContext(captured, '   '), {})
    await expect((engine as unknown as Summarizer).summarize(
      { messages: [] },
      fakeAgent({ provider: 'p', model: 'm' }),
    )).rejects.toThrow('no text summary content')
  })
})

describe('the manual path', () => {
  it('prunes tool results before compacting', async () => {
    const order: string[] = []
    const ctx = new Context()
    ctx.provide('toolResultPruner', { pruneSession: () => { order.push('prune') } })
    const engine = new EfaiCompactionEngine(ctx, {})
    vi.spyOn(BasicCompactionEngine.prototype, 'compactNow').mockImplementation(async () => {
      order.push('compact')
      return null
    })

    await engine.compactNow(fakeAgent(), signal)
    expect(order).toEqual(['prune', 'compact'])
  })

  it('runs without a pruner mounted', async () => {
    const engine = new EfaiCompactionEngine(new Context(), {})
    vi.spyOn(BasicCompactionEngine.prototype, 'compactNow').mockResolvedValue(null)
    await expect(engine.compactNow(fakeAgent(), signal)).resolves.toBeNull()
  })

  it('waits out a turn in flight and retries once, instead of failing busy', async () => {
    const engine = new EfaiCompactionEngine(new Context(), {})
    let idleWaits = 0
    const agent = { ...fakeAgent(), whenIdle: () => { idleWaits += 1; return Promise.resolve() } } as unknown as Agent
    const attempts = vi.spyOn(BasicCompactionEngine.prototype, 'compactNow')
      .mockImplementationOnce(() => Promise.reject(new ManualCompactionError('busy', 'the agent is not idle')))
      .mockImplementationOnce(async () => null)

    await expect(engine.compactNow(agent, signal)).resolves.toBeNull()
    expect(attempts).toHaveBeenCalledTimes(2)
    expect(idleWaits).toBe(1)
  })

  it('propagates any other failure without waiting', async () => {
    const engine = new EfaiCompactionEngine(new Context(), {})
    let idleWaits = 0
    const agent = { ...fakeAgent(), whenIdle: () => { idleWaits += 1; return Promise.resolve() } } as unknown as Agent
    vi.spyOn(BasicCompactionEngine.prototype, 'compactNow')
      .mockRejectedValue(new ManualCompactionError('changed', 'history moved'))

    await expect(engine.compactNow(agent, signal)).rejects.toThrow('history moved')
    expect(idleWaits).toBe(0)
  })

  it('does not wait when the caller already cancelled', async () => {
    const engine = new EfaiCompactionEngine(new Context(), {})
    const aborted = AbortSignal.abort()
    let idleWaits = 0
    const agent = { ...fakeAgent(), whenIdle: () => { idleWaits += 1; return Promise.resolve() } } as unknown as Agent
    vi.spyOn(BasicCompactionEngine.prototype, 'compactNow')
      .mockRejectedValue(new ManualCompactionError('busy', 'the agent is not idle'))

    await expect(engine.compactNow(agent, aborted)).rejects.toThrow('not idle')
    expect(idleWaits).toBe(0)
  })
})
