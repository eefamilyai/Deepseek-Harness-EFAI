/**
 * Two ways a skill body reaches the model that upstream's `tool-skill` does
 * not provide: the `@skill <name>` gesture, and names whose body must outlive
 * a compaction.
 *
 * **The gesture.** `/name` is the user-explicit load gesture upstream reads.
 * The fork's client `@` picker lands `@skill <name>` instead, and an unread
 * gesture ships dead prose to the model — the user asked for a procedure and
 * got the words "@skill dsh-session-history".
 *
 * **The always-loaded bodies.** After a compaction the catalog republishes
 * `{name, description}` for every skill, but a *body* only ever entered the
 * surface through a gesture, so a recovery procedure the model was told to
 * follow is reduced to its own name exactly when it is needed most. The names
 * configured here re-enter beside every catalog publication instead.
 *
 * Both ride `agent/pre-step`, the same waterfall `tool-skill` uses, so this is
 * an ordinary second listener rather than an edit to that package. Injections
 * this plugin adds carry the same `skill-invocation` source a gesture produces,
 * so every transcript consumer presents one shape.
 *
 * ```yaml
 * - id: skill-injection
 *   name: '@deepseek-ai/dsh-skill-injection'
 *   config:
 *     alwaysLoadSkills: ['dsh-session-history']
 * ```
 *
 * @module @deepseek-ai/dsh-skill-injection
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { isModelInvocable, renderSkillContent } from '@deepseek-ai/dsh-skill'
import type { SkillLookupOptions } from '@deepseek-ai/dsh-skill'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'skill-injection'

/** The registry supplies the bodies; the agent loop supplies the step. */
export const inject = ['skills']

/** Names whose body re-enters after a compaction prunes it, unless configured otherwise. */
export const DEFAULT_ALWAYS_LOAD_SKILLS: readonly string[] = ['dsh-session-history']

/**
 * A whitespace-bounded `@skill <name>` token.
 *
 * The same word-boundary shape as upstream's `/name` grammar, so a gesture
 * reads as one wherever it sits in the sentence.
 */
const SKILL_AT_GESTURE = /(^|\s)@skill\s+([a-z0-9]+(?:-[a-z0-9]+)*)(?=\s|$)/g

/** Plugin config. */
export interface Config {
  /**
   * Skill names whose full body rides every catalog publication, including the
   * republication after compaction prunes both. An empty list disables it.
   */
  alwaysLoadSkills?: string[]
  /** Whether `@skill <name>` loads a body the way `/name` does. */
  atGesture?: boolean
}

export const Config: z<Config> = z.object({
  alwaysLoadSkills: z.array(z.string()).default([...DEFAULT_ALWAYS_LOAD_SKILLS])
    .description('Skill names whose body is re-injected whenever it is no longer on the surface.'),
  atGesture: z.boolean().default(true)
    .description('Read `@skill <name>` as a skill-load gesture, like `/name`.'),
})

/**
 * Skill names whose injected body is still visible on the session surface.
 *
 * Read from the surface rather than the message list: a compaction removes a
 * body by shadowing its event, which the message list no longer shows but the
 * surface does.
 * @param agent - the agent whose surface is inspected.
 * @returns the names whose bodies the model can still read.
 */
export function visibleInvokedSkillNames(agent: Agent): Set<string> {
  const visible = new Set(agent.session.surface.nodes)
  const names = new Set<string>()
  for (const event of agent.session.ownEvents()) {
    if (event.type !== 'user/message' || event.data.source.kind !== 'skill-invocation') continue
    if (visible.has(event.seq)) names.add(event.data.source.name)
  }
  return names
}

/**
 * The `@skill <name>` names one batch of user messages asks for, in order.
 * @param messages - the user messages this step admitted.
 * @returns the requested names, deduplicated, first mention first.
 */
export function atGestureNames(messages: readonly UserMessage[]): string[] {
  const names: string[] = []
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type !== 'text') continue
      for (const [, , skillName] of block.text.matchAll(SKILL_AT_GESTURE)) {
        if (skillName !== undefined && !names.includes(skillName)) names.push(skillName)
      }
    }
  }
  return names
}

/** Names whose body this step's injections already carry. */
function carriedNames(messages: readonly UserMessage[]): Set<string> {
  return new Set(messages.flatMap(message => (
    message.source.kind === 'skill-invocation' ? [message.source.name] : []
  )))
}

/**
 * Load the bodies of `names` that are available and model-invocable.
 *
 * An absent or model-disabled name is a configuration fact rather than a
 * transient miss, so it is cached: a bad entry costs one lookup per agent, not
 * one per step, while a later registry change still lands on a fresh session.
 * @param ctx - host context owning the skill registry.
 * @param lookup - registry lookup context for this step.
 * @param names - the names to load, in publication order.
 * @param already - names this step's injections already carry.
 * @param missing - per-agent cache of names that resolved to no usable body.
 * @returns one injection per loadable body.
 */
async function bodyInjections(
  ctx: Context,
  lookup: SkillLookupOptions & { scope: Agent },
  names: readonly string[],
  already: ReadonlySet<string>,
  missing: Set<string>,
): Promise<UserMessage[]> {
  const injections: UserMessage[] = []
  for (const skillName of names) {
    if (already.has(skillName) || missing.has(skillName)) continue
    const skill = await ctx.skills.get(skillName, lookup)
    if (skill === undefined || !isModelInvocable(skill)) {
      missing.add(skillName)
      continue
    }
    injections.push(createUserMessage({
      content: [{ type: 'text', text: renderSkillContent(skill) }],
      source: { kind: 'skill-invocation', name: skillName, form: 'instructions' },
    }))
  }
  return injections
}

/**
 * Install the gesture reader and the always-load re-injection.
 *
 * The listener runs after `next()`, so upstream's catalog and any `/name` body
 * are already in the decision and this only adds what is still missing.
 * @param ctx - the plugin context.
 * @param config - the resolved configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const alwaysLoad = config.alwaysLoadSkills ?? [...DEFAULT_ALWAYS_LOAD_SKILLS]
  const readAtGesture = config.atGesture ?? true
  /** Per-agent names that resolved to no usable body. */
  const missingByAgent = new WeakMap<Agent, Set<string>>()

  ctx.on('agent/pre-step', async ({ agent, messages, signal }, next): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    signal.throwIfAborted()

    const requested = readAtGesture ? atGestureNames(messages) : []
    const visible = visibleInvokedSkillNames(agent)
    const wantedAlways = alwaysLoad.filter(skillName => !visible.has(skillName))
    if (requested.length === 0 && wantedAlways.length === 0) return decision

    let missing = missingByAgent.get(agent)
    if (missing === undefined) {
      missing = new Set()
      missingByAgent.set(agent, missing)
    }
    const lookup = { cwd: agent.session.header.cwd, signal, scope: agent }
    const carried = carriedNames(decision.messages)
    // A gesture asks for the body now, even when one is already on the
    // surface; an always-load name only fills a gap.
    const added = [
      ...await bodyInjections(ctx, lookup, requested, carried, missing),
      ...await bodyInjections(
        ctx,
        lookup,
        wantedAlways.filter(skillName => !requested.includes(skillName)),
        carried,
        missing,
      ),
    ]
    if (added.length === 0) return decision
    return { ...decision, messages: [...decision.messages, ...added] }
  })
}
