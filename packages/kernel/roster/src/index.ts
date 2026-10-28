/**
 * The runtime tool roster: which tools the model may see and call, decided per
 * turn instead of once at boot.
 *
 * A tool plugin registers its system-prompt section when it mounts, so hiding a
 * tool without unmounting it leaves the model reading instructions for a
 * function it cannot call. Unmounting it instead makes the roster a Loader fact,
 * and a Loader fact is read once at boot — which is why the previous switch
 * demanded a restart.
 *
 * This package resolves that tension without touching the composition, through
 * the two seams the registry offers. A tool the registry can mask is denied in
 * the Agent's own scope at `agent/pre-step`, so it leaves that step's admitted
 * set and its declaration leaves the request. A tool a preset registers in its
 * own scope cannot be masked there; for those the roster drops the tool's
 * `tool:<name>` guidance section from the assembly and refuses the call.
 *
 * Three properties make that safe:
 *
 * - **The roster is stable for a whole turn.** Both hooks run per step, so an
 *   unguarded settings change would change the model's hands between steps. A
 *   change is held as PENDING and promoted at `agent/turn-stopping` — the
 *   serial point awaited before a completed turn commits — so a toggle lands
 *   exactly when the model stops generating.
 * - **Visibility is not enforcement.** Neither the mask nor the dropped section
 *   stops a model that remembers the name from earlier in the conversation. A
 *   monotonic `tools.guard()` denies those calls, so a hidden tool is also an
 *   uncallable one.
 * - **The change is announced.** A different admitted set changes the request,
 *   which the agent loop records as a new request series. That is the
 *   prompt-cache invalidation a configuration surface warns about.
 *
 * ```yaml
 * - id: tool-roster
 *   name: '@deepseek-ai/dsh-tool-roster'
 * ```
 *
 * @module @deepseek-ai/dsh-tool-roster
 */

import type { Context, Volatile } from '@deepseek-ai/cordis'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-settings'
// The Loader's `loader/volatile-update` event and `fiber.entry`.
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-agent'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'tool-roster'

/**
 * The profile entry id the roster is composed under, which is also the id a
 * configuration surface edits it by.
 */
export const TOOL_ROSTER_ENTRY_ID = 'tool-roster'

/** Default for the tools category switch. */
export const TOOLS_ENABLED_DEFAULT = true

/** Default for the kernel switch: the kernel is the fork's acting surface. */
export const KERNEL_ENABLED_DEFAULT = true

/**
 * The tool the PTC presentation transport reserves.
 *
 * Deliberately exempt: it is a transport rather than a capability, and the
 * registry refuses to let a restriction name it at all.
 */
const RUN_CODE_NAME = 'run_code'

/** The one tool the kernel category switch owns. */
const KERNEL_TOOL_NAME = 'kernel'

/** One resolved roster: the two category switches and the per-tool overrides. */
export interface Roster {
  /** Whether the conventional tools category is on. */
  readonly toolsEnabled: boolean
  /** Whether the kernel tool is available. */
  readonly kernelEnabled: boolean
  /** Per-tool overrides; a name absent here is enabled. */
  readonly overrides: Readonly<Record<string, boolean>>
}

/**
 * Plugin config. Every field is live: an edit reaches the running plugin
 * without a remount, is held as pending, and lands at the end of the turn in
 * flight.
 */
export interface Config {
  /**
   * Whether the persistent Python kernel is available to the model. Off, the
   * `kernel` tool leaves the prompt; the conventional roster is unaffected.
   */
  kernel: Volatile<boolean>
  /**
   * Whether the conventional tool roster is available. Off, every non-kernel
   * tool leaves the model's prompt and refuses to execute.
   */
  enabled: Volatile<boolean>
  /**
   * One switch per tool, which the Tools settings page renders as a list. The
   * roster adds an entry (enabled) the first time it mounts a switchable tool,
   * so the map is the deployment's roster rather than only the names someone
   * already withdrew; the values are the switches, and a name absent from the
   * map is still available. Tools whose visibility no switch controls, and the
   * kernel tool its own category switch governs, get no entry.
   */
  tools: Volatile<Record<string, boolean>>
}

export const Config = z.object({
  kernel: z.boolean().default(KERNEL_ENABLED_DEFAULT)
    .description('Make the kernel tool available: run Python in a persistent namespace, where'
      + ' reading a file, editing it, searching the tree, and running a command are'
      + ' function calls inside it. Independent of the conventional tool roster.'
      + ' Applies when the model next stops generating.')
    .volatile(),
  enabled: z.boolean().default(TOOLS_ENABLED_DEFAULT)
    .description('Make the conventional tools available to the model. Turn this off to'
      + ' withdraw every tool in the category at once; the kernel category is separate.')
    .volatile(),
  tools: z.dict(z.boolean()).default({})
    .description('Per-tool switches, one entry per switchable tool. A tool absent from this map'
      + ' is available; the roster adds an entry (enabled) the first time it sees a newly'
      + ' mounted tool, so the settings page can offer a switch for every one of them.'
      + ' Applies when the model next stops generating.')
    .volatile(),
})

/** Normalize a tool or section name so `web_fetch` and `web-fetch` compare equal. */
function normalize(toolName: string): string {
  return toolName.replace(/-/g, '_')
}

/**
 * Decide whether one tool name is visible under a roster.
 *
 * The two category switches are independent, which is the point: the kernel can
 * be on while the conventional roster is on, off, or anywhere between.
 * @param roster - the roster in force.
 * @param toolName - the tool name as registered.
 * @returns whether the model may see and call it.
 */
export function toolVisible(roster: Roster, toolName: string): boolean {
  if (toolName === RUN_CODE_NAME) return true
  if (toolName === KERNEL_TOOL_NAME) return roster.kernelEnabled
  if (!roster.toolsEnabled) return false
  // Keyed by the normalized name: a switch is written against a section's
  // spelling, and the registry's spelling of the same tool can differ by a dash.
  return roster.overrides[normalize(toolName)] !== false
}

/**
 * Names of the tools a roster hides, out of every mounted tool.
 *
 * A section is dropped only when its tool is one this roster actually hides.
 * A `tool:<x>` section naming something absent from the roster entirely is left
 * alone: several packages contribute sections named after a capability rather
 * than a registered tool, and dropping those would silently strip guidance the
 * roster never meant to touch.
 * @param roster - the roster in force.
 * @param mounted - every tool name the assembly carried.
 * @returns normalized names of the hidden tools.
 */
export function hiddenToolNames(roster: Roster, mounted: readonly string[]): ReadonlySet<string> {
  return new Set(mounted.filter(tool => !toolVisible(roster, tool)).map(normalize))
}

/**
 * Whether an assembled prompt section belongs to a hidden tool.
 * @param hidden - normalized hidden tool names.
 * @param sectionName - the assembled section name.
 * @returns whether the section must be dropped from the assembly.
 */
export function sectionHidden(hidden: ReadonlySet<string>, sectionName: string): boolean {
  if (!sectionName.startsWith('tool:')) return false
  return hidden.has(normalize(sectionName.slice('tool:'.length)))
}

/**
 * Resolve the configured switches into one roster.
 * @param tools - the conventional-tools switch and the per-tool overrides.
 * @param kernelEnabled - the kernel switch.
 * @returns the roster those settings describe.
 */
export function resolveRoster(
  tools: { enabled?: boolean; tools?: Record<string, boolean> } | undefined,
  kernelEnabled: boolean,
): Roster {
  const overrides: Record<string, boolean> = {}
  for (const [tool, enabled] of Object.entries(tools?.tools ?? {})) {
    overrides[normalize(tool)] = enabled
  }
  return {
    toolsEnabled: tools?.enabled ?? TOOLS_ENABLED_DEFAULT,
    kernelEnabled,
    overrides,
  }
}

/**
 * Whether two rosters would assemble the same tool list.
 * @param left - one roster.
 * @param right - the roster to compare.
 * @returns whether they agree on every switch.
 */
export function sameRoster(left: Roster, right: Roster): boolean {
  if (left.toolsEnabled !== right.toolsEnabled) return false
  if (left.kernelEnabled !== right.kernelEnabled) return false
  const names = new Set([...Object.keys(left.overrides), ...Object.keys(right.overrides)])
  for (const tool of names) {
    if ((left.overrides[tool] ?? true) !== (right.overrides[tool] ?? true)) return false
  }
  return true
}

/**
 * Install the runtime roster.
 *
 * The plugin stays mounted in both positions of both switches. A switch that
 * disappeared when switched off could never be switched back on, and this one
 * also has to keep watching for the change that turns it back on.
 * @param ctx - the plugin context.
 * @param config - the live roster fields, read afresh on every change.
 */
export function apply(ctx: Context, config: Config): void {
  const read = (): Roster => resolveRoster(
    { enabled: config.enabled.get(), tools: config.tools.get() },
    config.kernel.get(),
  )
  // `active` is the roster the model is currently working under; `pending` is
  // what the configuration says now. They diverge only between a toggle and the
  // end of the turn in flight, which is exactly the contract. Both start on the
  // configuration: no turn is in flight at mount, so there is no change to hold.
  let active = read()
  let pending = active

  // The configuration surface writes the profile; the loader commits the new
  // values into these fields and tells this plugin which ones moved.
  ctx.on('loader/volatile-update', () => { pending = read() })

  // The page is the fork's Tools section, so the generic form would repeat it.
  ctx.inject(['settings'], (child) => { child.effect(() => child.settings.configure({ auto: false }, ctx.fiber)) })

  /**
   * Learn a roster into this configuration's own per-tool map.
   *
   * The map is what the Tools page renders as switches, and a map that held only
   * the names someone already withdrew could not offer a switch for anything the
   * operator has not touched yet — the page would list the tools that are off and
   * nothing else. So the roster records every switchable tool it is shown as
   * enabled the first time it sees it: the entries are the page's list, the values
   * are the switches. A tool absent from the map is still available, so a
   * deployment that refuses the write loses the listing and nothing else.
   *
   * The names come from an assembled prompt, not from `ctx.tools.schemas()`: that
   * call reads the *global* view, and every tool a preset registers is scoped to
   * its agent, so the registry alone yields a list of the handful of globally
   * registered tools. What the prompt service assembles for an agent is the set
   * that agent can actually be offered, which is the set this page exists to
   * switch; the registry is read too, at mount, so a row that has never assembled
   * a prompt still starts from something.
   *
   * Writes are additive by construction: one `set` per unseen name, never an
   * update of a name that is already there, so a write can never race the
   * operator's own flip of an existing switch.
   * @param ctx2 - plugin context, for the optional settings service.
   * @param config2 - the live roster fields.
   * @param names - the tool names to record, in the order they were seen.
   */
  const learnRoster = (ctx2: Context, config2: Config, names: readonly string[]): void => {
    const settings = ctx2.get('settings')
    if (settings === undefined) return
    const known = config2.tools.get()
    const additions = [...new Set(names.map(normalize))]
      // The run-code alias is not switchable (`toolVisible` always answers yes),
      // so it is not a switch this page could honour; the kernel tool has the
      // category switch above.
      .filter(name => name !== RUN_CODE_NAME && name !== KERNEL_TOOL_NAME && !(name in known))
    if (additions.length === 0) return
    void settings.mutate(TOOL_ROSTER_ENTRY_ID, additions.map(name => ({
      op: 'set' as const,
      path: ['tools', name],
      value: true,
    }))).catch(() => {
      // A profile that refuses writes (memory mode, or a read-only document)
      // keeps the map as it is; the switches it already has still work.
    })
  }

  ctx.inject(['tools', 'systemPrompt'], (runtime) => {
    /**
     * Restriction this plugin installed in one agent scope, so a roster change
     * replaces the mask instead of stacking another one on top.
     */
    const denials = new WeakMap<Context, { names: string; dispose: () => void }>()

    /**
     * Narrow one agent's tool set to what the roster leaves switched on.
     *
     * `tools.restrict` is the registry's own mask: a denied tool leaves the step's
     * admitted set, so its schema leaves the request and a call naming it answers
     * `UNKNOWN_TOOL`. The registry accepts only names the scope inherits, so a tool
     * a preset registers in its own scope cannot be masked here and stays declared;
     * the guard below is what refuses those, and it refuses everything either way.
     * @param agentCtx - the agent's scoped context.
     */
    const denyHidden = (agentCtx: Context): void => {
      // `schemas()` with no argument answers the global view; the mask only
      // shows in the view of the scope that owns it.
      const mounted = agentCtx.tools.schemas(scopeOf(agentCtx)).map(schema => schema.name)
      // Raw names, not the normalized ones: the registry matches its own spelling.
      const hidden = mounted.filter(name => !toolVisible(active, name)).sort()
      const key = hidden.join(',')
      const installed = denials.get(agentCtx)
      if (installed?.names === key) return
      installed?.dispose()
      denials.delete(agentCtx)
      if (hidden.length === 0) return
      const accepted: string[] = []
      for (const name of hidden) {
        try {
          // Probe one name at a time: the batch call rejects the whole mask when a
          // single name is not the registry's to restrict, and a scope-local tool is
          // the guard's business rather than a failure here.
          const probe = agentCtx.tools.restrict({ deny: [name] })
          probe()
          accepted.push(name)
        } catch (error) {
          if (!(error instanceof Error) || !error.message.includes('unknown global tool')) throw error
        }
      }
      if (accepted.length === 0) return
      denials.set(agentCtx, { names: key, dispose: agentCtx.tools.restrict({ deny: accepted }) })
    }

    // 1. The prompt: a hidden tool's guidance goes with it. Tool declarations are
    //    the registration's own now, so the mask above is what removes them.
    runtime.on('system-prompt/assemble', async (_assembly, context, next) => {
      const out = await next()
      const mounted = runtime.tools.schemas(context.scope).map(schema => schema.name)
      // Before this plugin's own filter: a tool switched off is exactly the entry
      // the page has to keep showing, and the registry's view is where the
      // agent-scoped ones appear.
      learnRoster(ctx, config, mounted)
      const hidden = hiddenToolNames(active, mounted)
      if (hidden.size === 0) return out
      return { ...out, sections: out.sections.filter(entry => !sectionHidden(hidden, entry.name)) }
    })

    // 2. The scope mask follows the roster: it is applied where an agent is in
    //    hand, so a switch turned off during one turn reaches the next one.
    runtime.on('agent/pre-step', ({ agent }, next) => {
      denyHidden(agent.ctx)
      return next()
    })

    // The page renders a switch per entry of this map. At mount the registry has
    // only the global registrations; the assemble hook in (1) adds everything an
    // agent can be offered.
    learnRoster(ctx, config, runtime.tools.schemas().map(schema => schema.name))

    // 3. Execution: neither the mask nor the guidance covers a model that
    //    remembers the name, so a hidden tool must also refuse to run.
    runtime.tools.guard(execution =>
      toolVisible(active, execution.name)
        ? undefined
        : `tool "${execution.name}" is switched off in settings; turn it on to call it`,
    )

    // 4. The turn boundary: hold a change until the model stops generating, so
    //    one turn never changes hands between its steps.
    runtime.on('agent/turn-stopping', () => {
      if (!sameRoster(pending, active)) active = pending
    })
  })
}
