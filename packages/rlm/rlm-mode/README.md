# @deepseek-ai/dsh-rlm-mode

The **RLM switch**: one setting deciding whether the first-party recursive engine — not the standalone `kernel` tool — is the model's way of acting on this machine.

## This package owns only the setting

Exactly as `@deepseek-ai/dsh-kernel-mode` owns `kernel.enabled`, this package owns `rlm.enabled` and nothing else. It stays mounted in **both** positions of its own switch, because a switch that disappeared when off could never be turned back on.

The gating is composition: the rows in the shipped agent presets read `dshSettingFlag('rlm.enabled', false)` once at boot.

## What turning it on changes

With RLM on, the engine drives the persistent kernel itself: it calls the LLM, runs every `python` tool call through `ctx.kernel.execute`, feeds the captured output back, reads `rlm_dump()`, and stops when the model marks its answer ready. The standalone `tool-kernel` row unmounts, because the engine subsumes it.

RLM mode still needs the kernel **seam** underneath — the engine executes cells through `ctx.kernel` — so the `kernel` and `kernel-python` *services* stay mounted. What changes is which tool the model reaches for, not whether a kernel exists.

## Settings

| Key | Default | Applies |
|---|---|---|
| `rlm.enabled` | `false` | `restart` |

## Model Experience

Indirectly, through the acting-roster swap it gates, which decides whether the model reaches for the `rlm` tool or the standalone `kernel` tool.

#### KV Cache effect

No direct invalidation; the swap changes which acting tool is composed, so the prefix changes only after a restart.

## Known Limitations and Deferred Work

These limits define what this package does not provide. They are current package constraints, not a roadmap.

- **A change requires a restart** - the `disabled` expression is read once at boot, so the acting roster is fixed for the life of the process.
- **RLM still needs `kernel.enabled`** - the engine executes cells through `ctx.kernel`, so turning RLM on without the kernel seam leaves it with nothing to run against.
- **The switch owns no model surface of its own** - it registers no prompt section, tool, or schema; the engine it mounts owns every model-visible effect.

Fork-owned: `packages/rlm/rlm-mode` is Tier 1, so it touches no upstream file.
