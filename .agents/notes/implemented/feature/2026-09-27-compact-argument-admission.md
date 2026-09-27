# Agent Note: The `/compact` argument reaches the summarizer

Status: implemented

English | [中文](2026-09-27-compact-argument-admission.zh.md)

## Problem

An operator types `/compact <text>` to steer what the checkpoint keeps. The compaction runs, and the instruction is absent from the summary. Two independent breaks produce that outcome, and each one hides the other.

**The argued line never becomes command input.** A command definition advertises whether it takes arguments through its input descriptor. The `compact` definition declared none, so the composer did not treat the argued line as this command's arguments: the text went to the model as ordinary chat and `command/run` recorded `args: ''`. Nothing downstream can recover an argument the command plane never received.

**The summarizer runs as the agent.** A compaction request replays the session as live roles — the agent's own system prompt governing, its tool schemas still offered — so the model reads the request as the next turn of a coding session and continues the agent's role. The reply is a tool call, a fenced block, a recital of the directive, or prose addressed to the operator, never a checkpoint. On a text-channel route a second directive compounds this: `packages/llm/llm-kiln/src/adapter.ts` exports its own `SUMMARIZER_SYSTEM` and `buildTurns` swaps it in for the tool protocol whenever `options.purpose === 'compaction'`. A fix in the engine alone leaves the route teaching a tool protocol to a request that has no tool channel.

Both breaks live in upstream-owned files, so both are seam edits with a merge cost that has to be justified and an exit condition that has to be written down.

## Decision

The command declares that it takes arguments, and the argument rides to the request as data rather than as prompt text.

**Admission.** `packages/compaction/command-compact/src/index.ts` declares `input: { hint: '[<instruction>]' }` on the `compact` definition. The descriptor is what makes the client treat the argued line as this command's arguments; without it the line is not advertised as args-tolerant and the composer sends it to the model. The edit carries a `DSH-FORK(kiln)` marker and an exit condition: upstream declares an input descriptor, or makes an argued line reach a registered command by default.

**Threading.** The per-call instruction crosses four hops, each marked `DSH-FORK(kiln)`:

1. `packages/compaction/compaction/src/index.ts` — `CompactionEngine.compactNow` gains a fourth parameter, `instruction?: string`.
2. `packages/compaction/compaction-basic/src/index.ts` — `compactNow` accepts it and spreads `{ instruction }` into the transaction.
3. `packages/compaction/compaction-basic/src/region.ts` — `CompactionTransaction` carries `readonly instruction?: string`, and `buildSummarizationInput(session, shadowedSeqs, instruction)` puts it on `SummarizationInput`.
4. `packages/compaction/compaction-basic/src/summarizer.ts` — `summarizeWithLlm` reads `input.instruction` and hands it to `buildCompactionInstruction`.

**The request shape.** `summarizeWithLlm` builds the request that stops the agent-role reading: the system slot carries `SUMMARIZER_ROLE` and never the replayed agent prompt; the messages are one quoted replay turn followed by one instruction turn; the request offers no tools; and it carries `purpose: 'compaction'` so an adapter can special-case it. `quotedReplay` flattens every replayed message into a single user turn labelled by role inside `<summarized-conversation>` tags, appending non-text blocks live so image-offload recovery still finds them. The trailing turn is `buildCompactionInstruction(readInstructionFile(), input.instruction)`: the role, the required checkpoint structure, standing operator text, then this call's text, with both operator blocks subordinate to the role.

**The adapter's half.** `SUMMARIZER_SYSTEM` in `packages/llm/llm-kiln/src/adapter.ts` stays the system slot on a text-channel route, replacing the tool protocol. The same file's `planCompactionFold` / `foldRequest` apply the same substitution when a route caps a single message and the transcript has to be folded across parts.

## Testing

`packages/compaction/command-compact/tests/command-compact.spec.ts` records the instruction each `compactNow` call receives, and `tests/loader-composition.spec.ts` asserts the descriptor the assembled command plane lists — `input: { hint: '[<instruction>]' }` — so a definition that loses its input descriptor fails the loader composition test rather than silently reverting to ordinary chat. Both specs are seam paths recorded in `local-overlay/SEAM.json`.

## Alternatives considered

**Teach the client to admit any argued line to a registered command.** It would fix every command at once and cost one edit in a client package the fork does not otherwise touch. The rule is upstream's to set, and a fork-local admission change would be a larger seam than the descriptor that expresses the same intent.

**Put the instruction in the system prompt only.** The system slot is where the role statement lives, and an operator instruction that shares it reads as engine configuration rather than a per-call request. Keeping the standing operator text and the per-call instruction as separate trailing blocks lets the engine keep the role dominant.

**Replay the transcript as live roles and let a trailing "summarize this" govern.** That is the reading that produces agent-voice output. A conversation already in progress overrides a trailing instruction; the fix has to change the request's shape, not add emphasis to its last turn.

**Fix the engine and leave the adapter alone.** The two directives are separate texts on separate routes. A fork that fixes only the engine keeps emitting tool-call blocks on every route whose adapter substitutes its own summarizer statement.

## Consequences

`/compact <text>` now compacts with the operator's text present in the request, and the checkpoint is produced by a request that states its own role. The instruction is data on the request, so an adapter, a fold, or a test can observe it without parsing prose.

The cost is three upstream paths on the seam: `command-compact/src/index.ts`, `command-compact/tests/command-compact.spec.ts`, and `command-compact/tests/loader-composition.spec.ts`, on top of the engine, region, and summarizer paths the instruction already crosses. Each carries a `DSH-FORK(kiln)` marker so a merge resolver reads the fork's side without reconstructing it.

Admission is the client's rule, not this package's: the descriptor is what the fork can state, and a client that changes how it treats an argued line changes the behavior under this definition without changing it.

## Related decisions

The [compaction handoff](2026-09-24-compaction-handoff.md) owns the ledger, the same-step handoff, the pins, and the fold this request shape feeds. The fork's [`dsh-compaction-pipeline`](../../../skills/dsh-compaction-pipeline/SKILL.md) skill carries the same path as operator-facing recon.
