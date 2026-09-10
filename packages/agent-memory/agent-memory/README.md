# @deepseek-ai/dsh-agent-memory

Durable, cache-friendly memory for a DeepSeek Harness agent.

An agent's transcript is a terrible place to keep evidence: it is the most
expensive context in the system, it is re-read on every turn, and a compaction
event deletes it. This package moves the evidence off the transcript and keeps
only a bounded, token-stable index in it.

Two write paths guarantee capture even when the model never thinks about memory:

1. a host-side observer on `tools/result` records every tool result
   automatically, and
2. the model-facing `memory_add` / `memory_recall` / `memory_map` tools.

Only the index is re-injected each turn, through `system-prompt/assemble` as a
single `memory:index` context block; the full text stays on the storage domain
and comes back only through `memory_recall`.

It is a fork-owned package (`packages/agent-memory/agent-memory`), so it
touches no upstream file. It builds on existing services:

- `ctx.storageDomain` — the durable per-record domain the evidence lives in,
- `ctx.systemPrompt` — the `system-prompt/assemble` hook the index rides,
- `ctx.tools` — tool registration and the `tools/result` observation seam.

## Why the index is re-injected, and the evidence is not

Prompt caching is positional: a prefix that changes invalidates everything
after it. An index that only ever grows at a stable offset keeps the cached
prefix intact, while a transcript full of tool output does not. So the index is
bounded by `maxIndexNodes` and `maxIndexChars`, and the full evidence is kept
strictly on disk — the model pays for a ref and a one-line summary, and pays for
the whole record only on the turn it actually recalls it.

## Layering

- `src/spec.ts` — the storage domain: the `nodes` and `agents` tables and the
  global cursor, declared with `defineDomain`.
- `src/memory.ts` — the pure helpers (`refOf`, `summarize`, `truncate`,
  `renderMemoryIndex`, `nodeKey`, `agentPrefix`). No Cordis import, so they are
  unit-tested in isolation.
- `src/index.ts` — the Cordis plugin: injects `storageDomain` + `systemPrompt` +
  `tools`, owns the `MemoryService`, and registers the three tools.

## Composition

The `agent-memory.enabled` toggle (default **off**) is mounted from the host
base composition (`packages/bundle/base/cordis.patch.yml`) alongside the
`agent-memory-mode` settings row. The mode row stays mounted in both positions
so the switch can always be flipped back, and both it and the gate declare
`applies: 'restart'`, because the Loader `disabled` expression is read once at
boot. Memory itself survives restarts: one shared domain, keyed per agent id.

See `HARNESS-EDITS.md` for the fork's tier rules; this package is Tier 1.
