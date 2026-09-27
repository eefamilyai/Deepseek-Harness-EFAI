# Cross-compaction context handoff — research findings and a design

**Scope.** How coding agents carry task context across a compaction boundary so the
next session starts *oriented* rather than merely *informed*. Based on reading the
actual compaction implementations in OpenHands SDK / OpenHands ≤0.30, the
DeepSeek Harness `packages/compaction` subsystem, and the memory-layer projects
(LangMem, Graphiti/Zep, Letta, mem0, basic-memory, oc-mnemoria, serena).

**Your current approach, per your description:** hand the next session the raw
session log file.

---

## 1. Why the raw session log underperforms

This is the weakest of the known designs, and the reasons are structural, not
tuning problems.

**1.1 It is unstructured, so the next agent redoes the summarization work.**
Every mature implementation uses a *schema-constrained* handoff. The OpenHands SDK
summarizing prompt is explicit — it demands named sections:

```
USER_CONTEXT      essential user requirements, goals, clarifications
TASK_TRACKING     active tasks, their IDs and statuses — PRESERVE TASK IDs
COMPLETED         tasks completed so far, with brief results
PENDING           tasks that still need to be done
CURRENT_STATE     current variables, data structures, relevant state
CODE_STATE        file paths, function signatures, data structures
TESTS             failing cases, error messages, outputs
CHANGES           code edits, variable updates
DEPS              dependencies, imports, external calls
VERSION_CONTROL_STATUS  repo state, branch, PR status, commit history
```

with two hard rules: *"If the events being summarized contain ANY task-tracking,
you MUST include a TASK_TRACKING section"* and *"When referencing tasks make sure
to preserve exact task IDs and statuses."*

A raw log contains all of this **information** and none of this **structure**. The
receiving agent must read thousands of turns to reconstruct it — which is exactly
the expensive operation summarization exists to eliminate.

**1.2 It preserves the wrong things.**
A log records the *path taken*, including dead ends, reverted edits, abandoned
approaches, and superseded decisions — all at equal weight. The single most
valuable act of a handoff summary is to **discard the abandoned branch and keep
the decision**. The log keeps both, with no marker distinguishing them. A
resumed agent that reads "tried X, it failed" next to "tried Y, it worked" has no
structural signal for which one is current state.

**1.3 It does not fit, and truncation loses the head.**
`.kiln_kernel_state/ds_sessions.json` is already **43 MB**. A long session's log
cannot be injected wholesale. When it must be truncated, the usual policy keeps
the *tail* — which drops the original goal statement and the user's clarifications,
i.e. precisely the `USER_CONTEXT` block. Summarization is bounded by construction;
raw injection is bounded only by the truncation heuristic, which is worse.

**1.4 Task identity does not survive.**
The strongest continuity rule in the reference implementation is *preserve task
IDs*. Losing task identity is what makes a resumed session silently redo completed
work, or re-litigate a settled decision. A prose log has no task IDs to preserve.

**1.5 It is passive.**
The log is a file the agent *may* consult. High-performing systems make the
handoff a first-class object in the event stream that is *always* in context.
OpenHands models this explicitly: `Condensation` is an event
(`openhands/sdk/event/condenser.py`) written into history, so the summary is part
of the conversation rather than a side channel that may be skipped.

**1.6 No lifecycle or truth maintenance.**
The memory-layer projects treat facts as *temporal*: Graphiti/Zep are temporal
knowledge graphs with valid-from/valid-to; LangMem separates hot-path from
background extraction; Letta and mem0 run extraction-and-consolidation passes. A
raw log has no notion of "this was true at turn 40 and was superseded at turn
90." Everything is equally true forever.

---

## 2. What the reference implementations actually do

### 2.1 OpenHands SDK — condenser as a pluggable strategy

The architecture is a small, clean contract:

- **`CondensationRequirement`** — `HARD` ("a condensation is required right now,
  and the agent cannot proceed without it") vs `SOFT` ("desired but not strictly
  required"). This distinction matters: overflow is not the same event as bloat.
- **`RollingCondenser`** — base class applying condensation to a rolling history
  produced by `View.from_events`.
- **`PipelineCondenser`** — chains condensers; each runs until one returns a
  `Condensation`, then the pipeline stops.
- **`NoOpCondenser`**, **`LLMSummarizingCondenser`** — the ends of the spectrum.
- Historical strategies (OpenHands ≤0.30), which are the interesting design space:
  - `amortized_forgetting_condenser` — spread the cost of forgetting across turns
    rather than paying it all at one cliff.
  - `recent_events_condenser` — keep a recent window, drop the rest.
  - `observation_masking_condenser` — mask *tool observations* (the bulky part)
    while keeping the reasoning/action trail intact.
  - `browser_output_condenser` — domain-specific masking for the noisiest source.
  - `llm_summarizing_condenser` — model-generated summary over forgotten events.

The **most transferable idea** is observation masking. Most context bulk is tool
output — file dumps, command output, fetched pages. Reasoning and decisions are
small. Masking observations buys large headroom at low information cost, and can
run continuously rather than at a cliff.

### 2.2 DeepSeek Harness — compaction already exists as a capability seam

DSH already has the right shape, documented in
`website/.generated/reference/subsystems/compaction.md`:

- **Service Definition:** `packages/compaction/compaction` (`ctx.compaction`)
- **Service Provider:** e.g. `packages/compaction/compaction-basic`
- **Consumer:** `packages/compaction/command-compact`
- Additional backends such as `compaction-tool-result-pruner` (the
  observation-masking idea, already productized)

Compaction is deliberately **not** in the agent-loop trunk; it is an optional
capability, and its persistent summary events use `ContentBlock` vocabulary. There
is prior art in the repo's own notes on summary-prefix cache reuse, English
compaction checkpoints, and the context meter being blind to compaction.

**Implication:** you do not need to invent a mechanism. You need to change *what
crosses the boundary* and *how it is injected*.

### 2.3 The memory layer — for anything crossing a *session* boundary

- **LangMem** — splits *hot-path* memory (agent records/searches during the
  conversation) from a *background* manager (extract, consolidate, update).
- **Graphiti / Zep** — temporal knowledge graph; facts carry validity intervals
  and get invalidated rather than deleted.
- **Letta / mem0** — extraction + consolidation of durable facts from turns.
- **basic-memory / oc-mnemoria / mcp-memory / serena** — filesystem- or
  MCP-backed persistent stores shared across sessions.

These are the right tool for *cross-session* durability. They are the wrong tool
for *intra-session* orientation across one compaction — that needs a
schema-constrained, always-present handoff, not a retrieval store.

---

## 3. Recommended design: three tiers

The failure mode of the current approach is that it conflates three different
needs into one artifact.

**Tier 1 — Orientation block. Always injected. ~1–2k tokens.**
A schema-constrained handoff, generated at compaction time, occupying a stable
position at the head of the resumed context. This is the artifact that makes the
next session *ready to work*. Schema in §4.

**Tier 2 — Session log. Retrievable, not injected.**
Keep the log, but expose it as a **tool**, not as context:
`search_session_log(query)` / `read_session_turns(range)`. The agent pulls the
turns it needs, when it needs them, instead of paying for all of them up front.
This preserves the recall benefit of the raw log while removing its cost.

**Tier 3 — Durable memory. Cross-session.**
Facts, decisions, and preferences that outlive the task — a memory store with
supersession, not an append-only log.

The rule: **Tier 1 is written, Tier 2 is fetched, Tier 3 is accumulated.**

---

## 4. The handoff contract

Generate this at compaction, validate it, and inject it verbatim.

```markdown
## GOAL
<one paragraph: what the user is trying to achieve, in their terms>

## USER_CONTEXT
<essential requirements, constraints, and clarifications — verbatim where
phrasing matters; a misinterpreted clarification is expensive>

## TASKS
| ID | Status | Description | Result/Blocker |
|----|--------|-------------|----------------|
| T1 | done   | ...         | ...            |
| T2 | active | ...         | ...            |
<!-- PRESERVE IDs exactly across compactions. Never renumber. -->

## DECISIONS
- <decision> — because <reason>. Rejected: <alternative>.
<!-- Include the rejected alternative; it prevents re-litigating. -->

## CURRENT_STATE
<branch, files touched, key variables/structures, what is half-finished>

## CODE_STATE
<file paths + function signatures + data structures that matter>

## TESTS
<failing cases, exact error messages, commands and their output>

## VERSION_CONTROL
<branch, uncommitted changes, commits made, PR status>

## NEXT_ACTION
<the single next concrete step — imperative, specific>

## OPEN_QUESTIONS
<what is unresolved; what must be asked of the user>
```

Three rules that carry most of the value:

1. **Task IDs are immutable across compactions.** This is the reference
   implementation's strongest stated rule and the main defense against redoing
   work.
2. **Record the rejected alternative, not just the chosen one.** Cheap to write,
   and it is what stops the next session from re-trying a dead end.
3. **`NEXT_ACTION` is mandatory.** An oriented agent knows what to do *next*; an
   informed agent knows what happened.

---

## 5. Concrete changes, in priority order

1. **Stop injecting the raw log.** Replace the injection with the Tier-1 block.
   This alone should be most of the improvement.
2. **Expose the log as a retrieval tool** (Tier 2) so nothing is lost — it just
   stops being pre-paid.
3. **Make the handoff schema a validated contract.** Generate it, then check it:
   does it name the goal, does it have task IDs and statuses, is `NEXT_ACTION`
   present and specific? Reject and regenerate if not. An unvalidated summary
   degrades silently.
4. **Adopt HARD vs SOFT triggers.** Compact on genuine pressure (HARD); treat
   bloat as SOFT so you are not paying a summarization cost mid-task for cosmetic
   reasons.
5. **Add observation masking as a continuous, cheap layer.** Given DSH already
   ships `compaction-tool-result-pruner`, this is available: prune bulky tool
   output continuously so the expensive LLM summarization cliff arrives far less
   often.
6. **Persist the handoff as an event in the stream**, not a side file — so it is
   always in context and always auditable.
7. **Route durable facts to Tier 3.** Decisions that outlive the task belong in a
   memory store with supersession, not in the session log.

---

## 6. How to tell whether it worked

A resumed session is *oriented* if, without reading the log, it can answer:

- What is the goal, in the user's words?
- What is the next concrete action?
- Which task IDs are done, active, blocked?
- What approach was already tried and rejected, and why?
- What is the current repo/test state?

If it must open the log to answer any of these, Tier 1 is incomplete. That
five-question check is a usable regression test for the handoff generator.

---

## Sources read

- OpenHands SDK — `openhands/sdk/context/condenser/` (`base.py`,
  `llm_summarizing_condenser.py`, `pipeline_condenser.py`, `utils.py`,
  `prompts/summarizing_prompt.j2`), `openhands/sdk/event/condenser.py`
- OpenHands ≤0.30 — `openhands/memory/condenser/impl/` (`amortized_forgetting`,
  `recent_events`, `observation_masking`, `browser_output`, `llm_summarizing`)
- DeepSeek Harness — `website/.generated/reference/subsystems/compaction.md`,
  `packages/compaction/` (`compaction`, `compaction-basic`,
  `compaction-tool-result-pruner`, `command-compact`), `.agents/notes/` on
  summary-prefix cache reuse and English compaction checkpoints
- Memory layer — LangMem, Graphiti/Zep (arXiv 2501.13956), Letta, mem0,
  basic-memory, oc-mnemoria, mcp-memory, serena
- Context engineering — Anthropic, "Effective context engineering for AI agents";
  Manus, "Context Engineering for AI Agents: Lessons from Building Manus"
