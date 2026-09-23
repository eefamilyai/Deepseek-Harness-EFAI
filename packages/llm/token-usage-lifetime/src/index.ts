/**
 * Lifetime token usage: what a session has cost since it began, across every
 * compaction.
 *
 * Upstream's `tokenUsage` projection answers for the conversation the model
 * can currently see, so a compaction resets what it reports — correct for
 * context pressure, and wrong for "what has this session spent". This unit
 * folds the same durable usage samples without that reset, which is what
 * `/session-info` reports.
 *
 * It is a separate projection rather than an edit to `token-meter` because a
 * projection is a registration: `ctx.sessionProjections.register()` takes a
 * definition from anyone, and two units over the same events cost one fold
 * each.
 *
 * ```yaml
 * - id: token-usage-lifetime
 *   name: '@deepseek-ai/dsh-token-usage-lifetime'
 * ```
 *
 * @module @deepseek-ai/dsh-token-usage-lifetime
 */

import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { lastAssistantStreamChunk, type TokenUsage } from '@deepseek-ai/dsh-llm'
// Type-only: carries the retry event this fold reads.
import type {} from '@deepseek-ai/dsh-llm-retry/types'
// Type-only: carries the compaction events this fold reads.
import type {} from '@deepseek-ai/dsh-compaction'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type { TokenUsageProjection } from '@deepseek-ai/dsh-token-meter'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'token-usage-lifetime'

/** The projection registry carries the unit. */
export const inject = ['sessionProjections']

/** Projection key this unit publishes under. */
export const TOKEN_USAGE_LIFETIME_KEY = 'tokenUsageLifetime'

const projectionSchema = z.object({
  uncachedInputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative(),
  cacheWriteTokens: z.number().int().nonnegative(),
}).strict()

/** State schema, and the one definition of the state shape. */
const stateSchema = z.object({
  totals: projectionSchema,
  last: z.object({
    turn: z.number().int().nonnegative(),
    step: z.number().int().nonnegative(),
    buckets: projectionSchema,
  }).nullable(),
}).strict()

type LifetimeState = z.infer<typeof stateSchema>

const zeroBuckets = (): TokenUsageProjection => ({
  uncachedInputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
})

const bucketsFrom = (usage: TokenUsage): TokenUsageProjection => ({
  uncachedInputTokens: usage.inputTokens,
  outputTokens: usage.outputTokens,
  cacheReadTokens: usage.cacheReadTokens ?? 0,
  cacheWriteTokens: usage.cacheWriteTokens ?? 0,
})

const bucketsEqual = (left: TokenUsageProjection, right: TokenUsageProjection): boolean =>
  left.uncachedInputTokens === right.uncachedInputTokens
  && left.outputTokens === right.outputTokens
  && left.cacheReadTokens === right.cacheReadTokens
  && left.cacheWriteTokens === right.cacheWriteTokens

/**
 * Add `next`, first removing whatever the same turn/step already contributed.
 *
 * One step can settle twice — an attempt, then the message — and the second
 * report supersedes the first rather than adding to it.
 */
const addReplacing = (
  totals: TokenUsageProjection,
  previous: TokenUsageProjection | undefined,
  next: TokenUsageProjection,
): TokenUsageProjection => ({
  uncachedInputTokens: totals.uncachedInputTokens - (previous?.uncachedInputTokens ?? 0) + next.uncachedInputTokens,
  outputTokens: totals.outputTokens - (previous?.outputTokens ?? 0) + next.outputTokens,
  cacheReadTokens: totals.cacheReadTokens - (previous?.cacheReadTokens ?? 0) + next.cacheReadTokens,
  cacheWriteTokens: totals.cacheWriteTokens - (previous?.cacheWriteTokens ?? 0) + next.cacheWriteTokens,
})

/** The usage one durable Assistant settlement reports for its attempt, if any. */
function usageOf(event: SessionEvent): TokenUsage | undefined {
  if (event.type === 'assistant/message' && event.data.usage !== undefined) return event.data.usage
  if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') return undefined
  return lastAssistantStreamChunk(event.data.stream, 'usage')?.usage
}

/**
 * Fold one event into the running totals.
 *
 * A retry discards the step it retried, so its earlier sample must stop
 * counting; every other event either reports usage for a turn/step or is not
 * about usage at all.
 * @param state - the totals so far.
 * @param event - the next durable event.
 * @returns the next state, or the same object when nothing changed.
 */
export function applyUsageSample(state: LifetimeState, event: SessionEvent): LifetimeState {
  if (event.type === 'llm/retry-started') {
    return state.last?.turn === event.data.turn && state.last.step === event.data.step
      ? { ...state, last: null }
      : state
  }
  if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') return state
  const sample = usageOf(event)
  if (sample === undefined) return state
  const { turn, step } = event.data

  const buckets = bucketsFrom(sample)
  const previous = state.last !== null && state.last.turn === turn && state.last.step === step
    ? state.last.buckets
    : undefined
  if (previous !== undefined && bucketsEqual(previous, buckets)) return state

  return {
    totals: addReplacing(state.totals, previous, buckets),
    last: { turn, step, buckets },
  }
}

/**
 * The unit itself.
 *
 * A compaction clears only the replacement fence, never the totals: the tokens
 * were spent whether or not the model can still see what they bought.
 */
export const tokenUsageLifetimeProjectionDefinition = {
  key: TOKEN_USAGE_LIFETIME_KEY,
  stateVersion: 1,
  stateSchema,
  init: () => ({ totals: zeroBuckets(), last: null }),
  apply: (state, event) => {
    if (event.type === 'compaction/end' && event.data.error === undefined) {
      return state.last === null ? state : { totals: state.totals, last: null }
    }
    return applyUsageSample(state, event)
  },
  wire: { viewSchema: projectionSchema, view: state => state.totals },
} satisfies ProjectionDefinition<'tokenUsageLifetime', LifetimeState>

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** Fold state: the running totals plus the turn/step fence that replaces a re-reported sample. */
    tokenUsageLifetime: LifetimeState
  }
  interface SessionProjectionMap {
    /** Provider-reported usage accumulated across the complete durable log, across compactions. */
    tokenUsageLifetime: TokenUsageProjection
  }
}

/**
 * Register the unit for this plugin's lifetime.
 * @param ctx - the plugin context.
 */
export function apply(ctx: Context): void {
  ctx.effect(
    () => ctx.sessionProjections.register(tokenUsageLifetimeProjectionDefinition),
    'token-usage-lifetime: projection unit',
  )
}
