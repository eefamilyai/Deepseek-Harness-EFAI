/**
 * The lifetime fold.
 *
 * Three properties decide whether this unit is worth having, and none is
 * visible from the definition alone: a compaction does not reset the totals
 * (the whole reason it exists beside upstream's windowed unit), a step that
 * settles twice counts once, and a retried step stops counting.
 */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import { createMessage } from '@deepseek-ai/dsh-llm'
import { CompactionId } from '@deepseek-ai/dsh-compaction'
import { RetryId } from '@deepseek-ai/dsh-llm-retry'
import { TOKEN_USAGE_LIFETIME_KEY, apply, inject, name } from '../src/index.ts'

/** Mount the registry with this unit registered. */
async function harness(): Promise<{ ctx: Context; session: Session }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin({ name, inject, apply })
  return { ctx, session: ctx.sessions.create() }
}

/** One settled assistant message reporting usage for a turn/step. */
function settle(session: Session, turn: number, step: number, usage: TokenUsage): void {
  session.append('assistant/message', {
    turn,
    step,
    message: createMessage({
      role: 'assistant',
      content: [{ type: 'text', text: 'ok' }],
      source: { kind: 'model', provider: 'mock', model: 'mock' },
    }),
    stream: [{ type: 'chunk', time: 0, chunk: { type: 'usage', usage } }],
    usage,
  }, { surfaceOp: 'append' })
}

/** The totals this unit currently publishes. */
function totals(ctx: Context, session: Session): Record<string, number> {
  return ctx.sessionProjections.snapshot(session).values[TOKEN_USAGE_LIFETIME_KEY] as unknown as Record<string, number>
}

const USAGE = (input: number, output: number): TokenUsage => ({ inputTokens: input, outputTokens: output })

describe('the lifetime fold', () => {
  it('starts at zero', async () => {
    const { ctx, session } = await harness()
    expect(totals(ctx, session)).toEqual({
      uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    })
    await ctx.fiber.dispose()
  })

  it('accumulates every reported sample', async () => {
    const { ctx, session } = await harness()
    settle(session, 1, 1, USAGE(100, 10))
    settle(session, 1, 2, USAGE(200, 20))
    expect(totals(ctx, session)).toMatchObject({ uncachedInputTokens: 300, outputTokens: 30 })
    await ctx.fiber.dispose()
  })

  it('counts cache traffic in its own buckets', async () => {
    const { ctx, session } = await harness()
    settle(session, 1, 1, { inputTokens: 10, outputTokens: 1, cacheReadTokens: 7, cacheWriteTokens: 3 })
    expect(totals(ctx, session)).toEqual({
      uncachedInputTokens: 10, outputTokens: 1, cacheReadTokens: 7, cacheWriteTokens: 3,
    })
    await ctx.fiber.dispose()
  })

  it('replaces rather than adds when one step reports twice', async () => {
    const { ctx, session } = await harness()
    settle(session, 1, 1, USAGE(100, 10))
    settle(session, 1, 1, USAGE(120, 12))
    expect(totals(ctx, session)).toMatchObject({ uncachedInputTokens: 120, outputTokens: 12 })
    await ctx.fiber.dispose()
  })

  it('drops a retried step, whose tokens bought a discarded attempt', async () => {
    const { ctx, session } = await harness()
    settle(session, 1, 1, USAGE(100, 10))
    session.append('llm/retry-started', {
      turn: 1, step: 1, retryId: RetryId('r1'), retry: 1,
    })
    settle(session, 1, 1, USAGE(140, 14))
    expect(totals(ctx, session)).toMatchObject({ uncachedInputTokens: 240, outputTokens: 24 })
    await ctx.fiber.dispose()
  })

  it('survives a compaction, which is the whole point of this unit', async () => {
    const { ctx, session } = await harness()
    settle(session, 1, 1, USAGE(1000, 100))
    const before = totals(ctx, session)

    session.append('compaction/start', { compactionId: CompactionId('c1'), turn: null })
    session.append('compaction/end', { compactionId: CompactionId('c1'), turn: null })
    expect(totals(ctx, session)).toEqual(before)

    settle(session, 2, 1, USAGE(50, 5))
    expect(totals(ctx, session)).toMatchObject({ uncachedInputTokens: 1050, outputTokens: 105 })
    await ctx.fiber.dispose()
  })

  it('ignores events that report no usage', async () => {
    const { ctx, session } = await harness()
    settle(session, 1, 1, USAGE(10, 1))
    session.append('step/start', { turn: 1, step: 2 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    expect(totals(ctx, session)).toMatchObject({ uncachedInputTokens: 10, outputTokens: 1 })
    await ctx.fiber.dispose()
  })
})
