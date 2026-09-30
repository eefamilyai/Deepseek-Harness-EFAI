# DeepSeek account mutes — findings summary

A condensed read of `ds-direct-mute-investigation.md` (79 KB of append-only notes).
Everything here is measured on this machine unless marked otherwise.

---

## The one-line answer

**Nine real defects were found and fixed. The accumulating cause behind the mute
was NOT identified, and the evidence available on the client side may not contain
it.** Three of the operator's theories were tested and refuted; two of those
refutations came from probes of mine that first appeared to CONFIRM them.

---

## What is established

### The mute is account-level, asynchronous, and fixed-duration

| Property | Value | How |
|---|---|---|
| Duration | **72 h** and **216 h** (9 days) | Both fit their observation exactly; alternatives fit nothing |
| Delivery lag | 15 min and 95 min after issue | `observed − issued` for two recoverable verdicts |
| Issue instant | `mute_until − duration` | Exact, because the duration is exact |
| Scope | Account, not device or session | A fresh chat is muted too; the next login is unaffected |

The 216 h variant was previously unknown. **Any start derived as
`mute_until − 72 h` is wrong by 144 h for such a mute.**

### Mutes are more numerous than the banners showed

Three mutes were recovered from `turn/end` error messages that never appeared in
the operator's banners — accounts `parserfix`, `jw1`, and `7`. That matters
because "accounts getting muted faster than ever" may partly be *more mutes
visible*, not more mutes happening.

### Retries DISCOVER a mute; they do not cause it

The strongest causal result here, and it is arithmetic rather than correlation:

```
verdict ISSUED      11:16:00Z
retry burst         11:30:34Z .. 11:31:05Z   <-- 14 minutes LATER
verdict OBSERVED    11:31:19Z
```

The verdict existed 14 minutes before the first retry of the burst that preceded
its observation. A cause cannot follow its effect.

The mechanism: a mute arrives as a bare JSON envelope with no `event:` framing, so
older code read it as an **empty response** and retried it 5–10 times under the
harness's own policy — each retry a fresh request to an account DeepSeek had
already refused. Mutes caused retries, not the reverse.

### The rate limit is a deterministic 10-turn cycle

Running turns tightly instead of at human pace exposed this:

```
turn 49: 181.6s   turn 59: 181.8s   turn 69: 181.8s
turn 79: 181.7s   turn 89: 181.5s   turn 99: 181.8s
```

Every ten turns to within 0.3 s, each `DS_RATE_WAIT` (180 s) plus overhead. Not a
random load event — a quota. **Six clean, orderly rate-limit recoveries in ~100
turns, every request journaled, and no mute followed.** If orderly rate-limit
recovery were the trigger, this run would have produced six mutes.

---

## Theories tested and refuted

| Theory | Verdict | Evidence |
|---|---|---|
| **Storm** — a rate-limit storm precedes the mute | Refuted 3 ways | Attempt counters never exceed 4; no storm precedes any mute start; the one recoverable issue instant is *before* its burst |
| **Device reuse / double login** | Not supported | The apparent overlap was a **forked log** — 60 identical timestamps, 0 unique to either session |
| **Headers** ("some header not supposed to be added") | Not supported | Journal shows route-appropriate header sets; 23 of 26 headers have one fingerprint; `authorization` stable across all 80 requests |
| **Cookie expiry** | Possible, no evidence | The defect is real (see below) but no request was ever sent with an expired cookie |

### Two probes of mine first appeared to CONFIRM the theory they were testing

Both are recorded because they are the most instructive part of this work.

1. `_storm.py` used a regex with a bare `429`, which matches inside every
   epoch-millisecond timestamp. It "found" 2244 storm lines whose samples are
   `step/start` and `compaction/summary` events. Its headline "84 min before the
   mute" was an artifact of three digits.

2. `_concurrent.py` reported account `+5` active in two sessions across nine
   overlapping windows — exactly the predicted shape. The two spans matched to the
   minute; comparing timestamps showed they held **the same events**. A fork, not
   two drivers.

**A probe that reports a satisfying answer is not therefore reporting a true one.**
Printing and reading the matched substring is the step that exposed both.

---

## Defects found and fixed

Each independently tested. **16 suites, all green.**

| # | Defect | Severity |
|---|---|---|
| 1 | Expired cookies **resurrected alive** by the lossy round-trip | Credential |
| 2 | Stale `ds_session_id` replayed on the first request after a long pause | Request shape |
| 3 | Resume clock was in-memory — a restart blinded the check | Logic |
| 4 | Last-turn mutation ran outside the lock guarding its own write | Race |
| 5 | `_MUTE_CODE` held only `"5"` while its docstring documented `14` | Missed verdict |
| 6 | A mute on the `event: hint` path looked like a **successful turn** | Missed verdict |
| 7 | A persisted cancel armed `preempt:true` after an overnight pause | Request shape |
| 8 | Account-exclusion flag | Operator control |
| 9 | **Per-request wire journal** with verdict preambles | Instrumentation |

### The wire journal is the deliverable worth keeping

It records every request with header **fingerprints** (never token values) and,
when a verdict lands, its **own preamble** — the exact request shapes that preceded
it. No previous mute has that artifact. It is off by default
(`KILN_DS_WIRELOG=1` or a `ds_wirelog.on` marker).

Read back over 80 real requests: header sets are route-appropriate, `authorization`
is stable across all 80 (no mid-run re-login), and **no request was ever sent with
an expired cookie**.

---

## What is NOT established

**The accumulating cause.** No request, header, cookie state, retry pattern, or
storm correlates with the issue instant. The decision is made server-side and
delivered late; the trigger is not visible in the client-side evidence on this
machine.

**The cookie-expiry theory is a reasoned precaution, not an evidenced cause.**
`_cookiejar.py` proves the defect is mechanically possible with no browser
involved — that is worth fixing on its own. But no log shows a stale cookie
actually being sent at a moment that drew a verdict.

**A client-side journal cannot answer the decisive question**: whether the request
shape is what the *website* sends. This compares the harness to itself. A header
that is uniformly wrong — present on every request and never sent by a browser —
would look perfectly stable. That is why the `x-hif-dliq` omission is recorded as
an environmental limitation, not a verdict.

---

## What would settle it

The server's own decision. The wire journal is the right instrument: **if a mute
occurs while it is recording, the journal will contain the verdict together with
the exact preamble of requests that preceded it** — an artifact that does not
exist for any previous mute.

The soak is currently at turn 103, walking away for 103 minutes, which exercises
the resume fix live for the first time.

---

## Environment notes

- `x-hif-dliq` cannot be minted here: `hif-dliq.deepseek.com` has no IPv4 A record
  and this host is IPv4-only. It is **omitted, not replayed stale** — the better of
  the two failure modes, and a missing header cannot produce account moderation.
- `aws-waf-token` is persistent (~3-day expiry) in the browser jar; `ds_session_id`
  is 32 chars and distinct across all five accounts.
- The provider_bridge caches its modules, so a fix lands only when that process
  restarts. It serves this session's own turns, so the restart is the operator's call.
