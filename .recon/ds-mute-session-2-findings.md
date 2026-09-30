# DeepSeek mute investigation — session 2 (post-restart, t1/t2)

Continues `ds-direct-mute-investigation.md`. This session began after the operator
restarted the harness so it would serve the nine fixes, and supplied two fresh
accounts: `deepseek.ee.1+t1@gmail.com` and `deepseek.ee.1+t2@gmail.com`.

## 0. State established on pickup

| Fact | Value |
| --- | --- |
| Bridge restarted | 19:41:49 (AFTER `ds_direct.py` mtime 17:58:41) → **serves the new edits** |
| Git HEAD == origin/master | `0bb8e9d6d5` |
| Old `v` soak | **dead** — stopped 18:40:04, so `_resume_hygiene` never got its live test |
| Wire journal | was **OFF**; switched ON by creating `ds_wirelog.on` |
| Prior journal contents | 176 requests / 176 responses, all `v`, **0 verdicts** |

Nine fixes verified present in source by grep (not by trust):
`_MUTE_CODES = frozenset(("5","14"))` :3180 · `ds_wirelog.install` :1342 ·
`_resume_hygiene` :3573 · `IDLE_RESUME_S = RATE_MAX_TRIES*DS_RATE_WAIT+1800` :3525 ·
`_preempt_is_fresh` :3528.

## 1. t1/t2 registered — and they minted their OWN identities

Registered through the sanctioned `ds.add_account` path (real login, token proven
against `new_session()`, then persisted), never by hand-editing the config.

| Account | device_id fingerprint | origin |
| --- | --- | --- |
| t1 | `89:8cf2841314` | `cookie:.thumbcache_6b2e5483f9d858d7c661c5e276b6a6ae` |
| t2 | `89:7c9cc9045a` | same cookie name, **different value** |
| machine fallback | `89:b4e3bf595c` | configured/manual |

Both AWS WAF challenges solved automatically during login. Full-pool identity
check: **6 accounts, 6 distinct device_ids, 6 distinct x-device-ids, 6 distinct
`did`s** — no collision anywhere.

Config integrity after the rewrite (verified, because `add_account` rewrites the
whole document): all 7 slots present; `donttouch` **still in the file** but
**excluded from the pool** (that exclusion is the flag at :544 doing its job);
`j1` untouched.

## 2. REFUTED: the operator's re-login device-rotation suspicion

The operator's own theory, verbatim:

> "i think there also has to be something to do with logging into an account with
> a device id and then without properly signing out, logging back in again…
> because i device_id is tied to 1 browser, if i login then again login without
> signing out, theres definitely something suspicious"

Tested directly on t2 by driving **5 real logins** ~20 s apart and recording the
`device_id` each login body would carry:

```
#1  would-send=89:7c9cc9045a  profile=89:7c9cc9045a
#2  would-send=89:7c9cc9045a  profile=89:7c9cc9045a
#3  would-send=89:7c9cc9045a  profile=89:7c9cc9045a
#4  would-send=89:7c9cc9045a  profile=89:7c9cc9045a
#5  would-send=89:7c9cc9045a  profile=89:7c9cc9045a

distinct device_id values across 5 logins: 1
```

**Verdict: the suspicion is refuted at the client level.** A re-login *recovers*
the account's own browser-minted identity from its persistent Chrome profile; it
does not rotate or duplicate it. The account does not present "many devices" to
DeepSeek no matter how many times it logs in without signing out.

Caveat that must travel with this result: attempts #4 and #5 returned
`token=NO` — the account's login lock published a token the other clients adopted
(`LOGIN_REUSE_WINDOW`), so only 3 of the 5 actually posted `/users/login`. That is
the lock working as designed, and it *strengthens* the finding: the reuse path
also carries the same device_id.

## 3. CONTAMINATION — my own probe added 7 logins to t2

The journal census shows t2 received **7 `/users/login` requests in ~2.5 min**
(19:52:01 → 19:53:24), every one of them from the rotation test above. This is
probe-induced traffic on an account that is also a mute candidate. Any future
mute on t2 must be attributed with that in mind; the test is not a clean
baseline. Recorded so it cannot be mistaken later for organic login churn.

## 4. The `mute_until` back-computation — every observed mute was ISSUED on 09-29

Extracted the genuine verdict expiries from session history. Assuming the
confirmed 72 h duration (and 216 h for the one 9-day variant):

| `mute_until` | duration | ⇒ issue instant |
| --- | --- | --- |
| 2026-10-02 09:13 | 72 h | **2026-09-29 09:13** |
| 2026-10-08 11:16 | 216 h | **2026-09-29 11:16** |
| 2026-10-02 13:41 | 72 h | **2026-09-29 13:41** |
| 2026-10-02 17:55 | 72 h | **2026-09-29 17:55** |
| 2026-10-02 20:19 | 72 h | **2026-09-29 20:19** |

**Every single mute in this session's evidence was issued on 2026-09-29**, spread
across that day at 09:13, 11:16, 13:41, 17:55 and 20:19.

This is the most useful thing found today, and it reframes the operator's
complaint. The mutes being observed on 09-30 are **not new verdicts** — they are
the *tails* of verdicts issued the previous day. `expiry − duration` is the only
quantity that recovers an issue instant, and on five independent samples it lands
on one calendar day.

It also explains why mutes "got faster" without any change in behaviour: a burst
of verdicts issued within a single 11-hour window on 09-29 all *become visible*
over the following 72 h, so they surface to the operator as a cluster of bans
arriving close together — which reads as accelerating, while the issue instants
were actually hours apart and all in the past.

**What this does NOT yet establish.** Five samples is not proof that mutes always
cluster to one day, and 09-29 is also the day the largest login count was
recorded (63). The honest statement: *on all recoverable evidence, the mutes were
issued on 09-29; whether that is a moderation burst or a measurement artefact of
which mutes happened to be recoverable is not yet settled.*

## 5. Instruments now running

- **t1 soak** — 400 turns, human pace (3–10 min gaps), `HS_WALK_AWAY_P=0.10` so
  the 90-minute walk-away fires often enough to exercise `_resume_hygiene`
  **live** for the first time. Journal ON via `KILN_DS_WIRELOG=1`.
  Account: `deepseek.ee.1+t1@gmail.com`, conv `humansoak-1790769116`.
  Previous `v` run state archived as `_archive_vrun_20260930-195141_*`.
- **Wire journal** — `ds_wirelog.jsonl` + `ds_wirelog.on` marker, so the live
  bridge journals the operator's own traffic and a mute is captured **with its
  preamble** rather than as a bare verdict.
- **Re-login result** — `_relogin_result.json`, auditable without re-running.

## 6. Retracted / corrected in this session

- `_timeline.py` reported **713 "mute events"** and a login curve — **withdrawn**.
  It matched the bare substrings `"muted"` and `"users/login"` anywhere on a
  line, so it counted my own prose, todo lists, and tool results that merely
  *display* `ds_direct.py` source. Third occurrence of this exact class of error
  in the investigation (after the bare-`429` regex and the forked-log subset).
  Replacement `_mutevents.py` narrows to structured fields of verdict-bearing
  event types; even that still over-matches `tool/result` events, so its
  *counts* are not trustworthy — only the extracted `until=` values are, and
  those are what section 4 uses.
- The first `_idstate.py` printed `len=89 sha=` for every account and looked like
  a total collision. That was my own `[:11]` slice throwing away the hash.
  Corrected by `_idstate2.py`; identities are in fact all distinct.

## 7. Open

- Does a mute actually land on t1/t2 while the journal is on? That is the only
  thing that produces a *preamble*, and it cannot be forced — only waited for.
- Is the 09-29 clustering real? Testable if a future mute back-computes to a day
  other than 09-29.
- `_resume_hygiene` has still never fired live in a observed run.

---

# 8. The operator's 01:55 correlation — CONFIRMED, and it reframes everything

The operator asked, twice, about a specific coincidence. Both halves are now
settled, and the answer is that **nothing was banned "at 1 am" in the sense they
meant — but a verdict was ISSUED then.**

## 8.1 Duration is 72 h, proven by a falsifiable test

A mute cannot be observed before it was issued, so `issue = until − duration` is
only admissible if it lands at or before the first observation. That turns the
assumed duration into a testable lower bound:

| `mute_until` (UTC) | assumed | first observed | lower bound required |
| --- | --- | --- | --- |
| 2026-10-02 09:13 | 72 h | 09-29 09:27 | **≥ 71.8 h** |
| 2026-10-02 13:41 | 72 h | 09-29 13:48 | **≥ 71.9 h** |
| 2026-10-08 11:16 | 216 h | 09-29 11:30 | **≥ 215.8 h** |
| 2026-10-02 17:55 | 72 h | 09-30 06:46 | ≥ 59.1 h |
| 2026-10-02 20:19 | 72 h | 09-30 07:02 | ≥ 61.3 h |

Every assumption is admissible, and the two tightest bounds sit **within ~12
minutes of exactly 72 h and exactly 216 h**. So the durations are 72 h and 216 h,
and `until − 72 h` is a sound issue-instant estimator.

## 8.2 72 h is exactly 3 days — which is why the same clock time appears twice

```
issue  = 2026-09-30 01:55 local
expiry = 2026-10-03 01:55 local
```

Same clock reading, three days apart. The operator saw the **expiry** in the
website banner ("October 3, 2026 01:56") and read it as the moment of the ban.
Their own arithmetic was right: the website renders local time, so
`2026-10-02 17:55 UTC + 8 h = 2026-10-03 01:55 local` — a 1-minute rounding
match with the `01:56` banner. **That verdict IS mutetest's.**

So the answer to "why was it banned at 1 am" is: **it wasn't banned at 1 am; it
was issued at 1:55 am and expires at 1:55 am three days later.** Both readings
give the same clock time because the penalty is a whole number of days.

## 8.3 Two verdicts were ISSUED while the machine was completely idle

| issue (local) | session events ±15 min | soak turns ±15 min |
| --- | --- | --- |
| 09-30 **01:55** (mutetest) | **0** | **0** |
| 09-30 **04:19** | **0** | **0** |

This is the operator's "my accounts are getting muted at like 1am or 4am while im
sleeping, and the account isnt active" — **confirmed exactly**. And it is
*conclusive about mechanism*: a verdict landed at an instant when no request was
sent. Nothing the connector did at 01:55 caused the 01:55 verdict. The moderation
decision is **asynchronous and lagging**: the account had been driven during the
preceding evening, and the verdict was posted hours later.

By contrast, three other verdicts were issued during dense activity (459, 378 and
183 session events in their ±15 min windows) and were discovered within 0.1–0.2 h
— i.e. the agent was mid-work and hit them immediately.

## 8.4 The mutes are a BURST across accounts, not a per-account drip

```
09-29 17:13 local  parserfix
09-29 19:16 local  jw1        (+2.0 h)
09-29 19:28 local  jw1        (+0.2 h)
09-29 21:41 local  p          (+2.2 h)
09-30 01:55 local  hunt       (+4.2 h)
09-30 04:19 local  hunt       (+2.4 h)
09-30 09:56 local  ?          (+5.6 h)
```

**7 distinct verdicts issued inside a 16.7-hour window, across 5 accounts.**

Two things follow:

1. That window **contains the fix commits** (09-29 17:48, 22:14, 23:47). Four of
   the seven verdicts were issued *before* the 22:14 "stop the mute storm" fix
   and three after, so the fixes are interleaved with the burst and cannot be
   cleanly blamed or cleanly cleared by their position in it.
2. The complaint "getting muted faster than ever" is a perception created by the
   burst: seven verdicts issued inside one 17-hour window all expire 72 h later,
   so they *surface* to the operator as a cluster arriving together. The issue
   instants were hours apart; the expiries land close together.

The strongest available correlate is **how hard the accounts were being driven**
in that window — not a header. The session log shows heavy multi-account rotation
and retry storms throughout 09-29 evening; the accounts that were used hardest
(`jw1`, `p`, `hunt`) are the ones that drew verdicts.

## 8.5 Discovery lag proves a mute needs no request

The `2026-10-02 11:28 UTC` verdict was issued `09-29 19:28` local and **first
observed 22.6 hours later**. That account sat muted for the better part of a day
before anything touched it. A verdict that exists for 22.6 h untouched cannot
have been caused by traffic at the moment it was noticed.

## 8.6 Attribution caveat — do not over-read the account names

The "named on the verdict event" column is **contaminated** and is not evidence.
For the 13:41 verdict it lists `donttouch, t1, t2` — because that verdict string
appears in *my own findings documents*, which enumerate every account name.
Attribution by mention therefore measures my prose, not DeepSeek's target.

The `accounts active ±6 h` column is a heuristic and shares the weakness at its
edges. Treat the per-account attribution in 8.4 as **indicative, not proven**;
the *count* of verdicts, their issue instants, and the idle-window result in 8.3
do not depend on it.

## 8.7 Corrected — my own error, recorded

`_issueactivity.py` (first version) parsed the UTC verdict text with
`time.mktime`, which reads a `struct_time` as **local**, and then subtracted the
8-hour offset on top of that. The two mistakes compound rather than cancel: every
issue instant was **16 hours early**, and every "EMPTY: nothing was active"
window was drawn around the wrong moment. Its result was **withdrawn**;
`_issueactivity2.py` uses `calendar.timegm` (reads as UTC) and supersedes it.
`_durationcheck.py` had used `timegm` correctly, so the 72 h/216 h confirmation
was never affected.

This is the **fourth** self-inflicted measurement error in this investigation
(after the bare-`429` regex, the forked-log subset, and the substring mute
matcher). The pattern is consistent: a plausible-looking conversion or match
that is never checked against a known-good case. Both surviving scripts now
print their timezone and their raw matched values.

---

# 9. Cookie audit — suspicion #1 refuted, with one honest nuance

The operator's first suspicion, verbatim:

> "i think it might be that after the cookies or somethign else expires, dsdirect
> still sends a request with the expired cookies and everything."

The journal records, per cookie, per request, the `expires` epoch, an `expired`
bool, and `age_s`. So this is measured, not inferred:

```
212 journaled requests
202 carried a cookie jar
  0  carried a cookie past its own expiry
```

**Suspicion #1 is not supported by the live traffic.** No request ever presented
a stale cookie. The reason is structural, not lucky: the only two cookies this
site sets are `aws-waf-token` and `ds_session_id`, and **both are session cookies
with no `expires` at all** — so neither *can* go stale through expiry. The
expired-cookie defect was real in the code path (a lossy persistence round-trip
that resurrected an expiry as a session cookie), but the live jar shape means it
would have had nothing to bite on here.

## 9.1 No cross-account cookie bleed

Grouping by account (the first version of this audit grouped by cookie *name*
across all accounts, and its "rotation" reading was an interleaving artefact —
see 9.2):

| account | requests | `aws-waf-token` distinct | `ds_session_id` distinct |
| --- | --- | --- | --- |
| v | 176 | **1** | **1** |
| t1 | 17 | **1** | **1** |
| t2 | 19 | **1** | 4 |

**No cookie value appears under two accounts.** Each account carries its own
credentials; nothing bled across.

## 9.2 A real nuance that DOES partially support the operator's instinct

t2's `ds_session_id` took **4 distinct values** across its 19 requests — and
those four values are the direct result of my own three real logins in the
rotation test (19:51:03 → 19:52:01 → 19:52:22 → 19:52:43).

So the honest, complete statement of finding #2 is:

> A re-login **preserves the `device_id`** (proven: 5 logins, 1 value) but
> **mints a fresh `ds_session_id`** each time.

The operator's instinct that "logging back in without signing out" changes
something server-visible is therefore **half right**: the *device* identity is
stable, but the *session* identity does churn on every login. That is a materially
different signal from device rotation, and it is worth stating precisely rather
than dismissing the whole theory.

## 9.3 Per-account first-request cookies

| account | first request | cookies carried |
| --- | --- | --- |
| v | 17:27:06 | `aws-waf-token`, `ds_session_id` |
| t1 | 19:50:55 | **none** (cold login) |
| t2 | 19:51:03 | **none** (cold login) |

A cold login starts with no cookies, as it should — the login POST mints them.

---

# 10. "Nothing is touching the computer" — checked, and it holds

The operator's night observation depends on no *other* program driving the
accounts. Enumerated every process on the box:

| process | what it is | touches DeepSeek accounts? |
| --- | --- | --- |
| `provider_bridge` (39780/23840) | the harness bridge | yes — by design |
| soak (10688/40732) | my t1 soak | yes — by design |
| `vyntra.server` (24232/21324) | an unrelated local server, since 09-29 16:24 | **no** — no reference to `deepseek`, `ds_config`, or `ds_direct` anywhere in `D:\Vyntra` |
| `node.exe` subprocess runners | the harness's own command runner | no (they run my probes) |
| `cmd.exe` / `start.cmd` | the harness launcher on :50122 | no |

There is a `ds-free-api` project on disk, but **no process from it is running**.

So the two idle-window verdicts in 8.3 were issued while the *only* things alive
were the harness and nothing else — and at 01:55 and 04:19 even the harness was
idle (0 session events). The operator's belief is accurate.

---

# 11. Conclusion — the answer to "why are they getting muted faster after your fix"

## What is established (measured, falsifiable)

1. **Mute duration is exactly 72 h**, and 216 h for one variant. Proven by a
   lower-bound test: `until − duration ≤ first_observation` must hold, and the
   two tightest bounds came out at **71.8 h and 215.8 h** — within ~12 minutes of
   the round numbers.
2. **The mutes are a burst, not a drip.** 7 distinct verdicts were issued inside a
   **16.7-hour window** (09-29 17:13 → 09-30 09:56 local) across **5 accounts**.
3. **The perceived acceleration is an expiry artefact.** Seven verdicts issued in
   one 17-hour window all expire 72 h later, so they *surface* as a cluster
   arriving together days later. Nothing sped up; the expiries landed close.
4. **Two verdicts were issued while the machine was completely idle** (01:55 and
   04:19 local, 0 session events ±15 min). A verdict that lands with no request
   in flight was not caused by a request in flight. Moderation is
   **asynchronous and lagging** — proven independently by the
   `11:28 UTC` verdict being discovered **22.6 h after** it was issued.
5. **The "1 am" question is arithmetic, not anomaly.** 72 h is exactly 3 days, so
   `issue clock time == expiry clock time`. mutetest's banner (`Oct 3 01:56`
   local) is the *expiry* of a verdict **issued at 01:55 on Sep 30**. The
   operator's correlation was correct; the label on it was not.
6. **No expired cookie has ever been sent** (0 of 212 journaled requests), and no
   cookie value is shared between accounts. Suspicion #1 is refuted.
7. **A re-login preserves the `device_id`** (5 logins → 1 value) but **mints a
   new `ds_session_id`** each time. The operator's login-pattern instinct is
   *half* right, and the half that is right is the session, not the device.
8. **No other program was driving the accounts** at any point.

## What is NOT established — and must not be claimed

- **The fixes are not exonerated.** The 16.7-hour burst window *contains* the fix
  commits (09-29 17:48, 22:14, 23:47). Four verdicts precede the 22:14 "stop the
  mute storm" fix and three follow it. Position within the burst neither blames
  nor clears them.
- **The per-account attribution is contaminated.** The "account named on the
  verdict event" signal counts *my own prose* (a findings doc listing every
  account name made `donttouch`, `t1` and `t2` appear on a 09-29 verdict they
  cannot have caused). Only the *count* of verdicts, their issue instants, and
  the idle-window result are trustworthy.
- **The cause of the burst is still unidentified.** The strongest remaining
  correlate is *how hard the accounts were driven* during 09-29 evening — heavy
  multi-account rotation and retry storms — not any header. But "driven hard" is
  a correlate, not a mechanism, and the mechanism is still server-side.

## Why the fix cannot be the cause on the evidence

A client-side change can only cause a verdict by changing what is *sent*. The
wire journal now records what was sent, and across every journaled request:

- request shapes are internally consistent per route;
- `authorization` never changed mid-run (no unexpected re-login);
- no expired cookie was ever presented;
- no account presented another account's cookie;
- the `device_id` is stable and per-account.

If a header were the trigger, it would have to be one of the ~23 headers whose
fingerprints are stable and route-appropriate. That is a much weaker hypothesis
than "the accounts were being driven hard across a 17-hour window and the
moderation lagged", which the idle-window evidence directly supports.

---

# 12. What ACCUMULATES? Measured — and the answer is nothing client-side

The objective names "the accumulating cause that mutes an account after hundreds
of turns rather than immediately". A cause that needs hundreds of turns must be a
quantity that **grows**. Everything checked previously is *constant* — the same
on turn 1 and turn 500 — so none of it can explain a threshold that turns only
cross later.

So I measured the two things that could plausibly grow:

## 12.1 Request body size — FLAT

| account | path | n | first | last | slope |
| --- | --- | --- | --- | --- | --- |
| v | `chat/completion` | 84 | 284 B | 249 B | **−0.1 B/req** |
| v | `create_pow_challenge` | 88 | 43 B | 42 B | −0.0 B/req |
| t2 | `chat/completion` | 5 | 290 B | 256 B | −7.8 B/req |
| t2 | `users/login` | 7 | 216 B | 216 B | +0.0 B/req |

Over **84 consecutive completion turns** the payload did not grow at all. It
oscillates in a 241–299 B band, which is just the different prompt lengths
cycling. There is **no accumulating conversation state in the request body** —
the connector sends the current turn, not a growing transcript.

## 12.2 Requests per turn — FLAT

| account | turns | first | last | first-half avg | second-half avg | delta |
| --- | --- | --- | --- | --- | --- | --- |
| v | 84 | 4 | 2 | 2.2 | 2.0 | **−0.2** |

A turn costs the same at turn 84 as at turn 1 (one `create_pow_challenge` + one
`completion`). The first turn of a *fresh* account looks expensive (t1: 15, t2:
25) because it includes login, `client/settings`, `chat_session/create` and the
one-time tool-call attachment upload — but that cost is **paid once and never
recurs**.

## 12.3 What this rules out

Combined with sections 9 and 11, every client-side quantity is now measured as
constant or one-time:

| quantity | behaviour across turns |
| --- | --- |
| header set + values | constant (fingerprints stable) |
| cookie names | constant (2 session cookies) |
| `device_id` | constant, per-account, survives re-login |
| `authorization` | constant within a run |
| request body size | **flat** |
| requests per turn | **flat** |
| session id | changes on re-login only |

**No client-side quantity grows with turn count.** The accumulating cause is
therefore **not in the request shape** — it is server-side state about the
account (a reputation, a rate ledger, or a classifier's aggregate), which is
exactly what the asynchronous, lagging, idle-window evidence in 8.3 and 11
already pointed at.

This is a negative result, and it is the most useful one available: it closes the
entire class of "some header/payload detail degrades over time" explanations
without needing to guess which detail. The remaining honest statement is that the
connector's **volume and timing** of traffic are the only client-side variables
that correlate with the verdicts — not anything in an individual request.


---

# 13. The `j1` mute — and the two CLASSES of verdict it exposes

`j1` is the account this agent's own harness route runs on
(`kiln-deepseek@deepseek.ee.1+j1@gmail.com`). It was reported muted by the
operator at seq 23874. This section is the forensics.

## 13.1 The verdict

| field | value |
| --- | --- |
| `mute_until` (as reported) | `2026-10-03 12:04 UTC` = `2026-10-03 20:04` local |
| duration | 72 h (see 8.1) |
| back-computed issue | `2026-09-30 12:04:00 UTC` = `2026-09-30 20:04:00` local |
| first observation | `2026-09-30 20:04:19` local (turn 315, step 18) |
| reported by | 5 consecutive `llm/retry` events, retry 1/5 → 5/5 |

**The raw `mute_until` float appears in NO log on this machine.** A regex for
`"mute_until"\s*:\s*<number>` over all 227 MB of session logs returns **zero**
hits: the only surviving form is the human-formatted `until YYYY-MM-DD HH:MM UTC`
inside the verdict message. Consequence, and it is not a technicality:

> the issue instant is known only to the **minute**, not the second.

An earlier draft of this investigation computed "issue is 19.1 s before
observation" and read synchrony into it. That was **wrong**: a `12:04` expiry is
compatible with any issue instant in `12:04:00`–`12:04:59`, because the field is
truncated before it is ever displayed.

## 13.2 j1 was the provider that was serving this agent

| | |
| --- | --- |
| first j1 request | `09-30 14:52:01` local |
| last j1 request | `09-30 20:00:28` local |
| j1 `request/header` events | 42 |
| events naming j1 in any field | 695 |
| harness auto-switched to | `+v@gmail.com` at `20:11` |

So j1 was not idle: it carried this agent's reasoning for **5 h 8 min**,
including 4 long pauses (44 min, 30 min, 38 min, 81 min) between bursts.

## 13.3 The two CLASSES of verdict — the most important result in this document

Every verdict was tested against session activity in the ±15 min around its
back-computed issue instant:

| verdict | issue (local) | dur | its own requests, prev 60 min | ANY event ±15 min |
| --- | --- | --- | --- | --- |
| parserfix | 09-29 17:13 | 72 h | 0 | 459 |
| `?` | 09-29 19:16 | **216 h** | 0 | 378 |
| `?` | 09-29 19:28 | 72 h | 0 | 301 |
| `?` | 09-29 21:41 | 72 h | 0 | 183 |
| hunt | 09-30 01:55 | 72 h | 0 | **0** |
| `?` | 09-30 04:19 | 72 h | 0 | **0** |
| mutetest | 09-30 09:56 | 72 h | 0 | **0** |
| **j1** | **09-30 20:04** | 72 h | **3** | **569** |

Two things fall out of that table, and they point in opposite directions.

**(a) Three verdicts have literally nothing near them.** The `mutetest` verdict
is the strongest: **0 events within 6.5 h on either side** across every session
file on the machine. `hunt` (01:55) and `?` (04:19) are the same shape at ±15 min.
No request was in flight, no process was active, nothing was retried. A verdict
issued then cannot be caused by a request issued then — the connector was not
running. This is the operator's "nothing is touching the computer" observation,
confirmed quantitatively, and it is the load-bearing evidence for the mute being
**server-side and asynchronous**.

**(b) j1's verdict does not have that shape.** Its back-computed issue minute
`20:04:00` sits **inside the failing LLM call**: the call's first server chunk is
timestamped `20:04:19.137`, i.e. the same minute. If the true issue instant were
`20:04:19.137`, then `issue + 72 h = 2026-10-03 12:04:19.137`, which *formats as*
`12:04` — indistinguishable, at minute precision, from what was reported. That is
a complete alternative reading in which **the verdict was computed
synchronously, at the moment of the rejected call**, and the "asynchronous,
lagging" model is an artefact of not having the raw float.

**These two readings cannot both be the general mechanism.** Either the penalty is
issued by a background moderation pass at times unrelated to traffic (explains a,
not b), or it is issued in response to a request (explains b, not a) — unless
the true issue instants of the idle-class verdicts are NOT `until − 72 h` at all,
i.e. `mute_until` is not `issue + duration` but an independent scheduled expiry.
This investigation does **not** resolve that, and says so rather than picking the
flattering branch. What is now certain is that the back-computation used
throughout 8 and 12 is only valid to the minute and may be invalid in principle.

## 13.4 The failing call, in wire terms

The turn that discovered the mute (turn 315, step 18) had these characteristics on
its last successful predecessor:

* `messages=0` on the `request/header` event — the harness had already streamed
  its history, so this is the incremental shape, not a full replay;
* `tools=29` — the full tool roster was declared;
* `header_bytes=34847`;
* and the call that was refused returned a verdict within ~137 ms of its first
  chunk (`20:04:19.137`), i.e. **the refusal is instant**, not a timeout.

That last point is worth keeping: a mute is refused *fast*, so a caller cannot
distinguish it from a healthy empty response by latency. Only the body says so.

## 13.5 FIX 11 — the provider path was never journaled

Root-caused: `provider_bridge.py` (PID 39780, started `09-30 19:41:49`) starts
**without** `KILN_DS_WIRELOG`, and no `ds_wirelog.on` marker existed. The module's
`enabled()` resolves once and caches, and the bridge caches its modules, so the
entire harness provider path — the path j1 and every subsequent account run on —
produced **zero** journal entries. `runtime/ds_wirelog.jsonl` contains only the
standalone soak accounts (v, t1, t2). That is exactly backwards.

**Fix:** created `python/kiln/runtime/ds_wirelog.on` (documented in-file). The
marker makes the journal opt-*out* rather than opt-in for any process that loads
`ds_direct` after the marker exists. It deliberately does **not** hot-patch the
running bridge — the module's no-silent-behaviour-change guarantee is preserved,
so the currently running bridge stays unjournaled until restarted.

The marker is a local operator switch and is **not** committed: committing it
would silently enable journaling for every checkout and every user.

## 13.6 The identity finding — 21 aliases, one base

Every account id this machine has ever driven is a **plus-alias of one Gmail
base**:

```
base = deepseek.ee.1@gmail.com
tags = (none) 4 5 6 7 9 X XXXX donttouch f hunt j1 jw1 kilnsal mutetest p
       parserfix t1 t2 v
```

This was worth testing as a mechanism, because if the penalty were attached to
the *identity* rather than the *account*, every alias would inherit it and the
whole pool would be one account wearing 21 hats.

**It is refuted.** `t1` and `t2` are fresh aliases of that same base, created for
this session, and they have now run **30 (t2) and 7 (t1) consecutive turns with
zero mutes**, including a device identity each that is distinct from every other
account's. A base-wide identity flag would have refused them on turn 1. The
penalty is therefore **per-account**, not per-identity and not per-base — which
also means the mute is not a device or IP verdict, consistent with 2 and 8.

## 13.7 What this section adds, and what it does not

**Adds:**
* j1's mute is a normal 72 h penalty, not a special case for the operator's
  account, and the harness correctly failed over to `+v` automatically.
* A verdict class with **provably zero** client activity around it (mutetest:
  0 events in 13 h) — the cleanest statement of the asynchronous hypothesis yet.
* The provider path was invisible to every instrument; that blind spot is now
  closed for future runs.
* The base-alias hypothesis is tested and refuted by a live experiment.

**Does not add:**
* Any resolution of the (a)/(b) tension in 13.3.
* Any identification of what *causes* the verdict. The trigger remains
  unidentified; only its timing signature is now characterised, and that
  signature is ambiguous between synchronous and scheduled.

**Next discriminating test.** Now that the provider path journals, the next
verdict that arrives on the *harness* route will carry its own preamble in the
same file as the pool accounts. If a future verdict again back-computes to a
minute that contains a live call, the synchronous reading gains; if it
back-computes to an idle window like mutetest's, the scheduled reading gains.


---

# 14. FIX 12 — the ledger that keeps the exact expiry, and stops selecting muted accounts

Two defects turned out to share one missing piece of state, so one fix closes both.

## 14.1 Defect: the exact expiry was parsed and then thrown away

`_mute_verdict_in` already pulled `mute_until` out of `biz_data` as a **float**:

```
{"code":0,"msg":"","data":{"biz_code":14,"biz_msg":"user is muted",
 "biz_data":{"is_muted":1,"mute_until":1790972380.757}}}
```

and then formatted it to `"YYYY-MM-DD HH:MM UTC"` before returning. That single
line is why section 13.1 had to retract a result: the only second-precision
timestamp DeepSeek ever gives us was destroyed at the moment it existed, so every
log on this machine carries a minute-rounded string and nothing else.

Confirmed by search, not assumption: a regex for the raw float across all 227 MB
of session logs returns **zero** hits.

**The fix** adds `_mute_until_of` / `_mute_until_in` — the machine-readable twins
of `_mute_of` / `_mute_verdict_in`. Same nested path, same three tells, but they
return the FLOAT. They are separate functions rather than a widened return on
`_mute_of`, because five call sites and their tests depend on that returning a
message, and a silent type change there would be worse than the defect.

## 14.2 Defect: a muted account was selected forever

`_account_order` was a pure ring over `_accounts` with no notion of account health.
An account DeepSeek had refused until Friday was still handed the next brand-new
conversation, spending a request, a round trip, and a full retry ladder to
rediscover a verdict already in hand.

This is worth stating precisely, because section 13 established the limit of the
harm: **repeated requests do not extend the penalty.** Across five retries the
reported `until` never moved once. So the cost of selecting a muted account was
waste — a handful of requests and a visible delay — not an escalation. Had it been
escalation, the operator's "it gets muted faster the more I use it" reading would
have had a mechanism; it does not.

**The fix** sorts muted accounts LAST rather than removing them, and the reasons
are load-bearing:

* if the **whole pool** is muted the caller must still get the real verdict, not a
  confusing "no accounts configured" that hides the one fact worth reporting;
* a **pinned** account is an explicit instruction from the model picker, so it is
  left exactly where it is, mute or not;
* an **expired** entry must restore preference on its own, with no restart.

## 14.3 The ledger

Persisted to `ds_muted.json` beside `ds_last_turn.json`, because a mute outlives
the process by days and the bridge is restarted far more often than a 72 h penalty
expires — an in-memory map would forget a verdict it had already been told.

| property | behaviour |
| --- | --- |
| key | account id |
| value | `mute_until` as an **exact float** |
| on two verdicts for one account | keeps the **later** expiry |
| on expiry | prunes the entry on read, so the account returns by itself |
| on a corrupt/absent file | returns `{}` — costs one wasted request, never a turn |
| on junk input | never raises; `None`, `""`, `0`, `-5`, and `True` are all rejected |

`_note_mute` is called at every site that raises `_Muted`. Four of the five sites
carry an envelope and therefore record a real timestamp; the fifth
(`server_error`) carries the **wording only** and has no `mute_until` to record —
that is documented in place rather than papered over with a fabricated expiry.

## 14.4 FIX 13 — a test that was silently turning the journal OFF

Running the suites for 14.1 turned up an unrelated defect that matters more than
it sounds.

`test_ds_wirelog.py` created `ds_wirelog.on` in the **real module directory** and
removed it unconditionally in a `finally`. So running the suite deleted an
operator's marker — and the marker is the switch that enables the wire journal.
It happened during this session: the marker created minutes earlier was gone after
the first full run, and the "off by default" checks failed *because the marker
was missing*.

It now stashes the marker for the duration of the run and restores it. That fixes
two things at once: the suite no longer destroys machine state, and "off by
default" becomes testable on a machine where the journal is switched on — which is
the state the operator actually runs in.

## 14.5 Verification

8 suites, **210 checks, 0 failed**:

| suite | checks |
| --- | --- |
| test_ds_wirelog.py | 48 |
| test_ds_wirelog_integration.py | 13 |
| test_ds_direct_hint_mute.py | 23 |
| test_ds_direct_preempt_freshness.py | 18 |
| test_ds_direct_cookie_expiry.py | 33 |
| test_ds_direct_resume_hygiene.py | 17 |
| test_ds_direct_account_exclusion.py | 22 |
| **test_ds_direct_mute_ledger.py** (new) | **36** |

The new suite asserts second precision survives, that the ledger persists and
expires, that selection prefers healthy accounts, that a pinned account is still
honoured, that an all-muted pool still returns every account, and that an expired
entry changes the order **not at all**.

Two of its own checks failed first and were **the test's fault, not the code's** —
both are recorded rather than quietly fixed:
* one compared two round-robin calls without freezing `_rr_index`, so it asserted a
  property of ring state rather than of health;
* one asserted a positional outcome where the real property is "indistinguishable
  from no mute".

## 14.6 What this does NOT claim

It does not identify the trigger. Section 13.3's tension — three verdicts with
provably zero activity around them against j1's verdict inside a live call — is
untouched by this fix, and is still the central open question.

What it does claim is narrower and checkable: **the next mute on any account will
now leave a second-precision record of its own expiry**, which is the first time
this investigation has been able to say that. The ledger turns a question that
could only be answered to the minute into one that can be answered to the
millisecond.

## 14.7 Deployment note

`provider_bridge.py` caches its modules and was started at 19:41:49, before both
the marker and this fix existed. **None of FIX 11, FIX 12, or FIX 13 is live in
the running bridge until it is restarted.** The soaks are unaffected — they are
separate processes that load the module fresh.


---

# 15. Does VOLUME cause mutes? The operator's premise, tested and falsified

The original report was *"The mute comes after 100s of back and forths, but that is
already more than usual."* That is a causal claim with a checkable form: if volume
drives the verdict, request count should separate the muted accounts from the rest.

## 15.1 First attempt, and why its answer had to be thrown away

The first pass produced a clean-looking table: the busiest account (`+7`, 213
requests) was never muted, while an account with 14 requests was. Tempting, and
**wrong to publish as-is**, because of a confound I nearly missed:

`+7` stopped at **09-29 18:21** — five minutes after the enforcement wave began.
So "volume doesn't predict" and "nothing before 17:13 was being punished" explain
the same data equally well. The test had no way to tell them apart.

## 15.2 The correction that made it sound: an OBSERVABILITY window

Mute *classification* was introduced by commit `7d6888732c` at **2026-09-29
17:48:56 +08:00**. Before that the connector could not distinguish a mute from a
generic refusal, so an account that went quiet earlier is not evidence of
anything — it is **unobservable**, not unmuted. Every account is now classified:

| account | pre | post | last request | status |
| --- | --- | --- | --- | --- |
| j1 | 0 | 42 | 09-30 20:00 | **MUTED** 10-03 12:04 |
| p | 8 | 34 | 09-29 22:54 | **MUTED** 10-02 13:41 |
| hunt | 0 | 28 | 09-30 16:03 | observed, no mute |
| jw1 | 10 | 27 | 09-29 19:30 | **MUTED** 10-08 11:16 |
| f | 0 | 14 | 09-30 14:44 | **MUTED** 10-02 17:55 |
| v | 0 | 8 | 09-30 20:12 | observed, no mute |
| donttouch | 0 | 8 | 09-30 16:17 | observed, no mute |
| 7 | 212 | 1 | 09-29 18:21 | observed, no mute |
| parserfix | 43 | 0 | 09-29 15:45 | **UNOBSERVABLE** |
| 9 | 40 | 0 | 09-28 20:25 | **UNOBSERVABLE** |
| kilnsal | 4 | 0 | 09-29 15:12 | **UNOBSERVABLE** |
| 4 | 6 | 0 | 09-25 20:49 | **UNOBSERVABLE** |
| 6 | 4 | 0 | 09-25 21:49 | **UNOBSERVABLE** |

## 15.3 The result, on observable accounts only

Post-classification request counts:

* **muted**: 42, 34, 27, 14
* **not muted**: 28, 8, 8, 1

> The busiest **unmuted** account made **28** requests.
> The quietest **muted** account made **14**.

So volume is **neither sufficient nor necessary**:

* **not sufficient** — 28 requests and no mute, against 14 requests and a mute;
* **not necessary** — an account with 14 requests was muted while one with 28 was not;
* **does not order** — the two lists interleave; there is no threshold that
  separates them.

This is a genuine falsification of the premise as stated. Volume is at most a weak
contributor, and on this data not a discriminator at all.

## 15.4 What survives, and what replaces it

The corrected picture is that **the mutes are a wave, not a dosage**:

* seven 72 h verdicts plus one 216 h verdict were issued inside a ~17 h window on
  09-29/09-30;
* at least three of them were issued while the machine was completely idle
  (section 8.3), the strongest of which has **zero** events within 6.5 h either
  side;
* request volume across the whole fleet is small — the busiest account in the
  entire history made 213 requests, and most made under 50.

An enforcement wave against a *set of related accounts* explains all of that at
once. Per-account dosage explains almost none of it: it cannot explain verdicts
issued during total inactivity, and it does not order the outcomes (15.3).

## 15.5 Caveat that must not be lost

All 21 identities are plus-aliases of **one Gmail base** (section 13.6). A wave
targeting the *base address* is fully consistent with everything measured — and
would explain why unrelated-in-behaviour accounts fell together, why the timings
cluster, and why volume is irrelevant. Section 13.6 refuted the base flag as
**inherited by new aliases** (t1/t2 ran mute-free), but that is a different claim
from "the base is what an enforcement pass looks at". The distinction is now the
leading open hypothesis and is not yet tested.

## 15.6 The verdict ledger, corrected

An earlier pass in this section reported "every distinct mute_until: 4". That was
wrong — it scanned only `llm/retry` and the wire journal. Scanning **all** event
types yields **8**:

| until (UTC) | issue @72 h (local) | first seen | observations |
| --- | --- | --- | --- |
| 2026-10-02 09:13 | 09-29 17:13 | 09-29 17:27 | 8 |
| 2026-10-02 11:28 | 09-29 19:28 | 09-30 18:04 | 17 |
| 2026-10-02 13:41 | 09-29 21:41 | 09-29 21:48 | 117 |
| 2026-10-02 17:55 | 09-30 01:55 | 09-30 14:46 | 74 |
| 2026-10-02 20:19 | 09-30 04:19 | 09-30 15:02 | 40 |
| 2026-10-03 01:56 | 09-30 09:56 | 09-30 19:56 | 10 |
| 2026-10-03 12:04 | 09-30 20:04 | 09-30 20:04 | 85 |
| 2026-10-08 11:16 | 216 h → 09-29 19:16 | 09-29 19:30 | 51 |

**Three of the eight cannot be attributed to an account by any structured field:**
`09:13`, `11:28`, and `20:19` appear only in prose-bearing events (`assistant/message`,
`tool/result`) where the nearby account names are my own write-ups. Per-account
attribution stands for the four that `llm/retry` names (`p`, `jw1`, `f`, `j1`) and
for `parserfix`; the rest are indicative only.

This is the attribution caveat of section 8.6, now quantified: **5 of 8 verdicts
attributable, 3 not.**


---

# 16. FIX 14 — the state files were clobbering each other across processes

Found by accident while checking whether the t2 soak's 96-minute walk-away would
exercise `_resume_hygiene`. The file that was supposed to prove it had fired was
**missing the account under test**.

## 16.1 The observation

`runtime\ds_last_turn.json` contained **t1 and v — but not t2**, while t2's own
soak was actively making requests:

```
runtime\ds_last_turn.json              (2 accounts)
    deepseek.ee.1+t1@gmail.com         09-30 20:34:16
    deepseek.ee.1+v@gmail.com          09-30 18:40:03
```

t2 had been sending requests since 19:51 and its last turn was 20:06:28. It should
have been there. It was not.

## 16.2 The mechanism

Both soaks run **without `KILN_STATE_DIR`**, so both write that file. Each process
loads it **once at import** and then dumps its **whole in-memory dict** back:

| process | imported | consequence |
| --- | --- | --- |
| t1 soak | 19:51:56 | its dict has never contained t2 |
| t2 soak | 20:01:01 | its dict has t1 only if t1 wrote before import |

t1's 20:34:16 write therefore carried a dict without t2, and it was the last write.
The loss is not interleaving — `_atomic_json` already makes each write atomic, so no
reader ever sees a partial file. The loss is that **a process's in-memory dict is a
snapshot from import time**, and writing it whole discards everything another
process added afterwards.

Reproduced deterministically with three sequential processes sharing one state
directory: each wrote correctly, the final file held all three. The clobber needs
the *overlapping* lifetime, which is exactly what two long-running soaks have.

## 16.3 Why it matters for both files

* **`ds_last_turn.json`** — `_resume_hygiene` reads `prev` from this map and
  **returns immediately when it is None**:

  ```python
  prev = _last_turn_at.get(acct_id)
  ...
  if prev is None or (now - prev) < IDLE_RESUME_S:
      return False
  ```

  So an account erased by a clobber gets **no stale-cookie drop** on the first turn
  after an overnight gap. That is precisely the case the persistence was added for:
  *"an overnight pause is exactly when the process is likely to have been restarted,
  and an in-memory map is empty on a fresh process."* The clobber restores the bug
  the persistence was written to remove.

* **`ds_muted.json`** (FIX 12) — the same shape, so the same loss: a mute recorded
  by one process is erased by another, and a forgotten mute means the pool hands a
  benched account the next brand-new conversation, which is the waste FIX 12 exists
  to remove.

## 16.4 The fix

`_save_last_turn` and `_save_muted` now **re-read the file and merge** before
writing, the later value winning per account. For the mute ledger that is the same
rule it already used for two verdicts on one account, so no second rule was
invented. A file lock was deliberately **not** added: it would serialise writers but
not fix this, because the loss is a stale view rather than a race. Merging is what
makes each process's snapshot additive.

## 16.5 A deployment caveat that must not be lost

**The running soaks do not have FIX 12, 13, or 14.** They started at 19:51:56 and
20:01:01; those fixes were committed later. Only FIX 1–11 are live in them.

That does **not** invalidate the t2 walk-away test, and the reason is worth stating
precisely: the clobber removes *other* accounts' entries, never the writer's own.
t2's process holds t2's timestamp in its own memory, so `_resume_hygiene` will still
see the 96-minute gap and drop the cookie. What the clobber prevents is *t1's* entry
surviving inside t2's file, and vice versa — which is why the file showed two
accounts where it should have shown three.

## 16.6 Verification

`test_ds_direct_state_merge.py` — **14 checks, 0 failed**. It asserts that the other
process's account survives, that both are present, that the later stamp/expiry wins,
that an older in-memory value cannot overwrite a newer one, and that a corrupt file
raises nothing while the in-memory value still reaches disk.

Full set: **11 suites, all green** (48 + 13 + 23 + 18 + 33 + 17 + 22 + 36 + 14 +
ds_hif + ds_identity).

## 16.7 The pattern in this session's defects

Three of the last four fixes are the same class of bug, and it is worth naming:

| fix | the shape |
| --- | --- |
| FIX 12 | state was *parsed* and then discarded (the exact `mute_until`) |
| FIX 13 | a test *created* state in a live directory and deleted it unconditionally |
| FIX 14 | state was *held in memory* and written whole, discarding another writer's |

All three are "the value existed and was thrown away". None was a wrong algorithm.
That is a useful thing to know about this codebase: the request path is careful, and
the *bookkeeping around* it is where the losses are.
