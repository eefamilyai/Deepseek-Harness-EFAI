---
description: "The agent-memory switch: one setting deciding whether the durable memory engine runs, and the mount that holds the engine to it."
kind: "package-reference"
---

# @deepseek-ai/dsh-agent-memory-mode

## Summary

`dsh-agent-memory-mode` owns `agent-memory.enabled` and the mount it controls. On, it plugs `@deepseek-ai/dsh-agent-memory` into its own context; off, it disposes that fiber, which unwinds the engine's tools, its prompt block, and its tool-result observer together. The switch stays mounted in both of its own positions, so it can always be flipped back.

## Table of Contents

- [Use this package](#use-this-package)
- [Why the switch owns the mount](#why-the-switch-owns-the-mount)
- [Dev Note](#dev-note)

<a id="use-this-package"></a>
## Use this package

Mount it in a composition carrying `settings`; `packages/bundle/efai-base` does. The engine row is not mounted separately — this package mounts it.

```yaml
- id: agent-memory-mode
  name: '@deepseek-ai/dsh-agent-memory-mode'
  config:
    enabled: false
```

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `false` | Whether the engine runs. Applies immediately. |
| `engine` | `{}` | Engine settings, passed through verbatim to `@deepseek-ai/dsh-agent-memory` when it mounts. |

A composition with no settings service still works: the switch has nothing to publish, and the composition's own `enabled` is the whole answer.

<a id="why-the-switch-owns-the-mount"></a>
## Why the switch owns the mount

Hiding a tool is enough for a tool. It is not enough here: the engine observes every tool result and writes the evidence to disk, so "off" has to mean "not running", which in Cordis means "not mounted".

The decision could have been a Loader `disabled: !!js …` expression on the engine's own row, and was until 2026-09-20. That is a worse interface for two reasons. The expression is evaluated once at boot, so the setting becomes a restart; and it gates the engine's row only, which means nothing publishes the switch when the engine is off — the user would have no way back. Keeping both halves here fixes both.

<a id="dev-note"></a>
## Dev Note

`sync` compares the wanted state against whether a fiber exists, so writing the value the switch already holds does nothing — a settings write that changes another field in the same namespace does not remount the engine and lose its in-memory state.
