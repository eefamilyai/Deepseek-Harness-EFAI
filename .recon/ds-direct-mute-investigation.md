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
