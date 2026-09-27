---
name: dsh-compaction-pipeline
description: Use when compaction misbehaves in this fork — the summarizer emits agent-voice output (a tool call, a fenced code block, a recital of the directive) instead of a checkpoint, `/compact` or `/compact <text>` does nothing, an operator instruction never reaches the summary, the checkpoint lacks a section, or a compaction request fails on a text-channel provider. Carries the full request path from composer to provider, the two separate summarizer directives, the known `/compact <text>` admission defect, the file inventory, and the build/verify commands, so no re-investigation is needed.
---

# The compaction pipeline in this fork

Compaction has one job: replace a span of conversation with a checkpoint that lets another model continue the work. In this fork it has repeatedly failed at that job, always in the same family of ways. This skill records the entire path, because the failure surfaces far from its cause and the path crosses three packages plus a client admission layer.

## 1. The request path, end to end

A compaction request is not an ordinary turn. Trace it in this order.

### 1.1 Entry

| Entry | Origin | File |
|---|---|---|
| `/compact` (typed) | human command registry | `packages/compaction/command-compact/src/index.ts` |
| automatic | context pressure / overflow policy | `packages/compaction/compaction-basic/src/index.ts` |

`command-compact` injects `['commands', 'compaction']`, registers the name `compact`, and its handler calls:

```ts
ctx.compaction.compactNow(agent, signal, commandId, ...instruction)
```

`compactNow` is declared on the `CompactionEngine` abstract class in `packages/compaction/compaction/src/index.ts`. This fork added the fourth parameter, `instruction?: string` (marked `DSH-FORK(kiln)`). The implementation that matters is in `packages/compaction/compaction-basic/`.

### 1.2 Threading the instruction

The fork threads the per-call instruction through four hops, each marked `DSH-FORK(kiln)`:

1. `compaction-basic/src/index.ts` — `compactNow(..., instruction?)` accepts it and spreads `{ instruction }` into the transaction.
2. `compaction-basic/src/region.ts` — `CompactionTransaction` gains `readonly instruction?: string`; `prepareCompaction(...)` and the region call receive it.
3. `compaction-basic/src/region.ts` — `buildSummarizationInput(session, shadowedSeqs, instruction)` puts it on `SummarizationInput`.
4. `compaction-basic/src/summarizer.ts` — `summarizeWithLlm` reads `input.instruction` and passes it to `buildCompactionInstruction`.

If an instruction is "lost", suspect this chain before anything else — and see §3, which is the actual defect found.

### 1.3 The request itself

`summarizeWithLlm` in `packages/compaction/compaction-basic/src/summarizer.ts` builds the request. Its shape is the fix for the failure described in §2:

- **system slot** = `SUMMARIZER_ROLE` (the engine statement, never the replayed agent prompt)
- **messages** = ONE quoted user turn, then ONE instruction user turn
- **tools** = absent, deliberately. There is no tool channel on a compaction request.
- **`purpose: 'compaction'`** — carried so adapters can special-case it

The quoted turn is produced by `quotedReplay(messages, tools)`: every replayed message — system head, user turns, assistant turns, tool calls, tool results — is flattened into a single user message, each labelled `--- <role> ---`, wrapped in `<summarized-conversation>` / `</summarized-conversation>`, preceded by `REPLAYED_PREAMBLE`. Non-text blocks (images) are appended live to that same turn rather than stringified, because the image-offload recovery reads the request's live image blocks.

The trailing turn is `buildCompactionInstruction(readInstructionFile(), input.instruction)`:
- `SUMMARIZER_ROLE`, then `COMPACTION_STRUCTURE`, then standing operator text, then this-call text. Both operator blocks are explicitly subordinate to the role.

Checkpoint framing on the way back in uses `CHECKPOINT_PREAMBLE`, `<compacted-summary>` / `</compacted-summary>` via `frameSummary`.

### 1.4 The second directive, in the provider adapter

**There are two summarizer directives, and this is the single most important fact in this file.**

`packages/llm/llm-kiln/src/adapter.ts` exports its own `SUMMARIZER_SYSTEM`, and `buildTurns` swaps it in for the tool protocol whenever `options.purpose === 'compaction'`:

```ts
const protocol = options.purpose === 'compaction' ? SUMMARIZER_SYSTEM : toolProtocolPrompt(options.tools)
```

So the system slot a text-channel provider finally sees is `options.system` (the harness statement, i.e. `SUMMARIZER_ROLE`) **plus** `SUMMARIZER_SYSTEM`. The adapter statement is not redundant: it replaces the tool protocol that would otherwise be taught on these routes. Fixing one without the other leaves the failure half-cured — that is exactly how a "fixed" summarizer still emitted a `<tool_calls>` block.

The same file also carries the message-capped fold (`planCompactionFold` / `foldRequest`), used when a route caps a single message: the transcript is split into contiguous parts and a running summary is merged forward. `foldRequest` also puts `SUMMARIZER_SYSTEM` in the system slot.

`buildTurns` also pins every turn of a compaction request:

```ts
const turn = options.purpose === 'compaction' ? { ...flattened, pin: true } : flattened
```

A compaction request is the material being condensed plus the instruction that asks for it, and both turns are assembled per-request, so neither carries a `source` and `PINNED_SOURCE_KINDS` never matches them. The sidecar's `_clip_body` keeps pinned turns unconditionally and drops oldest-first from everything else, so an unpinned compaction request lost its ENTIRE quoted transcript to the clip and reached the summarizer as the instruction alone — a checkpoint with nothing to condense. Pin the request's own turns, not just the `compact-checkpoint` and `session-recovery` messages it produces. `compaction.spec.ts` pins both halves: a compaction request's turns are `pin: true`, and an ordinary request's are not.

## 2. The failure this pipeline was built to stop

**Symptom.** The summarizer does not summarize. It produces agent-voice output: a tool call, a `<tool_calls>` block, a fenced code block, a recital of the compaction directive itself, or prose addressed to the user.

**Cause.** The replayed transcript is a coding-agent conversation. Replayed back as live roles, with the agent's own system prompt governing and its tool schemas still offered, the model reads the request as the next turn of that conversation and continues the agent's role. A bare trailing "summarize this" is not enough to override a conversation that is already in progress.

**Fix (both halves required).**

1. State the summarizer role in the system slot, offer no tool channel, and flatten the entire replayed transcript into one quoted user turn — `packages/compaction/compaction-basic/src/summarizer.ts`.
2. Keep the adapter's `SUMMARIZER_SYSTEM` in place of the tool protocol on `purpose === 'compaction'` — `packages/llm/llm-kiln/src/adapter.ts`.

**Regression coverage** pins the request, not the summary text: system slot carries the role, the whole transcript is one quoted user turn, no live assistant turn, no tool channel. See `compaction-basic.spec.ts` (the `transcript-summarization engine` / `<summarized-conversation>` assertions) and `summarizer-instruction.spec.ts`.

## 3. Known defect: `/compact <text>` never reaches the handler

**Status: diagnosed, not yet fixed. Fix this before re-diagnosing anything else.**

`command-compact` registers the `compact` command with `definitionId`, `name`, `description`, `handler` — and **no `input` descriptor**.

`CommandInputDescriptor` in `packages/interaction/commands/src/types.ts` is the metadata that advertises free-form input (`hint`, optional `attachments`). Only a definition that declares `input` is *args-tolerant*.

The client admission table is `packages/client/ui-commands/src/client/service.ts` → `matchEnter`. Read its two lines together:

```ts
if (desc.input !== undefined) { ... return { claim: this.leadingClaim(...) } }   // args-tolerant
if (!bare) return undefined                                                      // argued line: unclaimed
```

With no `input`, an argued line (`/compact some text`) falls through to `return undefined` — **unclaimed**. An unclaimed line is not a command at all; the composer sends it to the model as ordinary chat. `/compact` alone still works because the bare-token path runs the command detached. That asymmetry — bare `/compact` compacts, `/compact <text>` does nothing and looks like a chat message — is the signature of this defect.

`packages/client/ui-commands/src/client/resolution.ts` already maps `compact: '@deepseek-ai/dsh-command-compact'` in `BUILTINS`, so the client knows the identity; it is only the descriptor's `input` that is missing.

**What a fix must respect.** The `input` field lives on upstream-owned `command-compact/src/index.ts`, already recorded in the seam. Adding `input: { hint: '[...]' }` is a seam edit: update `SEAM.json`/`rules.json` bookkeeping and the patch, and re-run the overlay gates in §6. Do not reach for `attachments: true` — compaction takes no attachments, and declaring it would let an attachment-carrying draft through to a handler that cannot use one.

## 4. File inventory

| Path | Owner | Why it matters |
|---|---|---|
| `packages/compaction/compaction/src/index.ts` | seam | `CompactionEngine`; `compactNow` gained `instruction?` |
| `packages/compaction/compaction-basic/src/summarizer.ts` | seam | the request shape, the role statement, quoted replay, the instruction channel |
| `packages/compaction/compaction-basic/src/region.ts` | seam | threads the instruction; `buildSummarizationInput` |
| `packages/compaction/compaction-basic/src/index.ts` | seam | `compactNow` implementation |
| `packages/compaction/command-compact/src/index.ts` | seam | `/compact` registration; **missing `input` descriptor (§3)** |
| `packages/llm/llm-kiln/src/adapter.ts` | fork-owned | the second `SUMMARIZER_SYSTEM`, `buildTurns`, the message-capped fold |
| `packages/compaction/output-masking` | fork-owned | observation masking |
| `packages/session/session-recovery-context` | fork-owned | post-compaction context |
| `packages/compaction/compaction-image-offload` | fork-owned | image recovery; its spec is sensitive to request-shape edits |
| `packages/interaction/commands/src/types.ts` | upstream | `CommandInputDescriptor` — read-only, but defines args-tolerance |
| `packages/client/ui-commands/src/client/service.ts` | upstream | the admission table; read-only, explains §3 |

`compaction.md` in the repo root is the **operator instruction file** read by `readInstructionFile()` — working directory first, then `DSH_HOME`. It is unrelated to `docs/subsystems/compaction.md`. Do not confuse them.

## 5. Operator interfaces

- **Standing instruction:** drop `compaction.md` in the working directory or `DSH_HOME`. Read fresh on every compaction.
- **Per-call instruction:** `/compact <text>` — appended after the role and the structure, explicitly subordinate to the role. Blocked by §3 until fixed.
- **Image ceiling:** a compaction summary may not contain image output (`summaryText` rejects it).

## 6. Build and verify

Source edits are not live until the host library is rebuilt. The running host loads built `lib/`, not `src/`.

```sh
pnpm run build:lib:host
```

Confirm the build actually carries the change before trusting a runtime observation — this cost the session an hour of chasing a phantom regression. Check markers in the built file:

```sh
node -e "const s=require('fs').readFileSync('packages/compaction/compaction-basic/lib/index.js','utf8'); for (const p of ['summarized-conversation','quotedReplay','transcript-summarization engine','compaction.md','renderBlock']) console.log(p, s.includes(p))"
```

`renderBlock` must be absent; the rest present.

Compaction tests:

```sh
npx vitest run packages/compaction
```

The four overlay gates, all of which must pass after any seam edit:

```sh
node local-overlay/rebuild.mjs --check
node local-overlay/verify-seam-frozen.mjs
node local-overlay/apply.mjs --check
# plus the round-trip verify
```

Current recorded state: 17 patches, 83 Tier-2 files, base `00102833df`.

## 7. Where to record what you learn

- **Behavioral fix with a durable reason** → the seam register in `HARNESS-EDITS.md`, in the same commit that makes the edit.
- **Operator instruction:** leave the fork-owned paths in §4 alone unless you are changing the pipeline; the seam edits carry `DSH-FORK(kiln)` markers and an `EXIT:` line naming what upstream must do to retire the edit. Never strip those.
- **Do not add this material to root `AGENTS.md`.** That file is upstream-owned and not in the seam's 83 paths; editing it creates a new permanent merge conflict on every release. Fork knowledge lives in fork-owned skills (this one), `HARNESS-EDITS.md`, and `local-overlay/`.

## 8. Debug order

When compaction misbehaves, check in this order — it is ordered by how often each one is the answer:

1. **Is the running host loading the change?** Rebuild (§6) and check markers. A stale `lib/` looks exactly like a failed fix.
2. **Is the instruction reaching the handler at all?** Bare `/compact` vs `/compact <text>` — if only the bare form acts, it is §3.
3. **Which directive is wrong?** Both must state the summarizer role: `summarizer.ts` and the adapter's `SUMMARIZER_SYSTEM`.
4. **Is the request shape intact?** One quoted user turn, no live assistant or tool turn, no tool channel.
5. **Is it the image-offload interaction?** That spec reads live image blocks; a request-shape change that flattens or drops them breaks recovery, not summarization.

## 4. The build trap: a source edit is not live until the host lib is rebuilt

Editing `src/index.ts` changes nothing the running host can see. The host loads `lib/`, and `pnpm run test` transpiles from `src/` in memory, so a suite can pass while the host still admits the old descriptor. The two paths diverge silently because the same source feeds both.

The failure looks exactly like the original defect: the descriptor is present in `src/`, all tests pass, and `/compact <text>` still does nothing.

Rebuild before believing a fix:

```sh
pnpm run build:lib:host     # tsc -b tsconfig.host.json && tsdown --env.DSH_BUILD_FACE host
```

Then confirm the artifact, not the source:

```sh
grep "hint" packages/compaction/command-compact/lib/index.js
```

A `lib/index.js` whose mtime predates its `src/index.ts` is stale. The build rewrites every package's `lib/`, takes a few minutes, and is the step that makes any seam edit real on a running host. Changing the client bundle instead requires `pnpm run build:lib:client`.

## 5. The client admission
