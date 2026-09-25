# Agent Note: Compaction hands off in the same step, from a code-kept ledger

Status: implemented

English | [中文](2026-09-24-compaction-handoff.zh.md)

## Problem

After a compaction the model routinely resumed the wrong task, or stopped. Reading the source, not any session, found five causes that compound.

1. **The recovery spent a step.** `session-recovery-context` answered a compaction with an "acknowledge the record" step. A step whose reply calls no tool ends the turn (`packages/core/agent-loop/src/agent.ts`), so every task compacted mid-run stopped there, and the operator's message waited for the next turn.
2. **What survived was whatever a model wrote.** The checkpoint is a model's paraphrase. It drops exactly what code can know for certain: the operator's own words, later corrections, the files edited, the error still open, the todo list. The previous recovery message carried prompts and a raw event tail, not the state of the work.
3. **On `ds_direct`, the re-prime dropped the checkpoint.** A compaction opens a fresh DeepSeek web chat primed within one 48,000-character prompt. The system prompt alone — the tool protocol for two dozen tools — takes most of it, and the checkpoint, the oldest turn, was not pinned. The sidecar's own pin for `kind: "compact"` matched nothing the adapter sends.
4. **The summarizer saw only the newest end.** A summary request on `ds_direct` larger than one capped prompt was clipped oldest-first, so the older work was never summarized at all.
5. **The system prompt was stored once per turn.** `ds_direct` re-sent it on every threaded turn. The web chat keeps every prompt, so its server-side conversation filled with copies of the tool protocol long before the work did.

## Decision

Code keeps what code can know, and recovery never interrupts the work it recovers.

- **A ledger folded from the log** (`session-recovery-context`, `src/ledger.ts`). A Session projection records operator messages verbatim (first and newest kept at the bound), mid-turn corrections, files created, edited, and read, recent commands with their outcome, unresolved errors (resolved by a later success on the same tool and target), the todo list, and the latest checkpoint.
- **A handoff in the same step.** A prepended `agent/pre-step` listener lets the chain run first — compaction runs inside it — and, when the newest checkpoint has no handoff, puts one message first in that step. The handoff contains the requests, the state, the current contents of the most recently changed files, `git status`, the paths of the full record, and, last, "Continue from here": the checkpoint's Current Work and Next Step, the todo in progress, and the latest request. It tells the model not to acknowledge or recap it, and never restates the checkpoint. Its budget is a share of the routed window. A record file per compaction keeps the handoff and checkpoint on disk.
- **A focus line** in the runtime context after the first compaction keeps the in-progress todo and the next step in the model's most recent attention, the way agents that rewrite their own todo file keep the goal in view.
- **Pins and a fold on Kiln** (`llm-kiln`). `compact-checkpoint` and `session-recovery` turns are pinned, so a re-prime never clips them. A summary request too large for one capped prompt on `ds_direct` can be folded across a BOUNDED number of parts (`compactionFoldParts`, default 1 — no folding), each carrying the running summary inside the `<compacted-summary>` tags upstream's summarizer already merges. The bound is load-bearing: an unbounded fold costs one fresh web chat per part, which on a long session leaves the compaction pending for many minutes and the turn never resumes.
- **One system prompt per chat** (`ds_direct.py`). It is sent when a chat opens or re-primes, when it changes, and every `KILN_DS_SYSTEM_EVERY` turns (default 8); other turns carry a one-line note, and the prompt budget pays for the system prompt only when it is sent.
- **Observation masking before compaction** (`output-masking`, new). Once half the routed window is in use, old, large, successful tool results become one-line stubs in one batch, through the tool-result pruner's own replacement protocol, so compaction fires later and summarizes less.

The design follows published practice. JetBrains Research found observation masking matches LLM summarization on SWE-bench agents at about half the cost. Factory's evaluation of compaction found that structured summaries anchored to earlier ones keep the most, and that the trail of files and artifacts is what every method loses first. Claude Code re-attaches recently read files after compaction and tells the model to continue without acknowledging the summary. Codex writes a handoff for the next context and carries the user's own recent messages verbatim. Manus keeps errors in context, uses the filesystem as memory, and recites a todo list to hold the goal in attention.

## Alternatives considered

**Improve only the summary prompt.** Upstream's checkpoint already has Current Work and Next Step sections; what it lacks is certainty. No prompt makes a model reliably reproduce a verbatim request, a file list, or an open error, and no reader can check that it did.

**Keep the acknowledgement step, but mark it as mid-turn.** The loop's rule that a tool-free reply ends the turn is upstream's and load-bearing. Any extra step either ends the turn or needs an agent-loop edit, which the frozen seam forbids.

**Re-inject the whole event tail, as before.** A tail is what happened most recently, not what matters: it spends the budget on routine calls and still omits the brief, the file list, and errors from further back.

**Summarize on `ds_direct` through a paid route.** It would sidestep the capped prompt, but it makes compaction depend on a key the free route exists to avoid. The fold keeps the route self-sufficient.

**Mask continuously, one result at a time.** Each mask rewrites the prompt prefix from the masked node onward. Batching at a usage threshold spends that cache invalidation rarely and for a real saving.

## Consequences

A compacted turn carries on in the step it was compacted in. The model sees, from the log itself, what it was asked and the exact state of the work, and ends its reading at the place to resume. Each compaction adds one durable handoff event and one record file.

The ledger's tool knowledge is by name: a new file or shell tool is recorded as a call but adds no file or command until the ledger learns it. Masked outputs must be regenerated by running the call again, and a call with side effects returns something different. On `ds_direct`, a summary of a long conversation costs one call per part.

The ledger's operator messages are the session's own text, so a handoff carries whatever the operator wrote. Like the log it is read from, it stays inside the session.

## Related decisions

The [synchronous-read deprecation](../architecture/2026-09-09-deprecate-synchronous-session-event-reads.md) is why the ledger and the masking surface are projections rather than history scans. The [tool-result pruner](../../../../packages/compaction/compaction-tool-result-pruner/README.md) defines the replacement protocol masking reuses.
