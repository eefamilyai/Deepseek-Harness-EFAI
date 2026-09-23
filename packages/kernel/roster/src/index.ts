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
 * This package resolves that tension by filtering the assembled prompt rather
 * than the composition: `system-prompt/assemble` is a scope-filtered waterfall
 * whose argument carries BOTH the tool schemas and the prompt sections, so one
 * listener drops a disabled tool and its guidance together.
 *
 * Three properties make that safe:
 *
 * - **The roster is stable for a whole turn.** `system-prompt/assemble` runs
 *   once per step, so an unguarded settings change would change the model's
 *   hands between steps. A change is held as PENDING and promoted at
 *   `agent/turn-stopping` — the serial point awaited before a completed turn
 *   commits — so a toggle lands exactly when the model stops generating.
 * - **Visibility is not enforcement.** Filtering the assembly does not remove a
 *   tool from the execution path: the registry still resolves a name the model
 *   remembers from earlier in the conversation. A monotonic `tools.guard()`
 *   denies those calls, so a hidden tool is also an uncallable one.
 * - **The change is announced.** A different roster changes the assembled tool
 *   list, which the agent loop records as a new request series. That is the
 *   prompt-cache invalidation a configuration surface warns about.
 *
 * ```yaml
 * - id: tool-roster
 *   name: '@deepseek-ai/dsh-roster'
 * ```
 *
 * @module @deepseek-ai/dsh-roster
 */

import type { Context, Volatile } from '@deepseek-ai/cordis'
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

/** Default for the RLM switch: the standalone kernel tool unless asked. */
export const RLM_ENABLED_DEFAULT = false

/**
 * The tool the PTC presentation transport reserves.
 *
 * Deliberately exempt: it is a transport rather than a capability, and the
 * registry refuses to let a restriction name it at all.
 */
const RUN_CODE_NAME = 'run_code'

/** The one tool the kernel category switch owns. */
const KERNEL_TOOL_NAME = 'kernel'

/**
 * The tool the RLM engine registers.
 *
 * It and `kernel` are the two acting surfaces over the same Python namespace,
 * and exactly one of them is offered: the engine drives the REPL recursively,
 * so a model holding both would be told to act two ways at once.
 */
const RLM_TOOL_NAME = 'rlm'

/** One resolved roster: the two category switches and the per-tool overrides. */
export interface Roster {
  /** Whether the conventional tools category is on. */
  readonly toolsEnabled: boolean
  /** Whether the kernel tool is available. */
  readonly kernelEnabled: boolean
  /**
   * Whether the RLM engine owns acting. On, the `rlm` tool is the kernel
   * category's surface and the `kernel` tool is withdrawn; off, the reverse.
   * Both require `kernelEnabled`, because the engine runs on the same seam.
   */
  readonly rlmEnabled: boolean
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
   * `kernel` and `rlm` tools both leave the prompt; the conventional roster is
   * unaffected.
   */
  kernel: Volatile<boolean>
  /**
   * Whether the recursive RLM engine is the kernel category's surface instead
   * of the standalone `kernel` tool. Requires `kernel`.
   */
  rlm: Volatile<boolean>
  /**
   * Whether the conventional tool roster is available. Off, every non-kernel
   * tool leaves the model's prompt and refuses to execute.
   */
  enabled: Volatile<boolean>
  /**
   * Per-tool overrides. A name absent here is enabled, so a newly mounted tool
   * is available until someone turns it off. Choosing a preset's tools is the
   * preset editor's job; this map is for withdrawing one host-plane tool.
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
  rlm: z.boolean().default(RLM_ENABLED_DEFAULT)
    .description('Offer the recursive RLM engine instead of the standalone kernel tool. Requires'
      + ' the kernel. Applies when the model next stops generating.')
    .volatile(),
  enabled: z.boolean().default(TOOLS_ENABLED_DEFAULT)
    .description('Make the conventional tools available to the model. Turn this off to'
      + ' withdraw every tool in the category at once; the kernel category is separate.')
    .volatile(),
  tools: z.dict(z.boolean()).default({})
    .description('Per-tool switches. A tool absent from this map is available.')
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
  if (toolName === KERNEL_TOOL_NAME) return roster.kernelEnabled && !roster.rlmEnabled
  if (toolName === RLM_TOOL_NAME) return roster.kernelEnabled && roster.rlmEnabled
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
 * @param rlmEnabled - the RLM switch.
 * @returns the roster those settings describe.
 */
export function resolveRoster(
  tools: { enabled?: boolean; tools?: Record<string, boolean> } | undefined,
  kernelEnabled: boolean,
  rlmEnabled: boolean,
): Roster {
  const overrides: Record<string, boolean> = {}
  for (const [tool, enabled] of Object.entries(tools?.tools ?? {})) {
    overrides[normalize(tool)] = enabled
  }
  return {
    toolsEnabled: tools?.enabled ?? TOOLS_ENABLED_DEFAULT,
    kernelEnabled,
    rlmEnabled,
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
  if (left.rlmEnabled !== right.rlmEnabled) return false
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
    config.rlm.get(),
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

  ctx.inject(['tools', 'systemPrompt'], (runtime) => {
    // 1. The prompt: drop a hidden tool's schema and its guidance together. The
    //    returned assembly is authoritative, which is what makes this possible
    //    without unmounting anything.
    runtime.on('system-prompt/assemble', async (_assembly, _context, next) => {
      const out = await next()
      const hidden = hiddenToolNames(active, out.tools.map(tool => tool.name))
      if (hidden.size === 0) return out
      return {
        ...out,
        tools: out.tools.filter(tool => !hidden.has(normalize(tool.name))),
        sections: out.sections.filter(entry => !sectionHidden(hidden, entry.name)),
      }
    })

    // 2. Execution: filtering the prompt does not stop a model that remembers
    //    the name, so a hidden tool must also refuse to run.
    runtime.tools.guard(execution =>
      toolVisible(active, execution.name)
        ? undefined
        : `tool "${execution.name}" is switched off in settings; turn it on to call it`,
    )

    // 3. The turn boundary: hold a change until the model stops generating, so
    //    one turn never changes hands between its steps.
    runtime.on('agent/turn-stopping', () => {
      if (!sameRoster(pending, active)) active = pending
    })
  })
}
