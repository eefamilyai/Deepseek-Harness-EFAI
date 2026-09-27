# Why ds_direct accounts get flagged — the browser/ds_direct network diff

Evidence base: `C:\Users\eejar\Downloads\chat.deepseek.com.har` — an **idle** chat.deepseek.com
session, 374 entries, captured from a real Chrome 153 on Windows. This file is the
record of what that log contains, what `ds_direct` sends instead, and which of the
differences explain the flags. It exists so nobody re-derives it.

## 1. Where the browser actually talks

| host | requests | what it is |
|---|---|---|
| `gator.volces.com` | **289** | Volcengine Gator — batched device/behaviour telemetry |
| `chat.deepseek.com` | 47 | the app API |
| `fe-static.deepseek.com` | 18 | static assets |
| `hif-dliq.deepseek.com` | 8 | mints the `x-hif-dliq` header |
| `hif-leim.deepseek.com` | 8 | mints the `x-hif-leim` header |
| `cdn.deepseek.com` | 2 | assets |
| `challenges.cloudflare.com` | 2 | Turnstile |

**77% of a real session's requests are telemetry that ds_direct never sends.** A
client that posts only `/chat/completion` and `/create_pow_challenge` is not merely
missing packets — it is missing the majority of the session's shape.

## 2. The four identities a browser holds, and which ds_direct sends

A real Chrome profile carries **four independent identifiers**. ds_direct has one
optional value that is not any of them.

| identity | where it appears | example from the HAR | ds_direct |
|---|---|---|---|
| `device_id` | `/users/login` **body** | *(no login in an idle HAR)* | ✅ sends one (Shumei-shaped) |
| `x-device-id` | **header** on every `/api/v0/*` call | `54b12f3c-7918-4bb8-ab56-7debe7cdd68d` (UUID v4) | ❌ never sent |
| `did` | **query param** on `/api/v0/client/settings?did=…` | `492cad22-8864-43df-8788-b7465d166631` (UUID v4) | ❌ never called |
| Gator ids | `gator.volces.com/list` body: `user.user_unique_id`, `user.web_id` | `c6502949-b36d-42f5-9ae8-de261bf0946c`, `7568507011558691588` | ❌ never sent |

They are **not** the same value: `x-device-id` ≠ `did`. Both are per-profile UUIDs
minted by the web client and persisted in the profile. ds_direct's single
`device_id` is presented as if it were the whole identity.

## 3. The `x-hif-*` headers are minted live, not replayed

The HAR shows where they come from:

```
GET https://hif-leim.deepseek.com/query   → 200, 151 bytes
  response headers include:  x-hif-ttl
  body: {"code":0,"msg":"","data":{"biz_code":0,"biz_msg":"",
         "biz_data":{"value":"XY8Yy4BCNbfyI4c7XPZVkltnkDmyAcO0zOPuI7Uqwmqp3sc8cG6bdMY=.nC3FKiKGHQAunNKu"}}}
```

- The response `value` is literally the `<ciphertext>.<iv>` blob that goes into
  `x-hif-leim` / `x-hif-dliq` on the next request.
- `x-hif-ttl` says it expires; the page re-fetches rather than replaying.
- In this HAR `x-hif-leim` has **3 distinct values** across the session while
  `x-hif-dliq` is stable — one rotates, one does not.

`ds_direct` reads a **frozen pair** out of `ds_config.json` and replays it on every
request forever. `ds_direct.py:261-268` already suspects this ("one value replayed on
every request is a sharper bot signal than sending nothing") — the HAR confirms it,
and also confirms the fix is a plain unauthenticated `GET …/query` that needs no
credentials at all.

## 4. Gator: what the telemetry says about the client

Every `gator.volces.com/list` POST carries:

```json
"header": {
  "app_id": 20006317, "os_name": "windows", "os_version": "10",
  "device_model": "Windows NT 10.0", "language": "en-US", "platform": "web",
  "sdk_version": "5.2.11_tob", "sdk_lib": "js", "timezone": 8, "tz_offset": -28800,
  "resolution": "1920x1080", "browser": "Chrome", "browser_version": "153.0.0.0",
  "width": 1920, "height": 1080, "screen_width": 1920, "screen_height": 1080,
  "custom": "{\"commit_id\":\"29e61c85\",\"ds_region\":\"overseas\",…}"
},
"user": {"user_unique_id": "c6502949-…", "web_id": "7568507011558691588"}
```

plus named behaviour events (`chatCompletionApi`, `send_button_click`,
`powSolveChallengeStart/Success`, `SSEConnected`, `__pageVisibilityChange`, …) with a
`session_id`, `local_time_ms` and `is_bav` per event. 257 events in one idle session.

This is the single strongest signal in the log: a client whose browser fingerprint is
`Macintosh / Chrome 150` (what `ds_identity` presents) but which sends **zero**
telemetry and reports no screen, no GPU and no language is a headless script, and the
absence is more diagnostic than any one wrong field.

## 5. The ranked causes of the flags

Ordered by how much of the signal each one explains.

1. **One frozen device identity shared by every account.**
   `_device_id_for()` falls back to `ds_identity.device_id()` — a single
   machine-level value. Every account on the box logs in presenting the *same*
   device, and `capture_device_id()` was called at most once. Several logins from
   one device is the textbook "multi-account on one machine" verdict.
   **This is the one the operator can fix directly, and the one asked for.**

2. **`capture_device_id()` cannot produce a stable identity at all.**
   It calls `browser.new_context()` — an **ephemeral** Playwright context with no
   `user_data_dir`. Nothing persists between captures, so a re-capture mints a
   *fresh* device identity rather than recovering the profile's existing one. The
   profile-per-account requirement is not satisfiable with this function as written.

3. **`x-hif-*` are replayed frozen instead of minted live.** §3.

4. **`x-device-id`, `did` and `/client/settings` are absent.** §2. The settings call
   is how the server learns which client build is talking; skipping it is a
   build-mismatch signal on its own.

5. **Zero telemetry.** §4.

6. **A macOS identity from a Windows box.** `ds_identity` presents
   `Macintosh … Chrome/150` because that is curl_cffi's ceiling, while the operator's
   other traffic (and any Gator-shaped signal) is Windows. Known tradeoff, documented
   in `ds_identity.py:44-50`; leave it, but it compounds with 4 and 5.

## 6. What was changed

- **`ds_profile.py`** (new) — one **persistent** Chrome profile per account,
  `~/.kiln_identity/profiles/<slug>/`, keyed by a stable slug of the account id. The
  profile is the identity: reopening it yields the same `device_id`, the same
  `x-device-id` and the same `did`, which is exactly what a real browser does.
- **`ds_identity.py`** — `capture_device_id` now accepts a `profile_dir` and uses
  `launch_persistent_context`, so a capture **recovers** the profile's identity
  instead of minting a new one; `capture_device_id_for_account()` persists the result
  per account; `device_id_for_account()` resolves it.
- **`ds_direct.py`** — `_device_id_for(acct)` prefers the account's own captured
  value, and a login that has no identity yet mints one from that account's profile
  before retrying, so re-logins stop looking like new devices.

## 7. What is still open

- Live `x-hif-*` minting (§3) — the endpoint is unauthenticated, so this is a plain
  GET added to the request path.
- Sending `x-device-id` / calling `/client/settings?did=…` (§2).
- Any telemetry at all (§4) — deliberately out of scope; fabricating analytics is a
  different risk from omitting it.
