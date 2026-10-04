---
description: "Skill bodies reaching the model by the fork's `@skill <name>` gesture, and names whose body must survive a compaction."
kind: "package-reference"
---


# @deepseek-ai/dsh-skill-injection

## Table of Contents

- [Two ways a body reaches the model](#two-ways-a-body-reaches-the-model)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

## Summary

Two ways a skill body reaches the model that upstream's `tool-skill` does not provide: the fork's `@skill <name>` gesture, which upstream's `/name` reader does not see, and names whose body must outlive a compaction. Both ride `agent/pre-step` and carry the `skill-invocation` source a gesture produces.

## Two ways a body reaches the model

- **The gesture.** The fork's client `@` picker lands `@skill <name>`, not `/name`. An unread gesture ships dead prose to the model: the user asked for a procedure and the model got the words `@skill dsh-session-history`.
- **The always-loaded bodies.** After a compaction the catalog republishes names and descriptions, but a body only ever entered the surface through a gesture. A recovery procedure the model was told to follow is reduced to its own name exactly when it is needed most.

Both ride `agent/pre-step`, the same waterfall `tool-skill` uses, so this is a second listener rather than an edit to that package. Everything it injects carries the `skill-invocation` source a gesture produces, so transcript consumers present one shape.

```yaml
- id: skill-injection
  name: '@deepseek-ai/dsh-skill-injection'
  config:
    alwaysLoadSkills: ['dsh-session-history']
    atGesture: true
```

<a id="dev-note"></a>
## Dev Note

Visibility is read from the session surface rather than the message list, because a compaction removes a body by shadowing its event: the message list no longer shows it, and the surface is what the model can actually read.


## Model Experience

### Injected skill bodies

#### What the model sees

A user message carrying the skill's rendered body, sourced `skill-invocation`, appended for each name this step loads — the same block a `/name` gesture would produce. A body is injected only when the name is present in the registry and model-invocable, and only when the surface no longer shows a body for that name: visibility is read from the session surface, because a compaction removes a body by shadowing its event, which the message list no longer shows.

#### Token effect

Each injection adds the skill's body to the request, once per loading. `alwaysLoadSkills` names cost their body again after every compaction that pruned them — the deliberate price of keeping a recovery procedure readable — and the gesture costs a body once, at the step the user asked for it. An empty `alwaysLoadSkills` removes the recurring cost entirely.

#### KV Cache effect

A gesture appends after the cached prefix, so it costs the body and leaves earlier caching intact. A re-injection after a compaction lands where the summary did, so the prefix is rebuilt from the publication onward either way; the plugin adds no separate invalidation of its own.

## Known Limitations and Deferred Work

- The gesture is read from the text blocks of admitted user messages. A skill name pasted as an attachment, or written into a file the model reads, is not a gesture, by design: loading a body is something the operator asks for in the message.