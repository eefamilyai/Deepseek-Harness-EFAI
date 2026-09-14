# @deepseek-ai/dsh-tool-roster

The **runtime tool roster**: which tools the model may see and call, decided per
turn instead of once at boot.

Two independent categories, both live:

| Category | Setting | What it owns |
|---|---|---|
| Kernel | `kernel.enabled` | the `kernel` tool — Python in a persistent namespace |
| Tools | `tools.enabled`, `tools.tools.<name>` | the conventional roster, one switch per tool |

Either can be switched off alone, and both can be on at once.

## Why this exists

A tool plugin registers its system-prompt section when it mounts. Hiding a tool
without unmounting it would leave the model reading instructions for a function
it cannot call; unmounting it makes the roster a Loader fact, and a Loader
`disabled` expression is read once at boot. That is the tension this package
resolves — and it resolves it without unmounting anything.

`system-prompt/assemble` is a scope-filtered waterfall whose argument carries
BOTH the tool schemas and the prompt sections, and whose return value is
authoritative. One listener therefore drops a disabled tool and its guidance
together. The seam existed for exactly this.

## Three properties that make it safe

- **The roster is stable for a whole turn.** Assembly runs once per step, so an
  unguarded settings change would change the model's hands between steps. A
  change is held as PENDING and promoted at `agent/turn-stopping` — the serial
  point awaited before a completed turn commits — so a toggle lands exactly when
  the model stops generating.
- **Visibility is not enforcement.** Filtering the assembly does not remove a
  tool from the execution path: the registry still resolves a name the model
  remembers from earlier in the conversation. A monotonic `tools.guard()` denies
  those calls, so a hidden tool is also an uncallable one.
- **The change is announced.** A different roster changes the assembled tool
  list, which the agent loop records as a new request series. That is the
  prompt-cache invalidation the settings surface warns about.

## How a tool name reaches the settings surface

`base.tools` is seeded from `ctx.tools.schemas()` when the plugin initializes,
so the names come from the composition that mounted them and a configuration
surface renders one switch per tool without a hardcoded list.

`ctx.tools.schemas()` sees the GLOBAL registry only. A plugin that installs its
tool into each agent's own scope — the subagent family does exactly that — never
appears there, so `SCOPED_TOOL_NAMES` names those tools explicitly. A name the
deployment does not mount simply stays absent from the assembly.

## Settings

| Key | Default | Applies |
|---|---|---|
| `tools.enabled` | `true` | `live` |
| `tools.tools.<name>` | `true` | `live` |

A tool absent from `tools.tools` is enabled, so a newly mounted tool is
available until someone turns it off.

## Model Experience

Indirectly: the roster decides which tool schemas and which `tool:<name>`
guidance sections reach the assembled prompt.

#### KV Cache effect

A changed roster changes the assembled tool list, which forces a new request
series and invalidates the provider's cached prefix from that point. The change
lands at the end of the turn in flight, never mid-turn.

Fork-owned: `packages/kernel/tool-roster` is Tier 1, so it touches no upstream file.
