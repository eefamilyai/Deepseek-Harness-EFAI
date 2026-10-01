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

## 33. FIX 17 verified end to end against the real raise sites

FIX 17's unit test (`mute-code.spec.ts`) feeds `isMutedAccount()` strings I chose. The string that actually reaches the adapter is different: it is `str(exception)` from `ds_direct`, carried by the bridge as `meta{finish:'error', error: ...}`. `_e2e_fix17.py` closes that gap by constructing the message each of the five `raise _Muted(...)` sites emits and testing it against the adapter's own regex, copied byte-for-byte from `adapter.ts`.

### 33.1 The result

All four real mute verdicts this investigation recovered produce a message the adapter classifies as a mute:

| verdict | classified as a mute |
| --- | --- |
| `user is muted (until 2026-10-03 12:04 UTC)` | **yes** |
| `user is muted (until 2026-10-08 11:16 UTC)` | **yes** |
| `user is muted (until 2026-10-02 17:55 UTC)` | **yes** |
| `user is muted (until 2026-10-02 20:19 UTC)` | **yes** |

And no non-mute refusal is misclassified:

| sample | classified as a mute |
| --- | --- |
| `DeepSeek 429: rate-limited` | no |
| `the Kiln provider bridge is missing` | no |
| `DeepSeek returned an empty response (HTTP 200)` | no |
| `too many ref files` | no |

### 33.2 A reading of the test output that must not be mistaken for a failure

`_e2e_fix17.py`'s section 2 prints `classifier=False` for five lines, and that looks alarming. It is an artifact of how that section reads the source: it pulls the **template literal** out of each `raise _Muted(...)`, which still contains the unsubstituted `%s` placeholder:

    "DeepSeek has muted this account: %s. Re-logging in will not ..."

A template with a literal `%s` in it does not contain the words "user is muted", so of course the regex does not match it. Section 1 performs the substitution the way the running code does (`... % muted`) and every one of those matches.

The two sections test different things on purpose: section 1 tests the **runtime message**, section 2 only locates the raise sites in the source. Section 1 is the evidence; section 2 is navigation. The `False` values are expected and carry no signal.

### 33.3 What this establishes

The chain from DeepSeek's verdict to the harness's classification is now verified at every link:

1. `ds_direct` raises `_Muted` with the verdict wording -- five sites, confirmed by source inspection;
2. `str(exception)` carries that wording -- confirmed by construction;
3. the bridge forwards it as `meta.error` -- `provider_bridge._stream`;
4. the adapter's `isMutedAccount()` matches it -- confirmed here against the adapter's own regex;
5. `reason()` returns `ACCOUNT_MUTED` before the rate-limit branch -- source inspection, and pinned by the unit test.

`ACCOUNT_MUTED` is not in the default retryable set, so the five-retry loop that escalated `jw1` from 72 h to 216 h cannot run on a mute any more.

## 34. The package suite after FIX 17: four pre-existing failures, none new

Running the whole `llm-kiln` package rather than the single spec:

    Test Files  1 failed | 4 passed (5)
    Tests       4 failed

All four failures are in **`dsml.spec.ts`**, and they are the same four recorded
in section 25.7 -- assertions that the DSML translator echoes raw block text into
its prose correction (lines 119, 126, 929, plus the shared-line case). They fail
identically against `HEAD`'s own copy of that spec in a scratch file, and
`packages/llm/llm-text-toolcalls` has no diff against `HEAD`. The assertions and
the implementation are simply out of step, in a package another agent owns.

**`mute-code.spec.ts` passes: 5 of 5.**

So FIX 17 added **zero** new failures. That is the claim worth recording: the one
file I added passes, and the four failures predate my change and are not mine to
fix.

### 34.1 The clock-time question, settled

The operator's observation was specific: *"my accounts are getting muted at like
1am or 4am while im sleeping."*

| account | issue instant | local clock | window |
| --- | --- | --- | --- |
| jw1 | 09-29 17:13:27 | 17:13 | afternoon |
| jw1 (second) | 09-29 19:16:00 | 19:16 | evening |
| ? | 09-29 19:28:00 | 19:28 | evening |
| ? | 09-29 21:41:00 | 21:41 | evening |
| **f** | **09-30 01:55:15** | **01:55** | **sleep** |
| **hunt** | **09-30 04:19:40** | **04:19** | **sleep** |
| mutetest | 09-30 09:56:00 | 09:56 | morning |
| j1 | 09-30 20:04:00 | 20:04 | evening |

Two of eight are in the small hours, and they are the two the operator named --
`f` at **01:55** and `hunt` at **04:19**, both from second-precision floats, both
inside a 14 h 54 m window with no harness activity at all.

The set is not *concentrated* in the small hours -- six of eight are daytime or
evening -- so this is not a nightly batch job. But the two that are, are exactly
the two the operator noticed, which is why the observation was worth measuring
rather than dismissing.

## 35. Every resume after 90+ minutes idle was clean

The operator's hypothesis is a pause, and the longest pauses available to test are the soaks' deliberate walk-aways -- the only event on this machine that resembles an overnight gap. `FIX 3`'s threshold (`IDLE_RESUME_S = 5400 s = 90 min`) is the boundary those pauses cross.

Every gap over 30 minutes across every soak log, and what the resume turn did:

| soak | gap | resume turn | result |
| --- | --- | --- | --- |
| vrun (human) | 35 min | 29 | ok, no mute |
| humansoak | **122 min** | 9 | ok, no mute |
| humansoak | **93 min** | 12 | ok, no mute |
| t2soak | **96 min** | 30 | ok, no mute |
| t2soak | **92 min** | 55 | ok, no mute |
| fastsoak | 24 min (x2) | 200, 397 | ok, no mute |

**Four resumes past the 90-minute threshold, and every one returned a normal answer.** Two of them are the same pauses FIX 3 was written for, and the hygiene guard fired on both without the turn failing.

The honest bound: a 2-hour pause is not a 6-to-10-hour overnight pause, and no soak has yet taken one. So this narrows the operator's hypothesis without closing it -- what is falsified is that a >90-minute pause *by itself* draws a verdict, at the durations that have been tested.

## 36. THE LIVE CAPTURE: t1 muted, with its wire preamble

The objective asked for one artifact above all others: a mute caught live with
the per-request journal on. That artifact now exists.

### 36.1 The verdict

    verdict : mute
    detail  : user is muted (until 2026-10-03 16:40 UTC)
    account : deepseek.ee.1+t1@gmail.com
    observed: 10-01 00:46:12 local
    recorded: 10-01 00:46:12 (ds_wirelog verdict record)

`2026-10-03 16:40 UTC` is the **ninth** distinct `mute_until` in this
investigation -- the eight in section 15 did not include it.

Back-computing at the standard 72 h: the issue window is
**10-01 00:40:00-00:40:59 local**. This is the tightest-bounded issue instant
available, because the account's own traffic is journaled to the second.

### 36.2 What preceded it, from the 80-entry preamble

| time | what |
| --- | --- |
| 09-30 23:35:15 | last request before a **46.5-minute gap** |
| 10-01 00:21:45 | resume, 241 B completion, **200** |
| 10-01 00:31:24 | 256 B completion, **200** |
| **10-01 00:40:55** | pow challenge, **200** |
| **10-01 00:40:55** | `chat.deepseek.com/` -> **202 `waf=challenge`** |
| **10-01 00:40:55** | `api/v0/users/login` -> **202 `waf=challenge`** |
| 10-01 00:40:55 | WAF `inputs` -> 200, `mp_verify` (11037 B) -> 200 |
| **10-01 00:40:55** | `api/v0/users/login` -> **200**  <- the re-login |
| 10-01 00:40:56 | 245 B completion -> **200** (turn 14 succeeded) |
| 10-01 00:46:12 | 245 B completion -> **the mute verdict** |

### 36.3 The correlation is exact

The issue window is 00:40:00-00:40:59. **The AWS WAF challenge and the re-login
both occur at 00:40:55**, inside that window.

And the account was still serving: turn 14's completion returned 200 at
00:40:57, two seconds after the re-login. The refusal came at 00:46:12, six
minutes later.

So this is a mute **issued in the same minute as a WAF challenge followed by a
re-login**, on an account that had been idle for 46 minutes just before. That is
the operator's stated shape -- *"a long pause ... then the ai comes back and
shortly after it gets banned"* -- captured live, in order, with timestamps.

### 36.4 What this establishes, and what it does not

**Established:**
- a mute can be issued in the same minute as a WAF challenge and a re-login;
- the account continued serving for ~6 minutes after the issue instant, which is
  the asynchronous lag section 25.4 described -- now measured rather than
  inferred;
- the pause -> resume -> WAF -> re-login -> mute ordering is real and recorded.

**Not established, and this matters:** whether the WAF challenge *caused* the
verdict or both are symptoms of the account already being flagged. A WAF
challenge is a bot check, not a moderation verdict, and this single episode
cannot separate "the re-login triggered it" from "the account was already
condemned and the challenge was the first visible sign".

**And the honest bound:** this is ONE instance. The other seven mutes have no
journal, so the pattern cannot yet be shown to be typical rather than coincident.

### 36.5 The re-login is on the WAF path, not the biz_code path

This distinction matters for whether a fix already exists. Commit `8b8e59fd7c`
removed the eager re-login that fired on an **unrecognised `biz_code`**. The
re-login here fired on a **token expiry during a WAF challenge** -- the `ds_waf`
recovery path, which is legitimate and still present. So this is not a
regression of that fix; it is a different trigger reaching the same request.

Whether the WAF recovery path should also avoid posting a login is an open
question this capture raises and does not answer.


---

## 37. THE ARRIVAL SHAPE OF A MUTE, THE 6-MINUTE LAG, AND A FALSIFICATION

### 37.1 A mute arrives as a SUCCESS-shaped response

At `10-01 00:46:12` the journal captured t1's verdict together with the 80 requests
that preceded it. The request that drew it:

    seq=65  REQ   /api/v0/chat/create_pow_challenge    -> 200 application/json
    seq=66  REQ   /api/v0/chat/completion              -> 200 application/json   <-- THE VERDICT
    verdict: "mute"  detail "user is muted (until 2026-10-03 16:40 UTC)"

The tell is the **content-type**. Every turn DeepSeek actually serves returns
`text/event-stream; charset=utf-8`. The muted turn returned `application/json` with
**HTTP 200** and no WAF header. So:

    served turn : 200 + text/event-stream
    muted turn  : 200 + application/json

That is a second, independent detection channel. `ds_direct` reads the body for the
verdict (`_mute_of`, `_mute_until_in`) and that works; this records that a
content-type test alone would also have caught it, which matters because the body
reader requires a parsed object with a nested `data` dict and silently declines
anything else.

### 37.2 The verdict lags its own clock by 6 minutes

`mute_until` is known to the minute and the penalty is a fixed 72 h, so

    issue = 2026-10-03 16:40 UTC - 72h = 2026-09-30 16:40 UTC = 10-01 00:40 local

but the refusal was **observed** at `10-01 00:46:12 local`. The account was still
being served in between:

    00:40:55  WAF challenge + re-login (the burst in section 36)
    00:40:57  /chat/completion -> 200 text/event-stream   <-- SERVED, 2s after the burst
    00:46:12  /chat/completion -> 200 application/json    <-- REFUSED

So the penalty clock starts at the minute of the burst, and enforcement arrives
about six minutes later. A mute is not a synchronous rejection of the request that
caused it, and the request that first observes it is generally not the cause.

### 37.3 FALSIFIED: the WAF burst shape did not cause this mute

t1 was WAF-intercepted and re-logged-in four times. Diffing all four, request by
request, they are **shape-identical**:

    seq  POW  GET-/  LOGIN  GET-/  AWSWAF  AWSWAF  GET-/  LOGIN  POW  COMPL
         |     |      |      |      inputs  verify  |      |      |    |
         |     |      |      |                      |      |      |    served
         |     |      |      +-- solver's own GET (11 hdrs, _nav_headers)
         |     |      +--------- 202 WAF-intercepted
         |     +---------------- naked GET (0 recorded hdrs)
         +---------------------- PoW for the turn

    19:50:55  (no leading POW - first login of the account)
    22:35:02  full shape -> served
    22:36:29  full shape -> served
    00:40:55  full shape -> served at 00:40:57, muted 5 min later

Three of the four are byte-for-byte the same request sequence, same jar transitions
(`ds_session_id` dropped first, `aws-waf-token` replaced by each solve), same status
codes. **Only the fourth drew a mute.** A shape that recurs four times cannot by
itself be the trigger, and this record will not claim it is. The correlation between
the burst and the issue minute is real; the causal claim is not supported.

Also against it: t2 was WAF-intercepted **five** times inside 2.5 minutes
(19:51:03, 19:52:01, 19:52:22, 19:52:42, 19:53:03, 19:53:23) and has never been
muted. A more aggressive burst than t1's, no penalty.

### 37.4 CORRECTION: the "naked GET" is not naked on the wire

Section 36 called `chat.deepseek.com/` with no headers a "naked fetch". That was
read off the journal, and the journal is misleading here: `ds_wirelog.install`
records `kwargs.get("headers")`, i.e. **the headers the call site passed**, and
`ds_direct.py:1569` passes none. `curl_cffi`'s `impersonate=` then mints the whole
browser navigation itself.

Measured with a loopback echo server (`_navtest.py`), the wire actually carries
**17 headers** for that call:

    Host, Upgrade, HTTP2-Settings, sec-ch-ua, sec-ch-ua-mobile, sec-ch-ua-platform,
    Upgrade-Insecure-Requests, User-Agent, Accept, Sec-Fetch-Site, Sec-Fetch-Mode,
    Sec-Fetch-User, Sec-Fetch-Dest, Accept-Encoding, Accept-Language, Priority, Connection

with `Sec-Fetch-Mode: navigate`, `Sec-Fetch-Dest: document`, `Sec-Fetch-Site: none`
and the full navigation `Accept`. That is a correct, complete browser navigation.

So `header_order: []` in the journal means "this call site set nothing", never "this
request had nothing". Any future conclusion drawn from that field has to say which
of the two it is.

### 37.5 The WAF-intercepted login sequence, counted

The arithmetic closes exactly, which confirms the reconstruction rather than
assuming it:

    per WAF-intercepted login() = 2 naked GET + 1 solver GET + 2 login POST
    t1: 4 intercepted logins  -> 12 GETs and 8 logins
    journal:                     12 GET-/ and 8 users/login      MATCH

`_login_attempt` runs `range(2)`: iteration 1 posts login, is answered 202, clears
the **entire** cookie jar, solves the challenge, and `continue`s; iteration 2
re-posts and succeeds.

### 37.6 What 37.1-37.5 do not settle

The same tension section 36 named is still open, now with better numbers:

* five of the eight known mute instants have **zero** journaled requests inside
  +/- 3 min (`f`, `jw1`, `mutetest`, and two others - all before the journal
  existed, so this is an absence of evidence, not evidence of absence);
* `j1`'s issue instant has 68 requests in its window, but 64 belong to t2 and 4 to
  t1 - **j1 itself sent nothing**;
* t1's is the only instant where the muted account is demonstrably active, and
  37.3 falsifies the obvious causal reading of that activity.

Either a scheduled background pass, or a computation at a request that was already
answered - not resolved, and not resolvable from client-side logs alone.


---

## 38. TWO PROCESSES, ONE ACCOUNT, TWO TOKEN GENERATIONS

### 38.1 How this was found, and the two false starts

Section 37 left an unexplained shape in the journal: at `22:36:29` t1 presented
token `3332b8b4af` when the newest token seen for that account was `ad3b0e7aca`,
minted **97 seconds earlier**. The first reading was "two clients in one process".

That was wrong, and the journal itself says so. `ds_wirelog._SEQ` is a
**module-global** counter (`ds_wirelog.py:47`, incremented in `_next_seq` at
:157) with no reset anywhere, so a single process can only emit a strictly
increasing `seq`. The window reads

    seq 407 .. 436   <- writer A
    seq  37 ..  46   <- a DIFFERENT writer, restarting from 1
    seq 437 .. 450   <- writer A resumes

One process cannot produce that. A second reading - "attribute requests to
writers by time windows" - also failed, because it split single writers at their
own pauses (the 429 ladders) and produced 52 bogus segments.

The reading that works is a **patience demultiplex**: assign each request to the
longest-running writer whose last `seq` is still below it, with no time
heuristic at all. That needs **12 writers** to cover the journal, and they
resolve into the processes that actually exist on this machine.

### 38.2 What the demux shows

    W0  n=830  seq   1..830   17:27 -> 23:35   v, t1
    W1  n=146  seq   1..146   17:32 -> 00:59   v, t1, t2
    W2  n=142  seq   1..142   18:14 -> 00:58   v, t1, t2
    W3  n= 66  seq   1.. 66   18:17 -> 00:46   v, t1, t2
    ... 8 more, all starting at seq=1

Every writer starts at `seq=1`, which is what a fresh process looks like.

And for t1, the token handoff at the interesting moment:

    22:35:02  W0  3332b8b4af
    22:35:03  W0  ad3b0e7aca     <- W0 logs in; its OWN generation advances
    22:36:24  W0  ad3b0e7aca     <- W0 still on the new generation
    22:36:29  W3  3332b8b4af     <- W3 presents the generation W0 REPLACED
    22:36:30  W3  abd09baa36     <- W3 logs in separately and gets its own

Two processes, one account, two independent token generations alive at once.
`3332b8b4af` was **2 h 46 m old** when W3 used it, and had been superseded by
another process 86 seconds earlier.

This is the operator's hypothesis - *"logging into an account with a device id
and then without properly signing out, logging back in again"* - found in the
data, with the mechanism named.

### 38.3 The structural cause: every pool is per-process

`_pool_for` reads a module-global `_pools` dict, `POOL_MAX` is 8 **per account
per process**, and `login()`'s docstring claims it is *"Serialised per ACCOUNT,
not per client"*. The lock it takes is `acct.login_lock`, a plain
`threading.Lock` on the account object - and the account object is also
per-process, built by `_load_accounts()` at import.

So the guarantee holds **only inside one process**. Across processes there is:

* no shared pool - N processes means N pools, up to 8 clients each;
* no shared `login_lock` - N processes can post `/users/login` simultaneously;
* no shared token - each process's `_Client.token` is its own, refreshed from
  `acct.last_login_token` only within that process;
* no shared "newest token" - so a process that has not logged in recently keeps
  presenting its own older generation until something makes it re-login.

The soak instruments make this concrete: `_fastsoak.py`, `_syssoak.py` and
`_t2soak.py` each `import ds_direct as ds` in their own interpreter, so each is
its own pool and its own token generation for whichever account it drives. The
same is true of `provider_bridge.py`.

### 38.4 What this does NOT establish

**It does not explain t1's mute.** At t1's actual issue instant, `00:40:55`, the
token handoff `abd09baa36 -> afa0b46406` happens **inside W3 alone** - the demux
attributes both to the same writer. No cross-process stale token is involved in
the minute that was muted.

So this record now holds two defects with different evidence:

    1. a mute is retried as TRANSPORT -> 10 requests per refusal, escalating
       72 h to 216 h                    (FIX 17; measured on jw1)
    2. a stale token is presented after another process re-logged in
                                       (section 38; measured once, on t1)

Both are real and both are worth fixing. **Neither is demonstrated to cause a
mute**, and this document will not claim otherwise. The one mute whose minute is
fully instrumented (t1, section 36-37) has a WAF re-login in it and that re-login
is shape-identical to three unmuted ones.

### 38.5 A candidate fix, not yet applied

Make the login generation shared rather than per-process: a small on-disk record
per account holding `{token_fp, minted_at, minted_by_pid}`, written on every
login, and read before any request that would use a token older than the record.
That is the same shape as the existing `ds_muted.json` ledger (FIX 12) and the
`ds_sessions.json` map, so it needs no new mechanism - only a new key.

Not applied here: it changes an auth path this agent runs through, and the bridge
would need a restart to pick it up, which is already the outstanding operator
action.


---

## 39. CORRECTION: CROSS-PROCESS TOKEN PROPAGATION DOES WORK

### 39.1 What section 38 got wrong

Section 38.3 asserted that across processes there is *"no shared token"* and
*"no shared notion of the newest generation"*. **That is wrong, and the mechanism
that refutes it is in the same file I was reading.**

`_lease_client` calls `_refresh_client_creds(c)` on **every** borrow
(`ds_direct.py:2102`). That function calls `_load_accounts()`, which compares
`_config_sig()` - a tuple of `(path, mtime)` per config file - and, on any change,
re-reads the config and merges each account by id via
`_Account.update_from`, which copies `token` and `cookie`. So a token another
process wrote to `ds_config.json` **is** picked up.

Measured directly, with a temp config so no real credential was touched
(`_propagate_test.py`):

    1. process A loads generation A, builds a client
    2. "another process" writes generation B to ds_config.json
    3. _refresh_client_creds(client)
       -> "[ds_direct] ds_config.json changed - reloaded creds for account ..."
       -> client.token is B : True
       -> a FRESH client reads B : True

    VERDICT: cross-process propagation via config+mtime: WORKS

And in the real journal, propagation is visible with a measured latency:

    t1  abd09baa36   W3 minted it 22:36:30 -> W0 first used it 22:36:35   =  5 s
    t2  f755169d1f   adopted by 11 of the 12 writers
    v   a2509c36ec   adopted by 4 of 4 writers

### 39.2 What survives from section 38

The **stale presentation** is still real and still exactly one:

    22:36:29  W3 presented 3332b8b4af while the newest generation was ad3b0e7aca

and `ad3b0e7aca` is the one generation that did **not** spread: W0 minted it at
22:35:03, used it for 18 requests over 1.3 minutes, and no other writer ever
adopted it before W3 superseded it at 22:36:30.

So the accurate statement is not "there is no shared token" but:

    a token propagates on the next LEASE, so a writer that is mid-turn, or that
    has already leased and cached a client, keeps presenting its own generation
    until that lease ends - and `LOGIN_REUSE_WINDOW` is 60 s and also
    per-process.

That is a narrow timing window, not the structural gap 38.3 described.

### 39.3 The part of 38.3 that does still hold

Two things remain genuinely per-process and genuinely wrong:

* **`acct.login_lock` is a `threading.Lock` on an object built by
  `_load_accounts()` at import**, so it serialises logins within one interpreter
  only. Two processes that both see a 401 will both POST `/users/login` for the
  same identity - the exact pattern `login()`'s own docstring says earns
  "too many requests".
* **`_login_attempt` does `self.sess.cookies.clear()`** (`ds_direct.py:1590`)
  before solving a WAF challenge. That wipes the jar in ONE process while another
  process may be holding a freshly solved `aws-waf-token` for the same account.

Both are real. Neither is demonstrated to cause a mute.

### 39.4 Consequence for the proposed fix

Section 38.5 proposed a shared per-account login-generation ledger. The
propagation test shows that is **larger than the defect needs** for the token
itself - the existing config+mtime path already carries the token across
processes within seconds.

What the evidence actually supports is narrower: a shared record of *who last
logged in*, consulted before an `_AuthExpired`-driven re-login, so that two
processes do not post `/users/login` for one account at the same time. That is a
much smaller change, and it is not applied here.

**Method note.** 38.3 was written from reading `_pools` and `acct.login_lock` and
generalising, without testing the propagation path that sits three lines below
the lease. The test took four minutes and falsified the claim. That is the second
time in this document that an untested structural inference was wrong (the first
was 37.4's "naked GET"), and both were caught by running the thing instead of
reading it.


---

## 40. THE SYSTEM-PROMPT SOAK RAN TO COMPLETION: 240 TURNS, ZERO MUTES

Accumulator 3 was the last one still standing. Sections 33-35 established that
`_system_due` re-sends the system prompt every `KILN_DS_SYSTEM_EVERY` turns
(default 8), that the resend really appears on the wire, and that no earlier soak
had ever sent a system message at all - so every earlier "no mute" result was
silent about this path. `_syssoak.py` was built to exercise it with a real
1,883-character system prompt in the request body.

It has now finished:

    turns completed      : 240 / 240
    system sends         : 30
    resend cadence       : exactly 8, every time (deltas = {8})
    mutes                : 0
    errors               : 0
    verdicts seen        : {None}  - not one non-null verdict in the run

Two pauses, both fully explained by the retry ladder and neither followed by a
mute:

    3.1 min    00:59:06 -> 01:02:15
    24.3 min   01:03:50 -> 01:28:05

The 24.3-minute one is `RATE_MAX_TRIES` laddering - a rate-limit window parks one
turn and resends every `DS_RATE_WAIT` (180 s), so ~24 min is eight rungs of a
ladder the connector is *waiting* on, not load it is adding. The soak resumed at
turn ~190 and ran clean to 240.

### What this closes

The system-prompt resend cannot be the accumulating cause. Over 240 turns the
account sent 30 copies of a ~1.9 KB system prompt - roughly 57 KB in total, all
of it into ONE server-side chat, alongside ~240 normal turns - and drew no
verdict. That is a small fraction of the traffic `v` carried unmuted (1,012,776
characters) and of what `f` was muted at (178,481).

It also independently reproduces the rate-limit finding: the ladder is a wait,
not an amplifier. 0.33 req/min during the window, then straight back to normal.

### Accumulator scoreboard, final

    1. chat length            FALSIFIED   397 turns in ONE chat, parent 12->830, no mute
    2. byte volume            FALSIFIED   v held 1,012,776 chars unmuted; f muted at 178,481
    3. system-prompt resends  FALSIFIED   this section: 240 turns, 30 sends, 0 mutes
    4. aggregate pool activity FALSIFIED  6 of 8 mute windows at the random baseline

All four named accumulators are now falsified by measurement rather than by
argument. The cause of a mute remains unidentified, and the two defects this
document *has* established - retrying a mute as TRANSPORT (section 17) and
presenting a stale token inside a lease window (sections 38-39) - are both real
and neither is demonstrated to cause one.


---

## 41. THE MUTED REQUEST IS SHAPE-IDENTICAL TO THE SERVED ONE

### 41.1 The comparison

t1's last two completion requests are 5 minutes 16 seconds apart. The first was
served a real answer; the second was refused with the mute verdict. Every field
the journal captures:

    field                served 00:40:56        refused 00:46:12
    -------------------  ---------------------  ---------------------
    path                 /api/v0/chat/completion /api/v0/chat/completion
    body_bytes           245                     245
    header count         25                      25
    stream               True                    True
    authorization         afa0b46406              afa0b46406
    aws-waf-token fp     68bf16cf13              68bf16cf13
    ds_session_id fp     2e70199336              2e70199336
    server answer        text/event-stream       application/json   <-- ONLY DIFFERENCE

Same token, same WAF clearance, same session cookie, same request body size, same
header set, same streaming flag. **The client sent the same request twice and got
two different answers.**

### 41.2 What this rules out

Whatever the mute was based on, it was **not a difference in this client's
request shape**. Every client-side hypothesis that would predict a distinguishable
"bad" request - a stale cookie, a wrong header, a malformed body, a missing
fingerprint - has to explain why the identical request was served six minutes
earlier. This is the cleanest single piece of evidence in the whole document, and
it is evidence *against* the client-side framing the investigation started from.

It also means a mute cannot be diagnosed by inspecting the request that receives
it. The information that decides it is not in that request.

### 41.3 It corroborates the 6-minute lag from 37.2

Section 37.2 established that `mute_until` back-computes to 00:40 while the
refusal was first observed at 00:46:12, and that the account was still served at
00:40:57. Section 41 shows the 00:46:12 request was not the cause but merely the
first request *after* the decision had already been made server-side.

So the sequence is:

    00:40:55  the burst minute - WAF challenge, re-login  (the clock starts here)
    00:40:57  completion SERVED                        (decision not yet in effect)
    00:46:12  completion REFUSED, request identical to the served one

The verdict was computed during (or about) the burst minute and enforced ~5-6
minutes later, on whatever request came next. The connector did nothing different
in between.

### 41.4 The honest limit

This is one account, one pair of requests. It narrows the search space - the
discriminator is server-side state, not request shape - but it does not identify
the discriminator. What it does do is close the line of investigation this
document opened with: the operator's *"some header or something sent mustve been
wrong"* cannot be true of the request that was muted, because that request was
byte-for-byte the same as one the server answered normally.

### 41.5 A note on idle gaps

The largest gap on t1 before its mute was 59.5 min (20:34 -> 21:33), and the mute
came 24 min after a 46.5-min gap (23:35 -> 00:21). The 90-min `IDLE_RESUME_S`
threshold was never reached on this account, so t1 contributes no evidence either
way about the long-idle-resume hypothesis - that stands as recorded in section 28
(every resume after 90+ min idle was clean).


---

## 42. THE LAST CLIENT-SIDE HEADER LEAD IS ALSO FALSIFIED

### 42.1 Why `x-hif-leim` was the best remaining suspect

Of every header on the request, `x-hif-leim` had the strongest claim to being the
accumulating defect. `ds_hif.py` says so itself:

* the server hands out a fresh value on a timer and states its own lifetime in
  `x-hif-ttl`;
* *"Replaying a captured value forever is worse than sending nothing"*;
* the module exists precisely because *"nothing ever renewed them, so every
  request after the capture carried a value the server had already expired"*.

A value that goes stale after capture is exactly the shape of "mutes after
hundreds of turns but not immediately". So: was the header on the muted request a
stale capture?

### 42.2 No. Renewal is working, and the value was fresh

t1's journal shows **28 distinct `x-hif-leim` values across 439 uses**, rotating
roughly every 8 minutes:

    5aa3d20c85   46 uses   21:42:57 -> 21:50:51
    439b3b6957   46 uses   22:34:37 -> 22:42:36
    1632b885ce   46 uses   22:59:01 -> 23:06:56
    5d833ac77c   45 uses   21:59:10 -> 22:07:04

That is the renewal path firing, not a frozen capture.

And the value on the **refused** request specifically:

    x-hif-leim c5bccd8206   first used 00:40:56, reused 00:46:12, 2 uses
    ds_hif TTL: DEFAULT_TTL=600 s, REFRESH_FRACTION=0.8  -> renew at 480 s
    the refused request came 316 s after first use  ->  WITHIN TTL

So the header was not stale. It was 5 minutes 16 seconds old against an 8-minute
renewal threshold, and it is the same value the server had just answered
normally.

### 42.3 The complete header diff - one field, and it is per-request by design

Full fingerprint comparison of the served request (`seq=64`, 00:40:56) and the
refused one (`seq=66`, 00:46:12):

    only on served  : []
    only on refused : []
    differing       : ['x-ds-pow-response']

That is the entire difference. And `x-ds-pow-response` **must** differ: it is a
proof-of-work minted per request for a specific path, and the journal confirms it
is never reused - **443 distinct values over 443 uses** on t1, no repeat ever.

Every other header is byte-identical, including the three the operator suspected
most: `authorization`, `x-device-id`, and the WAF/session cookie fingerprints.

### 42.4 What is now closed

The original framing - *"some header or something sent mustve been wrong"* - has
been tested field by field against the one request that was actually muted, and
there is no differing header to blame. Combined with section 41 (the identical
request was served 5m16s earlier), the conclusion is:

    a mute is not decided by the shape of the request that receives it

This closes the client-side-request line of investigation that the whole document
opened with. It does not identify the cause, and it does not claim the connector
is innocent of everything - FIX 17 (retrying a mute as TRANSPORT, escalating
72 h to 216 h) is a real defect that made every mute worse, and the lease-window
stale token in sections 38-39 is real too. But neither is the *trigger*.


---

## 43. "THE PAUSE BEFORE THE MUTE" IS FALSIFIED ON 6 OF 7 MUTES

The operator's strongest hypothesis, stated twice, was that a mute follows a
pause:

    "its the pause during these turns then the ai comes back and shortly after
     it gets banned"

    "my accounts are getting muted at like 1am or 4am while im sleeping, and the
     account isnt active"

That is testable, and it has now been tested against every mute instant on record
by asking one question: **how long before the verdict was the machine last doing
anything?**

### 43.1 The measurement

Event timestamps were extracted from all **13** harness session logs on this
machine (`session.v4.jsonl.zstd`, decompressed with zstd; 23,406 distinct event
timestamps spanning 09-14 19:39 to 10-01 02:21). For each mute, the gap between
the last recorded event and the mute instant:

    account    issue instant (local)   events in the 2 h before   last event before   gap
    ---------  ---------------------   -----------------------   -----------------   ------
    f          09-29 17:13                        983               16:57:07        15.9 min
    ?          09-29 19:28                       1525               19:13:03        14.9 min
    jw1        09-29 19:16                       1689               19:13:03         3.0 min
    ?          09-29 21:41                        432               21:40:18         0.7 min
    j1         09-30 20:04                        574               20:03:42         0.3 min
    t1         10-01 00:40                        423               00:39:59         0.0 min
    mutetest   09-30 09:56                          0               00:32:55       563.1 min

**Six of the seven mutes land within 16 minutes of live activity, and three of
them within a single minute.** `t1`'s verdict arrived 0.0 minutes after the last
event: the machine was demonstrably working at the instant it was muted.

### 43.2 So the pause hypothesis is wrong for six of seven

It cannot be the general mechanism. If inactivity were the trigger, the mutes
with 423-1689 events in the preceding two hours would not exist.

### 43.3 But `mutetest` is a genuine exception, and it is the one the operator named

`mutetest` is different in kind: **zero** events in the two hours before it, the
last event 9.4 hours earlier, and it sits inside an **848-minute (14 h 8 m)**
global inactivity gap (09-30 00:32 -> 09-30 14:41). That is precisely the "while
I was sleeping" case, and it is real.

So the honest reading is that there are **two shapes**, not one:

    1. a mute issued while the machine is WORKING  - f, ?, jw1, ?, j1, t1
    2. a mute issued while the machine is IDLE      - mutetest (and the earlier
                                                      f=01:55 / hunt=04:19 pair)

and the operator has been describing shape 2 while the majority of mutes are
shape 1. Both are real; they are not the same phenomenon, and a single mechanism
does not have to explain both.

### 43.4 The t1 rate profile, stated carefully

t1's request rate collapsed going into its mute, and that is worth recording even
though it does not generalise:

    23:00  112 req   23:10   16   23:20    6   23:30    8
    00:20    2       00:30    2   00:40   12   <- muted in this minute

and the two silences with the rate on each side:

    59.5 min silence  20:34:17 -> 21:33:46   30 req before    438 req after
    46.5 min silence  23:35:15 -> 00:21:45  421 req before     16 req after

The second is the striking one: **421 requests in the hour before a 46-minute
silence**, then a resume, then the mute 19 minutes later. That is "heavy use,
pause, resume, muted" and it matches the operator's description exactly.

But it is **one account and one instance**, and section 43.1 shows the other six
mutes have activity right up to the instant. A pattern that holds for one of
seven cases is a lead, not a finding - and this document has already retracted
two conclusions drawn from a single striking observation (37.4, 38.3). It is
recorded as a lead.

### 43.5 What would settle it

A mute that lands after a *measured* heavy-use-then-idle-then-resume cycle on an
account with the wire journal on, reproduced more than once. `t1` is the only
account that has produced this shape once; it is muted until 10-03 16:40 UTC, so
the same test on the same account cannot run until then. A different account run
through the same profile is the available substitute.


---

## 44. A CLOSED LEAD WAS NEARLY RE-OPENED - AND THE GUARD FOR THAT

### 44.1 What happened

Round 52 opened with what looked like a fresh and strong finding: the live probe's
debug output showed

    ds_hif: refresh from hif-dliq.deepseek.com failed (DNSError: Could not resolve host)

and `ds_hif.headers()` returns exactly one header where the module knows of two:

    x-hif-leim   len=73   BL+yRuowfz+oUrQQvH2a7txQBtPZxe1jHXLsczNW...
    x-hif-dliq   absent

The journal agrees: `x-hif-leim` 598 uses, `x-hif-dliq` **zero**. A named
anti-abuse header that is never sent, and a host that does not resolve - on its
face a better lead than anything in sections 37-43.

**It is already closed.** `.recon/ds-direct-mute-investigation.md` investigated it
and reached the right conclusion:

    hif-dliq.deepseek.com has NO IPv4 A record on this network (AAAA only), so
    curl_cffi cannot resolve it ... So this is an environmental divergence, not
    a code defect, and it is not fixable from here without an IPv6-capable route.

and, more decisively:

    x-hif-dliq cannot be minted on this IPv4-only network and is OMITTED rather
    than replayed stale, which is the better of the two failure modes and cannot
    produce account-level moderation.

`ds-mute-findings-summary.md` carries the same line: *"It is omitted, not replayed
stale ... a missing header cannot produce account moderation."*

So the round produced no new finding, and the honest record says so.

### 44.2 The one detail that was genuinely unchecked, and it checks out

The prior doc left exactly one thing UNRESOLVED:

    Whether a real browser sends BOTH on /chat/completion is unconfirmed - the
    Chrome probe could not reach an authenticated completion.

That is still unresolved, and it cannot be resolved from here: it needs an
authenticated browser session, which means using a real account, which is not
something this investigation should do to the operator's accounts.

The related question - whether `x-hif-request` is a **third request header** we
omit - was checked and is not: `x-hif-request` appears in the recon material only
alongside `x-hif-ttl`, both of which are the `hif-*` **endpoint's own response
headers** (the TTL the server states for the minted value), not headers the chat
client sends. `ds_hif` names no such request header, and the journal has never
recorded one. The live header set is exactly `{x-hif-leim}`, which is what the
module intends.

### 44.3 The guard

This is the third time in this investigation that effort went into something the
`.recon` tree already answered - the first two were caught by measurement, this
one by reading. The convention `AGENTS.local.md` already prescribes is the fix,
and it was not followed at the start of the round:

    BEFORE opening any new lead, search .recon for the subject first.

Concretely, for this investigation the check is one call:

    grep "dliq|hif|stale|cookie|header" .recon/*.md

3216 `x-hif-*` mentions already exist across the `.recon` tree. A lead that is
genuinely new will not be the first mention of its own subject.

### 44.4 Where the objective actually stands

The goal is to identify the accumulating cause and fix it. After 43 sections:

    FALSIFIED BY MEASUREMENT
      chat length, byte volume, system-prompt resends, aggregate pool activity
      the WAF-burst shape (4 identical sequences, 1 muted)
      every client-side header (the refused request is byte-identical to a
        served one except the per-request PoW)
      the pause-before-mute story on 6 of 7 mutes
      device rotation, login bursts, cross-process token propagation

    REAL DEFECTS FOUND AND FIXED
      FIX 17: a mute was retried as TRANSPORT, 10 requests per refusal, and
              escalated 72 h to 216 h (measured on jw1)

    REAL DEFECTS FOUND, NOT DEMONSTRATED TO CAUSE A MUTE
      the lease-window stale token (sections 38-39)

    STILL UNIDENTIFIED
      what actually decides a mute. The evidence says it is not the request:
      the muted request was identical to one the server answered normally
      five minutes earlier.

The honest summary is that the *symptom* is understood far better than the
*cause*, and the one fix that survives measurement is FIX 17 - which does not
prevent a mute but stops a mute from being escalated into a nine-day one.


---

## 45. CORRECTION TO 44.2: THE BROWSER DOES SEND BOTH hif HEADERS

### 45.1 Section 44 was wrong, and the answer was already on disk

Section 44.2 said the question *"whether a real browser sends BOTH on
/chat/completion"* was **"still unresolved, and it cannot be resolved from
here."** That is false. The capture that answers it is in the same `.recon` tree
section 44 was reading.

`session-9be5b830.jsonl` contains a real browser's authenticated capture. It
prints a header-frequency table, then a representative completion with full
header values:

    x-hif-dliq      5
    x-hif-leim     35          (of 47 captured requests)

and the representative POST, explicitly labelled:

    === a representative POST (completion) - full headers ===
    url: https://chat.deepseek.com/api/v0/chat/completion
    ...
    x-device-id: 54b12f3c-7918-4bb8-ab56-7debe7cdd68d
    x-device-model:
    x-ds-pow-response: eyJhbGdvcml0aG0iOiJEZWVwU2Vla0hhc2hWMSIsImNoYWxsZW5nZSI6...
    x-hif-dliq: zKkMWZB0KhynCvcCjQ9j8CImF3YSVCZpeCFwptbxI87/I4oy4FbEKs4=.Rwk19Z85grs8wiJd
    x-hif-leim: 4OBuw315ohIDyxweIpBN/CHN35/HSApLcT1AP5pyW7b3Pkqqf49/n8U=.DbEA57PPx49r2Lyy

**Both headers, on the completion call, with values in the documented
`<base64 ciphertext+tag>.<base64 iv>` shape.** The unresolved question is
resolved, and the answer is yes.

### 45.2 So the omission IS a real divergence, not only a limitation

The prior doc reached the right *operational* conclusion - dliq cannot be minted
on this IPv4-only host, and omitting is better than replaying stale - but its
framing was too generous in one respect. Section 44 repeated that framing:

    x-hif-dliq ... is OMITTED rather than replayed stale, which is the better
    of the two failure modes and cannot produce account-level moderation

The comparative half is right. The absolute half is not: **a request without
dliq is not the request a browser sends.** The browser sends both. So the harness
presents a completion whose header set differs from a real client's by one
anti-abuse envelope, on every request, always in the same direction.

Whether that matters is unknown, and this section does not claim it does. What it
corrects is the record: the divergence is real and known, not hypothetical.

### 45.3 Why it still cannot be fixed from here

Unchanged from the prior finding, and verified again this round:

    hif-leim.deepseek.com   RESOLVES  -> 2600:9000:2715:0:3d00:c8:4:9d02, 3.173.21.63
    hif-dliq.deepseek.com   FAILS locally (gaierror)
    via 1.1.1.1:            hif-dliq has AAAA records ONLY
                            (2600:9000:2717/2715/2716:0:3d00:c8:4:9d02)
    hif-leim via 1.1.1.1:   d30r5fqlixgje6.cloudfront.net, with an IPv4 A record

So `hif-dliq` is IPv6-only and this host has no IPv6 default route. The header
cannot be minted here by any code change; it needs an IPv6-capable network path.
That is an environmental fact, not a defect to patch.

### 45.4 Method note - the third self-correction, and the cheapest

Sections 37.4, 38.3 and now 44.2/45 are the same mistake in three costumes:
**asserting a conclusion before checking the material that already answers it.**
37.4 and 38.3 were caught by running a test. This one was caught by grepping the
tree I was already reading - and the answer had been sitting in the capture the
whole time, 470 occurrences of `x-hif-dliq` deep.

The guard section 44.3 proposed is the right one and this section is its second
demonstration: **search `.recon` before writing a claim about what is unresolved.**
A question marked UNRESOLVED in one document may have been answered by a capture
recorded in another.


---

## 46. `x-hif-dliq`: CONFIRMED SENT BY THE BROWSER, CONFIRMED STATIC, AND WE SEND NONE

Section 45 corrected the record. This section states what the capture actually
proves, now that the numbers have been read properly instead of skimmed.

### 46.1 The confirmed facts

From the authenticated browser capture in `.recon/session-9be5b830.jsonl`:

    browser completions carrying x-hif-dliq : 5 of 5
    browser completions carrying x-hif-leim : 5 of 5
    distinct x-hif-dliq values               : 1
    distinct x-hif-leim values               : 3
    x-hif-dliq request value, len            : 73  (sha256 prefix eb76c5add75ef0d3)
    dliq's own GET to hif-dliq.deepseek.com/query : status=0  (never completed, 8 attempts)

Three things follow, and each is a correction to something stated earlier in this
document:

1. **The browser sends both.** Section 44.2 called this unconfirmed and
   unresolvable. It is confirmed, in a capture that was already on disk.
2. **`x-hif-dliq` is STATIC.** One value across every completion in the capture,
   spanning ~40 minutes, while `x-hif-leim` rotated three times in the same
   window. The prior doc said *"likely from local storage / a one-time fetch"* -
   that reading holds.
3. **The browser cannot fetch dliq either.** All eight of its own
   `hif-dliq.deepseek.com/query` attempts returned `status=0`. So the browser is
   not renewing dliq on the TTL; it holds one long-lived value and replays it.

### 46.2 What the harness sends, verified this round

    ds_hif.ENDPOINTS              : ("x-hif-leim", hif-leim), ("x-hif-dliq", hif-dliq)
    ds_hif.headers({})            : {"x-hif-leim": <73 chars>}      <- one header
    ds_hif.status({})             : leim "cached", dliq "absent"
    journal, entire 2553 entries  : x-hif-leim 598 uses, x-hif-dliq 0 uses
    ds_config.json, right now     : NO top-level "headers"; every account's
                                    "headers" key is EMPTY

So the position is: the browser sends a static dliq on every completion; the
harness sends none, and cannot mint one because the host is IPv6-only and this
machine has no IPv6 route.

### 46.3 Why this is a real divergence and still not a fixable defect here

It is a divergence - the request shape differs from a browser's on every
completion, always the same way. It is not fixable from this host by any code
change, because minting requires reaching an IPv6-only host.

There is one theoretical route: **capture a dliq value once and replay it
statically, the way the browser does.** The evidence supports that it would be
*shape*-correct - dliq really is static, and the browser itself replays one value
for at least 40 minutes. What the evidence does NOT support is that it would be
*correct*: the value is bound to a browser session and an account, and replaying
a foreign value from a different account's capture is exactly the "frozen capture
is a sharper signal than nothing" failure `ds_hif`'s own docstring warns about.

So this is recorded as a **known, characterised divergence**, not as a fix. It
would need a fresh dliq from a live session on the account in question, which
means an authenticated browser on that account - an operator action, not
something this investigation should do to the accounts.

### 46.4 Whether it can cause a mute: still unknown, and the prior claim was an assertion

`ds-mute-findings-summary.md` states *"a missing header cannot produce account
moderation."* That is an assertion, not a measurement, and this document has been
burned three times already by exactly that move. The accurate statement is:

    a missing header is a stable, always-same-direction difference from a real
    browser, on every completion. No measurement in this investigation shows it
    causing a verdict, and none shows it cannot.

The two facts that make it *less* likely to be the accumulating cause: it is
present from the very first request (so it cannot explain "mutes after hundreds
of turns rather than immediately"), and it is uniform across every account,
including ones never muted.

### 46.5 Round outcome

No new defect and no new fix. The round's value is that the record is now correct
on a point it previously got wrong in both directions: section 44 wrongly called
the question unanswerable, and the prior doc wrongly called the answer harmless.



## 47. FIX 18 — the wirelog wrote an 11.47 GB record, and rotation could not stop it

Found while auditing disk state after the bridge restart. `ds_wirelog.jsonl.1` was
**11,472,864,956 bytes (11.47 GB)**. `_FILE_MAX` is 32 MiB, so rotation should have
moved it 350 times over.

### 47.1 What the file actually is

It has **five newlines**. The first four lines are 3,681 bytes of ordinary records
(seq 43 request/response, seq 44 request/response — all t2, all 14:41:37-38). The
fifth line is a single JSON object of **11,472,861,274 bytes**.

That object is one `verdict` record. Inside it:

| quantity | value |
|----------|-------|
| `"kind": "verdict"` occurrences | 1,048,545 |
| `"preamble"` occurrences | 1,048,545 |
| `"seq"` occurrences | 12,582,372 |
| **distinct** `seq` values | **44** |
| distinct `ts` values | 15, spanning 3.4 minutes (14:38:11 - 14:41:38) |

So **44 real requests** produced **12.58 million nested copies** — an amplification
of **285,963x** — and 1,048,545 nested verdict objects, every one of them for `t2`
with the detail `user is muted`.

### 47.2 The mechanism, in the code

`ds_wirelog.verdict()` did this:

    with _LOCK:
        preamble = list(_RING)
        obj = {"ts": ..., "kind": "verdict", ..., "preamble": preamble}
        _RING.append(obj)          # <-- the verdict goes INTO the ring
        del _RING[:-_RING_MAX]
    _append(obj)

`preamble` is a copy of `_RING`. The verdict just built is then appended to `_RING`.
So verdict N's preamble contains verdict N-1 whole — including *its* preamble, which
contains N-2, and so on. The record for one verdict is larger than every earlier
verdict put together: the growth is **exponential in the number of verdicts**, not
linear in the number of requests.

Reproduced directly (this is the run that reached ~9 GB of RAM and had to be killed):

| verdicts | bytes on disk |
|---------:|--------------:|
| 1 | 765 |
| 2 | 2,299 |
| 3 | 5,366 |
| 5 | 23,771 |
| 8 | 195,544 |
| 12 | 3,140,253 |
| 16 | 50,255,598 |
| 20 | **402,050,952** |

Roughly 4x per verdict. The live file reached 1,048,545 verdicts because t2 was
muted and **every subsequent request in that process re-raised the mute**, each one
adding a verdict to the ring.

### 47.3 Why rotation never fired — the second defect

`_rotate_if_needed(p)` reads `os.path.getsize(p)` and rotates only if it is already
over `_FILE_MAX`. It is called from `_append`, i.e. **before** the new record is
written. That is correct for a stream of small records. It is defenceless against one
enormous record: the size is checked while the file is small, then a single
`f.write()` puts 11.47 GB on disk. The next `_append` would have rotated — but by
then the damage is done, and in this case the process was restarted first.

The write itself took **28 minutes to reach disk** (content timestamped 14:41, file
mtime 15:09:48), which is why the file looked like a 19-hour log and why an earlier
pass mis-estimated it at ~683 rows.

### 47.4 The fix

Three changes to `ds_wirelog.py`:

1. **`_strip_verdict(obj)`** — returns a copy of a verdict without its `preamble`.
   Applied both when building `preamble` (each ring entry is stripped on the way out)
   and when appending the new verdict to `_RING` (stripped on the way in). The ring
   therefore never holds an object that already contains a preamble, and nesting
   cannot start.
2. **`_RECORD_MAX = 1 MiB`** — a hard ceiling on one serialized record. A legitimate
   verdict carries at most `_RING_MAX` (80) request shapes at ~1.5 KB each, so ~120 KB;
   1 MiB is far above any real record. Anything larger is replaced by a small stub
   recording `truncated: true` and the original byte count.
3. The `_FILE_MAX` rotation is left as it was; it is correct for small records and the
   ceiling now guarantees records are small.

### 47.5 Verification

New suite `test_ds_wirelog_nesting.py`, **5 tests, all passing**:

* a written verdict record contains exactly one `"preamble"` (nothing nested)
* 300 verdicts stay under 20 MB and under 100x the size at 50
* `_RING` never holds a verdict carrying a `preamble`
* every record is within `_RECORD_MAX`
* an over-ceiling record is replaced by a stub, not written whole

Measured after the fix: 500 verdicts = **8,348,635 B**, last record a flat
**17,068 B**, one preamble per record. Linear.

### 47.6 This was not harmless, and it was not the operator's

Two consequences worth stating plainly:

* It consumed **11.47 GB of disk** and, during the write, **several GB of RAM** in the
  bridge process. The operator saw a ~9 GB python process and asked whether it was
  mine. It was — that was the *reproduction*, not the bridge — but the bridge had
  written the same shape 20 minutes earlier.
* It is the reason the journal looked unusable. Every verdict line was enormous, so
  the artefact built to answer "what did we send before the mute?" was itself
  unreadable exactly when a mute happened.

The 11.47 GB file has been deleted; a 240 KB head+tail sample is kept beside it as
`ds_wirelog.jsonl.1.headsample` for the record.

## 48. The j1 "second ban" is the first ban, still in force

The operator reported j1 banned again, and then that every account except d1 is muted.

**j1 has not sent a single request since 09-30 20:04:39.** That is `ds_last_turn.json`'s
entry for j1, and no journal on the machine contains a j1 request after it. A mute is
issued in response to traffic (or in an idle window attributable to the account); with
zero traffic for 36 hours there is no second issue to find.

j1's first and only mute runs **until 2026-10-03 12:04 UTC = 20:04 local**, i.e. it has
**52 hours left**. The operator is seeing the same penalty, still running. "LOL the
irony" and "the j1 account got banned" are both reports of that one event.

The pool picture at 2026-10-01 08:06 UTC:

| account | state | until (local) | remaining |
|---------|-------|---------------|-----------|
| hunt | clean | - | no mute on record |
| v | clean | - | no mute on record |
| f | clean | - | no mute on record |
| **j1** | **MUTED** | 2026-10-03 20:04 | 52.0 h |
| donttouch | clean (disabled) | - | - |
| **t1** | **MUTED** | 2026-10-03 16:40 | 48.6 h |
| **t2** | **MUTED** | 2026-10-03 20:53 | 52.8 h |
| **d1** | **clean** | - | - |

Three of eight carry a live 72 h penalty; two more were never observed muted in this
window; `donttouch` is deliberately disabled. **This is not "every account except d1
is muted"** — it is j1, t1 and t2, which are exactly the three accounts this
investigation has been driving hardest, and d1, which is the one serving the agent.

Worth stating as a real, unresolved tension rather than explained away: the three
muted accounts are the three with the most harness traffic in the window (t1 923 req,
t2 395, v 176, d1 262). That is consistent with mutes following use, and it is also
consistent with an account-level rule that simply has not fired for d1 yet. It does
not distinguish them.

### 48.1 What is still not known

After 48 sections: the mute is account-level, asynchronous, fixed-duration (72 h or
216 h), arrives as prose inside an HTTP 200, and **is not discernible from the request
that receives it** — section 41's muted completion request is byte-identical in shape
to one served five minutes earlier. What issues it remains unidentified. The defects
found and fixed along the way (retrying a mute as TRANSPORT, escalating 72 h to 216 h,
the stale-token lease window, and now an 11.47 GB journal record) are all real and
none is demonstrated to cause a mute.


## 49. FIX 18 is NOT in the running bridge, and the watchdog that covers the gap

### 49.1 The deployment gap

Python caches a module at import. The bridge processes started **15:41:30**;
`ds_wirelog.py` was written at **15:59:33**. The running bridge therefore holds the
PRE-FIX-18 `ds_wirelog` in memory and will keep the nesting behaviour until it is
restarted again.

Nothing has gone wrong yet: the journal since the restart has **620 rows, 310
requests, 0 verdicts**, and the longest single line is **1,862 B** — a healthy
record. The risk is latent and begins the moment that process raises a mute twice,
because the second verdict's preamble will carry the first one whole.

That is reachable in the near term: **t2 is muted until 10-03 20:53**, so any t2
request routed through this bridge re-raises the mute, and repeated raises are
exactly the nesting trigger.

### 49.2 The stopgap

`_wirelog_watchdog.py` polls the journal and truncates it on either of two signals:

| signal | threshold | why |
|--------|-----------|-----|
| last line length | 4 MiB | a healthy record measured 17,068 B; post-fix ceiling is 1 MiB. 4 MiB means `_strip_verdict` never ran. |
| whole file size | 256 MiB | `_FILE_MAX` is 32 MiB, so this means rotation is not keeping up. |

`_last_line_size` reads backwards in 1 MiB blocks rather than reading the file, so
it stays cheap against a multi-gigabyte journal.

Truncating is safe: nothing reads this journal for control flow. It is append-only
diagnostics written by `_append` and consumed by a human after the fact, and a
runaway record is unreadable anyway. A head+tail sample is preserved as
`<journal>.runaway` before the file is emptied.

### 49.3 Verification

Both directions tested:

* **clean journal** (5 normal records, 279 B) -> `once: clean`, file untouched
* **synthetic runaway** (8 MB final line) -> `TRUNCATED`, file reduced to 0 B,
  240,026 B sample kept, reason recorded in `_wirelog_watchdog.log`

Launched against the real state dir at 16:09:14, polling every 30 s.

### 49.4 What this is not

The watchdog does not prevent the single large `f.write()` — a runaway record can
still reach disk once before being caught. What it prevents is that record *staying*
there, and the disk filling while an old process runs. The actual fix is FIX 18 plus
a bridge restart; the watchdog only covers the window between them.

### 49.5 The restart is now the second one owed

The first restart (15:41:30) activated FIX 12/14/15/16. This one activates FIX 18.
Both are the operator's call, because the bridge is the route this agent runs
through.


## 50. THE HEADER HYPOTHESIS CLASS IS FALSIFIED — d1 shares 23 of 29 headers with two muted accounts

The operator's leading theory, stated more than once, is that a header is wrong:
"maybe some headers are not supposed to be added because of some special reason",
and "are you sure they detect LANGUAGE header differences?? thats just stupid".
Section 42 falsified one specific header lead. This section falsifies the class.

### 50.1 The comparison that decides it

Four accounts have journaled requests. Three are muted (t1, t2, j1); two are not
(d1, v). **d1 is the account this agent is running on right now** — it shares this
machine's IP, this process, and this code path with the muted accounts.

Across all four accounts, **29 distinct header names** appear. Comparing the
fingerprints of every header shared by d1 (clean) and t1/t2 (muted):

**23 of 29 are byte-identical**, including every header that carries client
identity:

    accept-language   sec-ch-ua          sec-ch-ua-mobile    sec-ch-ua-platform
    sec-fetch-dest    sec-fetch-mode     sec-fetch-site      sec-fetch-user
    upgrade-insecure-requests            user-agent          origin
    referer           priority           x-client-bundle-id  x-client-locale
    x-client-platform x-client-version   x-client-timezone-offset
    x-device-model    accept             cache-control       ect
    pragma

The **6 that differ** are all per-account or per-request **by design**:

| header | why it must differ |
|--------|--------------------|
| `authorization` | the account's own bearer token |
| `x-device-id` | deliberately distinct per account (4 accounts, 4 values) |
| `x-ds-pow-response` | fresh every request — 163/163, 443/443, 178/178, 88/88 unique |
| `x-file-size` | depends on the file uploaded |
| `x-hif-leim` | rotating anti-abuse token |
| `content-type` | depends on the endpoint, not the account |

There is **no stable client-identity header** that a muted account sends and a
clean one does not. `accept-language`, the specific header the operator was told
was "stupid" to suspect, is **identical across all four accounts**.

### 50.2 Why this closes the class

If a header caused mutes, then an account sharing the IP, the process, the code
path and 23 of 29 header values with two muted accounts would be muted too. d1 is
serving requests right now. The signal is therefore **not in the client's request
shape at all** — which is the same conclusion section 41 reached from the opposite
direction, where t1's muted completion request was shape-identical to one served
five minutes earlier.

Two independent measurements now agree, from two different comparisons.

### 50.3 The login hypothesis also fails on this data

The operator's second suspicion was login patterns. Measured login rate:

| account | state | logins | span | rate |
|---------|-------|-------:|-----:|-----:|
| d1 | clean | 2 | 0.48 h | **4.2/h** |
| t1 | MUTED | 8 | 4.92 h | 1.6/h |
| t2 | MUTED | 11 | 19.50 h | 0.6/h |
| v | clean | 0 | 1.22 h | 0.0/h |

**The account with the highest login rate is the one still working.** Login
frequency does not order the mutes.

### 50.4 What does survive, and it is confounded

Total `completion` requests in the observed window:

| account | completions | state |
|---------|------------:|-------|
| t1 | 439 | MUTED |
| t2 | 174 | MUTED |
| v | 84 | clean |
| d1 | 41 | clean |

Every account above ~170 completions is muted; every account below ~90 is not.
**But this is confounded by construction**: the soaks were *built* to drive t1 and
t2 to a mute, so "high completions" and "was the subject of the experiment" are the
same variable. Section 8.6's attribution caveat applies with full force.

It is recorded as the only surviving correlate, not as a cause. `v` at 84
completions was never driven past that, so the data does not distinguish "the
threshold is between 84 and 174" from "the soaks are the difference".

### 50.5 Honest position after fifty sections

Established:

* the mute is account-level, asynchronous, fixed-duration (72 h, or 216 h), and
  delivered as prose inside an HTTP 200
* it is **not discernible from the request that receives it** (41, 50.1)
* it is **not a client-shape or IP-level signal** (50.1)
* it is **not a login pattern** (50.3)
* it is **not** pause-before-mute (43), chat length, byte volume, system-prompt
  cadence, or aggregate pool activity (40 and earlier)

Not established: **what issues it.** Fifty sections of falsification have not
produced the trigger, and this document should not pretend otherwise.

Defects found and fixed along the way, none demonstrated to cause a mute:

| # | defect |
|---|--------|
| 3 | expired cookies replayed instead of re-authenticating |
| 12 | the exact `mute_until` was parsed and discarded |
| 14 | cross-process state clobber |
| 15 | `last_prompt` grew unbounded |
| 17 | **a mute was retried as TRANSPORT — five retries, ten requests, and it escalated jw1 from 72 h to 216 h** |
| 18 | **verdict preambles nested into a single 11.47 GB record** |

FIX 17 and FIX 18 are the two that made an existing mute materially worse. Neither
creates one.


## 51. 400 consecutive turns drew NO mute — and the pacing hypothesis comes back

This section started as an account census and turned into the most informative
measurement in the document. It also corrects a counting error I made in the
first pass (51.0).

### 51.0 Correction first: the soak logs do not contain mutes

A first pass counted "mute mentions" per soak log and reported 84, 240, 400, 177.
Those were **the field name `muted`**, which every soak row carries and which is
`null` in every clean row. Counting rows where a mute is actually *real* — an
`err` naming one, or a true flag — gives **0 for every soak**. The only file with
real mute records is `_cycle.jsonl` (the 2026-10-02 20:19 verdict from the first
session). Recorded because it is the fifth substring-over-log-text error in this
document, and the same fix applies: count structured fields, not words.

### 51.1 The census: 19 accounts on this machine, 2 with observed mutes

Every `ds_sessions.json` under the checkout and `%TEMP%` was parsed. **19 distinct
accounts** appear, including ones never in the pool: `deepseek.ee.1+4/+5/+7`,
`deepseek.ee.1/2/3`, `dsfreeapi1/2@yahoo.com`, `jaryl.ery.api@gmail.com`,
`eefamilyai@gmail.com`.

Consolidating every mute source (ledger, wirelog verdicts, soak logs):

| account | mute evidence |
|---------|---------------|
| t1 | wirelog, until 10-03 16:40 UTC |
| t2 | ledger + wirelog, until 10-03 20:53 UTC |
| **the other 17** | **none observed** |

This is **not** an IP-level penalty. Seventeen accounts on this machine, sharing
this IP, have no observed mute. The two that do are the two the soaks drove.

### 51.2 The result that matters: 400 consecutive turns, zero mutes

| soak | turns | span | turns/min | median gap | outcome |
|------|------:|-----:|----------:|-----------:|---------|
| `_fastsoak_t1` | **400** | 121.5 min | **3.29** | 10.9 s | **clean** |
| `_syssoak_t2` | **240** | 69.7 min | **3.44** | 10.7 s | **clean** |
| `_archive humansoak` (v) | 103 | 211.8 min | 0.49 | 5.4 s | clean |
| `_t2soak` | 169 | 607.4 min | 0.28 | 12.1 s | MUTED at turn 168 |
| `_humansoak` | 16 | 294.2 min | **0.05** | 369.8 s | MUTED at turn 15 |

**Four hundred turns back to back, at 3.3 turns/minute, drew no mute at all.**
That falsifies any "N requests in a row" theory outright — the fastest, densest
run in the whole investigation is one of the two that stayed clean.

Every prompt in these runs was innocuous: *"Reply with the single word: ok"*,
*"What is 2+2? Answer with just the number."*, *"Name one colour. One word."*,
*"What day comes after Monday? One word."* **t1 and t2 were muted while sending
those**, and `v` sent the *same* prompts for 103 turns without one. Content is
not the discriminator either.

### 51.3 The operator was pointing at something real

The operator said: *"when the AI keeps running, it usually doesnt get muted, until
theres a long pause"*. The two cleanest runs are the two with the highest sustained
rate; the two muted runs are the two with the lowest. On this table the hypothesis
has real support.

**But it is confounded with cumulative exposure, and I am not going to pretend
otherwise.** Two framings both fit:

**A — pacing.** Continuous activity is safe; idle time is when a moderation pass
lands. Clean runs: 3.29 and 3.44 turns/min. Muted runs: 0.05 and 0.28 turns/min.

**B — cumulative.** A threshold near 400 total requests, regardless of pacing.
t1 was muted after 400 (fastsoak) + 16 (humansoak) ≈ 416. t2 after 240 + 168 ≈ 408.
v stopped at 103 and d1 is at 41.

Neither separates cleanly. `v` at 0.49 turns/min was clean, between the muted
`_t2soak` (0.28) and the clean fast runs (3.3) — and `v` also stopped earliest of
the human-paced runs. **Every candidate discriminator here is also a measure of how
long the account was exposed**, so this table cannot distinguish A from B.

### 51.4 A falsifiable prediction, running now, costing nothing

**d1 is this agent's own account.** It is serving this session, and it is climbing:
**370 requests** in the live journal at the time of writing, with no mute.

* If **B** holds, d1 draws a mute near its 400th request.
* If d1 passes **~600 requests still clean**, B is falsified.

No new traffic is needed: this agent's own turns generate it. This is the first
genuinely falsifiable, zero-cost test this investigation has had, and it is the
thing to check on the next pass.

**A caveat on the test itself:** d1's traffic is shaped like neither soak. It is
many short bursts (one per agent turn) with long gaps between, which is closer to
the *muted* profile than the clean one. If d1 is muted, that supports A; if it
sails past 600, it weakens both.

### 51.5 What this changes

Sections 40–50 progressively closed every client-side lead: request shape (41),
headers (50), login pattern (50.3), content (51.2). This section closes the last
one — **volume in a burst** — and reopens the operator's original timing
observation with real support, while stating plainly that the pacing reading and
the cumulative reading are confounded in every table I have.


## 52. Correction to 51.3 — the gap "separation" is confounded, and t1's mute lands in a SHORT gap

Section 51.3 reported that the clean runs and the muted runs separate on gap size, and
flagged the confound. This section tests it at the event level and the separation does
not hold.

### 52.1 Run-level: it looks like a clean separation

| soak | turns | median gap | max gap | gaps > 45 min | outcome |
|------|------:|-----------:|--------:|--------------:|---------|
| `_fastsoak_t1` | 400 | 11 s | 24.3 min | 0 | clean |
| `_syssoak_t2` | 240 | 11 s | 24.3 min | 0 | clean |
| `_archive humansoak` (v) | 103 | 5 s | 35.1 min | 0 | clean |
| `_humansoak` (t1) | 16 | 370 s | **122.2 min** | 2 | MUTED |
| `_t2soak` (t2) | 169 | 12 s | **98.3 min** | 6 | MUTED |

Clean runs max out at 35.1 minutes; muted runs reach 98.3 and 122.2. A 63-minute
margin. It is tempting to call this the answer.

### 52.2 Event-level: it is not the answer

What matters is not the largest gap *anywhere in the run* but the gap that **contains
the issue instant**. Computing that:

| mute | issue (local) | gap before | gap after | enclosing gap |
|------|---------------|-----------:|----------:|--------------:|
| t1 (`_humansoak`) | 10-01 00:40:00 | 8.6 min | 0.9 min | **9.5 min** |
| t2 (`_t2soak`) | 10-01 04:53:00 | 22.8 min | 75.4 min | 98.2 min |
| j1 (provider) | 09-30 20:04:00 | no later events | — | — |

**t1's mute lands in a 9.5-minute gap** — comfortably inside the range the clean runs
also contained. Only t2 sits inside a genuinely long gap.

So of the two muted runs, one does not fit the story at all. The run-level statistic
was measuring the *shape of the soak*, not the state of the account at the moment the
mute was issued.

### 52.3 Why this was always going to be confounded

The fast soaks were **built** to run continuously; the human soaks were **built** with
deliberate gaps. "Has a long gap" and "is the human-paced soak" are the same variable.
Neither pacing nor run length was randomised, so no table built from these runs can
separate them. Section 51.3 said this; section 52 shows the data cannot rescue it.

This also agrees with section 43, which measured the gap before the mute across the
**seven** mutes of the first session and found 15.9, 14.9, 3.0, 0.7, 0.3 and 0.0
minutes — every one under 16 minutes. Today's t1 result (9.5 min) is the same shape.

### 52.4 Standing after 52 sections

The operator's pacing intuition has real support in the *aggregate* table and no
support at the *decisive* instant. Both readings are confounded with soak design.
Recording it as unresolved rather than picking the reading that flatters the
hypothesis.

What remains genuinely open and testable is the d1 prediction (51.4): d1 is this
agent's account, at **382 requests** as of 10-01 16:13, still clean. If the cumulative
threshold (~400) is real, it is about to fire. If d1 passes ~600 clean, that specific
number is dead. This needs no new traffic and no operator action.


## 53. Census correction: the per-account table was contaminated, but the mute catalogue is sound

### 53.1 What was wrong

A scan of all 89 session logs reported "mute evidence per account" with every account
at 874-906 hits. That is impossible and it is contamination: **this session's own log**
contains the compaction checkpoints, which *list every account name* while discussing
this investigation. One log contributed 874 of the hits, and it named all 25 accounts.

So the per-account counts are garbage and are retracted. What the scan *did* establish
correctly:

* the distinct `mute_until` values, which are specific enough that checkpoint prose
  repeats them verbatim only when quoting this investigation's own findings
* the **absence** of real verdicts for accounts that were never muted

### 53.2 The two "new" values are not verified

The scan surfaced `2026-10-03 18:43` and `2026-10-02 11:28` as values I had not
catalogued. Searching the 30 largest session logs **excluding this one** for a real
verdict line naming either returned **nothing**. `2026-10-02 11:28` was already
catalogued in section 33. `2026-10-03 18:43` therefore has **no verified source** and
is recorded as unconfirmed, not as a twelfth mute.

### 53.3 The confirmed catalogue

Ten confirmed values (section 33's nine, plus `2026-10-03 16:40` from the live t1
capture), all 72 h except one:

| until (UTC) | duration | issue instant (local) |
|-------------|---------:|----------------------|
| 2026-10-02 09:13 | 72 h | 09-29 17:13 |
| 2026-10-02 11:28 | 72 h | 09-29 19:28 |
| 2026-10-02 13:41 | 72 h | 09-29 21:41 |
| 2026-10-02 17:55 | 72 h | 09-30 01:55 |
| 2026-10-02 20:19 | 72 h | 09-30 04:19 |
| 2026-10-03 01:56 | 72 h | 09-30 09:56 |
| 2026-10-03 12:04 | 72 h | 09-30 20:04 |
| 2026-10-03 16:40 | 72 h | 10-01 00:40 |
| 2026-10-03 20:53 | 72 h | 10-01 04:53 |
| 2026-10-08 11:16 | **216 h** | 09-29 19:16 |

**Nine penalties were issued between 09-29 17:13 and 09-30 09:56 local** — a 16.7-hour
window — and they all expire 72 h later, which is why the operator sees bans "surface"
in clusters. The issue instants are the signal; the expiry dates are just that window
shifted three days.

### 53.4 The d1 test, latest

d1 is at **398 requests** and still clean. It has now **passed t2's 395** — a muted
account's request count — without a mute. If the cumulative threshold is real it is
imminent; if d1 passes ~600 the number is dead. Checking costs nothing because d1 is
this agent's own account.


## 54. d1 passed a muted account's request count and is still serving

Section 51.4 set a test that costs nothing: d1 is this agent's own account, so its
traffic accumulates without any new probe, and the cumulative-threshold hypothesis
(~400 requests) makes a specific prediction.

**Result at 10-01 16:16 local:**

| account | requests | state |
|---------|---------:|-------|
| **d1** | **422** | **clean, serving right now** |
| t2 | 395 | MUTED (until 10-03 20:53) |
| t1 | 923 | MUTED (until 10-03 16:40) |
| v | 176 | clean |

**d1 has passed the request count at which t2 was muted and has not been muted.**
The specific number "~400 cumulative" does not hold.

### 54.1 What this does and does not kill

It kills the *threshold* reading of hypothesis B — there is no fixed count near 400
that draws a penalty. It does **not** kill the general idea that exposure accumulates,
because d1's traffic is shaped differently from any soak: many short bursts, one per
agent turn, with long gaps between. If the rule is "N requests *within a session*" or
"N requests without a long gap", d1's 422 are spread across a very different profile
and the number would not transfer.

It also does not rescue hypothesis A (pacing) on its own: d1 is at 422 clean with the
*gappiest* traffic of any account measured, which is the opposite of what A predicts.
If long gaps were dangerous, d1 — which has them constantly — should have been muted
first.

So the honest reading: **d1 falsifies the fixed-count reading and leans against the
simple pacing reading at the same time.** Neither surviving hypothesis explains why
t1, t2 and j1 were muted and d1 was not.

### 54.2 What is left

After 54 sections, the discriminator is still not identified, and every client-side
and volume-side lead is now closed:

| lead | status | section |
|------|--------|---------|
| request shape | shape-identical to a served request | 41 |
| headers (all 29) | 23/29 byte-identical with muted accounts | 50 |
| login pattern | highest login rate is the clean account | 50.3 |
| content | muted on "Reply with the single word: ok" | 51.2 |
| burst volume | 400 consecutive turns drew nothing | 51.2 |
| pacing / long gaps | confounded with soak design; t1's mute in a 9.5-min gap | 52 |
| cumulative count | d1 at 422, past t2's mute point, clean | 54 |
| IP-level penalty | 17 accounts on this IP unmuted | 51.1 |

The remaining unexplained fact is narrow and specific: **nine penalties were issued
between 09-29 17:13 and 09-30 09:56 local**, a 16.7-hour window, and nothing client-side
distinguishes the accounts that received them from d1, which did not.

### 54.3 Standing recommendation

Do not treat any of the six fixes as a cure. FIX 3, 12, 14, 15, 17 and 18 are real
defects, correctly fixed, and **FIX 17 and FIX 18 each made an existing mute materially
worse** — 72 h escalating to 216 h, and an 11.47 GB journal record. Neither creates a
mute. The operator should expect mutes to continue until the issuing rule is
identified, and the strongest remaining instrument is the wire journal now that FIX 18
has made it readable.
