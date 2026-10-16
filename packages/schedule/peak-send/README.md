---
description: "Deferred sends: the Remote surface the peak-hour send dialog uses to hold a DeepSeek API message until peak pricing ends, as an Automation task."
kind: "package-reference"
---

# @deepseek-ai/dsh-peak-send

## Summary

Holds a message until DeepSeek peak pricing ends. The peak-hour send dialog in `@deepseek-ai/dsh-client-ui-peak-hours` calls this package's `peakSend` Remote namespace when the user chooses to schedule a message instead of paying peak rates. Each deferred message is an ordinary one-shot task of the Host schedule service, so it appears on the Automation tasks page, survives a restart, and can be edited or deleted there.

## Table of Contents

- [Use this package](#use-this-package)
- [Placements](#placements)
- [The `peakSend` namespace](#the-peaksend-namespace)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## Use this package

`packages/bundle/efai-base` mounts it. One row loads both halves: the Host service and the client half that mounts the namespace.

```yaml
- id: peak-send
  name: '@deepseek-ai/dsh-peak-send'
```

The Host service requires the `schedule` service, which the Automation tasks bundle (`@deepseek-ai/dsh-experimental-schedule-bundle`) provides. Without it the service never starts, and the send dialog reports that the Session cannot schedule messages.

<a id="placements"></a>
## Placements

A deferred task's title starts with `Off-peak send: `, followed by the message's first line. That prefix is how the service tells its own tasks from the user's other reminders.

| Placement | Effect |
|---|---|
| `alone` | A new task at the requested time, normally the end of the current peak period. |
| `after` | A new task at the earlier task's time. Tasks due at the same instant are delivered in creation order, and each delivery is a follow-up that becomes the sole message of its own turn, so this message starts only once the earlier message's turn has settled. |
| `together` | The text is appended to the earlier task's message, separated by a blank line, so both are sent as one message. |

<a id="the-peaksend-namespace"></a>
## The `peakSend` namespace

| Method | Contract |
|---|---|
| `pending(sessionId)` | The Session's deferred messages (`{ id, at, text }`), earliest first. |
| `defer({ sessionId, text, at, placement, earlierId? })` | Defers one message and returns the task carrying it with its canonical UTC send time. |

The client half mounts the namespace from the descriptors the build generates for this package, so no shared Remote assembly has to know it exists. A refusal surfaces as `RemoteError` with code `peakSend/defer-rejected` and the Session id in `details`. Refusals cover an empty message, a time that does not parse, an earlier message that is no longer waiting, and a merge the schedule service rejects.

No runtime invariant companion is published: the service keeps no state of its own. Every answer is read from or written to the schedule service in the same call, so a companion would have nothing independent to observe. The package spec asserts each placement against a stand-in schedule service.

## Model Experience

### Messages delivered when peak ends

#### What the model sees

This package hands each deferred message to the schedule service, which delivers it as a user-role message framed `[SCHEDULE REMINDER]` and `This is a scheduled message from the user`, with the message text as `reminder_prompt_json`. A message placed `together` is one reminder whose text holds both messages separated by a blank line.

#### Token effect

Each delivery costs the schedule framing plus the message text. Listing or deferring messages issues no model request.

#### KV Cache effect

The delivered message appends to the Session's history and starts its own turn; earlier messages and the request prefix are unchanged.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Attachments cannot be deferred, because a schedule task carries text only. The dialog leaves sending now or keeping the draft for a message with attachments.
- The delivered message keeps the schedule service's reminder framing; it is not replayed as if typed into the composer.
