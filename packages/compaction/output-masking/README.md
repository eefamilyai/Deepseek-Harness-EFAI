---
description: "Observation masking for long sessions: old, large tool outputs become one-line stubs once the context fills, deferring compaction — for deployments tuning context economy."
kind: "package-reference"
---

# @deepseek-ai/dsh-output-masking

English | [中文](README.zh.md)

## Summary

`dsh-output-masking` keeps tool output the model has already acted on from filling the context. Once a set share of the routed model's window is in use, every successful text result older than the newest few and longer than a threshold is replaced, in one batch, by a stub naming the call, its size, and its first and last lines. The reasoning and the actions stay intact; only the bulk goes, and the model can run the call again to see it. The original stays in the session log. Masking makes no model call. It defers compaction and leaves it a smaller, denser history to summarize.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount this package next to a compaction engine when tool output dominates long sessions.

### When to choose it

Choose it when sessions read files, run tests, and inspect output for many steps, which is most coding work. Measured on SWE-bench agents, masking old observations matched summarization's solve rate at about half the cost, and the two compose. Avoid it when the model routinely needs to re-read an exact output from many steps back without re-running the call — a result the model will quote verbatim much later is better kept. Errors are never masked.

### Minimal configuration

```yaml
- name: '@deepseek-ai/dsh-output-masking'
  config:
    usageRatio: 0.5
    keepRecent: 8
    minChars: 2000
    minBatch: 4
```

| Field | Default | Meaning |
|---|---|---|
| `usageRatio` | `0.5` | Mask once this share of the context window is in use |
| `keepRecent` | `8` | The newest this-many tool results are never masked |
| `minChars` | `2000` | Only results at least this many characters long are masked |
| `minBatch` | `4` | A pass runs only when it can mask at least this many results |
| `contextWindow` | none | The window to assume when the routed model's cannot be resolved; with neither, no pass runs |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-output-masking) is the exhaustive source.

### When masking runs

Ahead of every step, before the rest of the pre-step chain — compaction included — so a pass that lands lowers the pressure compaction measures in the same step. A pass runs only when no compaction is in progress, at least `minBatch` results qualify, and the tokens in use reach `usageRatio` of the window. Tokens in use come from the token meter when it is mounted, and otherwise from the surface's own heuristic price.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design; the observable behavior is covered in [Use this package](#use-this-package).

### Design concept

Each mask is the tool-result pruner's own replacement: a `compaction/prune` shadow price, then a `tool/result` that replaces exactly one surface node and cites the original through `sourceEventSeqs`. The token meter, replay, and every surface reader already understand that shape, and the original event stays in the append-only log.

Nothing here reads history. A Session projection folds the current surface — each node's heuristic price, and for a tool result its call, size, first and last lines, and flags, never its text. Prices come from the token meter's own estimator applied to the same derived message, so the shadow price each replacement declares is exactly what the meter subtracts. A test checks the live meter against a fresh replay of the same log.

Masks land in batches because each rewrites the request prefix from the first masked node onward. With `minBatch`, the cached prefix is invalidated rarely and only for a real saving.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: projection registration, the pre-step pass, the replacement protocol |
| [`src/surface.ts`](src/surface.ts) | The surface projection's schema and fold, candidate selection, the stub |

**Runtime invariant:** No companion is published. Each replacement passes the session invariant and the compaction invariant's `compaction/prune` checks, which a test exercises inside an open turn.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Tool-result pruner](../compaction-tool-result-pruner/README.md) — the head-and-tail trim this package's replacement protocol comes from.
- [Compaction basic backend](../compaction-basic/README.md) — the summarizing backend masking runs ahead of.
- [`session-recovery-context/`](../../session/session-recovery-context/README.md) — the fork's post-compaction handoff.
- [Token meter](../../llm/token-meter/README.md) — the measurement the pass reads and the estimator its prices come from.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-output-masking) — every accepted config field and its source declaration.

-----

<a id="model-experience"></a>
## Model Experience

### Masked tool result

#### What the model sees

In place of the output, a tool result naming the call, the output's size, and its first and last lines. The tool call it answers is unchanged, so the model still sees what it asked for.

##### Stub verbatim

```markdown
[output masked to keep the context small — <tool> <target>: <chars> characters over <lines> lines.
It began: <first non-blank line, clipped>
It ended: <last non-blank line, clipped>
Run the call again if you need the full output.]
```

#### Token effect

A masked result costs a few dozen tokens in place of its full price. With the defaults, a pass removes at least four results of 2,000+ characters each, so at least ~2,000 tokens.

#### KV Cache effect

A pass rewrites the prefix from the first masked node onward, so the next request re-reads that span. `minBatch` and `usageRatio` keep passes rare. Once a result is masked it stays masked, so later passes never touch it again.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **The detail is gone from the context** — an exact value that was only ever in a masked output must be regenerated by running the call again; the stub keeps the first and last lines, not the middle.
- **Re-running is not always free** — a call with side effects, or one whose output changed since, returns something different. The stub does not say whether it is safe to repeat.
- **Text-only results** — a result carrying an image or other non-text block is left to the image offload.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The research this rests on is summarized in the [compaction handoff Agent Note](../../../.agents/notes/implemented/feature/2026-09-24-compaction-handoff.md).

</details>
