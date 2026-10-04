# Fork-local tools

Utilities the fork owns and runs by hand. Nothing here ships in a profile or runs as part of
a build; each one exists because a repair or a check had to happen outside the harness.

## `repair-recorded-tables.mjs`

Repairs the markdown tables a session already recorded.

**Why it exists.** `@deepseek-ai/dsh-llm-markdown-fidelity` repairs a table's delimiter row
while the answer streams. Text a session recorded *before* that pass was mounted is never
streamed again, so the malformed bytes stay malformed for every reader — the page shows a
paragraph of pipes where a table was meant. No supported mechanism can shadow a recorded
`assistant/message` either: a surface `replace` must cite every node it shadows
(`packages/core/session/src/surface.ts`), and an assistant message may not carry that field,
while the client builds its transcript from the raw event data. The recorded bytes are the
only place a historical table can be fixed.

**What it does.** Walks `~/.dsh/sessions/**/session*.jsonl(.zstd)`, decompresses the frame
concatenation, repairs `assistant/message` text blocks and `compaction/summary` bodies with
the same `repairTableLines` the stream pass uses, and writes the frames back through a
temporary file. Before and after every write it verifies the result: one header line, events
contiguous from seq 0, every repaired text a fixed point. Any disagreement restores the
`<name>.bak-<stamp>` copy it took first.

**When it must not run.** A host holds the authoritative log in memory and appends to the file
with `open(path, 'a')` per batch, so a rewrite is append-safe — but an append *in flight*
during the rewrite would land in the file the rename replaced, and the host's next append
would leave a seq gap that makes the log unloadable. The tool therefore skips any log written
inside `--settle` seconds, and `--held <session-id>` waits for a window with no
`DeepSeek Harness.exe` running before touching the session a host reopens. That window is the
gap of an ordinary restart, so it polls every second.

```sh
# what would change, and nothing else
node local-overlay/tools/repair-recorded-tables.mjs

# rewrite everything that is safe now, and wait for the rest
node local-overlay/tools/repair-recorded-tables.mjs --apply --held session-<id>

# one project, for checking the shapes without touching the corpus
node local-overlay/tools/repair-recorded-tables.mjs --sessions ~/.dsh/sessions/--D-...-- --apply --settle 0

# drop backup copies once the repaired sessions have been looked at
node local-overlay/tools/repair-recorded-tables.mjs --prune-backups 14
```

| Flag | Meaning |
|---|---|
| `--apply` | rewrite; without it the run only reports |
| `--sessions <dir>` | sessions root, or one project directory (default `$DSH_HOME/sessions`) |
| `--wait-for-pid <pid>` | wait for that host process to exit first |
| `--held <session-id>` | leave this session for a host-free moment, and repair everything else now |
| `--settle <seconds>` | treat a log written this recently as in use (default 120; `0` disables) |
| `--hold-ms <ms>` | how long the host-free wait may take (default 6h) |
| `--prune-backups [days]` | remove `*.bak-*` older than the grace period (default 14) |

**Proving a repaired log is still a session.** The repair changes only text inside event
payloads and re-compresses the frames, so the check is a read: hand the repaired file to the
harness's own reader (`node apps/cli/lib/bin.js --profile headless --session-id <id> "…"`) and
require that it decompresses, parses, and validates the log. A staged copy of this session was
verified that way; the reader failed only on the unrelated "preset not composed" check.
