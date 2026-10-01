# DS-MUTE: WHAT THE MUTE ACTUALLY IS

## The reason, from the web UI (the one place it is ever stated)

> Due to violation of user policies, your account has been suspended until
> October 4, 2026 00:40. If you have any questions, please Contact us.

Three independent records agree to the second:

| source | value |
|---|---|
| web UI banner (t1) | October 4, 2026 00:40 (local) |
| `ds_muted.json` t1 | `1791045600` -> 2026-10-04 00:40:00 |
| wirelog verdict | `user is muted (until 2026-10-03 16:40 UTC)` |

It is an account-level POLICY verdict. The API this harness talks to reports only
the penalty (`is_muted`, `mute_until`) and never a reason -- which is why ten
client-side leads all came back empty.

## The penalty

72 h, with a 216 h variant. The 216 h on jw1 was **our own doing**: 32 requests
retried through a live mute escalated 72 -> 216 h (FIX 17).

## Your original hypothesis was right, and was already partly fixed

Six `sec-ch-ua-*` headers were being sent that the origin never granted. Commit
`8b8e59fd7c` -- *"stop the mute storm and send only the granted client hints"* --
moved all three call sites to the triple. This session's FIX 22 retired the stale
docstring and stale test that would have led someone to put the nine back.

It is not the whole story: accounts kept muting after that fix.

## Ten client-side leads, all falsified by measurement

request shape · the 29-header set (identical across muted and clean) · login
pattern · content · burst volume · pacing · cumulative count · IP/machine scope ·
token generations · exposure duration.

None separates muted from clean. Whatever the client does, it does to every
account equally -- so no client-side property can explain a *differential* mute.

## What to do

1. **Restart `provider_bridge`.** FIX 18/19/20/21/22 are on disk; the running
   process still holds the pre-fix modules.
2. **Appeal**: "Contact us" -> `service@deepseek.com` (Terms of Use s11).
3. **Expect recurrence** if the automated client keeps running at this volume. A
   policy suspension is an adjudication about the account, and driving it harder
   is what re-triggers it.

## Shipped this session

FIX 21 -- the mute backfill floored expiry to `:00`, expiring live mutes up to
59 s early (the FIX 17 escalation class). FIX 22 -- stale nine-hint docstring +
a test that had been red for two days. Both pushed.
**1022 checks across 35 suites, zero failures.**
