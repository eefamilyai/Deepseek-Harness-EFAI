---
description: "Post-compaction recovery injection carrying the operator's prompts and the session log tail, plus the session log path as a prompt fact, for deployments tuning what survives a compaction."
kind: "package-reference"
---

# @deepseek-ai/dsh-session-recovery-context

English | [中文](README.zh.md)

## Summary

`dsh-session-recovery-context` puts the record back after a compaction: one injected message carrying every operator prompt and the tail of the session log, delivered once per compaction, so the model spends no turn fetching what it just lost. It also keeps that record in the system prompt as a `Context file:` fact, re-read whenever a compaction replaces it, and registers the session's log path, directory, and id as prompt variables. A session with no compaction receives nothing. The cost is one durable user-role message per compaction, bounded by the configured prompt and tail budgets.

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

Mount this plugin when sessions run long enough to compact and the model must resume the operator's actual task rather than a summary of it.

### When to choose it

Choose it for any composition that mounts a compaction engine and keeps working after the summary replaces the transcript. The turn after a compaction is the turn most likely to resume the wrong task confidently, because what compaction drops includes the operator's own words — the brief the work was commissioned with, and every correction since. Avoid it when a deployment never compacts, or when durable history cost matters more than post-compaction accuracy: the injected message is itself a permanent session event. There is no fallback package; the alternative is a skill or prompt line telling the model to go read its own log, which costs a turn and can be skipped.

### Minimal configuration

The minimal mount needs no configuration beyond the session root, which must match the persistence backend's:

```yaml
- name: '@deepseek-ai/dsh-session-recovery-context'
  config:
    tailEvents: 50
```

| Field | Default | Meaning |
|---|---|---|
| `root` | `dshHomePath('sessions')` | Session root the JSONL backend writes under, used to derive the printed log path |
| `compression` | `zstd` | The backend's artifact encoding, which decides the log file's suffix |
| `tailEvents` | `50` | Trailing events the digest carries; `0` drops the tail entirely |
| `promptChars` | `1200` | Per-prompt character budget before a clip marker replaces the remainder |
| `maxPrompts` | `0` (keep every prompt) | How many operator prompts to retain |
| `labelChars` | `120` | Per-event label budget inside the tail |
| `preamble` | shipped sentence | First line of the injected message |

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

Nothing here scans history. One Session projection folds the operator prompts, a rolling event tail, and the newest compaction's sequence number as events commit, which is what the [synchronous-read deprecation](../../../.agents/notes/implemented/architecture/2026-09-09-deprecate-synchronous-session-event-reads.md) prescribes in place of reading the log: the state survives resume and costs one pure fold per event. A prepended `agent/pre-step` listener delegates first, then appends one sourced `UserMessage` when the entered decision belongs to a session whose newest compaction has no answer yet.

Idempotency runs through the log rather than through process memory. The injected message records `{ kind: 'plugin', plugin: 'session-recovery-context' }` as its source, and the same fold reads that back as "this compaction has been answered", so a second step in the same turn cannot repeat it and a resumed session does not re-inject.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: projection fold, pre-step injector, prompt variables and the log context line |
| [`src/log-path.ts`](src/log-path.ts) | Session path derivation mirroring the JSONL backend's own sanitization |

### Main flow

The fold clips each operator prompt to `promptChars` and keeps prompts in order; at a `maxPrompts` bound it drops from the middle, because the first prompt is the brief and the last ones are the current intent, and what a bound can afford to lose is the steering in between. The tail keeps one digest per event — sequence, type, and a short label read structurally out of whatever payload the event turns out to carry, so event types added after this file still render legibly. Rendering joins the preamble, the numbered prompts, the tail, and a closing line naming the log file that holds everything clipped above.

`src/log-path.ts` mirrors the backend's path sanitization rather than importing it, because that logic lives in a file the backend package does not publish; it imports the two format-policy pieces that are public. `tests/log-path-oracle.spec.ts` pins the mirror byte-for-byte against the backend's own derivation across roots, working directories, and session ids, so drift fails a test rather than printing a path to a file that does not exist.

**Runtime invariant:** No companion is published. The projection's state schema validates every folded value at the registry boundary, and the one relationship this package owns — an injection answers exactly one compaction — is carried in the log by the injected message's own source, where the fold re-reads it.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the event stream this plugin folds, through the engine that triggers it, to the exhaustive configuration.

- [Session projections subsystem](../../../docs/subsystems/session-projection.md) — the projection unit contract, drive semantics, and state versioning.
- [Compaction subsystem](../../../docs/subsystems/compaction.md) — what a compaction keeps, what it drops, and when the summary event commits.
- [`session-persistence-jsonl/`](../session-persistence-jsonl/README.md) — the backend that writes the file this package names, and the root it writes under.
- [`system-prompt/`](../../core/system-prompt/README.md) — prompt variables, runtime-context contributions, and the strict `{{name}}` rule.
- [session group map](../README.md) — sibling durable session-data packages.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-session-recovery-context) — every accepted config field and its source declaration.

-----

<a id="model-experience"></a>
## Model Experience

### Post-compaction recovery message

#### What the model sees

One user-role message, injected on the first entered step after a compaction. `<preamble>` is the configured first line; prompts are numbered oldest first and clipped to `promptChars` with a `[+N chars, whole text in the session log]` marker; the tail section is omitted entirely when `tailEvents` is `0`.

##### Injected message

```markdown
<preamble>

## Operator prompts, oldest first
1. [seq <n>] <operator-text-or-clip>

## Last <count> session events, oldest first
[seq <n>] <event-type> — <label-when-the-payload-has-one>

The whole record, including everything clipped above, is in this session's log: <absolute-log-path>
```

#### Token effect

One message per compaction, never per step, and it persists in durable history afterwards. Its size is bounded by `promptChars` times the retained prompt count plus `tailEvents` times `labelChars`; the defaults put a typical injection in the low thousands of tokens.

#### KV Cache effect

Append-only; the message follows the reusable request prefix and does not invalidate existing KV Cache entries. The compaction that triggers it has already rewritten the prefix.

### Session log path in the system prompt

#### What the model sees

One runtime-context line naming the session's own log file, plus the `{{session_id}}`, `{{session_log}}`, and `{{session_dir}}` variables available to deployment-owned prompt text. Every one of them is empty when no session is attached to the assembly.

##### Runtime context line

```markdown
This session is logged to <absolute-log-path>
```

#### Token effect

A single line in the stable system prompt, re-rendered per assembly. It replaces the several tool calls a model would otherwise spend locating its own log.

#### KV Cache effect

The line is stable for the life of a session, so it contributes to the reusable prefix rather than invalidating it; it changes only when the session itself changes.

### Compaction record in the system prompt

#### What the model sees

One runtime-context fact naming the current compaction record, then the record's own text: a `Context file:` line followed by the file's contents, re-read whenever a compaction replaces it. Before the first compaction the fact is empty; between a compaction and the write of its record it carries the path alone.

##### Runtime context fact

```markdown
Context file: <absolute-record-path>

# Compaction record
...
```

#### Token effect

The record's full text joins the system prompt, so the cost is the record's own size — the same document the recovery step carries, bounded by the configured event and prompt budgets.

#### KV Cache effect

The fact changes exactly when a compaction replaces the record, which is the same moment the prefix is rewritten anyway. Between compactions it stays stable.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when the recovery injection is a poor fit. They are current package constraints.

- **The printed root is stated twice** — `root` and `compression` mirror the persistence backend's own configuration instead of being read from it, so a deployment that moves the session root must move both rows or the prompt will name a file that does not exist.
- **Path derivation is a mirror, not a call** — the backend's sanitization is reimplemented here and held in place by an oracle test, because the backend does not publish it; an unpublished change upstream fails that test rather than being absorbed.
- **One injection per compaction, whatever its size** — a compaction that drops an hour of work and one that drops a minute of it produce the same bounded message.
- **Durable cost** — the injected message is a permanent session event, so a session that compacts repeatedly accumulates one recovery message per compaction.
- **Labels are structural** — the tail reads `content`, `name`, `summary`, `reason`, `mode`, or `title` out of each event, and renders a bare type name for events carrying none of them.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
