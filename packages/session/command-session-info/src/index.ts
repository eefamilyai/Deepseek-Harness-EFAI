/**
 * Human-facing `/sessioninfo` command over the session-projection seam.
 *
 * The handler is synchronous and read-only: it snaps the receiving agent's
 * session through the projection registry, then renders cumulative token
 * usage, current context pressure, and whole-log activity side by side so a
 * billing total is never mistaken for one turn's prompt cost. Nothing here
 * writes to the session or starts model work.
 * @module @deepseek-ai/dsh-command-session-info
 */

import type { Context } from '@deepseek-ai/cordis'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-agent' // pull in the Context.modelSelection augmentation
// Resolve the host-side `ctx.sessionProjections` declaration.
import type {} from '@deepseek-ai/dsh-session-projection'

export const name = 'command-session-info'
export const inject = ['commands', 'sessionProjections']

const USAGE = 'Usage: /sessioninfo (no arguments)'

/** Read-only view assembled from the registry's detached projection snapshot. */
interface SessionInfo {
  id: string
  createdAt: number | undefined
  cwd: string | undefined
  agentPreset: string | undefined
  provider: string | undefined
  model: string | undefined

  uncachedInputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  outputTokens: number

  lifetimeUncachedInputTokens: number
  lifetimeCacheReadTokens: number
  lifetimeCacheWriteTokens: number
  lifetimeOutputTokens: number

  pressureTokens: number | undefined
  projectedTokens: number | undefined
  contextWindow: number | undefined

  turns: number
  steps: number
  llmMs: number
  toolMs: number
  ttftMs: number
  ttftSteps: number
  decodeMs: number
  decodeTokens: number
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function optionalNum(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function scaled(n: number): string {
  return n >= 100 ? String(Math.round(n)) : String(Math.round(n * 10) / 10)
}

function fmtTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0'
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${scaled(n / 1_000)}K`
  return `${scaled(n / 1_000_000)}M`
}

function fmtMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0ms'
  if (ms < 1_000) return `${Math.round(ms)}ms`
  const s = ms / 1_000
  if (s < 60) return `${Math.round(s * 10) / 10}s`
  const whole = Math.round(s)
  return `${Math.floor(whole / 60)}m${whole % 60}s`
}

function fmtDate(epochMs: number | undefined): string {
  if (epochMs === undefined) return 'n/a'
  const d = new Date(epochMs)
  return Number.isNaN(d.getTime()) ? 'n/a' : d.toISOString()
}

function collect(invocation: CommandInvocation, ctx: Context): SessionInfo {
  const { agent } = invocation
  const header = agent.session.header
  const options = agent.options
  // Authoritative live selection: the entry point installs the agent's current
  // provider/model on its scoped context through `installModelSelection` (the
  // picker switch is applied there immediately, before the next request logs a
  // header). Fall back to the creation-time options when no selection seam is
  // installed (e.g. a minimal custom entry point).
  const selected = agent.ctx.modelSelection

  const snapshot = ctx.sessionProjections.snapshot(agent.session)
  const values = snapshot.values as unknown as Record<string, unknown>
  const usage = values.tokenUsage as Record<string, unknown> | undefined
  const lifetime = values.tokenUsageLifetime as Record<string, unknown> | undefined
  const pressure = values.contextPressure as Record<string, unknown> | undefined
  const stats = values.sessionStats as Record<string, unknown> | undefined

  return {
    id: String(agent.id),
    createdAt: typeof header.createdAt === 'number' ? header.createdAt : undefined,
    cwd: header.cwd,
    agentPreset: header.agentPreset,
    provider: selected?.provider ?? options?.provider,
    model: selected?.model ?? options?.model,

    uncachedInputTokens: num(usage?.uncachedInputTokens),
    cacheReadTokens: num(usage?.cacheReadTokens),
    cacheWriteTokens: num(usage?.cacheWriteTokens),
    outputTokens: num(usage?.outputTokens),

    // Whole-session totals that survive compaction. Fall back to the
    // resettable buckets when the lifetime projection is absent (an older
    // token-meter, or a minimal composition that never registered it), so the
    // report degrades to the since-compact figures rather than showing zero.
    lifetimeUncachedInputTokens: num(lifetime?.uncachedInputTokens ?? usage?.uncachedInputTokens),
    lifetimeCacheReadTokens: num(lifetime?.cacheReadTokens ?? usage?.cacheReadTokens),
    lifetimeCacheWriteTokens: num(lifetime?.cacheWriteTokens ?? usage?.cacheWriteTokens),
    lifetimeOutputTokens: num(lifetime?.outputTokens ?? usage?.outputTokens),

    pressureTokens: optionalNum(pressure?.pressureTokens),
    projectedTokens: optionalNum(pressure?.projectedTokens),
    contextWindow: optionalNum(pressure?.contextWindow),

    turns: num(stats?.turns),
    steps: num(stats?.steps),
    llmMs: num(stats?.llmMs),
    toolMs: num(stats?.toolMs),
    ttftMs: num(stats?.ttftMs),
    ttftSteps: num(stats?.ttftSteps),
    decodeMs: num(stats?.decodeMs),
    decodeTokens: num(stats?.decodeTokens),
  }
}

/** Render the report, keeping cumulative billing apart from current pressure. */
export function renderSessionInfo(info: SessionInfo): string {
  const billed = info.uncachedInputTokens + info.cacheReadTokens + info.cacheWriteTokens
  const lifetimeBilled = info.lifetimeUncachedInputTokens
    + info.lifetimeCacheReadTokens + info.lifetimeCacheWriteTokens
  const occupancy = info.contextWindow !== undefined && info.contextWindow > 0 && info.projectedTokens !== undefined
    ? ` (${Math.min(100, Math.round(info.projectedTokens / info.contextWindow * 100))}% of ${fmtTokens(info.contextWindow)})`
    : ''
  const ttft = info.ttftSteps > 0
    ? `${fmtMs(info.ttftMs / info.ttftSteps)} avg over ${info.ttftSteps} steps`
    : 'n/a'

  return [
    'Session',
    `  id       ${info.id}`,
    `  created  ${fmtDate(info.createdAt)}`,
    `  cwd      ${info.cwd ?? 'n/a'}`,
    `  preset   ${info.agentPreset ?? 'n/a'}`,
    `  model    ${info.provider ?? '?'}/${info.model ?? '?'}`,
    '',
    'Token usage (lifetime; across all compactions)',
    `  fresh input   ${fmtTokens(info.lifetimeUncachedInputTokens)}`,
    `  cache read    ${fmtTokens(info.lifetimeCacheReadTokens)}`,
    `  cache write   ${fmtTokens(info.lifetimeCacheWriteTokens)}`,
    `  billed input  ${fmtTokens(lifetimeBilled)}`,
    `  output        ${fmtTokens(info.lifetimeOutputTokens)}`,
    '',
    'Token usage (since last /compact)',
    `  fresh input   ${fmtTokens(info.uncachedInputTokens)}`,
    `  cache read    ${fmtTokens(info.cacheReadTokens)}`,
    `  cache write   ${fmtTokens(info.cacheWriteTokens)}`,
    `  billed input  ${fmtTokens(billed)}`,
    `  output        ${fmtTokens(info.outputTokens)}`,
    '',
    'Context pressure (current, prompt side only)',
    `  pressure    ${info.pressureTokens !== undefined ? fmtTokens(info.pressureTokens) : 'n/a'}`,
    `  projected   ${info.projectedTokens !== undefined ? fmtTokens(info.projectedTokens) : 'n/a'}${occupancy}`,
    '',
    'Activity (whole log)',
    `  turns          ${info.turns}`,
    `  steps          ${info.steps}`,
    `  model time     ${fmtMs(info.llmMs)}`,
    `  tool time      ${fmtMs(info.toolMs)}`,
    `  first token    ${ttft}`,
    `  decode time    ${fmtMs(info.decodeMs)}`,
    `  decode tokens  ${fmtTokens(info.decodeTokens)}`,
  ].join('\n')
}

export function executeSessionInfo(
  ctx: Context,
  invocation: CommandInvocation,
): CommandResult {
  if (invocation.rawInput.trim().length > 0) {
    return { kind: 'error', text: USAGE }
  }
  try {
    return { kind: 'success', text: renderSessionInfo(collect(invocation, ctx)) }
  } catch (error: unknown) {
    return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
  }
}

/** Register `/sessioninfo`. */
export function apply(ctx: Context): void {
  ctx.effect(function* () {
    yield ctx.commands.register({
      name: 'sessioninfo',
      description: 'report session token usage, context pressure, and activity',
      recordInput: false,
      handler: invocation => executeSessionInfo(ctx, invocation),
    })
  }, 'command-session-info lifecycle')
}
