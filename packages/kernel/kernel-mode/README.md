# @deepseek-ai/dsh-kernel-mode

The **kernel switch**: one setting deciding whether the persistent Python kernel is available.

Turned **on**, the model can run Python in a namespace that outlives a single call. Turned **off**, the `kernel` tool is withdrawn.

The switch owns ONE tool and one category. It no longer decides whether the conventional roster — bash, the filesystem tools, search, background jobs — is mounted: that is the separate `tools` category owned by `@deepseek-ai/dsh-tool-roster`, and the two are independent, so the kernel and the conventional tools can be on at once.

## This package owns only the setting

It stays mounted in **both** positions of its own switch. A switch that disappeared when turned off could never be turned back on.

The gating itself is `@deepseek-ai/dsh-tool-roster`, which filters the assembled prompt and guards execution. The rows in the shipped agent presets mount unconditionally; the runtime roster decides visibility per turn.

## Settings

| Key | Default | Applies |
|---|---|---|
| `kernel.enabled` | `true` | `live` |
| `kernel.browserWindow` | `false` | `restart` |

`kernel.enabled` is `live`: `@deepseek-ai/dsh-tool-roster` applies it at the end of the turn in flight, so no restart is needed. `kernel.browserWindow` stays `restart` because it is resolved once when the interpreter is set up.

`kernel.browserWindow` is the second decision this package owns, and it is not a roster question: it says whether the agent's browser may put a window on your desktop. Off, the browser works windowless and nothing appears while the agent browses; screenshots and the live view still work, because those never needed a visible window. On, a genuine Chromium window opens that you can watch and take over. It is here rather than in the browser package because it is a deployment preference about your desktop, not a capability of the browser itself.

## Model Experience

Indirectly, through the composition rows it gates, which decide whether the model receives the `kernel` tool or the conventional roster.

#### KV Cache effect

No direct invalidation; the rows it gates own the composed request prefix, so a flip changes it only after a restart.

## Known Limitations and Deferred Work

These limits define what this package does not provide. They are current package constraints, not a roadmap.

- **The switch owns no roster of its own** - it decides the `kernel` tool alone; every other tool belongs to the `tools` category.
- **The switch owns no model surface of its own** - it registers no prompt section, tool, or schema; the tools it gates own every model-visible effect.
- **It cannot hide a tool on its own** - withdrawing the kernel is `tool-roster`'s job, because only a filter over the assembled prompt takes a tool's guidance section with it.

Fork-owned: `packages/kernel/kernel-mode` is Tier 1, so it touches no upstream file.
