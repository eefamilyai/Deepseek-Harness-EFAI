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
 *   name: '@deepseek-ai/dsh-tool-roster'
 * ```
 *
 * @module @deepseek-ai/dsh-tool-roster
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-agent'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'tool-roster'

/** The settings namespace holding the roster. */
export const TOOLS_SETTINGS_NAMESPACE = 'tools'

/** Default for the tools category switch. */
export const TOOLS_ENABLED_DEFAULT = true

/** The settings namespace the kernel switch lives in, owned by kernel-mode. */
export const KERNEL_SETTINGS_NAMESPACE = 'kernel'

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
 * Tool names registered into an AGENT's own scope rather than the global layer.
 *
 * `tools.schemas()` with no scope sees only the global registry, so a tool a
 * plugin installs per agent — the subagent family does exactly that — never
 * reaches the seeded per-tool defaults. Naming them here keeps them visible in
 * the settings surface, where the operator expects every tool they can call.
 * A name the deployment does not mount simply stays absent from the assembly.
 */
const SCOPED_TOOL_NAMES = [
  'subagent',
  'subagent_fork',
  'send_message',
  'list_agents',
  'interrupt_agent',
] as const

/** One resolved roster: the two category switches and the per-tool overrides. */
export interface Roster {
  /** Whether the conventional tools category is on. */
  readonly toolsEnabled: boolean
  /** Whether the kernel tool is available. */
  readonly kernelEnabled: boolean
  /** Per-tool overrides; a name absent here is enabled. */
  readonly overrides: Readonly<Record<string, boolean>>
}

/** Plugin config: the composition-layer roster, resolved under the user layer. */
export interface Config {
  /**
   * Whether the conventional tool roster is available. Off, every non-kernel
   * tool leaves the model's prompt and refuses to execute.
   */
  enabled?: boolean
  /**
   * Per-tool overrides. A name absent here is enabled, so a newly mounted tool
   * is available until someone turns it off.
   */
  tools?: Record<string, boolean>
}

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(TOOLS_ENABLED_DEFAULT)
    .description('Make the conventional tools available to the model. Turn this off to'
      + ' withdraw every tool in the category at once; the kernel category is separate.'),
  tools: z.dict(z.boolean()).default({})
    .description('Per-tool switches. A tool absent from this map is available.'),
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
 * Read the two namespaces and resolve them into one roster.
 * @param tools - the `tools` namespace section, when registered.
 * @param kernelEnabled - the `kernel.enabled` value.
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
 * @param config - the composition-layer roster, resolved under the user layer.
 */
export function apply(ctx: Context, config: Config): void {
  const configured = config.enabled ?? TOOLS_ENABLED_DEFAULT
  const initial: Roster = {
    toolsEnabled: configured,
    kernelEnabled: true,
    overrides: config.tools ?? {},
  }
  // `active` is the roster the model is currently working under; `pending` is
  // what settings say now. They diverge only between a toggle and the end of the
  // turn in flight, which is exactly the contract.
  let active = initial
  let pending = initial

  ctx.inject(['settings', 'tools', 'systemPrompt'], (runtime) => {
    // Seeding `base.tools` from the registry is what lets a configuration
    // surface render one switch per tool without hardcoding a list: the names
    // arrive from the composition that mounted them.
    const mounted = [
      ...runtime.tools.schemas().map(schema => schema.name),
      ...SCOPED_TOOL_NAMES,
    ]
    const section = runtime.settings.register(TOOLS_SETTINGS_NAMESPACE, Config, {
      base: {
        enabled: configured,
        tools: Object.fromEntries(mounted.map(tool => [tool, true])),
      },
      applies: 'live',
    })

    const readKernel = (): boolean => {
      const raw = runtime.settings.get(KERNEL_SETTINGS_NAMESPACE)
      if (typeof raw !== 'object' || raw === null) return active.kernelEnabled
      const enabled = (raw as { enabled?: unknown }).enabled
      return typeof enabled === 'boolean' ? enabled : active.kernelEnabled
    }
    const refresh = (): void => {
      pending = resolveRoster(section.get(), readKernel())
    }
    refresh()
    section.watch(() => { refresh() })
    runtime.on('settings/updated', (ns: string) => {
      if (ns === KERNEL_SETTINGS_NAMESPACE) refresh()
    })

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
