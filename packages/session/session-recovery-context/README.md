---
description: "Post-compaction recovery: a code-maintained session ledger restated as a handoff in the same step a compaction happens, plus a focus line and the session log path, for deployments tuning what survives a compaction."
kind: "package-reference"
---

# @deepseek-ai/dsh-session-recovery-context

English | [中文](README.zh.md)

## Summary

`dsh-session-recovery-context` makes a compacted session carry on as if nothing was lost. As the log commits, it folds the facts a summary drops first — the operator's own words, the files touched, the commands run, the errors still open, the todo list — into a ledger. In the same step a compaction happens, it adds one handoff message that restates them, attaches the current contents of the most recently changed files, and ends with the exact place to resume. The turn keeps running: no step is spent and nothing is acknowledged. After the first compaction, a one-line focus note in the runtime context keeps the in-progress todo and the next step in view. The plugin also registers the session's log path, directory, and id as prompt variables. A session that never compacts gets only the log-path line.

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

Mount this plugin when sessions run long enough to compact and the model must resume the operator's actual task, not a summary of it.

### When to choose it

Choose it for any composition that mounts a compaction engine and keeps working after the summary replaces the transcript. The step after a compaction is the one most likely to resume the wrong task with confidence. A model-written summary paraphrases the operator's brief, drops corrections, forgets which files were edited, and loses the error that was still open — and nothing downstream can tell. Avoid it when a deployment never compacts. There is no fallback package; the alternative is a prompt line telling the model to read its own log, which costs turns and can be skipped.

### Minimal configuration

The only field most deployments set is the session root, which must match the persistence backend's:

```yaml
- name: '@deepseek-ai/dsh-session-recovery-context'
  config:
    root: !!js dshHomePath('sessions')
```

| Field | Default | Meaning |
|---|---|---|
| `root` | `dshHomePath('sessions')` | Session root the JSONL backend writes under; used for the log path and the per-compaction record file |
| `logCompression` | `zstd` | The backend's artifact encoding, which decides the log file's suffix |
| `ledger` | `{ prompts: 24, promptChars: 4000, files: 60, commands: 12, errors: 6, errorChars: 400 }` | Bounds on what the ledger keeps |
| `rehydrate` | `{ files: 4, perFileChars: 8000, maxBytes: 524288 }` | How many changed files the handoff re-attaches, and how much of each |
| `handoffShare` | `0.08` | Share of the routed model's context window the handoff may use |
| `handoffMinChars` / `handoffMaxChars` | `6000` / `24000` | Floor and ceiling of the handoff budget, in characters |
| `git` | `true` | Snapshot `git status` into the handoff |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-session-recovery-context) is the exhaustive source for every accepted field and its JSDoc.

### Naming the log file in your own text

The plugin registers three prompt variables — `{{session_id}}`, `{{session_log}}`, and `{{session_dir}}` — so deployment-owned persona text can name the exact file the log writer is appending to. Names are snake_case because the prompt registry rejects anything outside `/^[a-z][a-z0-9_]*$/`. A `{{name}}` reference with no registered provider throws at assembly on every turn, so text using these must not be composed into a tree that omits this plugin.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design of the plugin; the observable behavior is covered in [Use this package](#use-this-package).

### Design concept

Two ideas carry the design. First, what a summary loses is what code can know for certain, so code keeps it: the ledger is a pure fold over committed events, and the model is never asked to remember what the log already records. Second, recovery must not interrupt the work it recovers. The handoff rides the step the compaction happened in, because a step whose reply calls no tool ends the turn — an extra "acknowledge the record" step stopped every task compacted mid-run.

Nothing here scans history. One Session projection folds each event once, as the [synchronous-read deprecation](../../../.agents/notes/implemented/architecture/2026-09-09-deprecate-synchronous-session-event-reads.md) prescribes, so the ledger survives resume. Idempotency runs through the log: the handoff's own source (`{ kind: 'session-recovery', form: 'handoff', compactionId }`) folds back as "this compaction has been answered", so a later step or a resumed session never repeats it.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: projection registration, the pre-step handoff, the record file, prompt variables, the log and focus context lines |
| [`src/ledger.ts`](src/ledger.ts) | The ledger schema and its pure fold: operator messages, pending calls, files, commands, unresolved errors, todos, the latest checkpoint |
| [`src/handoff.ts`](src/handoff.ts) | Rendering the handoff within its budget, and the focus line |
| [`src/workspace.ts`](src/workspace.ts) | The `git status` snapshot and the re-attached file contents |
| [`src/log-path.ts`](src/log-path.ts) | Session path derivation mirroring the JSONL backend's own sanitization |

### Main flow

The ledger keeps every operator message verbatim up to `promptChars`. At the `prompts` bound it drops from the middle, because the first message is the brief and the newest ones are the current intent. A message that arrives after a step of the open turn has ended is marked as a mid-turn correction. Tool calls are classified by name and arguments: `read`, `write`, `edit`, `str_replace_editor`, and `notebook_edit` touch a file; `bash`, `pwsh`, and `kernel` are commands. Each result is judged by its error flag, a non-zero exit status, or a Python traceback. A later success with the same tool and target resolves an earlier failure there.

The pre-step listener is prepended and calls the rest of the chain first, so compaction — which runs inside that chain — has already happened when it reads the ledger. If the newest checkpoint has no handoff yet, it builds one. The budget comes from the routed model's context window; the `git status` snapshot and the re-attached files come from the session's working directory. The listener writes the handoff and the checkpoint to `compaction-<id>-<session>.md` in the session directory, then puts the handoff first among the step's messages, so the operator's own message and the runtime context stay nearest the next generation.

The handoff never restates the checkpoint, which is already in the history one message above it. It ends with "Continue from here": the checkpoint's Current Work and Next Step sections, the todo in progress, and the most recent request. That is the last thing the model reads before it generates.

`src/log-path.ts` mirrors the backend's path sanitization rather than importing it, because that logic lives in a file the backend package does not publish. `tests/log-path-oracle.spec.ts` pins the mirror byte-for-byte against the backend's own derivation.

**Runtime invariant:** No companion is published. The projection's state schema validates every folded value at the registry boundary. The one relationship this package owns — a handoff answers exactly one compaction — is carried in the log by the handoff's own source, where the fold reads it back.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the event stream this plugin folds, through the engine that triggers it, to the exhaustive configuration.

- [Session projections subsystem](../../../docs/subsystems/session-projection.md) — the projection unit contract, drive semantics, and state versioning.
- [Compaction subsystem](../../../docs/subsystems/compaction.md) — what a compaction keeps, what it drops, and when the summary event commits.
- [`output-masking/`](../../compaction/output-masking/README.md) — the fork's masking pass, which defers compaction by stubbing old tool output.
- [`session-persistence-jsonl/`](../session-persistence-jsonl/README.md) — the backend that writes the file this package names, and the root it writes under.
- [`system-prompt/`](../../core/system-prompt/README.md) — prompt variables, runtime-context contributions, and the strict `{{name}}` rule.
- [session group map](../README.md) — sibling durable session-data packages.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-session-recovery-context) — every accepted config field and its source declaration.

-----

<a id="model-experience"></a>
## Model Experience

### Handoff after a compaction

#### What the model sees

One user-role message, first among the messages of the step in which the compaction happened, directly after the checkpoint. Sections with nothing to say are omitted. File contents take only the budget the other sections leave.

##### Handoff message

```markdown
# Handoff after context compaction

The earlier part of this session was condensed into the checkpoint above to free up context.
This message restates, from the session record itself, what you were asked and the exact state of the work.
You are continuing work already in progress: do not acknowledge this message and do not recap it.
Pick up at "Continue from here" at the end, and read the full record if you need an exact detail it does not carry.

## Your requests (verbatim, oldest first)

### 1. first request (seq <n>)

<operator-text>

### <k>. correction mid-turn (seq <n>)

<operator-text>

## State when the context was compacted

### Todo list
- [x] <completed>
- [~] <in progress>
- [ ] <pending>

### Files touched (newest first)
- `<path>` — created, edited, read ×<n>

### Unresolved errors (newest last)
- **<tool>** `<target>` (seq <n>):
  <error excerpt>

### Recent commands (newest last)
- ✓ <tool>: `<command>`
- ✗ <tool>: `<command>`

### Git
<git status --porcelain --branch, clipped>

## Recently changed files (current contents)

### `<path>`
<file contents, cut to fit>

## Full record

- This handoff and the checkpoint, as plain text: `<record-path>`
- The complete session log (zstd-compressed JSONL, one event per line): `<log-path>`

## Continue from here

**In progress when the context was compacted:** <checkpoint Current Work>
**Todo in progress:** <todo>
**Next step:** <checkpoint Next Step>
**Most recent request (seq <n>):** <operator text, clipped>
```

#### Token effect

One message per compaction, never per step, and it persists in durable history afterwards. Its size is `handoffShare` of the routed window, clamped to `handoffMinChars`–`handoffMaxChars` characters: 6,000–24,000 characters, roughly 1,500–6,000 tokens, with the defaults.

#### KV Cache effect

Append-only. The compaction that triggers it has already rewritten the prefix, and the handoff follows the checkpoint, so it invalidates nothing that the compaction had not already invalidated.

### Focus line and session log path in the runtime context

#### What the model sees

One line naming the session's own log file, always. After the first compaction, a second line re-anchors the plan. Both are empty when no session is attached to the assembly.

##### Runtime context lines

```markdown
This session is logged to <absolute-log-path>
Focus (this session was compacted; the handoff message has the full state): in progress: <todo> · <n> todo(s) open · next step at the last compaction: <next step>
```

#### Token effect

A line or two per assembly, re-rendered each time. The focus line costs a few dozen tokens, and only in sessions that have compacted.

#### KV Cache effect

The runtime context is projected as a message appended to the step, and is re-sent only when its text changes. The log line is stable for the session's life. The focus line changes when the todo list or the checkpoint changes, which is when the model most needs the new text.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define when the recovery handoff is a poor fit. They are current package constraints.

- **The printed root is stated twice** — `root` and `logCompression` mirror the persistence backend's own configuration instead of being read from it, so a deployment that moves the session root must move both rows or the handoff will name a file that does not exist.
- **Path derivation is a mirror, not a call** — the backend's sanitization is reimplemented here and held in place by an oracle test, because the backend does not publish it.
- **Tool knowledge is by name** — the ledger recognises the harness's own file and shell tools by name and argument key. A tool it does not know is still recorded as a call, but it does not add a file or a command.
- **Re-attached files are read at handoff time** — the contents are the file as it is when the handoff is built, not as the model last saw it. That is the point, but an external edit shows up unannounced.
- **Durable cost** — each handoff is a permanent session event, so a session that compacts repeatedly accumulates one handoff per compaction.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The design and the research behind it are recorded in the [compaction handoff Agent Note](../../../.agents/notes/implemented/feature/2026-09-24-compaction-handoff.md).

</details>
