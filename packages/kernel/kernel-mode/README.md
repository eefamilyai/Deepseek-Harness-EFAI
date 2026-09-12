# @deepseek-ai/dsh-kernel-mode

The **kernel switch**: one setting deciding which tool roster the harness composes.

Turned **on**, the model gets the persistent Python kernel plus the tools the kernel cannot supply — web access, delegation, skills, goals, planning, asking the user. Turned **off**, it gets the conventional roster: bash, the filesystem tools, search, background jobs, and no kernel.

The tools *between* those two lists — the ones the kernel replaces — are the only ones the switch moves. A tool the kernel cannot do is mounted either way, because switching the kernel off must not silently remove a capability the model still needs.

## This package owns only the setting

It stays mounted in **both** positions of its own switch. A switch that disappeared when turned off could never be turned back on.

The gating itself is composition, not imperative code: the rows in the shipped agent presets read `dshSettingFlag('kernel.enabled', …)` once at boot and mount accordingly. See `packages/preset/agent-presets/presets/*/agent.cordis.yml` for the rows that read it.

## Settings

| Key | Default | Applies |
|---|---|---|
| `kernel.enabled` | preset-dependent | `restart` |
| `kernel.browserWindow` | `false` | `restart` |

`applies: 'restart'` is deliberate — swapping the acting roster mid-session would leave the conversation's earlier turns describing a tool set the model no longer has.

`kernel.browserWindow` is the second decision this package owns, and it is not a roster question: it says whether the agent's browser may put a window on your desktop. Off, the browser works windowless and nothing appears while the agent browses; screenshots and the live view still work, because those never needed a visible window. On, a genuine Chromium window opens that you can watch and take over. It is here rather than in the browser package because it is a deployment preference about your desktop, not a capability of the browser itself.

## Model Experience

Indirectly, through the composition rows it gates, which decide whether the model receives the `kernel` tool or the conventional roster.

#### KV Cache effect

No direct invalidation; the rows it gates own the composed request prefix, so a flip changes it only after a restart.

## Known Limitations and Deferred Work

These limits define what this package does not provide. They are current package constraints, not a roadmap.

- **A change requires a restart** - the `disabled` expression is read once at boot, so the roster is fixed for the life of the process.
- **The switch owns no model surface of its own** - it registers no prompt section, tool, or schema; the tools it gates own every model-visible effect.
- **It cannot hide a tool without unmounting it** - a mounted tool plugin has already contributed its prompt section, which is why the gate is composition rather than a runtime filter.

Fork-owned: `packages/kernel/kernel-mode` is Tier 1, so it touches no upstream file.
