---
name: dsh-session-history
description: "Use when you need this harness's own prior conversation history — reading, searching, or resuming what an earlier agent did in this project, recovering context lost to compaction, or distinguishing the operator's actual instructions from mid-task steering and machine-injected reminders. Locates $DSH_HOME/sessions/ logs, decodes their concatenated zstd frames, and answers 'what was I asked to do' and 'what happened'."
---

# Reading DSH Session History

Every session this harness runs is written to disk as it happens. That log is the
only durable record of what the operator asked for and what the agent did, and it
survives context compaction, a kernel restart, and a fresh session.

## When to use this

- The user says "resume", "continue", "pick up where you left off", or hands you a
  path to a session log.
- Context was compacted and you need the original request, not the summary of it.
- You need to know what a previous agent already changed, tried, or ruled out.
- The user asks what the latest instruction actually was.

## The one command that matters most

```bash
node .agents/skills/dsh-session-history/session-read.mjs latest-prompt
```

That prints the **instructional** prompt: the prompt at which the goal was set, which
is the task the work was actually commissioned with. Start there when resuming
anything. Add `--session <id>` to target a specific session, or `--kind steering` to
see the last mid-task correction instead.

## Instruction versus steering

Not every `user/message` in the log is a task statement, and treating them alike is
how an agent ends up re-doing work or ignoring the real brief.

- **Instruction** — the prompt in effect when the goal was set. The harness writes
  goal creation as a `goal/change` event with operation `create`, mid-turn; the
  operator message that opened that turn is the prompt the work was commissioned
  with. In this session that was `resume.`, not the later nudges.
- **Steering** — redirects work already underway and states no new task:
  `dont touch that dsml.ts`, `use optimized methods to search`,
  `read slightly more history`, `you can use git grep?`.

The harness records how each message arrived in `agent/inbox/spliced`:
`target: "next-step"` means it was injected into the running turn, and
`target: "next-turn"` means it opened the next one. A `next-step` message is always
steering. Turn-opening messages are judged by shape too, because a steer can land in
the gap after a turn aborts and then opens a turn of its own — `you can use git grep?`
did exactly that. Pass `--steer-max-chars 0` to disable the shape test.

`agent-instructions`, `plugin`, `skill-catalog`, `goal`, `subagent-report`, and
`compaction` messages are machine-injected context. They are never an operator
prompt; the tool already excludes them from `latest-prompt`.

## Other modes

```bash
# Newest sessions first, with cwd and size
node .../session-read.mjs list --limit 20
node .../session-read.mjs list --cwd D:\deepseek-kernel-harness

# Every operator prompt in a session, with role/delivery/turn
node .../session-read.mjs prompts --session f30b9b43
node .../session-read.mjs prompts --session f30b9b43 --kind steering

# Event-type histogram, useful for sizing a log before reading it
node .../session-read.mjs types --session f30b9b43

# Regex search across one session or all of them
node .../session-read.mjs grep "boot failure" --session f30b9b43 --before 1 --after 3
node .../session-read.mjs grep "ERR_MODULE_NOT_FOUND" --limit 5

# Recent events, or a specific window
node .../session-read.mjs tail --session f30b9b43 --limit 30
node .../session-read.mjs show --session f30b9b43 --from 8700 --to 8710
```

Session ids may be given in full, as an id prefix, or as a bare UUID fragment; an
ambiguous fragment resolves to nothing rather than to a guess.

## How to work efficiently

These logs get large — this project has sessions over 8 MB and one log held 10,000
events. Do not read one end to end.

1. `types` first to see what the log contains and how big each part is.
2. `grep` with a narrow regex to jump to the interesting region.
3. `show --from N --to M` to read only that window.
4. `latest-prompt` when the question is simply "what was I asked to do".

Prefer `git grep` over `rg` inside this repository: it reads the tracked tree only and
skips `node_modules` and other untracked bulk by construction.

## Log format

Logs live at `$DSH_HOME/sessions/<project>/<session-id>/session.jsonl.zstd`
(`$DSH_HOME` defaults to `~/.dsh`). The project directory is the cwd with separators
replaced by `-`, so `D:\deepseek-kernel-harness` becomes
`--D-deepseek-kernel-harness--`.

Each file is a **concatenation of independent Zstandard frames**, so a single
`zstdDecompress` call returns only the first frame and silently loses the rest. The
reader scans frame boundaries structurally, mirroring
`@deepseek-ai/dsh-session-persistence-jsonl`, then decodes each frame in turn. It
needs no dependency beyond the zstd support built into Node 22.15+/24, so it runs from
any checkout without a build step.

A log written by a session that is still running ends in a torn frame; the reader
skips the incomplete tail rather than failing.

## Limits

- The reader is read-only. It never writes to a session log or resumes a session.
- It reports what the operator said, not whether the agent complied; check
  `tool/call` and `tool/result` events in the same window for what actually ran.
- A `--kind` value that matches nothing prints `no <kind> prompt found` and exits 0,
  so a caller can distinguish "none" from "the tool broke".
