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

## RETRACTION 2 - THE BROWSER-COMPARISON EVIDENCE IS VOID

I claimed the captured Chrome profiles prove the real client does not send
`ds_session_id`, and used that to justify the cookie and resume fixes. That
inference does not hold, and the probe that tested it (`_profilelogin.py`) shows why:

    Login Data   : absent   (ALL five profiles)
    History      : absent   (ALL five profiles)
    LocalStorage : present

No saved logins and no browsing history means these profiles were never LOGGED IN.
They are minted by `ds_profile`, which launches Chrome to capture the identity it
mints -- not to sign in. A jar from a profile that never authenticated lacking a
session cookie is EXPECTED and says nothing about an authenticated browser.

So this specific claim is withdrawn:

    WRONG: "the real Chrome jar has no ds_session_id, so the harness diverges."
    WHY:   the profiles were never logged in, so the absence is uninformative.

WHAT SURVIVES, AND ON WHAT EVIDENCE.

The cookie-expiry defect does NOT depend on the browser comparison. It was proven
directly and mechanically by `_cookiejar.py` Part B, with no browser involved:

    install a cookie with expires one hour in the PAST
      -> cookie_string() serializes it as "name=value", carrying no expiry
      -> apply_account() re-installs with set(name, value)
      -> it comes back ALIVE with expires=None

`cookie_string` reads `get_dict()`, which has no domain or expiry to give it, and
`apply_account` calls `set(name, value)`, which curl_cffi accepts and stores with
expires=None. That is a lossy round-trip regardless of what any browser does. The
fix stands on that measurement alone.

`aws-waf-token` being PERSISTENT at host `.deepseek.com` also survives as a fact --
it was in the jar with a real ~3-day expiry -- but it is a fact about an ANONYMOUS
visit, since these profiles never authenticated. It says the WAF cookie is
persistent for a logged-out visitor; it does not characterise the logged-in jar.

WHAT THIS MEANS FOR THE RESUME FIX. `_resume_hygiene` drops `ds_session_id` after a
long idle gap, and I justified that with the (now void) browser comparison. The
mechanism is still defensible on its own terms -- a session cookie the server may
have lapsed is not worth re-presenting after 90 minutes, the WAF token is kept, and
the ordinary `_AuthExpired` path re-authenticates if the drop was unnecessary -- but
it is now a REASONED precaution rather than an evidenced correction. It should be
described that way, and if `ds_session_id` turns out to be a long-lived device
identifier rather than a session token, dropping it could cost a re-login without
buying anything. That is not yet known either way.

THE LESSON, WHICH IS THE SAME ONE TWICE. Retraction 1 was testing a hypothesis
against strings I had transcribed myself. This one was drawing a conclusion from a
profile whose precondition I never checked. Both times the fix was to verify the
SOURCE before reasoning from it: read the raw `mute_until`, and confirm the profile
was logged in. A captured artifact is only evidence about the state it was actually
captured in.

## IS _resume_hygiene SAFE? YES -- AUTH DOES NOT RIDE THE COOKIE

The question that decides it: if `_resume_hygiene` drops `ds_session_id`, does that
force a re-login? A re-login burst is the suspected amplifier, so a fix that CAUSED
one would be net-negative.

It does not. `_Client._headers` sets authentication from the BEARER TOKEN, wholly
apart from the cookie jar:

    if self.token:
        h["authorization"] = "Bearer %s" % self.token

The token is what authenticates the request; cookies ride alongside it. Dropping a
session cookie therefore cannot make an authenticated request become
unauthenticated. The worst case is that the request carries one fewer cookie than
before, which is the browser-equivalent state the fix is aiming for anyway.

So the resume fix is safe on its own terms, independent of the retracted browser
comparison: it removes a cookie that may have lapsed server-side, keeps the WAF
token, cannot trigger a re-login, and the ordinary `_AuthExpired` path still
re-authenticates if the TOKEN is the thing that died.

## ds_session_id IS PER-ACCOUNT, NOT PER-DEVICE

`_dsid.py`, fingerprints only: all five accounts hold a DISTINCT 32-char
`ds_session_id`. A shared per-DEVICE identifier would repeat across accounts on one
machine, so that reading is ruled out; the values look like per-account state.

This does not PROVE it is a short-lived session token -- confirming that needs a
re-login to observe whether the value changes -- but it removes the objection that
dropping it throws away a stable device identity, which was the one way the fix
could have been harmful.

## THE FIXES DO NOT REACH A RUNNING HARNESS UNTIL provider_bridge RESTARTS

Operational finding, worth recording because it decides when the fix takes effect.

`providers._load_module` caches each provider module in a module-level dict and never
re-reads it:

    def _load_module(module_name):
        if module_name not in _MODULES:
            ... exec_module(mod) ...
            _MODULES[module_name] = mod
        return _MODULES[module_name]

Measured against the running processes:

    provider_bridge PID 836/5664  started 2026-09-30 15:09:44   <- serves harness turns
    fix 1 (cookie expiry)         committed 16:09:29
    fix 2 (resume hygiene)        committed 16:15:24
    fix 4 (account exclusion)     committed 16:22:49

The bridge started 60 minutes BEFORE the first fix, so its cached `ds_direct` is the
pre-fix code and a long-lived harness keeps serving the old behaviour until that
process is restarted. The source being correct on disk is not enough; the import is
memoised for the life of the process.

This does NOT invalidate the soak, which is a SEPARATE process: `_humansoak.py`
imports `ds_direct` directly (it does not route through provider_bridge), and it was
started at 16:17:38 -- after fixes 1 and 2 were on disk. So the soak's turns have
been running the fixed cookie and resume code. It does not have fix 4 (committed
16:22:49), which is harmless here because the soak pins its account explicitly via
HS_ACCOUNT rather than relying on automatic selection.

The bridge is deliberately NOT restarted from here: it serves THIS session's own
turns, and killing it mid-run would cut the session off. The restart is the
operator's call, and the honest guidance is that the fix lands on the next bridge
start -- not on the commit.

## THE SOAK COULD NOT HAVE DETECTED A MUTE (found and fixed)

A bug that would have silently wasted the whole multi-day verification run.

A mute reaches a caller as a RAISED `ds._Muted`, not as a returned body. The soak's
turn loop caught the exception and did this:

    except Exception as e:
        err = "%s: %s" % (type(e).__name__, e)
        raw = [err]
    v = verdicts_of([str(x) for x in raw])
    if v.get("mute"): ...stop...

But every verdict reader requires a parsed JSON ENVELOPE -- that is their whole
safety property, so the model's own prose can never classify itself -- and
`_Muted`'s message is prose. Measured directly:

    raise ds._Muted("DeepSeek has muted this account: user is muted. ...")
    ds._mute_verdict_in(["...that string..."])  ->  None

So `v.get("mute")` was never truthy for a real mute. The soak would have run all 200
turns through a mute, recorded 200 clean turns, and reported "completed with no
mute" -- the exact opposite of the truth, at the end of a multi-day run.

FIX: catch the type, not the text.

    except Exception as e:
        ...
        if isinstance(e, ds._Muted):
            muted = str(e)

and the stop condition becomes `if muted or v.get("mute")`. The `isinstance` test is
precise -- only ds_direct's own `_Muted` matches, so a transient error cannot be
misread as a mute -- and both paths are kept because a mute can also arrive inside a
200 body that the verdict readers DO see.

Verified end to end: raising `_Muted` now sets the flag and the stop condition fires.

## THE SOAK'S PER-TURN TELEMETRY (goal requirement)

The goal asks for request paths, prompt size, session id, and all four verdict
readers per turn. The soak logged only chars, prompt text, and verdicts. Added:

    sid            the DeepSeek session serving this conversation, read from
                   ds._sessions by its "<conv>#<model_type>" key -- this is what
                   attributes a mute to a specific chat
    prompt_chars   the request size
    dur_s          turn duration; the field that separates a normal turn from a
                   retry storm, which is ONE turn lasting about an hour
    account        which login served it
    reply          the first 400 chars of what came back
    muted          the raw _Muted message when the turn raised one

Verified live on turn 18: sid=08c2a07e-c708-4b66-8d27-34f5f2371e30, prompt_chars=30,
dur_s=1.4.

## x-hif-* : ONE OF THE TWO ENVELOPES CANNOT BE MINTED HERE (environmental, not a defect)

`_hifprobe.py`, no account touched (anonymous GETs to the same endpoint a browser calls):

    x-hif-leim     MINTED  len=73  ttl=600.0
    x-hif-dliq     FAILED  (no value)
    refresh(configured={}) -> leim present, dliq ABSENT (omitted)

So on this network the harness renews `x-hif-leim` on its stated 600 s TTL and
OMITS `x-hif-dliq` entirely. Neither is replayed stale -- and that matters, because
`ds_hif`'s own docstring is explicit that a frozen capture is worse than nothing:
"a value frozen at capture time is a beacon that says this client stopped behaving
like a browser at the moment of the capture, and it is a sharper signal than an
empty header would be." The omission is the better of the two available failures.

WHY dliq CANNOT BE MINTED. `hif-dliq.deepseek.com` has NO IPv4 A record on this
network (AAAA only), and this host is IPv4-only -- measured: `Get-NetRoute
-AddressFamily IPv6` reports no ::/0 default route. `hif-leim` answers from
3.173.21.63 and mints fine. So this is an environmental divergence, not a code
defect, and it is not fixable from here without an IPv6-capable route.

WHAT IS AND IS NOT CLAIMED. The real web client is believed to send BOTH envelopes
on `/chat/completion`; the harness sends one. That is a header-count divergence --
but a MISSING HEADER CANNOT PRODUCE ACCOUNT-LEVEL MODERATION, so this is hygiene at
most, exactly as the operator said when calling the header theory "stupid". It is
recorded as an environmental limitation, NOT as a mute cause. Whether the real
browser sends both on that specific route also remains unconfirmed without a
capture.

## THE RESUME CHECK COULD NOT SEE A GAP ACROSS A RESTART (found and fixed)

The second defect in my own resume fix, and the one that made it miss its own use case.

`_last_turn_at` was an in-memory dict. Measured with a probe: on a fresh process it is
`{}`, so `prev is None` and `_resume_hygiene` returns False -- meaning the FIRST turn
after any restart never dropped the cookie, HOWEVER long the pause had been. An
overnight pause is exactly when the process is likely to have been restarted, so the
check was blind to the scenario it exists for. Within one process it worked (a 27.8 h
gap dropped correctly).

FIX: the map round-trips through `ds_last_turn.json` beside `ds_sessions.json`, using
the existing `_atomic_json`:

    _LAST_TURN_FILE = os.path.join(KILN_STATE_DIR or _DIR, "ds_last_turn.json")
    _load_last_turn()  -> {} on absent/corrupt
    _save_last_turn()  -> atomic write, best-effort

Recorded on EVERY turn, not only on a drop -- a stale entry would make the next gap
look longer than it was and drop a cookie for a pause that never happened.

VERIFIED LIVE, not just unit-tested: the running soak now writes

    {"deepseek.ee.1+v@gmail.com": 1790759653.9045358}

And verified by runtime round-trip in a throwaway state dir: fresh -> {} on load,
fresh turn -> False, file written as {'a@x': 1000.0}, then a 100000 s gap -> True.

TEST ISOLATION. The suite now sets `KILN_STATE_DIR` to a temp dir BEFORE importing
ds_direct, because the module resolves its state paths at import time. Without that the
test wrote epoch-1000 timestamps into the REAL state directory, which a later
production run would read as an enormous idle gap and act on -- a test corrupting
production. Confirmed: no real `ds_last_turn.json` is created by the suite.

ALSO FIXED: the comment block above `IDLE_RESUME_S` still asserted the retracted
browser claim ("a browser in that state has been redirected to the sign-in page").
Rewritten to state the drop is a PRECAUTION and why it is safe.

## END-TO-END VERIFICATION: A RESTART + AGED CLOCK DROPS THE COOKIE (the fix works)

The persistence fix was verified on the REAL soak, not just in a unit test. Method:

  1. stop the soak (fresh process on restart, so the in-memory map is empty)
  2. age the persisted clock in ds_last_turn.json by 7200 s (simulating an overnight gap)
  3. clear stderr, restart, and read what the first turn does

Result -- the resume check FIRED:

    [ds_direct] ds_direct: deepseek.ee.1+v@gmail.com resumed after 122 min idle
                -- dropped the stale ds_session_id (it named a session the server had rejected)

122 min is the aged clock plus the turn's own elapsed time. The chain that had to hold
for this line to appear: the process restarted (empty map), the map was RELOADED from
disk, the gap exceeded IDLE_RESUME_S, and the drop ran. Before the persistence fix the
first turn after any restart was a guaranteed no-op.

AND THE TURN SUCCEEDED AFTERWARD. Turn 22 returned `reply: "4"`, chars=1, dur_s=1.7 --
no error, no re-login, no re-auth. That is the empirical form of the safety argument:
authentication rides the bearer token, so dropping a cookie cannot make the request
unauthenticated. The prediction and the measurement agree.

The clock was also re-written on that turn ({account: 1790759786.95}), confirming the
every-turn write path.

This is the strongest verification in the whole investigation: a real restart, a real
aged gap, the fix firing, and the request still succeeding.

## THE WIRE JOURNAL (the network logger the operator asked for)

The mute verdict is ASYNCHRONOUS: it lands 7-226 min after the last request, never
during one. So the request that draws the verdict is never the one that reports it,
and any log that records only verdicts cannot answer "what did we send right before
this account was muted?". `ds_wirelog.py` fixes exactly that.

WHAT IT IS. A wrap around `sess.request` installed at `_Client.__init__`. `Session.get`
and `Session.post` both delegate to `Session.request`, so ONE wrap covers every HTTP
call an account makes -- login, PoW, upload, completion -- without touching a single
call site. Every request is appended to `ds_wirelog.jsonl` AND kept in a bounded
in-memory ring of the last 80 events. The four `_Muted` raise sites call
`ds_wirelog.verdict(...)`, which writes the verdict TOGETHER WITH its own preamble --
the exact request shapes that preceded it, in one line. That artifact is the whole
point of the module.

NEVER WRITES A CREDENTIAL. Header and cookie VALUES are written as short SHA-256
fingerprints (10 hex chars), never plaintext: two requests whose `authorization`
differs get different fingerprints, two whose `accept-language` matches get the same
one. That is exactly the comparison this investigation needs -- did a header change
shape, appear, or go missing? -- and it leaks nothing. The prompt body is not written
either, only its top-level KEY NAMES and serialized size. Verified: three planted
secrets (bearer token, cookie value, WAF token) are all absent from the file.

OFF BY DEFAULT. Enabled per-process with `KILN_DS_WIRELOG=1` or globally by creating a
`ds_wirelog.on` marker beside the module. Deliberately not on by default: a running
provider_bridge caches its modules, and this must never silently change the live
bridge's behaviour.

### TWO BUGS THE MODULE HAD, BOTH FOUND BY RUNNING IT

1. IT WROTE NOTHING. `_append` swallowed `FileNotFoundError` because `KILN_STATE_DIR`
   may name a directory nobody created -- the same failure `_atomic_json` already
   documents in ds_direct. A journal that silently writes nothing is the worst
   possible failure for a file whose entire purpose is to exist after the fact.
   Fixed by creating the parent directory before the first write, mirroring
   `_atomic_json`.

2. IT COULD NOT SEE COOKIES. The first live run showed `ck=` empty on every request.
   curl_cffi applies cookies at the libcurl level, so a request carrying a full jar
   usually has NO `cookie` header in the kwargs dict the journal was reading. For an
   investigation specifically about stale-cookie replay this was the silently wrong
   answer. Fixed by reading `sess.cookies.jar` (real Cookie objects, with `expires`,
   `domain`, and a computed `expired` flag) instead of the header.

MEASURED LIVE, on real DeepSeek traffic (soak turn 26, 4 requests):

    POST .../chat/create_pow_challenge   jar: aws-waf-token, ds_session_id
    POST .../file/upload_file            jar: aws-waf-token, ds_session_id
    POST .../chat/create_pow_challenge   jar: aws-waf-token, ds_session_id
    POST .../chat/completion             jar: aws-waf-token, ds_session_id

Both cookies are SESSION cookies in the harness jar -- `expires` is empty/None for
both -- and `ds_session_id` carries `domain=chat.deepseek.com` while `aws-waf-token`
carries an empty domain. Neither is expired, so nothing is being replayed stale in
this run. Note the contrast with the browser capture, where `aws-waf-token` at host
`.deepseek.com` was PERSISTENT with a ~3-day expiry: the harness jar holds it as a
session cookie. Whether that divergence matters is unknown, and a missing expiry is
not evidence of wrongdoing -- recorded as an observation, not a defect.

The value of the instrument is prospective: every request now records per-cookie
`expired` and `age_s`, so the operator's exact hypothesis -- a request sent with a
cookie already past its expiry -- becomes a visible `expired=True` line instead of an
inference.

`test_ds_wirelog.py`: 48 checks green, including the two bugs above, the leak check,
install idempotence, and error propagation.

## TWO MORE DEFECTS IN THE MUTE READERS (rounds 27-32)

### 1. `_MUTE_CODE` held ONE code while its own docstring documented TWO

    _MUTE_CODE = "5"

but the docstring two lines below `_is_muted_payload` records the live sample:

    {"code":0,"msg":"","data":{"biz_code":14,"biz_msg":"user is muted",
     "biz_data":{"is_muted":1,"mute_until":1790972380.757}}}
    `biz_code` there is 14, not the 5 the older samples carried

and `_mute_verdict`'s own docstring says "the code has already been observed to
vary (5 and 14)". So the code tell silently covered half of its own evidence. It
did not cause a missed mute -- that upload sample also carried `biz_msg` and
`biz_data`, so one of the other two tells caught it -- but a future code-14 mute
with an empty `biz_msg` and no `biz_data` would have been read as an unrecognised
verdict. Now `_MUTE_CODES = frozenset(("5", "14"))`, checked with `in`. A third
code is a one-token change rather than a new branch.

FOUND BY: a test I wrote asserting the documented behaviour, which failed. The
docstring and the constant disagreed and the constant was wrong.

### 2. A mute arriving on the `event: hint` path looked like a SUCCESSFUL turn

`_parse` emits an `("error", msg)` event for a `event: hint` payload with
`type == "error"`. That sets `server_error`, and the `if server_error:` branch
RETURNS before the mute reader is reached -- after yielding the text as chat
content:

    yield {"type": "content", "text": "W DeepSeek: " + msg}   # shown as an answer
    ...
    if server_error:  ... return                              # <-- leaves here
    if not yielded:
        muted = _mute_verdict_in(raw_sink)                    # <-- never reached

So the turn looked successful: nothing rotated the pool off an account DeepSeek
had already refused, and the operator saw prose instead of "switch accounts".
NOT a storm -- `_retry_kind` returns None for mute wording (verified), so nothing
retried -- but a muted account stayed in service.

FIXED by reading the same three tells at that site, before the return.

### WHAT WAS VERIFIED SAFE, AND WHY IT MATTERS

The operator's storm hypothesis -- a mute misread as transient, resending for an
hour -- is REFUTED by measurement, not argument:

    _retry_kind('user is muted')                        -> None
    _retry_kind('user is muted (until 2026-10-02 ...)') -> None
    _retry_kind('Too Many Requests')                    -> rate
    _retry_kind('server is busy')                       -> busy

A mute can never reach `_RotateAccount` or the 20 x 180 s resend loop. And a mute
envelope is a bare JSON object with no `event:` framing, which `_parse` ignores
entirely -- so no events are yielded, `yielded` stays False, and the
`if not yielded:` mute reader is reached normally. The normal path was already
correct; the gap was only the `hint` variant.

`test_ds_direct_hint_mute.py`: 23 checks. All 15 suites green.

## A SECOND PIECE OF STALE STATE SURVIVES THE SAME PAUSE (round 33)

Found by looking for the SAME SHAPE as the resume-cookie defect rather than for
new evidence: `_resume_hygiene` exists because state that made sense before a
pause should not be replayed after one. `was_cancelled` is a second instance.

WHAT IT IS FOR. When the user stops a generation, the next send carries
`preempt:true` so DeepSeek kills the server-side generation still running
instead of queueing our new prompt behind it. That is a real browser behaviour --
in the moment it happens.

THE DEFECT. The flag is PERSISTED (`st["was_cancelled"] = True`, then
`_save_sessions()`) and popped on the NEXT turn however far away that is. A
cancel followed by an overnight pause therefore still sent `preempt:true` on the
first request back. By then the stale generation is long finished and the page is
a freshly loaded one, which is not a state that sends preempt at all. So the
first request after a long pause carried a body field the website would not
produce -- the same shape as the session cookie the resume guard already drops on
the same pause.

FIX. The cancel is now STAMPED when recorded, and honoured only while fresh:

    def _preempt_is_fresh(cancelled_at, now=None):
        if cancelled_at is None:
            return True                      # no stamp: keep the old behaviour
        age = (time.time() if now is None else now) - float(cancelled_at)
        return age < IDLE_RESUME_S

It reuses `IDLE_RESUME_S` on purpose: both guards are about the same thing -- the
first request after a long pause should not carry state that only made sense
before it -- so they must not drift apart. Unknown age counts as FRESH, because
an entry written before the stamp existed must keep the behaviour it had, and
losing the flag is the worse failure (a live server generation queues behind
ours).

WHY IT IS A HELPER. The first version was three inline lines inside
`_stream_with`, which nothing could reach without constructing a client and
driving a whole turn -- so the threshold went untested. That is the same mistake
the IDLE_RESUME_S work already paid for once. Extracted so the decision is
testable; `test_ds_direct_preempt_freshness.py`, 18 checks.

CLASSIFICATION: a PRECAUTION, not a measured mute cause -- recorded as such. It
cannot be evidenced from the existing logs because the flag's value is never
logged. It is fixed because it is the same defect shape as one already fixed, and
because it is cheap and safe.

All 16 kiln suites green.

## THE STORM MODEL, TESTED PROPERLY: REFUTED (round 33)

The operator's model -- "a long pause OR a rate-limit storm precedes the mute" --
was testable from the session logs, and it does not hold. Getting a trustworthy
answer needed THREE attempts, because the first two probes were broken.

WHY THE FIRST TWO PROBES WERE WORTHLESS.

`_storm.py` used this pattern:

    r"rate limit reached|retrying in \d+|server is busy|too many requests"
    r"|attempt \d+/\d+|429"

The trailing bare `429` matches ANYWHERE -- including inside an epoch-millisecond
timestamp, since `..."time":1790656492429,...` ends in `429`. It reported 2244
"storm lines" whose samples are `step/start`, `agent/inbox/spliced` and
`compaction/summary`. Every one of its 11 clusters was an artifact, and its
headline "84.2 min before the mute" for `f` was just the last log line anywhere
containing those three digits. A three-character number is not a signal.

`_storm2.py` fixed the regex but still counted echoes: extracting the matched
substrings showed the top hit (x49) is the agent's own `reasoning` text quoting
the notice, and the rest are ds_direct.py source, comment text, and recon-log
prose being READ by the agent. Matching wording that the agent wrote ABOUT the
mechanism is not observing the mechanism.

WHAT THE REAL SIGNAL IS, AND WHAT IT SAYS. `_transient_pause` emits

    DeepSeek rate limit reached -- retrying in 3 min (attempt N/20)...

on every resend, and N only rises within one storm. Keeping only lines inside an
assistant `reasoning` or `notice` frame (never a tool result reading source,
never a compaction summary) gives 101 notices in 53 episodes. Grouped by a
20-minute gap -- longer than the 3-minute retry interval, so one storm cannot be
split -- **no episode ever exceeded attempt 4.**

So on this machine the retry loop has never actually run to the 20-attempt hour
the constants permit. The decay in the raw attempt distribution (293 lines at
attempt 1 down to 3 at attempt 16) is the shape of notices being QUOTED in later
reasoning, not of long storms.

    mute start            nearest heavy storm before it
    v/hunt? 09:13Z        none
    f       17:55Z        none
    hunt    20:19Z        none

AND THE SEQUENCE IS BACKWARDS ANYWAY. A storm is activity. Every mute instant
measured in this investigation lands when there is NO activity -- the 01:55/04:19
local pair fell after the machine's last write of the evening (00:30 local), with
no scheduled task and no session file touched in the window. A storm cannot be
the cause of a verdict that lands when nothing is running.

WHAT SURVIVES. The async-verdict model stands: the mute is decided elsewhere and
delivered late. The retry loop is still worth having bounded -- an hour of
resends on one account is not free -- but it is not the trigger, and no evidence
here supports resending as the accumulating cause.

METHOD NOTE, recorded because it cost real effort: both broken probes LOOKED like
they worked. The first produced a plausible 11-cluster timeline and a headline
correlation; the second reproduced most of that timeline with a "fixed" regex. A
probe that reports a satisfying answer is not therefore reporting a true one --
the matched SUBSTRING has to be printed and read, which is the step that exposed
both.

## TWO VERDICTS RECOVERED FROM `turn/end` ERRORS, AND A 216 h MUTE VARIANT (round 33)

The session log records a failing turn as `turn/end` with
`reason.kind == "error"` and the full exception message. Nobody had read those.
Searching them for mute wording recovers verdicts that were never in the
operator's banner, and two of them are new.

    observed 09-29 09:20:57Z   (message text not preserved)
    observed 09-29 11:31:19Z   mute_until 2026-10-08 11:16 UTC
    observed 09-29 13:02:53Z   mute_until 2026-10-02 11:28 UTC

A MUTE IS A FIXED DURATION, SO THE ISSUE INSTANT IS EXACT. Subtracting each
candidate duration and checking which one lands BEFORE the observation (a verdict
cannot be observed before it is issued):

    until 10-08 11:16, observed 11:31:19Z
        -72 h  -> issued 10-05 11:16   IMPOSSIBLE (after the observation)
        -216 h -> issued 09-29 11:16   observed +15 min later   <-- FITS
        -24 h  -> issued 10-07 11:16   IMPOSSIBLE
    until 10-02 11:28, observed 13:02:53Z
        -72 h  -> issued 09-29 11:28   observed +95 min later   <-- FITS
        -216 h -> issued 09-23 11:28   observed +6 days later   (absurd)
        -24 h  -> issued 10-01 11:28   IMPOSSIBLE

So BOTH durations are real: 72 h, and a **216 h (9-day) variant** this
investigation had never seen. That matters beyond bookkeeping -- every "mute
start" reported earlier was computed as `mute_until - 72 h`, and for a 216 h mute
that is wrong by 144 h. The -216 h reading for the 10-02 expiry is absurd (6 days
of lag), which is what makes the 72 h reading for that one the right one rather
than an assumption.

THE TWO ISSUE INSTANTS ARE 12 MINUTES APART, DURING HEAVY ACTIVITY. Between
11:06Z and 11:38Z the log shows turn 98 running to step 62 before being
`interrupted`, then turn 259, then turn 260 stepping through 13 steps. So these
two verdicts were issued while the machine was working, not while it was idle.

THAT REVISES AN EARLIER CLAIM, AND THE REVISION IS RECORDED HERE. The conclusion
"every mute instant lands when nothing is running" was measured on the
01:55/04:19-local pair, which falls after the machine's last write of the evening.
It is true of THAT pair and NOT of these two. The honest statement is:

  * the ASYNC DELIVERY model holds for all of them -- a verdict is observed
    15 min and 95 min after it was issued, never at the moment of the request;
  * whether the ISSUE instant coincides with activity or idleness is now MIXED,
    and the earlier generalisation was drawn from one pair and should not have
    been stated as a rule.

WHY THE STORMS DID NOT SHOW UP HERE EITHER. The harness-level `llm/retry` events
ARE recorded (225 of them) and they cluster into bursts of 5 or 10 within seconds
to a few minutes -- never the 20 x 180 s hour the ds_direct constants permit. The
largest burst in the whole history is 10 retries over 122 s. So the retry loop has
never actually run long on this machine, which is consistent with the earlier
attempt-count finding and leaves the storm model refuted from two directions.

PROBES: `_storm2.py` (strict wording), `_storm3.py` (reasoning-frame only),
`_commitmute.py` (activity before a start), `_llmretry.py` / `_llmretry2.py`
(harness retries and full pre-mute errors), `_mutevariant.py` (duration
arithmetic), `_issuewindow.py` (activity at an exact issue instant).

## RETRIES DISCOVER A MUTE; THEY DO NOT CAUSE IT (round 34)

The strongest causal result in this investigation, and it is arithmetic rather
than correlation.

THE OBSERVATION. Every mute the session log records is preceded by a burst of
harness `llm/retry` events that stops 10-14 s before the verdict appears:

    mute observed 09:20:57Z   10 retries, burst 09:18:44..09:20:46 (122 s), last 10 s before
    mute observed 11:31:19Z    5 retries, burst 11:30:34..11:31:05 ( 31 s), last 14 s before
    mute observed 13:02:53Z    5 retries, burst 13:02:28..13:02:40 ( 12 s), last 13 s before

A burst that stops the instant the verdict appears is what "the harness found
out" looks like. It is NOT what "the harness caused it" looks like -- a cause
would keep retrying, because nothing yet says not to.

THE ARITHMETIC SETTLES IT. For the second one, the issue instant is recoverable
exactly (`mute_until - 216 h` = 11:16:00Z). The observation is at 11:31:19Z. The
retry burst runs 11:30:34..11:31:05.

    verdict ISSUED      11:16:00Z
    retry burst         11:30:34Z .. 11:31:05Z      <-- 14 minutes LATER
    verdict OBSERVED    11:31:19Z

The mute already existed for 14 minutes before the first retry of that burst. The
retries cannot have caused a verdict that was issued before they started. What
they did was make the harness ASK, and the fifth ask is the one that came back
with the refusal.

WHY THERE WAS A BURST AT ALL -- AND WHY THE FIX REMOVED IT. A mute arrives as a
bare JSON envelope with no `event:` framing. Before commit 7d6888732c `_parse`
yielded nothing for it, so the turn looked like an EMPTY RESPONSE and the harness
retried it under its own policy:

    ["normal", 5, ["EMPTY_RESPONSE", "RATE_LIMIT", "SERVER", "TIMEOUT", ...]]

Every one of those retries is a FRESH request to an account DeepSeek had already
refused. That is the real harm the operator was seeing, and it is the opposite
direction from the storm hypothesis: not retries causing mutes, but mutes causing
5-10 extra requests each, aimed at an account already under moderation.

MEASURED AGAINST THE FIX:

    PRE-fix   3 mute observations;  3 had a retry burst within 10 min
    POST-fix  0 mute observations;  0 had a retry burst
    retries: 108 before the fix, 5 after

LIMITS OF THAT COMPARISON, STATED PLAINLY. There are ZERO post-fix mute
observations, so this is not a direct before/after test of the same event -- it
is the absence of the event. And the retry count fell while overall activity also
fell (accounts were being muted and sessions slowed), so the drop from 108 to 5
cannot be attributed to the fix alone. What CAN be said: the mechanism that
produced the bursts is gone (a mute now raises `_Muted`, which is not retryable),
and no burst has accompanied any verdict since.

WHAT THIS CLOSES. The operator's storm model is refuted from three directions now:
retry bursts never exceed 10 and last seconds, not the 20x180 s hour the
constants permit; the reason/wording probes show no storm before any mute start;
and the one mute with a recoverable issue instant was issued 14 minutes BEFORE
its burst began. Retrying is a consequence of a mute, never its cause.

PROBE: `_discover.py` (burst vs observation), `_fixcheck.py` (pre/post the fix).
