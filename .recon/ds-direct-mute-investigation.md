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
