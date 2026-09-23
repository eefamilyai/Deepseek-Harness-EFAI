# @deepseek-ai/dsh-roster

The **runtime tool roster**: which tools the model may see and call, decided per
turn instead of once at boot.

Two independent categories, both live config fields of this row:

| Category | Field | What it owns |
|---|---|---|
| Kernel | `kernel`, `rlm` | the acting surface over the persistent Python namespace: the `kernel` tool, or the `rlm` engine in its place |
| Tools | `enabled`, `tools.<name>` | the conventional roster |

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

## How a change arrives

Every field is declared `.volatile()`, so Settings edits it by this row's id
(`tool-roster`) and the Loader commits the new value into the running plugin
without remounting it, then emits `loader/volatile-update`. The plugin re-reads
its fields into PENDING there; the turn boundary promotes it. The row keeps its
fields off upstream's generated pages because the fork's Tools section
(`@deepseek-ai/dsh-client-ui-settings-tools`) renders the three switches.

## Settings

| Field | Default | Applies |
|---|---|---|
| `kernel` | `true` | live, at the end of the turn in flight |
| `rlm` | `false` | live, at the end of the turn in flight |
| `enabled` | `true` | live, at the end of the turn in flight |
| `tools.<name>` | `true` | live, at the end of the turn in flight |

A tool absent from `tools` is enabled, so a newly mounted tool is available
until someone turns it off. Choosing a preset's tools belongs to upstream's
preset editor; the per-tool map is for withdrawing one host-plane tool from
every preset at once, and has no page of its own.

## Model Experience

Indirectly: the roster decides which tool schemas and which `tool:<name>`
guidance sections reach the assembled prompt.

#### KV Cache effect

A changed roster changes the assembled tool list, which forces a new request
series and invalidates the provider's cached prefix from that point. The change
lands at the end of the turn in flight, never mid-turn.

Fork-owned: `packages/kernel/roster` is Tier 1, so it touches no upstream file.
