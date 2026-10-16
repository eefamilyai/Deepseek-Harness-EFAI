---
description: "Lifetime token usage: what a session has spent since it began, across every compaction, published as its own projection."
kind: "package-reference"
---


# @deepseek-ai/dsh-llm-token-usage-lifetime

## Table of Contents

- [What it folds](#what-it-folds)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

## Summary

Upstream's `tokenUsage` projection answers for the conversation the model can currently see, so a compaction resets what it reports. That is correct for context pressure and wrong for "what has this session cost", which is what `/session-info` reports. This unit folds the same durable usage samples without the reset and publishes them under `tokenUsageLifetime`.

It is a separate projection rather than an edit to `token-meter` because a projection is a registration: `ctx.sessionProjections.register()` takes a definition from anyone, and two units over the same events cost one fold each.

```yaml
- id: token-usage-lifetime
  name: '@deepseek-ai/dsh-token-usage-lifetime'
```

## What it folds

One settlement per turn/step, replacing rather than adding: a step can settle twice — an attempt, then its assistant message — and the second report supersedes the first. Totals carry four buckets (`uncachedInputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`) plus the turn and step of the last sample, so a reader can tell a stale figure from a live one.

<a id="dev-note"></a>
## Dev Note

The fold is one pass over the session events, and its state schema is the one definition of the totals a reader sees: `projectionSchema` is shared between the definition and the state it stores, so a bucket added in one place cannot be forgotten in the other.

No runtime invariant companion is published: the projection is one fold over durable usage samples, and the projection registry owns its checkpoint and replay.

## Model Experience

### The lifetime total

#### What the model sees

Nothing. The projection is read by the surfaces that report cost — `/session-info` and any consumer that selects the `tokenUsageLifetime` key — and never enters a request. It adds no session event either: it folds events other packages already recorded.

#### Token effect

None. Reading a projection does not change a request, and the plugin's own work is a fold over events that exist whether it is mounted or not.

#### KV Cache effect

None. The unit never touches the assembled prefix, so mounting or unmounting it cannot invalidate a cached request.

## Known Limitations and Deferred Work

- A provider that omits its cache buckets reports nothing for them, and the fold records zero; a session on such a provider reads as one that never used a cache, which is a fact about the report rather than about the traffic.