# @deepseek-ai/dsh-agent-memory

Durable, cache-friendly memory for a DeepSeek Harness agent.

An agent's transcript is a terrible place to keep evidence: it is the most expensive context in the system, it is re-read on every turn, and a compaction event deletes it. This package moves the evidence off the transcript and keeps only a bounded, token-stable index in it.

Two write paths guarantee capture even when the model never thinks about memory:

1. a host-side observer on `tools/result` records every tool result automatically, and
2. the model-facing `memory_add` / `memory_recall` / `memory_map` tools.

Only the index is re-injected each turn, through `system-prompt/assemble` as a single `memory:index` context block; the full text stays on the storage domain and comes back only through `memory_recall`.

It is a fork-owned package (`packages/agent-memory/agent-memory`), so it touches no upstream file. It builds on existing services:

- `ctx.storageDomain` — the durable per-record domain the evidence lives in,
- `ctx.systemPrompt` — the `system-prompt/assemble` hook the index rides,
- `ctx.tools` — tool registration and the `tools/result` observation seam.

## Why the index is re-injected, and the evidence is not

Prompt caching is positional: a prefix that changes invalidates everything after it. An index that only ever grows at a stable offset keeps the cached prefix intact, while a transcript full of tool output does not. So the index is bounded by `maxIndexNodes` and `maxIndexChars`, and the full evidence is kept strictly on disk — the model pays for a ref and a one-line summary, and pays for the whole record only on the turn it actually recalls it.

## Layering

- `src/spec.ts` — the storage domain: the `nodes` and `agents` tables and the global cursor, declared with `defineDomain`.
- `src/memory.ts` — the pure helpers (`refOf`, `summarize`, `truncate`, `renderMemoryIndex`, `nodeKey`, `agentPrefix`). No Cordis import, so they are unit-tested in isolation.
- `src/index.ts` — the Cordis plugin: injects `storageDomain` + `systemPrompt` + `tools`, owns the `MemoryService`, and registers the three tools.

## Composition

The `agent-memory.enabled` toggle (default **off**) is mounted from the host base composition (`packages/bundle/base/cordis.patch.yml`) alongside the `agent-memory-mode` settings row. The mode row stays mounted in both positions so the switch can always be flipped back, and both it and the gate declare `applies: 'restart'`, because the Loader `disabled` expression is read once at boot. Memory itself survives restarts: one shared domain, keyed per agent id.

## Model Experience

### Auto-injected memory index

#### What the model sees

A `memory:index` runtime-context block, rebuilt on every assembly from the newest entries: a one-line header plus one `[kind:ref] source: summary` line per node, newest first. The block replaces any previous `memory:index` entry rather than appending, so there is never a second one. The index carries refs and summaries only; the full evidence stays on disk and reaches the model solely through a `memory_recall` result.

#### Token effect

Bounded by configuration: `maxIndexNodes` (default 40) entries, `maxIndexChars` (default 4000) for the whole block, and `maxSummaryChars` (default 240) per summary. A recalled record costs its full stored text once, capped at `maxFullChars` (default 20000) when it was written.

#### KV Cache effect

Stable while the entry set is unchanged. The block is appended after the stable prefix and bounded on purpose, so growth does not reorder the cached prefix the way a transcript full of tool output does.

### Memory tools

#### What the model sees

Three tools. `memory_add` records a note or evidence and returns the new ref and sequence; `memory_recall` returns the full on-disk text for one ref and persists nothing into the index; `memory_map` renders the current index on demand. Each description states which of the two does what, so the model does not have to guess whether a recall is durable.

#### Token effect

The three descriptions are billed once per request as part of the stable prefix. A `memory_add` result is a single short line, and a `memory_recall` result is the stored text.

#### KV Cache effect

The schemas are static. Both results append to the transcript as ordinary tool results.

## Known Limitations and Deferred Work

These limits define what this package does not provide. They are current package constraints, not a roadmap.

- **The index is the only automatic context** - full evidence reaches the model only through an explicit `memory_recall`, so a fact the model never recalls is effectively absent from the turn.
- **Automatic capture observes tool results only** - the host-side observer records `tools/result` payloads, so reasoning, user messages, and provider output are never captured on their own.
- **Capture is truncated** - an auto-recorded result is capped at `maxAutoRecordChars` (default 16000) before it is stored, and the stored copy at `maxFullChars`.
- **Refs are content-addressed** - an identical capture returns the existing node instead of a new one, so two genuinely separate occurrences of the same text collapse into one entry.
- **Memory is keyed per agent id** - a new agent id starts with an empty index, and the shared domain is not consulted across ids.
- **The injected index is capped, so old entries fall out of view** - entries beyond `maxIndexNodes` remain on disk but are no longer listed until the model calls `memory_map`.

See `HARNESS-EDITS.md` for the fork's tier rules; this package is Tier 1.
