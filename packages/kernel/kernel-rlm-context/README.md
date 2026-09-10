# @deepseek-ai/dsh-kernel-rlm-context

The **RLM "context-as-variable" agent-loop seam**.

It closes a loop that spans two languages:

- **Python side** — the model writes `ctx_write(name, value)` and a terminal `answer` dict into the Kiln namespace; `rlm_dump()` emits one machine-readable marker line describing both.
- **This side** — `KernelContextService` reads that dump back through `ctx.kernel.execute(...)`, parses it, and contributes the result as runtime context on the `system-prompt/a…` extension point.

So the model's accumulated working state becomes part of its own context on the next turn, without a tool call spent re-reading it.

## Where the pieces live

| Piece | Home |
|---|---|
| `ctx_write` / `answer` / `rlm_dump()` primitives | `python/kiln/runtime/rlm_context.py` |
| `rlm.*` seam on the kernel provider | `packages/kernel/kernel-python` |
| `parseRlmDump` and this service | this package |
| The recursive driver loop | `@deepseek-ai/dsh-rlm` |

The `__KILN_RLM_STATE__` marker protocol is shared with `@deepseek-ai/dsh-rlm`; that package's engine stops as soon as this reader reports the answer ready.

## Model Experience

### Kernel RLM context section

#### What the model sees

A `kernel:rlm` runtime-context block contributed on `system-prompt/assemble`, built from the kernel's own `rlm_dump()` snapshot. It leads with `Kernel RLM context variables. These are live program values, not transcript.` and then one `name = value` line per bind, sorted by name, followed by an `answer (ready)` or `answer (not-ready)` line when an answer exists. The block replaces any previous `kernel:rlm` entry rather than appending, so there is never a second one.

##### Contributed header verbatim

```markdown
Kernel RLM context variables. These are live program values, not transcript.
```

#### Token effect

One line per bind plus the header, bounded by `maxBindChars` per value and `maxAnswerChars` for the answer. A bind whose value is large is truncated rather than dropped, and the whole block is skipped when there is nothing to report.

#### KV Cache effect

Appended after the stable prefix as a runtime-context section, so the cached prefix survives while the binds change. The replace-not-append rule keeps the section count fixed.

## Known Limitations and Deferred Work

These limits define what this package does not provide. They are current package constraints, not a roadmap.

- **Skipped while the kernel is busy** - the read-back is skipped while `ctx.kernel.busy()` reports a queued or running cell, so a re-entrant read cannot queue behind an in-flight fan-out.
- **A ready answer is terminal and contributes nothing** - the agent already received it through the fan-out return value, so the listener adds no text for a settled result.
- **`ownerAgentId` is the only isolation** - omitting it broadcasts the binds to every agent assembled on that context, including in-process child agents.
- **The block is bounded per bind and answer** - `maxBindChars` and `maxAnswerChars` truncate a value, so a large structure is summarized rather than reproduced in full.

Fork-owned: `packages/kernel/kernel-rlm-context` is Tier 1, so it touches no upstream file.
