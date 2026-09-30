# ds-direct mute-rate investigation

Job: why the harness's requests to chat.deepseek.com earn account mutes faster
than a real browser does. Evidence gathered 2026-09-29 with a real desktop
Chrome (channel="chrome", Chrome 153, non-headless) as the reference.

## 1. ROOT CAUSE - the eager re-login on an unrecognised biz_code (my regression)

Commit 7d6888732c added `client.login()` to the catch-all `biz_code` path in
both `_stream_with` and `_run_vision_turn`. Every unrecognised refusal therefore
posted another `/users/login` for an account DeepSeek was already declining.
`ds_identity`'s own docstring names that exact pattern as the flag trigger:
"several logins for one identity inside a second is what earns too many
requests". A re-login against an already-throttled account is how a soft
throttle escalates into an account-level mute. This is a BEHAVIOUR cause and it
matches the reported onset ("right after your fix").

FIX: removed the `client.login()` from both catch-all sites. The verdict is
received and the turn fails; no resend, no re-auth. Pinned by
`test_ds_direct_biz_verdict.py` (main + vision: logins == 0).

## 2. HEADER - the ungranted high-entropy client hints

Measured with real desktop Chrome against chat.deepseek.com:
  - Chrome sent ONLY the triple (sec-ch-ua, -mobile, -platform) on 22/22 requests.
  - The site advertises NO Accept-CH: 0 responses, no <meta http-equiv>, no
    Critical-CH.
Chrome emits the six high-entropy hints (arch, bitness, full-version,
full-version-list, model, platform-version) ONLY to an origin that granted them.
`ds_direct` sent all nine on three call sites, asserting a browser state this
origin cannot produce.

FIX: all three chat call sites now send `ds_identity.client_hints()` (the
triple). `ds_waf` already did this correctly. The derivation in
`client_hint_extras()` is kept - it is sound for an origin that DOES grant the
set - but nothing on the chat path sends it.

NOTE: the old ds_identity comment claimed a capture showed all nine on 47/47
requests with "the grant simply held". Measurement falsifies that; comment
corrected.

## 3. HYGIENE - accept-language was absent

Real Chrome carried `accept-language` on every request; the harness carried
none (curl_cffi's impersonation reproduces TLS and header ORDER, not this).
Added `ds_identity.browser_headers()` with the Chrome value `en-US,en;q=0.9`.

Explicitly NOT claimed as a mute cause: a single missing header does not produce
account-level moderation. Kept because a browser always sends it.

## 4. REFUTED - do not re-investigate

  - Shared x-device-id: all three pooled accounts carry distinct browser-minted
    UUIDs; none is on the machine-wide derived fallback.
  - Stale x-client-version: real Chrome sends 2.5.0, identical to the harness.
    Same for x-client-platform/-locale/-bundle-id and the timezone offset.
  - chrome150 is NOT a silent fallback: curl_cffi 0.16.2 ships it as
    DEFAULT_CHROME, so the TLS fingerprint and the Chrome/150 UA agree.
  - Machine-wide WAF canvas/GPU (seed-derived, not account-keyed): a real
    machine shows one canvas across its own profiles, so this is not by itself
    a farm tell. Noted, not changed.

## 5. STILL OPEN

The WAF challenge path (`x-amzn-waf-action: challenge` was observed on the
document load). Whether one `aws-waf-token` is replayed across accounts, or held
for too long, is untested - it is the most plausible remaining account-level
correlation signal and the next thing to measure if mutes persist.

## ADDENDUM - the cumulative reframe (hundreds of turns, not a static header)

Operator correction: the mute arrives after HUNDREDS of back-and-forth turns, and
that is already more than usual. That falsifies the static-header framing - a
header mismatch would mute on turn 1 - and points at something that accumulates.

Measured with a dedicated soak against deepseek.ee.1+mutetest@gmail.com
(`_soak.py`, telemetry in `_soak.jsonl`):

  * per-turn request footprint is LEAN and does NOT grow:
    create_pow_challenge -> /query -> /completion, exactly 3 requests;
  * prompt length is FLAT at 29 bytes - the harness threads via
    parent_message_id and sends only the new message;
  * one chat session throughout; no re-priming, no fresh chats;
  * sustained rate ~16 turns/min (~960/hour).

`_prompt_for` verified separately: threaded (parent captured) the prompt stays
flat at ~1,324 bytes from 1 to 500 conversation turns; only when parent was NOT
captured does it fall back to dumping the transcript (up to 47 KB). The
`sent` counter is written only on a yielding turn, and every non-yielding path
raises first, so it cannot stall into a permanent full-transcript resend.

So nothing in the wire shape is wrong PER TURN. The anomaly is the QUANTITY:
~960 turns/hour is not a thing a browser does, and account-level moderation
reads sustained volume. Combined with the eager re-login regression this
session removed (each unrecognised biz_code posted another /users/login), the
likeliest explanation for "mutes faster than ever" is the login storm
amplifying the volume signal, not a bad header.

## UNRESOLVED

  * `hif-dliq.deepseek.com` has NO IPv4 A record on this network (AAAA only), so
    curl_cffi cannot resolve it; `hif-leim.deepseek.com` resolves and mints
    normally. The completion call carries `x-hif-leim` but not `x-hif-dliq`.
    Whether a real browser sends BOTH on /chat/completion is unconfirmed - the
    Chrome probe could not reach an authenticated completion.
  * The soak calls `open_completion` directly, so it exercises the wire path but
    not `stream()` -> `_prompt_for` -> compaction/tool-result machinery. If
    production builds a growing prompt, this soak would not see it.

## OUTCOME - 700 turns, no mute reproduced

Two soaks against deepseek.ee.1+mutetest@gmail.com, telemetry captured per turn
(request paths, prompt bytes, cumulative bytes, session id, all four verdict
readers):

  * COUNT soak  - 400 turns, 3 requests each, 29 B/turn. Zero verdicts.
  * VOLUME soak - 300 turns at ~8.8 KB/turn (realistic tool-output payload),
                  2,598,000 bytes cumulative. Zero verdicts.

Total 700 consecutive turns / 2.6 MB and the account never muted. Both soaks
held one chat session throughout, sent exactly create_pow_challenge -> /query ->
/completion per turn, and showed no drift in request count, prompt size, or
session identity.

What this does and does not show:

  * It does NOT prove the mute is fixed. A mute that needs more than 2.6 MB, or
    wall-clock days, or a trigger not exercised here (vision turns, file
    uploads, account switching, the parallel-agent pool) would not appear.
  * It DOES show that nothing in the ordinary single-account turn loop
    accumulates into a mute on the timescale tested - no header drift, no
    prompt growth, no session churn, no request amplification.

The three defects this session did find and fix stand on their own evidence:
the eager re-login regression (behaviour), the ungranted high-entropy hints
(header), and the missing accept-language (hygiene). The re-login regression is
still the best explanation for "mutes faster than ever", because it multiplied
/users/login traffic on exactly the turns DeepSeek was already refusing.

## NEXT - the untested axes

  1. Vision turns and file uploads (different endpoints, x-hif scoping).
  2. The parallel-agent pool: several accounts driven concurrently from ONE IP
     is the correlation an account-level mute would key on, and no soak here
     exercised it.
  3. Wall-clock spread: these soaks ran in ~20 min. A real day of use at a
     human pace is a different distribution even at the same total volume.

## CONCURRENCY - the pool-from-one-IP axis, partially tested

A third soak drove THREE concurrent clients on the SAME account (`_stress.py`),
3 workers x 80 turns at ~36 KB/turn:

  * 240 turns, 8,800,533 bytes (8.4 MB), 236 HTTP 200.
  * ZERO mutes. No biz_code, no auth verdict, no ref-file verdict.

That also exercises the "several logins for one identity inside a second"
pattern ds_identity warns about: all three workers logged in as the same
account at start. It did not mute.

One transient was observed and NOT reproduced: two of the three workers died
at their last turns (79-80) with `TypeError: 'NoneType' object is not
subscriptable`. Two clean re-runs of the identical config produced zero
tracebacks, so it is a timing-dependent race, not a deterministic defect. It is
recorded here rather than fixed, because a fix for a crash that cannot be
reproduced cannot be verified. Worth a look if it recurs: the completion path,
under concurrent clients on one account.

## TOTAL EVIDENCE

Across four runs the account absorbed roughly 1000 turns and >11 MB with no
mute: 400 turns/29 B, 300 turns/8.8 KB (2.6 MB), 240 turns/36 KB concurrent
(8.4 MB), plus validation and re-runs. The account never muted.

Combined with the eager re-login regression this session removed - which
multiplied /users/login traffic on exactly the turns DeepSeek was already
refusing - the working conclusion is that the login storm was the real
amplifier, and nothing else in the tested request path accumulates.

## SURFACE 4 - the UPLOAD path had the same nested-verdict defect

Found live while exercising the one axis the soaks never touched: an upload on
the vision surface returned biz_code 7 "rate limit reached" nested at
`data.biz_code`, which `upload_file` flattened into "upload returned no file id".

The function read only the TOP-LEVEL `code`, then jumped straight to `biz_data`.
A nested refusal fell past every check, so a rate limit, a full attachment list,
and a mute all produced that one identical string. Same dead end the completion
path already fixed, on a third surface - and it hid a real server-side throttle
appearing on the endpoint.

Fixed in 7f71823f5f: the upload path reads the nested verdict through the same
readers and raises the same types (_Muted, _ContextFull, plain RuntimeError with
no retry), and `upload_files` re-raises an account-level verdict instead of
swallowing it into a per-file error string. `biz_code 7` gets no tailored remedy
- per the standing rule it is received and fails, and one sample establishes
nothing beyond "slow down".

## STATUS OF THE OBJECTIVE

The objective was to drive the account to a mute, diagnose the accumulation, and
fix it. It did not mute: ~1000 turns and >11 MB across four runs, four separate
shapes of load. The accumulating cause therefore remains UNCONFIRMED and the
mute cannot be claimed fixed.

What is established: the login storm is the only accumulation the evidence
supports, and it is gone; nothing else on the request path drifts over 1000
turns; and verdict handling is now consistent across chat, vision, and upload.

## THE MUTE IS A FIXED-DURATION PENALTY - 72 h, with a 216 h variant

Measured from the verdicts themselves. A mute reports only an expiry, but the
remaining time at the moment it is observed recovers the duration, because a
freshly-started mute shows nearly the whole window:

  observed 2026-09-29 09:27 UTC, expires 2026-10-02 09:13 -> 71.76 h left = 3 d
  observed 2026-09-29 11:30 UTC, expires 2026-10-08 11:16 -> 215.76 h left = 9 d
  observed 2026-09-29 13:57 UTC, expires 2026-10-02 13:41 -> 71.73 h left = 3 d
  observed 2026-09-30 06:46 UTC, expires 2026-10-02 17:55 -> 59.15 h left = 3 d

71.76 h against a 72 h window means the account was muted ~14 minutes before the
verdict was seen. So `expiry - 72 h` is the START, and every observed mute
back-computes to 2026-09-29:

  09:13, 11:16, 13:41, 17:55, 20:19 UTC - all on one day.

This is the first hard measurement of WHEN mutes begin rather than only that they
happen, and it is what makes the correlation below possible at all.

## THE 2026-09-29 CLUSTER vs THE COMMITS

Commit times that day (author date, converted to UTC):

  09:48  7d6888732c  the eager re-login added to the catch-all biz_code path
  14:14  8b8e59fd7c  the eager re-login REMOVED (this session's first fix)
  15:47  7f71823f5f  the upload path's nested verdict read

Against the mute starts: 09:13 and 11:16 straddle the eager-re-login commit, and
13:41 / 17:55 / 20:19 follow it. So the eager re-login is NOT a complete
explanation - a mute began 35 minutes BEFORE that commit existed. It remains the
best candidate for AMPLIFYING a mute (a login burst against an account already
being declined), but something else was already getting these accounts muted that
day.

What that day actually contained: ~1000 turns of soak traffic at ~960 turns/hour
across the pool, four load shapes, plus the concurrent 3-worker run. No human
browser produces 16 turns/minute sustained, and account-level moderation reads
sustained volume. Volume is the one factor present before, during and after every
commit on that day - which is why the pace axis, not the header axis, is what
remains untested.

## THE RE-LOGIN REPLAYED A DEAD SESSION COOKIE (operator lead A - CONFIRMED)

The operator's first suspicion was right, and it was mechanical. `_login_attempt`
posted /users/login while the session jar still held the `ds_session_id` of the
session DeepSeek had just rejected. A browser cannot be in that state: the site
answers an expired session by sending the page to the sign-in route, and the
sign-in page carries no dead session id - so the only client presenting one at
the login call is a client that never saw the redirect. It is the same
stale-cookie problem the WAF branch already cleared the whole jar for, with a
comment saying so, in a branch the ordinary re-login path never reaches.

There is no sign-out anywhere in the runtime (a grep for logout/sign_out across
every .py in the tree: no matches), so every re-login is by construction a login
without a sign-out - the operator's second suspicion is not a risk, it is the
only possible behaviour.

FIX: `_drop_dead_session_cookie` removes `ds_session_id` before the login body is
built, and KEEPS `aws-waf-token` - the clearance is what lets the login reach
DeepSeek at all, and replacing it costs a solved challenge. Pinned by
`test_ds_direct_relogin_cookie.py`, which asserts on the jar AT THE MOMENT OF THE
POST rather than before or after; the end state alone cannot distinguish a
correct fix from one that drops the cookie too late.

## THE MUTE CODE IS NOT STABLE (biz_code 14)

Observed live on the upload route:

  {"code":0,"msg":"","data":{"biz_code":14,"biz_msg":"user is muted",
   "biz_data":{"is_muted":1,"mute_until":1790972380.757}}}

`biz_code` 14, not the 5 every earlier sample carried. The reader recognised a
mute by code OR wording, so the wording caught it - but the structured fields
`is_muted` and `mute_until` are the verdict stating itself, and they work for any
code. `_mute_verdict` now recognises three independent tells (code, wording,
`biz_data`), and `test_ds_direct_mute_shapes.py` pins both observed codes plus
the structural-only case, while keeping the reader strict against model prose and
success bodies.

## ACCOUNT STATE AT 2026-09-30 07:04 UTC

  hunt      MUTED   until 2026-10-02 20:19 UTC
  f         MUTED   until 2026-10-02 17:55 UTC
  v         OK
  j1        OK

Also confirmed live: a re-login on a muted account SUCCEEDS and changes nothing,
exactly as `_Muted`'s docstring predicts. The mute is not the credential, which
is why re-authenticating at it is pure added risk.

## REFUTED SINCE THE FIRST WRITE-UP

  * A SHARED aws-waf-token across accounts: all four accounts carry distinct WAF
    tokens AND distinct ds_session_ids (sha256-compared). The shared `5d4cd3`
    prefix that prompted the check is token framing, not shared material.
  * A SHARED device identity: all four accounts carry distinct `device_id`,
    `x_device_id` and `did`, none on the machine-wide fallback.
  * The eager re-login as the SOLE cause: falsified by the 09:13 and 11:16 mute
    starts, which precede the commit that introduced it.

## SURFACE 5 - THE HARNESS RESURRECTS EXPIRED COOKIES (operator lead A, deepest form)

CONFIRMED empirically by `_cookiejar.py` (Part B, deterministic, no network):

    step 1: install ds_session_id with expires = (now - 3600)   -> jar: domain='chat.deepseek.com' expires=1790748939
    step 2: get_dict()                                          -> {'ds_session_id': 32, ...}
    step 3: cookie_string() serializes                         -> "ds_session_id=ZZZ..." (carries expiry? False)
    step 4: apply_account() re-installs via set(name, value)    -> jar: domain='' expires=None
    >>> EXPIRED COOKIE RESURRECTED ALIVE: True

The mechanism, three cooperating defects in ds_direct.py:

  1. `cookie_string()` (line 1208) emits ONLY `name=value`:
         return "; ".join(f"{k}={v}" for k, v in self.sess.cookies.get_dict().items())
     `get_dict()` has no domain/expiry to give it, so the expiry is destroyed at the
     moment of persistence.
  2. `apply_account()` (line 1201) re-installs with a bare `set(k, v)`:
         self.sess.cookies.set(k.strip(), v)
     No domain, no path, no expires. curl_cffi yields domain='' expires=None -- a
     SESSION cookie that never expires.
  3. `ds_config.json` stores the result as a flat 416-char string
     ("aws-waf-token=...; ds_session_id=..."), a format that CANNOT carry an expiry,
     so nothing downstream can recover it either.

Net effect: every cookie this harness holds is immortal. A cookie that DeepSeek has
already lapsed server-side is still presented on every single request, forever. That
is precisely the state the operator described and a browser can never be in: the site
answers an expired session by redirecting the page to the sign-in route, and the
sign-in page never carries the dead session id -- so the only client that presents one
on the next call is a client that never saw the redirect.

## THE BROWSER'S REAL JAR, READ FROM THE CAPTURED CHROME PROFILES

`_chromecookies.py` read `expires_utc` / `is_persistent` / `has_expires` from each
profile's `Default/Network/Cookies` (metadata only; the `value`/`encrypted_value`
columns are never selected). All four profiles agree:

  | cookie                  | host               | persistent | has_expires | expires_utc      |
  |-------------------------|--------------------|------------|-------------|------------------|
  | aws-waf-token           | .deepseek.com      | 1          | 1           | ~2026-10-03/04   |
  | smidV2                  | chat.deepseek.com  | 1          | 1           | 2027-11-03/04    |
  | .thumbcache_6b2e5483... | chat.deepseek.com  | 1          | 1           | 2027-11-03/04    |
  | ds_session_id           | (ABSENT)           | -          | -           | -                |

Three consequences, all divergences from the real client:

  * `aws-waf-token` is PERSISTENT in the browser with a ~3-day expiry and host
    `.deepseek.com`. The harness holds it as a session cookie with domain='' and no
    expiry, so it outlives the value the server issued -- a stale WAF clearance is
    exactly what the WAF branch at ~1408 already documents as making "/users/login
    still refuse it".
  * `smidV2` is the Shumei device cookie -- the same Shumei vendor ds_identity names
    when it mints the "browser-minted Shumei fingerprint" for `device_id`. The real
    browser carries it as a first-party cookie on chat.deepseek.com. The harness
    sends the header-side fingerprint but NONE of the cookie-side one.
  * `ds_session_id` is not in the browser jar at all, yet ds_config.json holds one for
    every account and `_headers` replays it on every request.

## WHAT THIS DOES *NOT* YET PROVE

The mute is an account-level moderation verdict, and a stale cookie is a session-state
defect; the link between them is the operator's hypothesis (lead A), now confirmed as a
real divergence, not yet proven as the mute trigger. It is however the strongest
remaining candidate, because it is the one state a browser is structurally prevented
from entering and the harness enters by construction.

FIX (implemented this round): preserve domain/path/expiry through the round-trip, so a
cookie dies on schedule the way a browser's does.

## SURFACE 6 - THE MUTE ARRIVES AFTER THE STORM, NOT DURING IT (operator leads B and C)

Two operator observations, both measured and both confirmed.

LEAD B - "it usually does not get muted until there is a long pause".
LEAD C - "the rate limit is normal, but it is the pause during those turns, then
the AI comes back and shortly after it gets banned".

What the turn-duration probe (`_turndur.py`) shows. Pairing every `turn/start`
with its `turn/end` makes a retry storm visible as ONE very long turn, because the
retries themselves print to stderr and never become turn events:

    median turn   0.9 min
    p90          21.0 min
    max         101.4 min

The long turns are the storms. `RATE_MAX_TRIES = 20` at `DS_RATE_WAIT = 180 s`
means a rate-limited turn resends 20 times over ~60 minutes on the SAME account,
session and prompt.

What the mutes show. Every mute back-computed from its reported expiry (expiry
minus 72 h) against the last turn that ended before it:

    account    mute start (UTC)   last turn ended   gap
    v          09-27 13:41        09-27 13:22       18.3 min
    j1         09-29 13:41        09-29 13:34        7.0 min
    f          09-29 17:55        09-29 16:33       82.1 min
    mutetest   09-29 17:56        09-29 16:33       83.1 min
    hunt       09-29 20:19        09-29 16:33      226.1 min

Every mute lands AFTER the last request, never during one. Moderation is
ASYNCHRONOUS: the offence precedes the verdict by minutes to hours. That is why an
earlier scan for events within plus/minus 30 min of the mute instant found ZERO --
it was looking at the verdict time, not the offence time. The correct window is the
STORM, and the storm's retries are invisible to event counting.

THE CORRELATION THE OPERATOR SPOTTED, CONFIRMED. `f` (expiry 2026-10-02 17:55 UTC)
and `mutetest` (expiry 2026-10-03 01:56 local = 17:56 UTC) back-compute to starts
60 SECONDS APART, and they are two DIFFERENT accounts. A per-account volume theory
cannot explain two accounts muted in the same minute; a shared INSTANT of the same
behaviour can. Both had their last turn end at exactly 16:32:55 UTC, and both mutes
follow ~83 min later.

THE MECHANISM THAT FITS ALL THREE LEADS. Operator lead A (expired cookies still
presented) and lead C (the AI comes back after a pause) are the same event:

  1. a pause long enough for the session to lapse server-side;
  2. the next request presents the credential the server has lapsed -- because
     `cookie_string()` wrote only `name=value` and `apply_account()` re-installed it
     as a SESSION cookie, so nothing in the harness could ever expire (SURFACE 5);
  3. the server refuses it, and the refusal is a `biz_code` the harness does not
     recognise;
  4. the retry path resends -- up to 20 times at 3-minute intervals -- carrying the
     same lapsed credential, for an hour.

A browser cannot enter step 2 at all: the site answers a lapsed session by sending
the page to the sign-in route, so the dead cookie is never presented, and there is
no storm to escalate.

## THE COOKIE FIX IS COMPLETE AND VERIFIED

`test_ds_direct_cookie_expiry.py`, 33 checks, ALL GREEN. Four pieces:

  * `_parse_cookie_field` reads both the legacy flat form and the attributed form,
    and only treats a token as an attribute when it FOLLOWS a cookie and its name
    is a known attribute -- so a cookie genuinely named `expires` stays a cookie.
  * `_cookie_expired` decides by the cookie's own expiry; a session cookie never
    expires.
  * `_cookie_header` emits Domain/Path/Expires so the round-trip is lossless.
  * `apply_account` and the login token handoff install through `_install_cookie`
    and SKIP anything already lapsed.

All 11 kiln suites pass. The 60-second `f`/`mutetest` correlation is the strongest
single piece of evidence in this investigation.

## RETRACTION - the "scheduled review at 13:41" hypothesis was MY ROUNDING ARTIFACT

I reported that two mute starts fell at exactly 13:41:00 UTC and inferred a possible
scheduled moderation job. That was wrong, and the error was mine.

The five expiry strings I tested were typed BY HAND from earlier notes, rounded to
whole minutes. Testing my own rounded transcription naturally produced `:00` seconds
and a spurious repeat. The RAW `mute_until` values in the session log are:

    raw=1790932407.459  expiry 2026-10-02 09:13:27.459 UTC  start 2026-09-29 09:13:27.459
    raw=1790963715.231  expiry 2026-10-02 17:55:15.231 UTC  start 2026-09-29 17:55:15.231
    raw=1790972380.757  expiry 2026-10-02 20:19:40.757 UTC  start 2026-09-29 20:19:40.757

Distinct times AND distinct fractional seconds. A scheduled job would show the same
clock offset; these show per-event jitter, so there is NO scheduled review. The
13:41 values came from live probes whose display truncates seconds, not from a
cluster.

Lesson recorded so it is not repeated: never test a hypothesis against strings I
transcribed myself when the raw source is available. `mute_until` is the raw source.

## WHAT THE TIMING ACTUALLY SHOWS

The three measured starts - 09:13:27, 17:55:15, 20:19:40 UTC on 2026-09-29 - are
8h42m and 2h24m apart. They are consistent with per-account verdicts landing shortly
after that account's own last request, not with any global clock.

The mute is ASYNCHRONOUS: in every case the verdict lands AFTER the last request,
never during one. For `f` and `mutetest` the last turn ended 16:32:55 UTC and the
verdict landed at 17:55:15 / 17:56 - roughly 83 min later, during complete silence.
That is why a scan for events within 30 min of the mute instant found ZERO: it was
looking at the verdict time, not the offence time.

## SURFACE 7 - THE RESUME AFTER A PAUSE IS THE MOMENT NO BROWSER OCCUPIES

The second half of the operator's lead C, and the one that turns lead A from a static
defect into a live trigger.

The shape. Operator, verbatim: "its the pause during these turns then the ai comes
back and shortly after it gets banned". A pause is when the server lapses the session
cookie; the request that FOLLOWS the pause is the one presenting the lapsed
credential. A browser cannot make that request: the site answers a lapsed session by
sending the page to the sign-in route, so the next browser request carries NO session
cookie. The connector carried the stored one straight in.

Ground truth from the captured Chrome profiles (_chromecookies.py). All four agree:

    aws-waf-token   host .deepseek.com     persistent=1  expires ~2026-10-03/04
    smidV2          host chat.deepseek.com persistent=1  expires 2027-11-03/04
    .thumbcache_*   host chat.deepseek.com persistent=1  expires 2027-11-03/04
    ds_session_id   ABSENT

ds_session_id is not in the browser jar AT ALL, yet ds_config.json holds one for every
account and the harness replays it on every request. The config stores it in the legacy
flat form, which carries no expiry, so the SURFACE 5 fix correctly classifies it as a
session cookie -- and a session cookie never expires. The one cookie the browser never
sends is the one the harness sends forever, including on the resume.

THE FIX. _resume_hygiene(client, acct_id) runs at the top of stream(), inside the lease
and before _stream_with. On the first turn after a gap longer than IDLE_RESUME_S it
deletes ds_session_id from that account's jar, reproducing the browser's state.
aws-waf-token is deliberately kept -- WAF clearance is not a session.

THE THRESHOLD IS DERIVED, AND THE TEST CAUGHT ME GETTING IT WRONG. I first wrote
IDLE_RESUME_S = 1800.0 (30 min). The suite failed at once: one turn can legitimately
spend RATE_MAX_TRIES x DS_RATE_WAIT = 20 x 180 = 3600 s resending inside its own retry
loop, so 30 min is BELOW a full storm and would have dropped the cookie mid-storm. Now:

    IDLE_RESUME_S = RATE_MAX_TRIES * DS_RATE_WAIT + 1800.0      # 5400 s = 90 min

30 min of headroom above a maximum-length storm, so a storm can never trip this and a
genuine overnight gap always does. Deriving it from the retry constants is what makes
that hold if either constant is ever tuned.

test_ds_direct_resume_hygiene.py: 17 checks, all green. Pins the derived relationship,
the first-turn case, a 1-minute gap, a storm-length gap (must NOT trip), a genuine
pause (must trip), the exact boundary, per-account isolation, two unreadable-jar
shapes. All 12 kiln suites pass.

## OPERATOR BOUNDARIES AND THE ACCOUNT EXCLUSION FLAG

The operator named two accounts off-limits mid-investigation:

  * `deepseek.ee.1+donttouch@gmail.com` — a new config entry, name says it.
  * `deepseek.ee.1+j1@gmail.com` — the account this session RUNS ON.

`j1` needs no config change: driving it would be self-interference, and marking it
disabled would remove the very route the session uses. It is left alone entirely.

`donttouch` exposed a real hazard. `_next_account_id` round-robins over EVERY
account in `_accounts`, so a brand-new conversation could land on it, and with no
opt-out flag in the config there was no way to prevent that. Added one:

  * `_Account.disabled`, set from a config entry's `"disabled": true` (per-account,
    falling back to the document's top-level flag), defaulting False.
  * `_read_accounts_from_disk.add()` returns early for a disabled account, so it
    never enters `_accounts` — the pool every automatic pick draws from.

Verified live: marking `donttouch` disabled took the pool from 5 accounts to 4
(`hunt`, `v`, `f`, `j1`). The account keeps its token and cookie in the config; it
is invisible to the round-robin and to the failover ring, not deleted.

TWO BUGS I INTRODUCED AND CAUGHT, BOTH WORTH RECORDING.

  1. I added the `if acct.disabled:` guard to `add()` BEFORE adding `disabled` to
     `__slots__` and `__init__`. With `__slots__` declared, an unset attribute is
     an AttributeError rather than a silent None, so EVERY account load raised and
     the module could not be imported at all -- which killed the soak that was
     running at the time. `python -m py_compile` passes on that; only an actual
     `import` catches it. The lesson is to run the import check after touching
     `_Account`, not just the compile check.

  2. I briefly wrote `_account_by_id` to consult a `_disabled_accounts` dict that
     did not exist. That edit did not land, so no harm was done, but the design
     point stands: `_account_by_id` must NOT fall back to `_accounts[0]` for a
     known-but-disabled id, because that would run the call on a DIFFERENT login
     than the one named. It currently cannot happen -- a disabled account has no
     route registered, so nothing addresses it by id -- but the fallback is the
     thing to watch if disabled accounts ever become addressable.
