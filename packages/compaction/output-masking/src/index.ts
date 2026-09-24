/**
 * Observation masking: old tool outputs give way to one-line stubs before the
 * context fills, so a summary is needed later and has less to throw away.
 *
 * Most of a coding session's context is tool output the model has already
 * read and acted on. Summarizing it costs a model call and loses detail at
 * random; replacing it with a stub that says what ran, how large the output
 * was, and how it began and ended keeps the reasoning and the actions intact
 * and drops only the bulk — which the model can regenerate by running the call
 * again. Measured on SWE-bench agents, that matches summarization's solve rate
 * at about half the cost, and the two compose: masking first means compaction
 * fires later and summarizes a smaller, denser history.
 *
 * Each mask is the tool-result pruner's own replacement — a `compaction/prune`
 * shadow price followed by a `tool/result` that replaces exactly one surface
 * node — so the token meter, replay, and every surface reader already
 * understand it, and the original event stays in the log untouched.
 * @module @deepseek-ai/dsh-output-masking
 */

import z from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
import { freezeMessage } from '@deepseek-ai/dsh-llm'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { Session, SessionEvent, SessionSeq, ToolResultMessage } from '@deepseek-ai/dsh-session'
// Type-only: the `compaction/*` SessionEventMap merges (the shadow-price event).
import type {} from '@deepseek-ai/dsh-compaction'
// Type-only: the `ctx.sessionProjections` Context merge.
import type {} from '@deepseek-ai/dsh-session-projection'
// Type-only: the optional `ctx.tokenMeter` Context merge.
import type {} from '@deepseek-ai/dsh-token-meter'
import {
  emptyMaskingSurface,
  foldMaskingSurface,
  maskCandidates,
  maskingSurfaceSchema,
  renderStub,
} from './surface.ts'
import type { MaskingSurface, SurfaceNode } from './surface.ts'

export {
  MASK_MARKER,
  callTarget,
  emptyMaskingSurface,
  foldMaskingSurface,
  maskCandidates,
  maskingSurfaceSchema,
  renderStub,
} from './surface.ts'
export type { MaskingPolicy, MaskingSurface, ResultShape, SurfaceNode } from './surface.ts'

export const name = 'output-masking'
export const inject = ['sessionProjections']

/** The projection this plugin folds the surface into. */
export const MASKING_PROJECTION = 'outputMaskingSurface'

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** The current surface as masking sees it: prices and result shapes, no text. */
    outputMaskingSurface: MaskingSurface
  }
}

/** Share of the context window in use before a pass runs. */
export const DEFAULT_USAGE_RATIO = 0.5
/** Newest tool results a pass never masks. */
export const DEFAULT_KEEP_RECENT = 8
/** Results shorter than this many characters are left whole. */
export const DEFAULT_MIN_CHARS = 2000
/** Fewest results worth one pass. */
export const DEFAULT_MIN_BATCH = 4

export interface Config {
  /** Mask once this share of the context window is in use. Defaults to 0.5. */
  usageRatio?: number
  /** The newest this-many tool results are never masked. Defaults to 8. */
  keepRecent?: number
  /** Only results at least this many characters long are masked. Defaults to 2000. */
  minChars?: number
  /**
   * A pass runs only when it can mask at least this many results, so the
   * cached prompt prefix is invalidated rarely and for a real saving. Defaults to 4.
   */
  minBatch?: number
  /** The context window to assume when the routed model's cannot be resolved. */
  contextWindow?: number
}

export const Config: z<Config> = z.object({
  usageRatio: z.number().min(0).max(1).description('Mask once this share of the context window is in use.'),
  keepRecent: z.natural().description('The newest this-many tool results are never masked.'),
  minChars: z.natural().description('Only results at least this many characters long are masked.'),
  minBatch: z.natural().description('A pass runs only when it can mask at least this many results.'),
  contextWindow: z.natural().description('The context window to assume when the routed model\'s cannot be resolved.'),
})

/** What one pass did. */
export interface MaskResult {
  /** The masked results' original seqs, oldest first. */
  readonly masked: readonly SessionSeq[]
  /** Heuristic tokens the masked results cost before the pass. */
  readonly tokensBefore: number
}

/**
 * Replace each candidate with its stub, the way the tool-result pruner does:
 * the shadow price, then the replacement, synchronously adjacent.
 * @param session - the session whose surface is rewritten.
 * @param candidates - the nodes to mask, from one surface snapshot.
 * @returns what the pass did.
 */
export function maskResults(session: Session, candidates: readonly SurfaceNode[]): MaskResult {
  const masked: SessionSeq[] = []
  let tokensBefore = 0
  for (const node of candidates) {
    const result = node.result
    if (result === null) continue
    const seq = node.seq as SessionSeq
    const data = result.data as SessionEvent<'tool/result'>['data']
    const message = freezeMessage<ToolResultMessage>({
      ...data.message,
      content: [{ type: 'text', text: renderStub(result) }],
    })
    session.append('compaction/prune', {
      shadowedRange: { start: seq, end: seq },
      shadowedSeqs: [seq],
      shadowedTokenCount: node.tokens,
    })
    session.append('tool/result', { ...data, message }, {
      surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq },
      sourceEventSeqs: [seq],
    })
    masked.push(seq)
    tokensBefore += node.tokens
  }
  return { masked, tokensBefore }
}

/**
 * Install the surface projection and the pass that runs ahead of each step.
 * @param ctx - the plugin context.
 * @param config - the deployment's policy.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const usageRatio = config.usageRatio ?? DEFAULT_USAGE_RATIO
  const policy = {
    keepRecent: config.keepRecent ?? DEFAULT_KEEP_RECENT,
    minChars: config.minChars ?? DEFAULT_MIN_CHARS,
  }
  const minBatch = Math.max(1, config.minBatch ?? DEFAULT_MIN_BATCH)

  ctx.sessionProjections.register({
    key: MASKING_PROJECTION,
    stateVersion: 1,
    stateSchema: maskingSurfaceSchema,
    init: emptyMaskingSurface,
    apply: foldMaskingSurface,
  })

  const surfaceOf = (session: Session): MaskingSurface =>
    ctx.sessionProjections.stateOf(session, MASKING_PROJECTION) ?? emptyMaskingSurface()

  /** The routed model's context window, or the configured fallback. */
  const contextWindowOf = async (session: Session, signal: AbortSignal): Promise<number | undefined> => {
    const routed = session.requestHeader()?.config
    const llm = ctx.get('llm')
    if (routed !== undefined && llm !== undefined && routed.provider.length > 0) {
      try {
        const info = await llm.resolveModelInfo(routed.provider, routed.model, signal)
        if (info.context?.contextWindow !== undefined) return info.context.contextWindow
      } catch {
        // Fall through to the configured window.
      }
    }
    return config.contextWindow
  }

  /** Tokens in use: the meter's measurement when mounted, else the surface's own price. */
  const tokensInUse = (session: Session, surface: MaskingSurface): number => {
    const meter = ctx.get('tokenMeter')
    if (meter !== undefined) return meter.measure(session).totalTokens
    return surface.nodes.reduce((sum, node) => sum + node.tokens, 0)
  }

  /** One pass over a session: mask when every condition holds, else nothing. */
  const pass = async (session: Session, signal: AbortSignal): Promise<void> => {
    const surface = surfaceOf(session)
    if (surface.compacting) return
    const candidates = maskCandidates(surface, policy)
    if (candidates.length < minBatch) return
    const window = await contextWindowOf(session, signal)
    if (window === undefined || signal.aborted) return
    if (tokensInUse(session, surface) < usageRatio * window) return
    const result = maskResults(session, candidates)
    ctx.logger.info(
      `output-masking: masked ${result.masked.length} tool results `
      + `(~${result.tokensBefore} tokens, seqs ${result.masked.join(', ')})`,
    )
  }

  // Ahead of the rest of the chain, compaction included: a pass that lands
  // here lowers the pressure compaction measures in this same step.
  ctx.on('agent/pre-step', async ({ agent, signal }, next): Promise<PreStepDecision> => {
    if (!signal.aborted) {
      try {
        await pass(agent.session, signal)
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error)
        ctx.logger.warn(`output-masking: pass failed: ${message}; continuing the step`)
      }
    }
    return next()
  }, { prepend: true })
}
