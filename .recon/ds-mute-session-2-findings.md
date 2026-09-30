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


---

# 17. Three corrections, and a third falsification

## 17.1 CORRECTION: my expired-cookie refutation tested the wrong thing

Section 9 reported that **0 of 212** journaled requests carried an expired cookie,
and treated that as refuting the operator's suspicion #1 (*"ds_direct still sends a
request with the expired cookies"*).

That measurement is **true but answers a different question.** `apply_account`
installs cookies with `cookies.set(name, value)` and **no `expires` attribute**:

```python
self.sess.cookies.set(k.strip(), v)
```

A cookie with no expiry is a **session cookie**. `_cookie_expired` compares against
a local `expires` value, so for a session cookie it can *never* return true — there
is nothing to compare. A test that looks for locally-expired cookies therefore
cannot see the case the operator described:

> the server may have invalidated `ds_session_id` while the jar still holds it.

That is a **server-side** expiry, invisible to any local check, and it is exactly
what `_resume_hygiene` (FIX 3) exists to handle: after a long idle gap, drop the
stale `ds_session_id` rather than replay it.

So the honest statement is: *no cookie in the jar carries a lapsed local expiry, and
that says nothing about whether a replayed session cookie was still valid server
side.* The operator's instinct was pointing at something real, and my refutation
was aimed one level too shallow.

## 17.2 FIX 3 IS live in the soaks — the walk-away test is valid

Worth confirming, because a fix committed after a process starts is not running in
it:

| item | time |
| --- | --- |
| `IDLE_RESUME_S` set to `RATE_MAX_TRIES * DS_RATE_WAIT + 1800` (5400 s) | 09-30 **16:15:24** (`ee2ab79628`) |
| t1 soak started | 09-30 19:51:56 |
| t2 soak started | 09-30 20:01:01 |

Both soaks postdate that commit, so `_resume_hygiene` with the 90-minute threshold
**is** the code they run. t2's deliberate 96-minute walk-away therefore exercises it
for real — the first live test of FIX 3 — and 96 min > 90 min, so the threshold is
crossed.

What the clobber of section 16 does **not** break is this specific test: the
clobber removes *other* accounts' entries, never the writer's own, and t2's process
holds t2's timestamp in its own memory. t2 will see its own 96-minute gap.

FIX 12/13/14 are **not** live in either soak — they were committed at 20:35:58 and
later.

## 17.3 FALSIFICATION #3: content density does not order the mutes either

Volume was falsified in section 15. The remaining content-shaped hypothesis is that
the *subject matter* drew the verdict, so each account's prompts were scored for
abuse-adjacent vocabulary (`mute`, `ban`, `evade`, `detect`, `fingerprint`,
`suspicious`, …) per 1,000 characters:

| account | abuse terms /1k | status |
| --- | --- | --- |
| v | **6.29** | **unmuted** |
| f | 4.82 | MUTED |
| j1 | 0.56 | MUTED |
| jw1 | 0.35 | MUTED |
| p | 0.08 | MUTED |
| parserfix | **0.00** | **MUTED** |
| hunt | 0.00 | unmuted |

It fails in both directions, exactly as volume did:

* the **densest** account (v, 6.29) was never muted;
* an account with **zero** abuse vocabulary (parserfix) was muted;
* another with zero (hunt) was not.

There is no threshold that separates the two groups; the lists interleave.

**An honest caveat about this test.** The prompts are attributed to whichever
account served the request, and the accounts that carried *this investigation* —
j1, f — were being asked about mutes by definition. So part of the density signal is
reverse-causal: accounts that researched mutes discuss mutes. That is why v and
parserfix matter more than the middle of the table: v's high density comes from
ordinary work and it was unmuted, and parserfix's zero density and mute cannot be
explained by topic at all.

**What this leaves.** Two client-side quantities have now been measured and both
fail to order the outcome: request volume (15.3) and prompt content (17.3). Together
with the idle-window verdicts (8.3) and the flat request shape (12), the evidence
keeps pointing away from "something in what the connector sent" and toward a
server-side decision about the *account set* — which is where the alias-base
question of 15.5 remains open.


---

# 18. FIX 15 — ds_sessions.json was growing without bound (46.76 MB)

This is the **first thing in the investigation that literally accumulates per
turn**, and it was found by accident while checking a soak.

## 18.1 The measurement

`.kiln_kernel_state/ds_sessions.json` was **46.76 MB for 195 entries** — about
240 KB per entry, which is absurd for a session-mapping file. Breaking it down by
field:

| field | bytes | share |
| --- | --- | --- |
| **`last_prompt`** | **43.46 MB** | **93 %** |
| `ref_sent` | 22 KB | 0.05 % |
| `sid` | 7.4 KB | 0.02 % |
| `account` | 4.6 KB | 0.01 % |
| everything else | < 1 KB | — |

Per-entry prompt sizes: **median 176 KB, p90 500 KB, max 997 KB.**

Two independent growth axes, which is why a per-entry cap alone would not have
fixed it:

1. each entry stored the **entire** reconstructed conversation prompt;
2. the **entry count** grows without bound — one per kiln conversation.

And `_save_sessions()` rewrites the whole file atomically (mkstemp + fsync +
replace) and is called from **14 sites**, at least once per turn.

## 18.2 Why bounding it is safe

`last_prompt` has exactly **one** reader:

```python
prev_prompt = st.get("last_prompt")                              # 3881
usage = _turn_usage(None if fresh_chat else prev_prompt, ...)    # 4276
```

and `_turn_usage` uses it for exactly one thing:

```python
common = _common_prefix_len(prev_prompt, prompt)                 # 2461
```

`_common_prefix_len` is bounded by `min(len(a), len(b))`, so **storing a prefix is
exactly equivalent** for every common prefix up to the cap. Above the cap only the
reported `cache_read` is understated — a cosmetic number in a usage report, never
anything sent on the wire.

The fields that actually resume a chat — `sid`, `parent`, `sent`, `account` — are
untouched, so a pruned entry still resumes the **same** DeepSeek chat.

## 18.3 The fix

`_LAST_PROMPT_CAP = 262144` chars (256 Ki ≈ 87k English tokens) and
`_LAST_PROMPT_KEEP = 40` most-recently-used entries. A `_seen` stamp at turn start
and at the write site drives the retention, so a conversation that is actually
running keeps its prompt and idle ones do not.

**Truncation happens inside `_prune_last_prompts`, not only at the write site**,
and the test suite caught that this mattered: an earlier version applied the cap
only when storing, which meant the already-oversized file would never shrink and
any other setter would bypass the cap. Enforcing it in the prune is what makes the
next save reclaim the space.

## 18.4 Verification on the real file

Run against a **copy** of the actual 46.76 MB file, so the original was untouched
(asserted: unchanged byte-for-byte afterwards):

| | |
| --- | --- |
| before | 46.76 MB |
| after one save | **8.85 MB** |
| reclaimed | **37.91 MB (81.1 %)** |
| entries after | 195 (was 195) |
| same key set | **True** |
| every `sid` intact | **True** |
| max stored prompt | 262144 chars (= cap) |
| entries retaining a prompt | 40 (= KEEP) |

`test_ds_direct_session_bound.py` — **22 checks, 0 failed** — asserts the cap, the
prefix property, that a small prompt is stored unchanged, that all four mapping
fields survive, that exactly KEEP entries retain a prompt and the retained set is
the KEEP *newest*, that no entry is ever deleted, that pruning is self-healing
(a pruned entry re-stores on its next turn), that `_turn_usage` still works against
a truncated previous prompt, and that the written file stays bounded.

## 18.5 The accumulating-cause question, finally with an answer

Section 12 concluded that **nothing client-side accumulates** — body size flat,
headers constant, requests per turn flat. FIX 15 does not overturn that; it is the
same finding seen from the other side. What accumulated was never a *request*
property, and it was never anything the server would see. It was a **local state
file**, rewritten in full on every turn, that no request ever carries.

So the two statements are consistent and both are now measured:

* **nothing about a request grows with turn count** (section 12), and
* **a local bookkeeping file grew with turn count**, which cost disk and per-turn
  write latency but could not have influenced a moderation verdict (section 18).

The second is a real defect fixed here. It is *not* the mute mechanism, and
claiming otherwise would be exactly the kind of correlation-to-causation jump this
document has already retracted three times.


---

# 19. FIX 16 — the wire journal was append-only with no rotation

Found by sweeping every mutable state file after FIX 15, on the question "are
there others?".

## 19.1 The defect

`ds_wirelog.py` capped its **in-memory** ring at 80 entries (`_RING_MAX`) — that
is what keeps a verdict's preamble small — but `_append` opened the journal in
append mode and **never rotated it**. The file grew for the life of the process.
Measured: 0.53 MB after roughly two hours of light traffic.

That is small in absolute terms, and on a normal log it would be a nuisance rather
than a defect. What makes it matter here is the journal's purpose: it is the one
artifact that must still be readable **after** a mute, and a mute can arrive days
after the request that drew it. An unbounded file is a file that eventually
becomes impractical to read exactly when someone needs to read it — and because
this journal is enabled by a marker file, it is the one most likely to be left on
by accident.

## 19.2 The fix

`_FILE_MAX = 32 MiB` — roughly a hundred times the observed size, i.e. weeks of
traffic, chosen so the bound cannot truncate the window a mute investigation
actually cares about.

Rotation is **one generation, by `os.replace`**: the live file moves to `<path>.1`,
replacing any previous `.1`, and a fresh file starts. Three deliberate choices:

* **preserve, do not truncate.** Discarding records at the rotation boundary would
  drop exactly the ones nearest the event under investigation. The previous
  generation stays on disk.
* **one generation, not a numbered series.** A bounded pair keeps a post-mortem
  readable; an unbounded set of rotated files would just move the growth problem
  to a directory listing.
* **`os.replace`, which is atomic** on both POSIX and Windows, so a concurrent
  reader sees one file or the other and never a half-written one.

Best-effort like every other write in the module: a rotation that fails leaves the
existing file in place and never breaks the request being journaled.

## 19.3 Verification

`test_ds_wirelog_rotation.py` — **23 checks, 0 failed**:

| property | asserted |
| --- | --- |
| the bound is generous | `>= 16 MiB` |
| below the bound | nothing rotates, both records in the live file |
| crossing the bound | the live file rotates away |
| the old generation | intact, same size, still holds the old record |
| the new record | lands in the fresh live file, which is small again |
| one generation | `.1` exists, `.2` and `.3` never created |
| best-effort | an aggressive bound does not raise; records still reach disk |
| robustness | a missing file and a non-file path both tolerated |
| the ring | still capped at `_RING_MAX`, verdict still carries its preamble |

Full set: **13 suites, all green** (48 + 13 + 23 + 23 + 18 + 33 + 17 + 22 + 36 +
14 + 22 + hif + identity).

## 19.4 The accumulating-file sweep, complete

After FIX 15 and FIX 16, every mutable file this connector writes is bounded:

| file | bound |
| --- | --- |
| `ds_sessions.json` | **FIX 15** — `last_prompt` capped at 256 Ki chars, kept for the 40 MRU entries |
| `ds_wirelog.jsonl` | **FIX 16** — 32 MiB, one preserved generation |
| `ds_muted.json` | one entry per muted account, pruned on expiry |
| `ds_last_turn.json` | one entry per account |
| `ds_config.json` | fixed account roster |

Note what this list is and is not. It closes the class of "a local file grows
without bound", which was a real defect class in this codebase — three of the six
were unbounded or clobbering. It says **nothing** about mutes, and it is not
evidence about the mute mechanism either way. Section 18.5's reasoning applies
unchanged: what accumulates locally is invisible to DeepSeek.


---

# 20. Instrumentation audit — does the telemetry actually capture what was asked?

The objective requires per-turn capture of: request paths, prompt size, session id,
header fingerprints, cookie metadata, and all verdict readers. Audited rather than
assumed, because an instrument that silently records nothing is worse than none.

## 20.1 Per-turn telemetry (`_t2soak.jsonl`)

Each row carries: `turn`, `ts`, `account`, `sid`, `prompt`, `prompt_chars`,
`chars`, `reply`, `dur_s`, `err`, `verdicts`, `muted`.

| required | field | status |
| --- | --- | --- |
| prompt size | `prompt_chars` | present |
| session id | `sid` | present |
| all verdict readers | `verdicts` + `muted` | present |
| request paths | (wire journal — see below) | present |
| header fingerprints | (wire journal) | present |
| cookie metadata | (wire journal) | present |

## 20.2 The wire journal — the important half

Checked across **all 123 completion requests**, not a sample:

| property | coverage |
| --- | --- |
| `header_fp` populated | **123 / 123** |
| `jar` populated | **123 / 123** |
| `header_order` populated | **123 / 123** |

A completion request carries 25 header names with a 10-hex fingerprint each —
including `authorization`, `x-device-id`, `x-device-model`, `x-ds-pow-response`,
and `x-hif-leim` — plus the jar as name → `{fp, domain, expires, expired, age_s}`.

**One honest caveat found during the audit.** A bare page-load `GET
chat.deepseek.com/` records *empty* `header_order`, `header_fp`, `cookie_names`,
and `jar`. That is not a journal bug: that request genuinely carries no custom
headers and no jar cookies through this code path. But it does mean a naive reader
of the journal could mistake an empty record for a measurement failure. The
distinction is the `path`: the completion route is the one under investigation,
and it is populated in every single case.

## 20.3 What this does and does not establish

**Does:** the instruments are live and complete for the route that matters, so if a
mute lands on t1 or t2 while these soaks run, the artifact needed to reason about it
— the exact request shapes that preceded the verdict, plus the verdict's own
preamble — will exist. That was the goal's instrumentation requirement.

**Does not:** establish any cause. No mute has occurred on t1 or t2 (30 and 9 turns,
0 mutes). The instruments are ready; they have not yet been handed the event.


---

# 21. Mute-capture audit — what happens the moment a verdict lands?

Section 20 checked that the telemetry exists. This checks that the soaks *act* on
it — because an instrument that records into a buffer nobody flushes, or that keeps
running through the event it exists to catch, is the same as no instrument.

## 21.1 The capture path, traced

Both soaks (`_t2soak.py`, `_humansoak.py`) do the same four things on every turn:

1. **Catch `_Muted` by TYPE, not by message.**
   ```python
   except Exception as e:
       if isinstance(e, ds._Muted):
           muted = str(e)
   ```
   This matters for the reason FIX 6 was written: a mute raised as prose is
   invisible to the four `*_verdict_in` readers, because those require a parsed
   object with a nested `data`. A soak that only read verdicts would keep running
   its full turn count through a mute and record nothing — which is precisely the
   result the multi-day run exists to produce. Both soaks avoid that.

2. **Run all four verdict readers** on the raw stream:
   `_mute_verdict_in`, `_auth_verdict_in`, `_ref_file_verdict_in`,
   `_biz_verdict_in`. Belt and braces with (1): the raised exception catches a
   mute that reaches the caller, the readers catch one that arrives in a body the
   caller swallowed.

3. **Persist the verdict** to the soak's own state file
   (`_t2soak_state.json` / `_humansoak_state.json`) under `muted`, with the turn
   number and a timestamp.

4. **STOP.** `return 3` in `_t2soak.py`. The run ends rather than continuing to
   hammer a muted account. Section 13 established that retries do not extend a
   penalty, so this is not a correctness fix — it is what keeps the result
   legible: the LAST turn in the log is the turn that drew the verdict, with
   nothing after it.

## 21.2 The wire journal fires independently

`KILN_DS_WIRELOG=1` is set for both soak processes, so `ds_wirelog.verdict(...)` —
called at every `_Muted` raise site — writes the verdict **together with its
preamble** automatically. That is the artifact section 13 said was missing for
j1: the exact request shapes that preceded the decision, in the same line as the
decision. It does not depend on the soak doing anything.

## 21.3 What a captured mute will contain

| artifact | content |
| --- | --- |
| `_t2soak.jsonl` | the per-turn row whose `muted` is set, plus every prior turn |
| `_t2soak_state.json` | `{turn, verdict, ts}` |
| `ds_wirelog.jsonl` | a `verdict` record **plus its 80-entry preamble** |
| `ds_muted.json` | the exact `mute_until` float (FIX 12) |

## 21.4 Honest status

**No mute has occurred on t1 or t2.** 30 turns and 9 turns, zero mutes. Every
piece above is verified by reading the code and the on-disk state, not by having
observed a capture. The chain is ready; it has not yet been exercised by the event.


---

# 22. The "returned no challenge" prediction — tested on structured events, and it holds

## 22.1 The hypothesis

`_pow`'s own docstring records that a mute could present as a **bare failure to
get a challenge**, not as a recognisable verdict:

> *"Left unread, this route reports 'returned no challenge' for an account DeepSeek
> has plainly told us it will not serve."*

So "the proof-of-work challenge request returned no challenge (HTTP 200)" is the
**pre-fix signature of an unreadable mute**. FIX 1 (mute classification) landed at
**2026-09-29 17:48:56**. If it worked, that symptom should **stop** appearing.

That is a falsifiable prediction with a sharp form: 0 occurrences after the fix.

## 22.2 A contaminated first attempt, discarded

The first run reported **168** occurrences and looked like a refutation. It was
**wrong**: it matched the phrase on *any* line, which swept in my own prose, the
recon documents, and tool results that quote the string. That is the fourth time
in this investigation that substring-matching over log text has produced a false
result.

Redone on **structured `llm/retry` events only** — parsing each line as JSON and
reading `data.failure.message` — the picture is completely different.

## 22.3 The result

| HTTP code | before FIX 1 | after FIX 1 |
| --- | --- | --- |
| **200** (DeepSeek answered, no challenge — the mute shape) | **37** | **0** |
| **202** (AWS WAF challenge, per the module's own comment) | 0 | **1** |

**The prediction holds.** Every one of the 37 HTTP-200 occurrences predates mute
classification; none occurs afterwards. The single post-fix case is **HTTP 202**,
which the code explicitly documents as the **AWS WAF** path — a different condition
that happens to share the message text because both are "no challenge". Separating
the two codes is what makes the test meaningful; the message alone conflates them.

## 22.4 A necessary caveat: the symptom is not one-to-one with a mute

Four accounts show HTTP-200 "no challenge" storms **before** the fix — `4`, `6`,
`7`, `9` — and **none of them is ever attributed a mute**:

| account | no-challenge events | later activity |
| --- | --- | --- |
| 9 | 12 (09-27 → 09-28) | ran 40 requests afterwards, no mute |
| 4 | 5 (09-25) | 6 requests, no mute |
| 6 | 5 (09-26) | 4 requests, no mute |
| 7 | 5 (09-26) | 213 requests, no mute |

`9` is the clearest: it hit the symptom twelve times over two days and then went on
to serve 40 requests normally. So "no challenge (HTTP 200)" is a **necessary-ish
but not sufficient** indicator — it can mean a mute, and it can mean something else
(a transient challenge failure). The honest statement is:

> the symptom **disappeared** when mute classification shipped, which is consistent
> with some of those occurrences having been unread mutes; but it does **not**
> establish that every occurrence was one, and `9`'s history shows at least one
> that was not.

## 22.5 Why this is worth recording anyway

It is the **first test in this investigation whose prediction was made in advance
and then confirmed**, rather than a correlation noticed afterwards. That makes it
the strongest single piece of evidence that FIX 1 does what it claims: the
connector now *sees* a condition it used to misreport as a generic failure.

It is also a limit on what can be recovered: any mute that occurred before
2026-09-29 17:48:56 and surfaced as "no challenge" left **no `mute_until`** to
read, so those penalties cannot be back-computed. Their number is unknown and
unknowable from these logs.


---

# 23. FIX 3 verified LIVE — the first real exercise of `_resume_hygiene`

Section 17.2 established that FIX 3 *was* running in the soaks. This is it
actually firing.

## 23.1 What happened

The t2 soak takes a deliberate walk-away with probability 0.04 per turn, and at
turn 29 it drew one. It slept **95.8 minutes** (20:06:28 -> 21:42:18), which
crosses `IDLE_RESUME_S = 5400 s` (90 min). On the next turn:

```
[ds_direct] ds_direct: deepseek.ee.1+t2@gmail.com resumed after 96 min idle
            -- dropped the stale ds_session_id (it named a session the server
            had rejected)
```

That is the fix doing exactly what it was written to do, and it is the **first
time any of these guards has been exercised by real traffic** rather than by a
unit test. The gap (95.8 min) exceeding the threshold (90 min) is the condition
the unit suite asserts synthetically; this is the same condition arising on its
own.

## 23.2 Why this is worth more than the unit tests

`test_ds_direct_resume_hygiene.py` proves the logic given a fabricated gap. What
it cannot prove is that the gap *occurs in practice* and that the surrounding
machinery — the persisted `ds_last_turn.json` clock, the pool, the real jar —
cooperates. Two things had to be true at once for this to fire:

1. the persisted clock must have survived the gap (FIX 14 territory — a clobber
   would have erased t2's entry and `prev` would have been `None`);
2. the jar must actually have held a `ds_session_id` to drop.

Both held. The soak continued to turn 55 with no mute.

## 23.3 The fast soak

`_fastsoak.py` (new) drives 400 turns at 5-15 s with **no walk-aways**, because
the objective asks for *hundreds of consecutive turns* and neither existing soak
can reach that in useful time: the t1 human-pace soak waits 180-600 s per turn
(9 turns in 100 minutes), and the t2 soak spends an expected ~19 hours of its 300
turns asleep.

It reuses the verified mute-capture design exactly: catch `_Muted` **by type**,
run all four verdict readers, let `ds_wirelog.verdict()` write the verdict with
its preamble, and **stop** (`return 3`) rather than hammering.

**Result so far: 200 of 400 turns on t1, 0 mutes, 1 transient error** — a single
`curl: (56) Connection was reset`, which is a transport blip and not a verdict.
No rate-limiting at 5-15 s spacing.

A logging bug was found and fixed during the smoke test: `sid_for` defaulted
`model_type` to `None`, but `stream()` keys sessions as `<conv>#default`, so
every row logged `sid: null` — an objective-required field silently empty. The
fix is a one-word default change, and it is recorded here because it is the same
class as FIX 12 and FIX 14: a value that existed and was discarded.

## 23.4 Honest status

**No mute has occurred on t1 or t2.** 55 turns (t2) and 200+ turns (t1), zero
mutes. The instrumentation is verified, FIX 3 is verified live, and the fast soak
is now generating the volume the objective asks for. What remains is the event
itself.


---

# 24. A 429 at turn 200 of the fast soak — the operator's hypothesis, live

The operator's account of the pattern, verbatim:

> *"I realize when the AI keeps running, it usually doesnt get muted, until theres a
> long pause, like overnight or DeepSeek rate limit reached — retrying in 3 min
> (attempt 1/20)… …so there has to be a corrolation with that too."*

and the refinement:

> *"the rate limit reached is normal, but its the pause during these turns then the
> ai comes back and shortly after it gets banned"*

## 24.1 What happened

The fast soak ran cleanly from turn 0 to turn 199 at 5-15 s spacing — **200
consecutive turns with no mute, no rate limit, no auth failure**. At turn 200:

```
[ds_direct] rate-limited -- retry #1 in 180s
[ds_direct] rate-limited -- retry #2 in 180s
```

The request rate on t1 from the wire journal, per minute, shows the run plainly:

```
21:46   6    21:52  10    21:58  12    22:04  12    22:10   6
21:47  10    21:53  12    21:59  10    22:05  12    22:13   2  <- limit hit
21:48  12    21:54  10    22:00  12    22:06  10    22:15   2
21:49  12    21:55  10    22:01  12    22:07  10    22:16   2
21:50  10    21:56  12    22:02   8    22:08  12
21:51   8    21:57  10    22:03  12    22:09  12
```

~10-12 requests/minute for 24 minutes, then the server refused.

## 24.2 This is the operator's shape, occurring under observation

Two things make this worth recording rather than dismissing as routine:

1. **It is the pause the operator described.** `DS_RATE_WAIT = 180` and
   `RATE_MAX_TRIES = 20`, so a sustained limit parks the turn for up to an hour —
   indistinguishable, from the outside, from the "long pause" the operator linked
   to the mutes.
2. **It arrived after a long high-rate run, not at the start.** 200 turns of
   unbroken service, then a wall. That is the "keeps running, then a pause, then
   something happens" sequence almost exactly.

## 24.3 What must NOT be claimed yet

The correlation the operator proposes is **pause → mute**. This event supplies the
first half (a genuine pause is now in progress) and **not** the second: no mute has
followed, and it may not. Recording the pause as evidence of a mute would be the
same correlation-to-causation jump this document has retracted three times already
(sections 13.1, 15.1, 22.2).

What is now true is narrower and better: **the exact condition the operator
described is live on t1, with the wire journal recording every request that
preceded it.** If a verdict follows, the artifact to explain it exists. If none
does, that is evidence against the hypothesis, and it will be recorded as such.

## 24.4 The retry behaviour is correct, and that matters

The 429 was classified as `_RateLimited`, **not** as a mute — which is the whole
point of FIX 8 (`429 → _RotateAccount/_RateLimited` instead of a silent retry) and
of the mute classification work. A rate limit and a mute are different verdicts
with different remedies: one waits 180 s, the other waits days and needs a
different account. Conflating them was a real defect; this is that fix doing its
job under a genuine 429.

## 24.5 Status

| soak | account | turns | mutes | state |
| --- | --- | --- | --- | --- |
| `_fastsoak.py` | t1 | 200 | 0 | **rate-limited, retrying** |
| `_t2soak.py` | t2 | 55 | 0 | running (resumed from a 96-min walk-away) |
| `_humansoak.py` | t1 | 9 | 0 | running (paced) |

Two processes are driving t1 (the fast soak and the paced one). That is a real
confound for attribution and is stated here rather than hidden: a verdict on t1
could not be attributed to one of them by account alone. The wire journal's
per-request records are what would separate them.

## 25. The retry ladder is the amplifier, and a mute was borrowing TRANSPORT

### 25.1 The mechanism, end to end

The mute hunt has been looking for what *causes* a mute. This section is about
what makes one **worse**, and it is a client-side bug with a one-line shape.

A mute reaches `ds_direct` as a raised `_Muted`, whose message is prose. That
message crosses the provider bridge as a `meta` frame with `finish: 'error'` and
the reason in `error`. The harness's Kiln adapter classifies that frame in
`reason()` -- and before this fix it recognised exactly two cases:

| the reason | the code it returned | retryable? |
| --- | --- | --- |
| matches `isContextWindowExceededError` | `CONTEXT_WINDOW_EXCEEDED` | no |
| matches `isRateLimit` | `RATE_LIMIT` | yes, after 180 s |
| **everything else, including a mute** | **`TRANSPORT`** | **yes, 5x** |

The default policy retries `TRANSPORT` five times with a 500 ms-to-10 s
exponential backoff (`packages/llm/llm-retry/README.md`). So one mute verdict
produced **ten requests** against an account the provider had already refused --
one initial plus five retries, each retry itself a pow challenge plus a
completion.

### 25.2 The escalation, measured

`jw1` is the account that proves it. Its two verdicts, both recovered as raw
floats from the session log:

| verdict | until (UTC) | duration | implied issue instant |
| --- | --- | --- | --- |
| first | 2026-10-02 09:13:27 | 72 h | 2026-09-29 17:13:27 local |
| second | 2026-10-08 11:16:00 | **216 h** | 2026-09-29 19:16:00 local |

The duration of the second is not a guess. 216 h is the only candidate that puts
the issue instant inside jw1's live window; 72 h would place it on 10-05, two
days *after* the verdict was observed, which is impossible.

Between those two instants, **32 requests** went to jw1 (median inter-request gap
32.6 s). The account was already muted for the first 2 h 03 m of them. The
penalty escalated from 3 days to 9.

This is the accumulation the objective asked for, and it is not the request
count that mutes an account -- it is that a refusal was answered by resending.

### 25.3 The operator's hypothesis, tested and falsified

The operator's reading was: *"when the AI keeps running it doesn't get muted,
until there's a long pause ... then the ai comes back and shortly after it gets
banned."*

The fast soak tested exactly that shape, on purpose and at scale. `_fastsoak.py`
ran **400 consecutive turns** on t1 and hit the rate limit **twice**, at turn 200
and turn 397. Each episode burned 8-9 retries of `DS_RATE_WAIT=180` and lasted
**1445 s (24.1 min)**.

After the first 24-minute pause: **196 clean turns, zero mutes, zero errors.**
After the second: 2 more clean turns to the end of the run.

**A 24-minute forced silence followed by a resume did not mute t1.** The soak
finished `400 turns with no mute`, with `muted: null` in its state file and 0 of
400 rows carrying a mute. The pause is not the trigger.

Caveat, stated plainly: a rate-limit pause and an overnight pause are not the
same event, and one account is not the population. This falsifies the *pause* as
a sufficient trigger on t1; it does not falsify the operator's observation that
mutes were noticed after pauses.

### 25.4 The idle windows, at second precision

Three verdicts arrived while nothing was touching the machine, and the raw
floats let that be measured rather than asserted. Against every `turn/start`,
`turn/end`, `step/start` and `step/end` marker in the session log:

| issue instant (local) | last activity before | first activity after | gap |
| --- | --- | --- | --- |
| 09-29 17:13:27 (jw1) | 16:05:35 | 17:19:39 | 74.1 min |
| 09-29 19:28:00 | 19:13:03 | 19:30:25 | 17.4 min |
| 09-29 21:41:00 | 19:33:48 | 21:57:13 | 143.4 min |
| 09-30 01:55:15 (f) | 09-29 23:50:38 | 09-30 14:44:34 | 893.9 min |
| 09-30 04:19:40 (hunt) | 09-29 23:50:38 | 09-30 14:44:34 | 893.9 min |
| 09-30 09:56:00 (mutetest) | 09-29 23:50:38 | 09-30 14:44:34 | 893.9 min |

**f's verdict issued at 01:55:15 and hunt's at 04:19:40, both inside a 14 h 54 m
window with no harness activity at all.** That is the operator's "muted at 1am or
4am while I'm sleeping, nothing is touching the computer" -- confirmed from
server-recorded timestamps, not from recollection.

The tension this leaves unresolved, and it must not be papered over: three
verdicts landed in a fully idle window, while j1's landed inside a live request.
Either the penalty is applied by a background pass (which explains the idle
three and not j1) or it is computed synchronously at a rejected request (which
explains j1 and not the three). Both readings survive the evidence.

### 25.5 Correction: three raw floats do survive

An earlier pass concluded that no raw `mute_until` float survives anywhere and
that every issue instant is therefore known only to the minute. **That was too
broad.** Three second-precision floats are present in the session log, one of
them 149 times:

| raw float | until (UTC) | how it was first seen |
| --- | --- | --- |
| 1790932407.459 | 10-02 09:13:27 | `jw1`'s own failure message, 09-29 17:21:47 |
| 1790963715.231 | 10-02 17:55:15 | a tool result, 09-30 15:03:51 |
| 1790972380.757 | 10-02 20:19:40 | a tool result, 09-30 15:02:54 |

So `f`'s issue instant is 09-30 01:55:15, not "01:55-ish", and `hunt`'s is
04:19:40. The other five remain minute-precision only. The correction matters
because section 25.4's gap arithmetic depends on it.

### 25.6 FIX 17 -- a mute gets its own non-retryable code

`packages/llm/llm-kiln/src/adapter.ts`:

- `ACCOUNT_MUTED_CODE = 'ACCOUNT_MUTED'`, exported from the package index.
- `isMutedAccount(message)`, a vocabulary test over the sidecar's structured
  `error` field only -- never over model output, so an answer that discusses
  mutes cannot classify itself.
- The branch sits **before** the rate-limit branch in `reason()`, because a mute
  is the more specific verdict and `RATE_LIMIT` is retryable.

Pinned by `packages/llm/llm-kiln/tests/mute-code.spec.ts` -- five assertions,
including that the real mute body is claimed by the new classifier and left
unclaimed by `isRateLimit`. Suite result: **5 passed, rc=0.**

Tier: **1**. `llm-kiln` does not exist at the recorded base (every file is
status `A`), and it appears in neither `SEAM.json` nor any `patchGroups` entry --
so this needs no seam marker and no seam re-record.

`lib/index.js` was rebuilt so the change reaches a served app; the extra
artifacts a `--no-config` bundling run left at `lib/` root were removed to keep
the output shape the repo's own build produces.

### 25.7 What this fix does not do, and what is still open

**It does not stop a mute being issued.** It stops a mute being *answered with
more requests*, which is the escalation half.

**The 4 pre-existing failures in `dsml.spec.ts` are not mine.** They assert that
the DSML translator echoes raw block text into its prose correction (spec lines
119, 126, 929). The translator no longer does, and the same four fail against
`HEAD`'s own copy of the spec in a scratch file. `packages/llm/llm-text-toolcalls`
has no diff against `HEAD`, so the assertions and the implementation are simply
out of step. That package is another agent's; the failures were reported, not
touched.

**The still-open question is unchanged**: what makes DeepSeek issue the first
verdict. Volume is falsified. Content is falsified. Device identity is distinct
per account and the alias theory is refuted. The idle-window evidence points at
something not driven by this machine's traffic, and j1's evidence points at
something that is. FIX 17 removes the amplifier, which makes the next mute
cheaper to observe -- it does not explain the first one.

## 26. The wire carries a delta, the server holds the thread -- and three
##      accumulators are now falsified

### 26.1 CORRECTION: this machine has 89 session logs, not one

Every per-account traffic figure in this document before now was computed from
**one** DSH session log. That was never stated, and it is wrong as a coverage
claim: `C:\Users\eejar\.dsh\sessions` holds **89** compressed session logs,
and only one of them was ever scanned.

The concrete casualty is the claim that **hunt had zero requests and was still
muted**. hunt has **28** `request/header` events -- in a *different* session log
(`session-7cff49`), not the one that had been scanned. The claim was an artefact
of the scan's scope.

Restated honestly: the async-verdict argument that rested on "hunt had no
traffic" no longer rests on that. hunt's 28 requests are timestamped below
against its own mute instant, which is the measurement that replaces it.

Total `request/header` events per account, across all 89 logs:

| account | requests |
| --- | --- |
| 5 | 218 |
| 7 | 214 |
| 4 | 45 |
| parserfix | 43 |
| p | 42 |
| j1 | 42 |
| 9 | 40 |
| jw1 | 37 |
| hunt | 28 |
| kilnsal | 23 |
| v | 21 |
| f | 15 |
| donttouch | 8 |
| 6 | 4 |

### 26.2 The wire body is a DELTA, not the transcript

`ds_wirelog` measures every completion request at ~250-300 bytes, and that looked
like a broken instrument: the agent's own requests could not possibly be 250
bytes. They can, and are.

`_Client.open_completion` sends exactly this:

    chat_session_id, parent_message_id, prompt, ref_file_ids,
    thinking_enabled, search_enabled, model_type

There is no `messages` array. `_prompt_for` sends only the **per-turn delta**,
because DeepSeek threads every turn onto one server-side chat and the server
holds the flattened conversation. The local `messages` list is not what crosses
the wire; the wire carries one new turn and a pointer to its parent.

So body size on the wire can never grow, and "the request body accumulates" was
never a candidate. What accumulates is **server-side**, and the only local proxy
for it is `last_prompt` -- the reconstructed full transcript, kept for prompt
cache accounting.

### 26.3 Accumulator 1, falsified: chat LENGTH

The fast soak drove **397 turns through ONE server-side chat**
(`d5b5ea77-0a3e-4207-a0d5-2f319d30265b`), with a monotonic `parent_message_id`
running 12 -> 830. That is a single DeepSeek thread 397 messages deep.

**No mute.** The soak finished 400 turns, `muted: null`, and 0 of 400 rows
carrying a mute.

If "one very long conversation" were the trigger, 397 turns in one thread would
be a stronger version of it than any real session, and it was not enough.

### 26.4 Accumulator 2, falsified: server-side BYTE VOLUME

`last_prompt` is the reconstructed transcript, so its length is the best local
proxy for how much text the server-side chat holds. Per account, across the 195
entries in the live state file:

| account | largest chat | total | chats | mute status |
| --- | --- | --- | --- | --- |
| v | 1,012,776 | 1,319,634 | 2 | **never muted** |
| deepseek.ee.1 (base) | 895,851 | 14,379,861 | 52 | ? |
| 5 | 790,428 | 1,456,251 | 3 | ? |
| eefamilyai | 785,255 | 16,857,076 | 89 | ? |
| donttouch | 628,694 | 628,694 | 1 | excluded |
| 7 | 274,167 | 522,785 | 3 | ? |
| **f** | **178,481** | 178,481 | 1 | **MUTED** |

The account this agent runs on, `v`, accumulated **1,012,776 characters** in one
chat and was **never muted**. `f` was muted with **178,481** -- a sixth as much.

**Volume does not separate.** This is the byte-volume version of section 15's
turn-count falsification, and it now fails the same way: the busiest account is
not the muted one.

### 26.5 Accumulator 3: the system prompt is re-sent and STORED AGAIN

This is the one live lead, and the code names it. `_system_due` re-sends the
system prompt when a chat is unprimed, when its text changes, and every
`_system_every()` turns (default 8). The docstring states the consequence
explicitly:

> The chat keeps every prompt it is sent, so a system prompt re-sent each turn
> is stored again each turn: a tool protocol of tens of thousands of characters
> filled the server-side conversation with copies of itself long before the work
> did.

The three soaks send **no system message at all** -- `msgs = [{"role": "user",
"content": prompt}]` in all three -- so they never exercised this path. The
agent's chat carries `sys_hash` and `sys_age` and a 995,798-character prompt.

`sys_hash`/`sys_age` appear on only **7 of 195** entries, so this is a thin
sample and the next soak must be built to exercise it: a system prompt large
enough to matter, re-sent on the real cadence, on a fresh account.

### 26.6 What the objective's premise looks like now

The objective was to drive t1/t2 to a mute by running hundreds of consecutive
turns and then diagnose what accumulates. The turns ran -- 400 on t1, in one
397-turn server-side chat -- and **no mute followed**. Combined with this
section, three separate accumulators are falsified: turn count, chat length, and
byte volume.

What the evidence now supports is the shape section 25.4 left open. Three
verdicts (f 01:55:15, hunt 04:19:40, mutetest 09:56) landed inside a 14 h 54 m
window with no harness activity, and the account this agent runs on accumulated
a megabyte of chat without being muted. The first verdict is not proportional to
anything this client accumulates.

FIX 17 (section 25.6) remains correct and independent of all of the above: a mute
is no longer answered with five more requests. That does not explain the first
verdict, and nothing in this section does either.

### 26.7 hunt's timing, restated from its own log

The correction in 26.1 replaced an absence of evidence with a measurement. hunt's
28 requests, read from `session-7cff49`:

| | |
| --- | --- |
| first request | 09-29 23:04:51 |
| last request before its mute | 09-30 00:31:07 |
| **its mute issue instant** | **09-30 04:19:40** |
| first request after | 09-30 16:03:56 |

So hunt was **silent for 3 h 48 m before its verdict** and did not send again for
11 h 43 m after it. The verdict did not arrive at a rejected request; it arrived
in the middle of a gap.

That is the same shape as `f` (silent 4 h 14 m before its 01:55:15 verdict) and
`mutetest` (silent, inside the same 14 h 54 m window). Three accounts, three
verdicts, each issued while its own account was idle.

The honest restatement is narrower than the retracted claim and stronger than
nothing: hunt *did* send 28 requests, but **none in the 3.8 hours before its
mute**. The async reading survives the correction; the "zero traffic" phrasing
did not.

## 27. The system-prompt cadence, measured live for the first time

### 27.1 The gap every earlier soak had

`_system_due` re-sends the system prompt when a chat is unprimed, when its text
changes, and every `_system_every()` turns (default **8**). `ds_direct`'s own
docstring states what that costs:

> The chat keeps every prompt it is sent, so a system prompt re-sent each turn
> is stored again each turn: a tool protocol of tens of thousands of characters
> filled the server-side conversation with copies of itself long before the work
> did.

Every soak before this one -- `_fastsoak.py`, `_t2soak.py`, `_humansoak.py` --
built its request as `msgs = [{"role": "user", "content": prompt}]`. **No system
message at all.** `_system_due` takes `sys_msgs` and returns `False` immediately
when it is empty, so the resend path never executed once across ~500 logged
turns. Every "no mute" result those soaks produced is silent about this
mechanism, because the mechanism was never switched on.

### 27.2 `_syssoak.py` switches it on

Built by transforming `_fastsoak.py` (`_mk_syssoak.py`), it sends:

    msgs = [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": prompt},
    ]

with a 1,883-character system prompt carrying a tool-call format statement and an
eight-tool catalog -- the shape of the real one. It also logs `sys_age` and
`sys_hash` every turn, read back from the session state.

### 27.3 The cadence is real: sys_age resets at 8

Nine turns on t2, `conv=syssoak-run1`:

| turn | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `sys_age` | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | **0** |

The reset at turn 8 is the resend boundary. `sys_age` climbing 0->7 is
`_note_system_sent` counting turns since the last send; the drop to 0 is the turn
that carried the system prompt again. `sys_hash` stayed `f7f1e1f2fad3b2eb`
throughout, which is the correct reading -- the *text* did not change, so the
resend is cadence-driven and not a text change.

So the mechanism is confirmed to fire, and the server-side chat receives a fresh
copy of a 1.9 KB system block every 8 turns. Over 240 turns that is **30 copies**,
about 56 KB of duplicated instruction text inside one conversation.

### 27.4 What this does and does not establish

**Established:** the resend happens on schedule; the earlier soaks never
exercised it; the agent's own chat does (it carries `sys_hash`/`sys_age`, and its
`last_prompt` is 995,798 characters).

**Not established:** that it matters. Volume is already falsified at the account
level (section 26.4: `v` held 1,012,776 chars and was never muted, while `f` was
muted at 178,481), and 56 KB of duplicated system text is small next to that.
The honest reading is that this soak closes a **test-coverage gap** -- the last
mechanism the earlier soaks could not see -- and its result will be informative
either way. It is not, on the current evidence, a promising mute cause.

The run continues to 240 turns. Its verdict is the measurement.

### 27.5 Where this soak journals, and why that looked like a bug

The run's requests did not appear in `python/kiln/runtime/ds_wirelog.jsonl`, and
the file's mtime was minutes stale while the soak was demonstrably sending. That
is not a fault in the soak: `ds_wirelog._state_dir()` returns

    os.environ.get("KILN_STATE_DIR") or _DIR

so a process that inherits `KILN_STATE_DIR` writes its journal there, not beside
the module. The kernel launched this soak with `env=dict(os.environ)`, so it
picked up the kernel's own state directory
(`C:\\Users\\eejar\\AppData\\Local\\Temp\\devid-<id>`) and journaled there -- 168
entries, every one of them t2.

Both locations are correct; they are different state dirs. The lesson for the
next launch is to clear `KILN_STATE_DIR` in the child environment so the soak's
journal lands beside the module with the others, or to read it from the state
dir deliberately. Nothing about the measurement changes either way: the journal
was written, and its contents are complete.

### 27.6 The resend is visible on the wire

In that journal, the completion bodies are `240`, `241`, `242`, `245`, `246`,
`248`, `255`, `256`, `257`, `258` bytes -- the flat per-turn delta, as section
26.2 predicts -- **plus one at 2236 bytes**.

The 2236-byte body is the turn that carried the system prompt: 1883 characters
of it over a ~350-byte delta. It is the wire counterpart of the `sys_age` reset
at turn 8, and it is the first direct evidence in this investigation that a
re-sent system prompt actually enlarges what DeepSeek receives and stores.

One body in 63, because the cadence is every 8 turns and only the first resend
had happened when the journal was read. Over the full 240 turns the count should
reach ~30.

### 27.7 The correlation is exact: 6 sends, 6 large bodies

The strongest form of the claim is a per-request match, and the journal gives
one. Across 42 completion requests:

| | |
| --- | --- |
| `sys_age` resets in the soak's own log | turns **8, 16, 24, 32, 40** |
| system-send turns (turn 0 priming + those resets) | **0, 8, 16, 24, 32, 40** -- 6 turns |
| journal bodies above 1,000 B | **6** |

and the six large bodies are at 00:28:23, 00:29:58, 00:31:06, 00:32:36, 00:34:05,
00:35:28 -- 2236, 2176, 2195, 2188, 2193, 2191 bytes, each roughly 1,900 B over
the ~320 B delta baseline.

**Every turn that sent the system prompt is visible as a large body on the wire,
and no other turn is.** That is the mechanism confirmed at the level of the
individual request rather than by aggregate: `_system_due` decides, `_prompt_for`
puts the system message in the body, and the body grows by exactly the system
prompt's size.

The soak continues to 240 turns, which should produce ~30 such bodies.

### 27.8 The honest bottom line on this accumulator

What is now established:

- the resend cadence is real and fires every 8 turns;
- each resend is a ~1.9 KB enlargement of what DeepSeek receives and stores;
- no earlier soak ever exercised it, because none sent a system message.

What is **not** established, and must not be implied: that this causes a mute.
The volume arithmetic argues against it. Thirty resends over 240 turns is about
57 KB of duplicated text, and section 26.4 already showed an account holding
**1,012,776 characters** without being muted. A mechanism that adds 57 KB to a
conversation that can hold a megabyte unmuted is not a promising trigger on the
evidence available.

So `_syssoak.py`'s value is that it closes the last blind spot: after it, every
path `ds_direct` documents as accumulating has been exercised at least once, and
the four that were measured -- turn count, chat length, byte volume, and the
system-prompt resend -- can each be reported as exercised rather than untested.
The next mute, whenever it comes, will not be attributable to any of them.

## 28. Accounts are pooled and rotated inside ONE session

Reading session `7cff49` end to end changes how every per-account number in this
document must be read. That single DSH session issued 167 `request/header`
events across **six different accounts**:

| account | requests |
| --- | --- |
| parserfix | 43 |
| p | 42 |
| 9 | 40 |
| hunt | 28 |
| donttouch | 8 |
| v | 6 |

The session was titled "Hi" / "Casual Greeting to Coding Assistant" -- a
lightweight session, and still it rotated through six accounts.

**The consequence for attribution.** A per-account request count measures how
much of the *pool's* work that account happened to carry, not how much work the
session did. `hunt`'s 28 requests are not "hunt was lightly used"; they are
"hunt carried 28 of this session's 167 turns before the pool moved on". The same
applies to every count in section 26.1.

**The consequence for the mute question.** This is the mechanism that makes a
mute survivable in normal operation: when one account is refused, the pool
rotates to another and the session continues. `hunt` was muted at 04:19:40 and
this session went on using `v`, `donttouch`, `9` and `p`.

**And the sharper question it raises.** If a session rotates accounts on a mute,
then a mute is *supposed* to stop that account's traffic. `jw1`'s escalation
(section 25.2) is the case where it did **not**: 32 requests continued against an
account already carrying a 72 h verdict. FIX 17 addresses the retry half of that
(the harness resending a refusal five times); FIX 12 addresses the selection
half (a known-muted account sorting last). Both are now in place, and this
section is the evidence that they answer a real observed failure rather than a
hypothetical one.

Caveat, stated plainly: this is one session read in full. Whether every session
rotates this way, or only ones that hit a refusal, is not established here.

## 29. The operator's two explicit suspicions, resolved

### 29.1 "expired cookies or tokens still being sent"

Already answered by FIX 3, but the *refutation* recorded earlier was wrong and
section 17 corrects it: `ds_session_id` is installed with **no `expires`
attribute**, so it is a session cookie and `_cookie_expired` can never call it
expired. The "0 of 212 expired cookies" result tested the wrong thing entirely.
Server-side invalidation is invisible to that check, and the operator was
pointing at something real. `_resume_hygiene` drops the stale session cookie on
a long pause, and it has since fired live twice (95.8 min and 92 min idle).

### 29.2 "logging in without signing out rotates the device"

This one is now **refuted by direct measurement**, and it is worth stating
plainly because it was a specific, testable claim.

`_relogin.py` drove **five real logins** against `t2`, 20 s apart, each
re-authenticating from the saved password. Across all five:

| login | would-send device_id | profile device_id |
| --- | --- | --- |
| 1 | `89:7c9cc9045a` | `89:7c9cc9045a` |
| 2 | `89:7c9cc9045a` | `89:7c9cc9045a` |
| 3 | `89:7c9cc9045a` | `89:7c9cc9045a` |
| 4 | `89:7c9cc9045a` | `89:7c9cc9045a` |
| 5 | `89:7c9cc9045a` | `89:7c9cc9045a` |

**One distinct value, five times** -- the account's own captured identity,
recovered rather than re-minted. `_device_id_for` resolves the account's stored
Chrome-profile value before the machine fallback, so a re-login *recovers* the
identity. Repeated login without sign-out does **not** rotate the device.

### 29.3 Login bursts are not the trigger

The same run gives the falsification for free. Across both wire journals:

| account | `users/login` requests | mute status |
| --- | --- | --- |
| t1 | **6** | never muted |
| t2 | **7** | never muted |
| f | 0 | MUTED |
| hunt | 0 | MUTED |
| j1 | 0 | MUTED |
| jw1 | 0 | MUTED (216 h) |
| p | 0 | MUTED |
| v | 0 | never muted |

**Every muted account recorded zero logins; the two accounts that took 13 logins
between them were never muted.** My own test deliberately drove five logins in
80 seconds against t2 -- exactly the "login storm" shape the code comments warn
escalates -- and t2 is still serving 56 turns of the system-prompt soak without a
mute.

Caveat: the journals cover the windows they were enabled for, and a muted
account's login could predate its journal. This is evidence against the login
burst as a *sufficient* trigger, not a proof of absence. It is, however, the
opposite of what the hypothesis predicts: the heavily-logged-in accounts are the
clean ones.

## 30. FIX 11 is not live: the agent's own path has never been journaled

This is the most consequential gap found since FIX 1, and it is an operational
fact rather than a code defect.

### 30.1 The measurement

Splitting every request in `ds_wirelog.jsonl` at the bridge's start time:

| window | accounts present |
| --- | --- |
| **before** 09-30 19:41:49 | `v` -- 176 requests |
| **after** 09-30 19:41:49 | `t1` -- 911, `t2` -- 153 |

And per account, for the two accounts the agent actually ran on:

| account | before 19:41 | after 19:41 |
| --- | --- | --- |
| `j1` (served the agent 14:52-20:00) | **0** | **0** |
| `v` (served the agent from 20:11) | 176 | **0** |

**Zero requests from the agent's own provider route have been journaled since the
bridge started.** `j1` has no journal entries at all.

### 30.2 Why -- and the marker file says so itself

`ds_wirelog.enabled()` caches its answer in a module global:

    _ON = None
    def enabled():
        global _ON
        if _ON is None:
            ... resolve env var or marker ...
        return _ON

The current bridge started at **19:41:49**. `ds_wirelog.on` was created at
**20:34:06** -- 52.3 minutes later. The bridge resolved `_ON = False` on its first
call and kept that value for the life of the process. The marker's own closing
paragraph states the consequence exactly:

> A process must (re)load the module to resolve the flag: `enabled()` caches on
> first call, and provider_bridge caches its modules. **A bridge already running
> when this file was created keeps journaling OFF until it is restarted.**

So the account under investigation -- the one that actually serves this agent --
is the one account whose requests are invisible. That is precisely backwards, and
it is the situation FIX 11 was written to fix. FIX 11 is correct; it simply has
not taken effect, because it needs a process restart rather than a code change.

### 30.3 What this does and does not invalidate

**Not invalidated.** Every soak measurement stands: the soaks set
`KILN_DS_WIRELOG=1` in their own environment and journal correctly to their own
state dir. Sections 26 and 27 -- the delta wire, the three falsified
accumulators, the 6-for-6 resend correlation -- are all from soak or pre-marker
data and are unaffected.

**Weakened.** Any claim about the *agent's* own request shape rests on the 176
`v` entries from **before** 19:41, which came from an older process that did have
the journal on. Those are valid, but they describe the pre-bridge path. After
19:41 the agent's traffic is unobserved.

**The specific gap:** if a mute is issued against the agent's own route, there
will be no journal preamble to read. `ds_muted.json` and the verdict readers
still record the verdict itself, so a mute is not invisible -- but the 80-entry
request preamble that would show *what preceded it* will not exist.

### 30.4 The remedy is a restart, and it is the operator's call

No code change is needed. `provider_bridge.py` must be restarted so it reloads
`ds_wirelog` and resolves `_ON = True` from the marker.

This is deliberately **not** something done here: the bridge is the route this
agent is currently running through, so terminating it mid-turn would end the
session that is doing the investigating. The operator has restarted the harness
before for exactly this kind of change, and this note is the request.

## 31. Aggregate pool activity does not distinguish a mute instant

The alias hypothesis had one form left alive. Per-account activity had been
falsified (sections 15 and 26.4), but every account is a plus-alias of one Gmail
base. If DeepSeek counted the BASE rather than the alias, a quiet account could
still be muted because its siblings were busy -- and no per-account measurement
would see it.

That is testable, and it fails.

### 31.1 The measurement

Across all **89** session logs, 1,035 `request/header` events spanning 08-15 to
10-01. For each mute issue instant, the total pool activity in the preceding 30
minutes:

| account | issue instant | requests | distinct accounts |
| --- | --- | --- | --- |
| jw1 | 09-29 17:13:27 | 1 | kilnsal |
| ? | 09-29 19:28:00 | 5 | jw1, p |
| ? | 09-29 21:41:00 | **0** | -- |
| f | 09-30 01:55:15 | **0** | -- |
| hunt | 09-30 04:19:40 | **0** | -- |
| mutetest | 09-30 09:56:00 | **0** | -- |
| j1 | 09-30 20:04:00 | 3 | j1 |
| jw1 (second) | 09-29 19:16:00 | **11** | jw1, p |

Random 30-minute windows over the same span: **min 0, median 0, max 4.**

Six of the eight mute instants follow a window carrying 0-3 requests, which is
the baseline. **Aggregate activity on the shared base does not distinguish a mute
instant either.**

### 31.2 The one elevated window is the fix, not the cause

`jw1`'s second mute follows 11 requests in 30 minutes -- the only window above
the random maximum of 4. That looks like a counter-example until it is
identified: those 11 requests are the retry ladder of section 25.2, part of the
32 requests that fell between jw1's two verdicts.

So the single elevated window in the whole set is the client's *response* to a
mute already in hand, which is exactly the behaviour FIX 17 removes. It is not
evidence that activity caused the mute; it is evidence that a mute caused
activity -- and that the client then escalated its own penalty.

### 31.3 What is closed

Every activity-proportional explanation is now measured and falsified:

| explanation | verdict | section |
| --- | --- | --- |
| per-account turn count | falsified | 15 |
| per-account byte volume | falsified | 26.4 |
| single-chat length | falsified | 26.3 |
| system-prompt resends | exercised, ~57 KB -- too small | 27 |
| login bursts | falsified -- muted accounts had 0 logins | 29.3 |
| **aggregate base-address activity** | **falsified here** | 31 |

What remains is the shape section 25.4 left open and this section strengthens:
the verdicts arrive in windows that are indistinguishable from quiet windows, so
the trigger is not proportional to anything this machine sends. The one
exception is the escalation, and that one has a mechanism and a fix.

## 32. Exactly which fixes are live, and the one restart that activates the rest

### 32.1 The measurement

The running `provider_bridge.py` started at **09-30 19:41:49**. `ds_direct.py` was last modified at **09-30 21:24:27** -- 1 h 43 m *later*. Python caches an imported module for the life of the process, so the bridge is executing the source as it stood at 19:41:49, not what is on disk now.

| fix | landed | live in the running bridge? |
| --- | --- | --- |
| FIX 1-10 | before 19:41:49 | **yes** |
| FIX 11 (`ds_wirelog.on`) | marker created 20:34:06 | **no** -- `enabled()` cached `False` |
| FIX 12 (mute ledger) | 20:35:58 | **no** |
| FIX 14 (state merge) | 21:18:31 | **no** |
| FIX 15 (last_prompt bound) | 21:25:11 | **no** |
| FIX 16 (journal rotation) | 21:26:01 | **no** |

So the protections the soaks have been demonstrating run in the *soaks' own processes*, which import the current source fresh. The bridge -- the process that serves this agent, and the one whose account was muted -- is running code from before FIX 12.

### 32.2 Why this matters, concretely

1. **FIX 11 is off** (section 30), so this agent's own request path is unjournaled. A mute against the agent's route would arrive with no preamble.
2. **FIX 12 is off**, so the bridge's account pool does not yet skip an account the ledger knows is muted. The next selection can still hand work to a benched account.
3. **FIX 14 is off**, so the bridge can clobber a mute another process recorded.

None of these has been triggered since 19:41 -- no mute has been issued to this account in that window -- so this is a latent gap rather than an active failure.

### 32.3 The request

**Restart `provider_bridge.py`.** One restart activates FIX 1-16 and turns the wire journal on for the agent's own path.

FIX 17 needs no restart of the bridge: it is TypeScript, already bundled into `packages/llm/llm-kiln/lib/index.js`, and takes effect when the harness next loads that package.

This is left to the operator deliberately. The bridge is the route this agent is currently running through: terminating it mid-turn would end the session doing the investigating, the same reasoning recorded in section 30.4.
