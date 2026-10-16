---
description: "DeepSeek API peak-hour indicator and send guard: a composer pill that warns while DeepSeek bills peak (2×) rates, and a dialog that asks before a DeepSeek API message is sent at peak."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-peak-hours

## Summary

A pill under the composer that shows which DeepSeek API price applies now. DeepSeek bills peak hours at twice the off-peak rate: 01:00–04:00 and 06:00–10:00 UTC on working days, with weekends and Chinese public holidays off-peak in full ([DeepSeek pricing](https://api-docs.deepseek.com/quick_start/pricing)). The pill turns amber during peak and shortly before it, and can send a desktop notification at both transitions. During peak, sending a message on a DeepSeek API route opens a dialog first: send anyway, schedule it for when peak ends, or keep editing.

## Table of Contents

- [Readings](#readings)
- [The send dialog](#the-send-dialog)
- [Use this package](#use-this-package)
- [Configuration](#configuration)
- [How time is classified](#how-time-is-classified)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

<a id="readings"></a>
## Readings

| Reading | Pill |
|---|---|
| Peak pricing on | amber fill, pulsing dot, `DeepSeek peak 2× · 1h 20m left` |
| Peak starts within `warnBeforeMinutes` | amber outline, `DeepSeek peak 2× in 12m` |
| Off-peak | tertiary text, `DeepSeek off-peak · peak in 3h 5m` |
| Schedule fields invalid | amber outline, `Peak schedule invalid`, problems in the tooltip |

Hovering or focusing the pill shows when the current period ends or the next starts, the reason for an off-peak day (weekend, or the holiday's name), and the working-day windows in the reader's time zone. Only a transition the open window observes notifies; a period already running when the window opens shows the pill without a notification.

<a id="the-send-dialog"></a>
## The send dialog

During peak pricing, sending a message whose route is in `gatedRoutes` opens a dialog before anything is sent. The default routes are the DeepSeek API ones: `deepseek-official` and the Kiln bridge `kiln-deepseek-api`. Web-login routes (`deepseek-account`, the `kiln-deepseek` pool) and every other provider are never asked about. A Session that has not sent yet uses the model catalog's default route.

| Choice | Effect |
|---|---|
| Send anyway | The message is sent as if the dialog had not appeared. |
| Schedule for *time* | The message becomes an Automation task due when peak ends, through `@deepseek-ai/dsh-peak-send`; the composer clears and says when it will be sent. |
| Keep editing (or Escape, or close) | Nothing is sent. The composer gets back the draft, its reference chips, and its attachments. |

When the Session already has a message waiting for its off-peak send, the dialog lists the waiting messages and replaces the schedule button with two choices:

- **Queue after the waiting messages**: a separate task at the same time, which starts only once the earlier messages' turns have settled.
- **Add to the last waiting message**: this text is appended to it, and both go out as one message.

The dialog sits on the conversation service's `sendSession`, the composer's default send. It installs while the `conversation` service exists and restores the original method on teardown. The composer clears a draft as soon as it is sent and restores it when the send settles as an error, so keeping the draft is an error without text, which shows no notice. A message with attachments, or a deployment without the `peakSend` namespace, offers only sending now or keeping the draft.

<a id="use-this-package"></a>
## Use this package

`packages/bundle/efai-web` mounts it:

```yaml
- id: ui-peak-hours
  name: '@deepseek-ai/dsh-client-ui-peak-hours'
```

The browser half reads its settings by that row id, so a composition that renames the row loses its settings and runs on the defaults.

<a id="configuration"></a>
## Configuration

Every field is volatile: an edit reaches the open window without a restart.

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Show the pill. |
| `showOffPeak` | `true` | Also show the off-peak reading; off hides the pill outside peak and the lead warning. |
| `warnBeforeMinutes` | `15` | Lead warning before a peak period, 0–240; 0 disables it. |
| `notify` | `true` | Desktop notifications at the lead warning and at peak start. |
| `windows` | `01:00–04:00`, `06:00–10:00` | Peak windows on a working day, `HH:MM` UTC, end exclusive. |
| `weekdays` | `[1, 2, 3, 4, 5]` | Working weekdays, 0 = Sunday. |
| `holidays` | the 2026 breaks | `{ name, from, to }` inclusive `YYYY-MM-DD` ranges, off-peak in full. |
| `calendarUtcOffsetMinutes` | `480` | Offset of the calendar that dates weekdays and holidays (China Standard Time). |
| `sendGate` | `true` | Ask before a DeepSeek API message is sent during peak. |
| `gatedRoutes` | `deepseek-official`, `kiln-deepseek-api` | Provider routes billed at DeepSeek API rates, which the dialog guards. |

The default holidays are the seven 2026 breaks of the State Council notice 国办发明电〔2025〕7号. Weekend make-up working days are not listed, because DeepSeek prices every weekend off-peak.

A schedule with a malformed time or date, a window that does not end after it starts, or a weekday outside 0–6 fails the Host row at load; the same problem introduced by a later volatile edit turns the pill into the invalid reading.

<a id="how-time-is-classified"></a>
## How time is classified

`src/schedule.ts` places each window on each UTC day from yesterday through 31 days ahead, drops a window whose start falls on a non-working weekday or a holiday date in the configured calendar, and merges windows that touch. An instant inside a merged interval is peak, and the interval's end is when it ends; otherwise the next interval's start is when peak resumes. The reading is recomputed every 15 seconds, when the settings section changes, and when the window becomes visible again, and the store republishes only when the minute-resolution reading changes.

No runtime invariant companion is published: the classification is a pure function of configuration and the clock, and the pill renders exactly that function's output, so there is no second observation that could diverge from it. The package specs pin the classification against fixed instants.

## Model Experience

None, as the pill, its notifications, and the send dialog are browser presentation. The dialog decides whether and when a message is sent, never what it contains; a scheduled message's delivery framing is described in `@deepseek-ai/dsh-peak-send`.

#### KV Cache effect

No model request prefix changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Holiday breaks are configuration, not a feed. The State Council publishes each year's breaks around November; until a new year's breaks are added to `holidays`, its holidays classify as ordinary working days.
- The pill shows DeepSeek's schedule whichever model the session uses; only the send dialog reads the selected route.
- The dialog guards the composer's own send. A message that reaches a Session another way (the queue dock's Steer, a slash command, an Automation task) is not asked about.
- The dock renders inside a session, so a blank New Session hero shows no pill.
