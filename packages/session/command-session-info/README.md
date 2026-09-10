# @deepseek-ai/dsh-command-session-info

The human-facing **`/sessioninfo`** slash command: a read-only report of one session's token usage, context pressure, and activity.

The handler is synchronous and read-only. It snaps the receiving agent's session through the projection registry and renders three things side by side:

- **Token usage** — reported twice: lifetime totals that survive every compaction, and the resettable buckets since the last `/compact`. Keeping them apart is the point, so a billing total is never mistaken for one turn's prompt cost.
- **Context pressure** — the current prompt-side occupancy and its share of the context window.
- **Activity** — whole-log turn and step counts, model and tool wall time, and first-token and decode statistics.

Nothing here writes to the session or starts model work.

```text
Session
  id       sess_…
  model    deepseek-official/deepseek-v4-pro

Token usage (lifetime; across all compactions)
  fresh input   1.2M
  cache read    18.4M
  billed input  19.6M
  output        412K

Context pressure (current, prompt side only)
  projected   118K (59% of 200K)

Activity (whole log)
  turns          14
  steps          63
```

## Registration

`ctx.commands.register` publishes the command with `recordInput: false`, so the invocation text never enters the session log. The report is returned as a `CommandResult` and rendered to the operator.

## Model Experience

None, as the command is operator-facing and registers no prompt, tool, schema, or session event.

#### KV Cache effect

No direct invalidation; the report is rendered to the person who typed the command and never enters a model request.

## Known Limitations and Deferred Work

These limits define what this package does not provide. They are current package constraints, not a roadmap.

- **Read-only projection** — the command reports only what the session-projection registry already folded; it computes no new statistic and cannot start or steer model work.
- **Degrades when the lifetime projection is absent** — with no `tokenUsageLifetime` unit mounted, the lifetime totals fall back to the since-compact buckets rather than showing zero, so the two blocks can then read alike.
- **No arguments** — passing any argument returns the usage line as an error.
- **Operator-facing only** — the output is shown to the human who typed it; it is not a tool, so the model never sees it.

Fork-owned: `packages/session/command-session-info` is Tier 1, so it touches no upstream file.
