# ds_direct flagging: browser-vs-connector network diff, and per-account device identity

Job files: `.recon/probe_two_accounts.py`, `.recon/probe_fresh_identity.py`,
`.recon/probe_waf_boundary.py`, `.recon/probe_signin_dom.py`.
Evidence base: `C:\Users\eejar\Downloads\chat.deepseek.com.har` (374 entries).

## The question

Why do ds_direct accounts get flagged, and does ds_direct fail to handle packets
a real browser sends? Separately: every re-login must present a VALID per-account
`device_id` minted from that account's own browser profile.

## Method

Every claim below is a measurement against the capture, not a reading of the code.
The header diff, the `client/settings` shape, and the two-account identity proof
were each produced by a script whose output is quoted here.

## What the browser sends that ds_direct did not

The capture splits its headers THREE ways by origin, and the split is the
browser's:

| origin | client hints | `x-client-*` | `x-device-id` / `x-device-model` |
|---|---|---|---|
| `chat.deepseek.com` (47 req) | all nine | yes | yes, on 47/47 |
| `hif-*.deepseek.com` | triple only | yes | **no** |
| `gator.volces.com`, CDN | no | no | no |

Measured gaps, each verified on the wire:

1. **`x-hif-*` staleness.** The pair is minted per batch with `x-hif-ttl: 600`;
   the browser re-fetches roughly every ten minutes. ds_direct replayed one
   capture-frozen pair forever -- a fixed value where the browser rotates is a
   sharper bot signal than sending nothing.
2. **`x-hif-*` scope.** The pair rides ONLY `/api/v0/chat/completion` (5/5). It is
   absent from `/api/v0/client/settings` (35), `/api/v0/chat/create_pow_challenge`
   (6), and `/api/v0/chat_session/create` (1). Sending it everywhere advertises a
   client the browser is not.
3. **Client hints.** `chat.deepseek.com` sends nine `sec-ch-ua-*` headers on all
   47 requests, with NO `Accept-CH` negotiation anywhere in the capture.
   ds_direct sent three.
4. **`x-device-id`** on 47/47 chat requests and nowhere else. `_extra_identity_headers`
   omitted it entirely.
5. **`x-device-model`** (present, empty) on 47/47. Never sent.
6. **`did`** as a query parameter on 35/35 `client/settings` requests, one value.
   ds_direct made that request ZERO times (`client/settings`: 0 hits in the file).
7. **Navigation-only headers.** curl_cffi adds `sec-fetch-user` and
   `upgrade-insecure-requests` because it shapes a request like a navigation. No
   XHR in the capture carries either -- `sec-fetch-user` absent from all 47 chat
   requests, `upgrade-insecure-requests` from all 374 entries.

Not established as flagging causes, only noted: `gator.volces.com/list` (289
requests) and `challenges.cloudflare.com` are browser telemetry/consent calls
ds_direct never makes.

## Why a fresh profile could never mint an identity

Playwright on `/sign_in` returned **HTTP 403** with the title
`ERROR: The request could not be satisfied` (a CloudFront/WAF block page, 923
bytes). Isolated by `.recon/probe_waf_boundary.py`:

| client | User-Agent | result |
|---|---|---|
| curl_cffi | connector UA | HTTP 202, real HTML (2524 B) |
| Playwright | Playwright's own `HeadlessChrome` | HTTP 403, block page |
| Playwright | connector UA | HTTP 202, real HTML (2522 B) |

The block was **UA-driven, not TLS-fingerprint-only and not the automation
flag**. A 403 page has no sign-in form and stores nothing, so a fresh profile
could never mint a `device_id` -- which is why every account fell back to the
machine-level value and several accounts presented as ONE device.

Fix: pass `user_agent=ds_identity.UA` into `launch_persistent_context`.

## Why accounts shared one device

`ds_direct._device_id_for` resolved explicit config -> account record ->
machine-level fallback. With the capture path broken (above), step two was always
empty, so every account reached step three. The machine-level value is what made
N accounts look like one device joining N times.

## What landed

New, fork-owned (Tier 1, `python/kiln/` -- no seam registration needed):

- `python/kiln/runtime/ds_hif.py` -- mints and TTL-caches the `x-hif-*` pair
  (`DEFAULT_TTL=600`, `REFRESH_FRACTION=0.8`), never raises.
- `python/kiln/runtime/ds_profile.py` -- one persistent Chrome profile per
  account, the identity it mints, and the record ds_direct replays.
- `python/kiln/runtime/test_ds_hif.py` (38 checks),
  `test_ds_profile.py` (97), `test_ds_did.py` (34).

Edits inside already-taken-on files (`ds_direct.py`, `ds_identity.py`) are
registered in `HARNESS-EDITS.md` and the `local-overlay` seam:

- `ds_identity.device_model()` / `derived_x_device_id()` / `client_hints_full()`.
- `_NOT_A_NAVIGATION` dropped in both `_headers` and `_login_headers`.
- `_extra_identity_headers` always emits `x-device-id` + `x-device-model`.
- `_mint_identity_for` mints before the first attempt, re-mints once on DEVICE risk.
- `ds_hif` scoping: `hif=True` only on `/chat/completion`.
- `_did_for` + `_Client.client_settings()` + `_settings_once()`, wired into
  `new_session`, sending `GET /api/v0/client/settings?did=<uuid>&scope=provider`.

## Per-account identity: proven, not asserted

`.recon/probe_two_accounts.py` minted real identities for two accounts in a
scratch identity dir:

| | alpha@example.com | beta@example.com |
|---|---|---|
| profile dir | `.../profiles/alpha_example.com-e0905a263469` | `.../profiles/beta_example.com-3dfeda449172` |
| `device_id` | `202609271800374d47...4340` (63 ch) | `202609271800433acf65...4770` (63 ch) |
| `x-device-id` | `8dd8d147-baae-4f87-...` | `a2f34e0d-827a-457c-...` |

Distinct profile dirs, distinct records, distinct `device_id`, distinct
`x-device-id`, both `device_id`s well-formed, both profiles and records on disk.
`ds_profile.device_id_for_account` -- the exact function `_device_id_for` calls --
returned the same value again afterwards, so a re-login replays rather than
re-mints.

## `did` is deliberately NOT auto-minted

`_did_for` has no machine-level fallback, unlike `_device_id_for`. A fabricated
`did` is a second identity the browser never had; the machine-level `device_id`
at least has the excuse of being a real value. With no captured `did`,
`client_settings` makes NO request at all -- which is what a client with no
stored settings does.

## One real defect the new suite caught

`_extra_headers` read `acct.headers` directly where every other account read in
the module uses `getattr`. A duck-typed account or an `object.__new__` client
raised `AttributeError` on a path that has nothing to do with identity. Fixed to
`dict(getattr(acct, "headers", None) or {})`.

## Verification

Every `test_ds_*.py` suite under
`python\kiln\runtime\.venv\Scripts\python.exe`: **13/13 rc=0, 455 checks, 0
failures**. Runtime interpreter is that venv; `py -3` fails with
`Unknown option: -3`, and these are self-running scripts, not pytest cases.
