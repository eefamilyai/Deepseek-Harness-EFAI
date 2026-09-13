# DeepSeek Direct (`ds_direct.py`)

Talk to **chat.deepseek.com directly** — no proxy, no third-party API server.

`ds_direct` is the connector that lets the harness use a **free** DeepSeek web
account as a model backend. It is a drop-in replacement for the old
`localhost:8000` `deepseek-free-api` proxy: it solves DeepSeek's browser
Proof-of-Work with DeepSeek's own WASM, holds one persistent chat per
conversation, and translates the web client's streaming SSE format into the
`reasoning` / `content` deltas the rest of the runtime expects.

> **This drives a normal web login, not the paid platform API.** You supply the
> same bearer token and cookies your browser uses. Treat it accordingly: it is
> for personal/experimental use and is subject to DeepSeek's own rate limits and
> terms.

---

## Quick start

1. **Sign in** at <https://chat.deepseek.com> in a browser.
2. Open **DevTools → Network**, send any message, and click the `/completion`
   request. From it copy:
   - the **`authorization`** header value *after* `Bearer ` → your **token**
   - the full **`cookie`** header → your **cookie** string
     (it needs at least `cf_clearance`, `aws-waf-token`, and the DeepSeek
     session cookies — copying the whole thing is easiest and safe).
3. Create **`ds_config.json`** next to `ds_direct.py`:

   ```json
   {
     "token": "<bearer token, no 'Bearer ' prefix>",
     "cookie": "cf_clearance=...; aws-waf-token=...; ds_session_id=..."
   }
   ```

4. Start the harness. `configured()` flips to true as soon as a usable token (or
   a login-capable account) is present, and the DeepSeek models appear in the
   picker.

`ds_config.json` is **git-ignored** and holds the *only* copy of your live
credentials. Keep it out of shared/synced folders, and never commit it.

### Auto-refresh (recommended)

A pasted token expires. To let `ds_direct` mint a fresh one on a `401` without
you re-pasting from DevTools, add your login credentials:

```json
{
  "token": "<optional; will be refreshed automatically>",
  "cookie": "<optional; refreshed on login>",
  "email": "you@example.com",
  "password": "<your DeepSeek password>"
}
```

Mobile login instead of email:

```json
{ "mobile": "1234567890", "area_code": "+86", "password": "<password>" }
```

With `email`/`mobile` + `password` set, an expired token is refreshed
transparently mid-session — no restart. An AWS-WAF challenge encountered during
login is solved automatically via [`ds_waf.py`](ds_waf.py).

---

## Configuration reference

| Key | Meaning |
| --- | --- |
| `token` | Bearer token from the web client (no `Bearer ` prefix). |
| `cookie` | Cookie header string; carries the WAF/Cloudflare tokens. Refreshed and persisted automatically as DeepSeek slides them. |
| `email` / `mobile` + `area_code` | Login identity for automatic token refresh. |
| `password` | Login password. Never logged, never returned, never sent anywhere but DeepSeek's login endpoint. |
| `headers` | Optional object of extra request headers copied verbatim (see [`x-hif-*` note](#the-x-hif--headers)). |
| `accounts` | Optional array of the above, one object per login — see [multi-account](#multiple-accounts). |

**Environment overrides**

| Variable | Effect |
| --- | --- |
| `KILN_DS_CONFIG` | Absolute path to a `ds_config.json` outside the source tree (checked before the local one). |
| `KILN_STATE_DIR` | Where `ds_sessions.json` (conversation → DeepSeek-chat map) is written. Keeps mutable state out of a read-only vendored runtime. |
| `DEEPSEEK_TOKEN` / `DEEPSEEK_COOKIE` / `DEEPSEEK_EMAIL` / `DEEPSEEK_MOBILE` / `DEEPSEEK_AREA_CODE` / `DEEPSEEK_PASSWORD` | Account `#0` straight from the environment (no file needed). |

The config file is **hot-reloaded** — editing it (e.g. pasting a new token)
takes effect on the next turn without a restart. Writes are atomic, so a token
refresh can never truncate the file and log you out.

---

## Models

`ds_direct` exposes several ids that map onto DeepSeek's web tiers and toggles.
Each id is `(model_type, thinking, search)`:

| Model id | Label | Thinking | Web search |
| --- | --- | --- | --- |
| `deepseek-default` | DeepSeek | – | – |
| `deepseek-reasoner` | DeepSeek · Thinking | ✓ | – |
| `deepseek-search` | DeepSeek · Search | – | ✓ |
| `deepseek-reasoner-search` | DeepSeek · Thinking + Search | ✓ | ✓ |

Those four are the website's whole picker: **DeepSeek**, **DeepSeek Thinking**,
**DeepSeek Search**, and **DeepSeek Thinking + Search**. There is no Expert or
Vision tier any more — that is the website's change, not this connector's — and
`LABELS` deliberately lists only the four, because that map is the advisory
catalogue the picker falls back to before a token is present. Advertising a mode
the website no longer offers would put a dead entry in front of the user.

### Retired ids still resolve

An older id may survive in a saved conversation, an agent preset, a pinned
route, or a default in `app_settings.json`. `MODEL_MAP` alone would send every
one of those through its `.get(..., default)` fallback and silently change which
mode answers, so `resolve_model()` maps them onto the closest surviving mode:

| Retired id | Resolves to |
| --- | --- |
| `deepseek-expert` | `deepseek-reasoner` |
| `deepseek-expert-reasoner` | `deepseek-reasoner` |
| `deepseek-expert-offline` | `deepseek-reasoner` |
| `deepseek-expert-search` | `deepseek-reasoner-search` |
| `deepseek-vision` | `deepseek-default` |
| `deepseek-vision-reasoner` | `deepseek-reasoner` |

Each target carries the `(thinking, search)` pair the retired id used to send,
so an old conversation keeps behaving as it did — only the label in the picker
changes. The Vision ids land on the plain modes because a file now rides an
**ordinary** chat as `ref_file_ids` rather than needing a vision tier at all;
see [File attachments](#file-attachments).

> **The backend still accepts `model_type: "expert"` and `"vision"`.** Verified
> live: both answer normally. They are nonetheless gone from the website, so
> nothing here depends on them — resolving a retired id onto a live mode keeps
> working whichever way DeepSeek eventually takes those values.

---

## How it works

```
stream(model, messages, conv_id, …)
  └─ pick account (sticky per conversation)         _account_order / _lease_client
  └─ resolve the DeepSeek chat for this conv        _get_state → ds_sessions.json
  └─ build the per-turn prompt (delta only)         _prompt_for / messages_to_prompt
  └─ solve Proof-of-Work                             solve_pow (Node+WASM → python fallback)
  └─ POST /chat/completion  (streaming)              _Client.open_completion
  └─ parse SSE fragments → (kind, text) deltas       _parse
  └─ yield {type: reasoning|content|refs|title|meta}
```

**One persistent chat per conversation.** Every harness conversation is pinned
to exactly one DeepSeek chat session (`ds_sessions.json`), so history lives
server-side and survives restarts, a new day, or a token refresh — as long as
it is the same account. After the first turn, only the **new** messages are sent
(`_prompt_for`), never the whole transcript.

**Proof-of-Work.** DeepSeek gates `/chat/completion` and `/file/upload_file`
behind a PoW challenge. `ds_direct` runs DeepSeek's own `sha3_wasm_bg.wasm`
through Node for speed (`_pow_solver.cjs`, generated on first use), with a pure
Python SHA3 fallback if Node is unavailable (slower — it prints a warning so a
silent slowdown is visible). The WASM is cached locally and fetched from
DeepSeek's CDN if not already present.

**Token accounting.** Because the web endpoint bills nothing, `_turn_usage`
models DeepSeek's real prefix cache (64-token blocks; prefixes shorter than one
block never hit) so the harness's usage/cost display is meaningful. Output
counts *total* generation (visible + thinking); `reasoning` keeps the
thinking-only subset.

### Resilience

`ds_direct` distinguishes failure classes and responds to each correctly:

| Condition | Response |
| --- | --- |
| `401` / dead token | Re-login with saved password (if configured), retry the **same** chat. |
| Rejected `parent_message_id` (`400`/`422`) | Reset threading, retry in the **same** chat — don't abandon it. |
| Unknown session (`404` / "invalid chat session id") | Open a **fresh** chat, re-prime once. |
| "Server is busy" | Wait `DS_BUSY_WAIT` (5s) and resend — it clears on its own. |
| Rate limit (`429` / "too frequent") | Wait `DS_RATE_WAIT` (3 min) and resend — a quota window, not a blip. |
| "Length limit reached" (chat full) | Raise a context-overflow the harness recognises → it compacts and retries in a fresh chat. |

A conversation **stays on its account**: transient failures wait and retry on
the same login rather than hopping, because switching accounts abandons the
server-side chat history. Switching accounts is a manual choice (pick another
account route in the model picker).

### Device identity

DeepSeek's anti-abuse stack reads two independent things about a client: the
`device_id` the web client replays on every login, and the browser fingerprint
(canvas hash, GPU) carried by the WAF challenge. A real browser presents both
**unchanged** for the life of its profile, and `ds_identity.py` makes this
connector do the same. It keeps one seed per machine — `ds_identity.json`, under
`KILN_STATE_DIR` when set — and derives from it:

| Value | Behaviour |
| --- | --- |
| `device_id` | Identical on every login from this machine, across restarts. |
| Canvas hash + histogram | Identical on every WAF challenge. |
| GPU | Identical on every WAF challenge, and of this machine's platform. |
| User-Agent, client hints, TLS fingerprint | One browser, described consistently. |

Two of those used to change on every attempt, and both read as bot signals
rather than as caution: a fresh `device_id` per login made a routine token
refresh look like a new machine joining the account, and a per-challenge canvas
hash is something no real browser produces. A second machine doing that from the
same address is what earns "too many requests" on `/users/login`.

The seed is **not a credential**. It is never sent anywhere; it only stops the
values this client already sends from changing under it. Delete
`ds_identity.json` to mint a new identity for this machine.

The browser profile itself lives in `ds_identity.py` (`IMPERSONATE`, `UA`,
`SEC_CH_UA`) so the TLS fingerprint curl_cffi impersonates and the headers that
ride it can never describe two different builds — a macOS Chrome 120 handshake
under a Windows Chrome 134 User-Agent is a combination no real browser emits.

The platform is **read out of the User-Agent** (`ds_identity.PLATFORM`), not
restated beside it, because a second hand-written copy is exactly how the
fingerprint drifted before. Two things follow from it:

  * `client_hints()` is the one source of the `sec-ch-ua*` triple, used by
    `ds_direct`'s request and login headers and by both WAF header sets. The WAF
    path used to hardcode Windows Chrome 134, so the challenge was solved under
    a different browser than the request that triggered it.
  * `gpu_for_platform()` filters the WebGL pool to renderers that exist on this
    platform. A renderer string is platform evidence — `Direct3D11 ... ps_5_0`
    and `PCIe/SSE2` only exist on Windows, an ANGLE Metal renderer only on
    macOS — and both shipped entries were Windows renderers, so every macOS
    challenge presented a Windows GPU.

### One login at a time

Pooled clients share an account and each retries a `401` on its own. Without
coordination, N conversations hitting one expired token fire N concurrent
`/users/login` posts for a single identity — which is itself a rate-limit
trigger. Logins are therefore serialised **per account**: the first caller logs
in and publishes its token, and any client that was waiting adopts that token
along with the WAF cookies the login refreshed, instead of asking DeepSeek
again. The handoff window is `LOGIN_REUSE_WINDOW` (60s), which spans only the
concurrent-`401` burst.

---

## Multiple accounts

To spread load across several free logins — so parallel agents don't contend on
one session and a busy/blocked account can fail over — list them:

```json
{
  "accounts": [
    { "id": "main",  "email": "a@example.com", "password": "…" },
    { "id": "alt",   "mobile": "1234567890", "area_code": "+86", "password": "…" }
  ]
}
```

- A plain top-level `{ "token", "cookie", … }` is still account `#0` — the array
  is additive and backward-compatible.
- New conversations are assigned round-robin; each conversation then sticks to
  its account.
- The harness registers **one model route per account**, so you can pin a
  subagent to a different login than its parent.
- Add an account at runtime with `add_account(email, password, …)`: it logs in,
  proves the token works, then persists the account to `ds_config.json`.

---

## Public API

Consumed by `providers.py` / `server.py`:

| Function | Purpose |
| --- | --- |
| `configured()` | True if any account can serve a request (has a token, or can log in). |
| `models()` | The live model ids (empty until configured). |
| `model_labels(cfg=None)` | id → display name, for the registry's catalogue. |
| `default_model(cfg=None)` | The mode a fresh conversation starts on (`deepseek-default`). |
| `resolve_model(model)` | Map any accepted id — current or retired — onto a live mode id. |
| `is_dsfree(model)` | True for an id this connector owns, retired ones included (they still route here). |
| `account_ids()` | Stable list of configured account ids (ids only — never a credential). |
| `stream(model, messages, conv_id=…, account=…, ref_file_ids=[…], …)` | Generator yielding `{type: reasoning\|content\|refs\|title\|meta, …}` deltas. The main entry point. |
| `upload_files(files, account=None, …)` | Push `[(name, blob)]` into DeepSeek; returns `{account, files:[{name,id,size}], errors:[…]}`. |
| `messages_to_prompt(messages)` | Flatten a role-tagged message list into the single prompt string the web endpoint takes. **Adds no instructions.** |
| `describe_files(files, prompt, …)` | Upload files and return `{name: description}` — the specialised "describe this for me" path. |
| `add_account(email, password, …)` | Test a login and persist it as a new pooled account. |

> `messages_to_prompt` deliberately injects **no** provider-authored guidance —
> it only relabels the caller's own turns (`User:` / `Assistant:` /
> `[Tool result]:`) and appends a trailing `Assistant:` completion cue. Any
> persona or tool-protocol text is owned by whoever owns the system prompt.

---

## File attachments

A file rides an **ordinary chat** as `ref_file_ids`. There is no separate vision
tier: the website retired it, and the plain modes read attachments. Verified
live — a file containing a known phrase, referenced from a
`model_type="default"` turn, comes back with the phrase.

Two entry points, for two different jobs:

| Call | Use it when |
| --- | --- |
| `describe_files(files, prompt)` | You want the model to **describe** the files and you will pass that prose on. Goes through one shared chat, returns `{name: description}`, splits a multi-file reply back per file. |
| `upload_files(files)` then `stream(…, ref_file_ids=[ids])` | You already know what to ask. Upload the bytes, get ids, attach them to your own turn. |

`upload_files` is the bridge the harness uses, and it is also available over
`provider_bridge.py` as the `upload_files` command (bytes cross base64-encoded,
because the framing is newline-delimited JSON). Its result names the account the
ids belong to:

```json
{"id": 5, "ok": true, "account": "you@example.com",
 "files": [{"name": "notes.txt", "id": "file-…", "size": 42}],
 "errors": [{"name": "big.bin", "error": "…"}]}
```

**File ids are scoped to the login that uploaded them.** Pass the returned
`account` back as `stream(..., account=<id>)` so the turn that references the
files runs on the same login; an id attached on a different account is a file
the chat cannot see.

Uploads require a content type DeepSeek recognises (it routes on it), their
**own** PoW challenge minted for the upload path, and the byte length in
`x-file-size`. Each file is uploaded independently, so one bad file fails only
itself and is reported under `errors` — losing one of five attachments is the
caller's decision, not this connector's.

`file_status()` is best-effort: `/file/fetch_files` no longer returns file rows,
so it answers `{}` for "no evidence either way" and callers proceed rather than
refusing every file. The upload response already carries the real `status`, and
referencing a freshly uploaded id works immediately.

---

## Troubleshooting

**`curl-cffi unavailable in the server's Python`** — almost always the server
was started outside the project virtualenv (a bare `python` on `PATH`), not a
missing package. Start it with the project venv and `uv sync` if it still can't
import.

**`No DeepSeek token`** — no usable account. Set a `token` *or* an
`email`/`mobile` + `password` in `ds_config.json`. Credentials alone are a
complete configuration (a token gets minted on first use).

**`DeepSeek auth failed` and it won't clear** — the WAF wants a
browser-solved token that retries can't produce. Paste a fresh `token` +
`cookie` from DevTools, or set `email` + `password` for auto-refresh.

**`code=0/11 RISK_DEVICE_DETECTED`** — the anti-abuse stack refused the *device*,
not the credential. It is deliberately **not** treated as an auth failure: a
device verdict is about this machine, so rotating to the next account would post
a fresh `/users/login` for every credential in `ds_config.json` and earn the same
refusal from each. The turn fails once, with that explanation, instead of burning
the pool. Because the verdict is about the device, the fix is the device: check
the identity above is stable and self-consistent, and sign in once from a real
browser on this machine to clear a flag.

**Answers show as "thinking" and then stop** — historically a fragment-typing
bug; the parser now honours `THINK → RESPONSE` type flips and dict-shaped
`fragments APPEND` events. If you see it, capture the raw SSE with `--debug`.

**"Too many requests" on login, or the account treated as a new device** — this
used to be self-inflicted. A fresh random `device_id` on every attempt and a
per-challenge canvas hash made ordinary token refreshes look like new machines
joining the account, and simultaneous `401` retries posted several logins for
one identity at once. Both are fixed (see [Device identity](#device-identity)
and [One login at a time](#one-login-at-a-time)). If it still happens after
updating, the account has genuinely been flagged: stop the harness for a while
and sign in once from a real browser to clear it. Running several machines
against one login will keep tripping it — give each its own account in
`accounts` instead.

### The `x-hif-*` headers

DeepSeek's web client sends an `x-hif-*` anti-abuse header pair — AES-GCM blobs
minted by obfuscated JS that **cannot be computed here**, only captured and
replayed. They are deliberately *not* hardcoded (a baked-in constant goes stale,
and one value replayed forever is a sharper bot signal than sending nothing). If
you ever need them, copy them from a live `/completion` request into the
`headers` object of `ds_config.json`; they are applied verbatim.

---

## Files

| File | Role |
| --- | --- |
| `ds_direct.py` | This connector. |
| `ds_waf.py` | Automatic AWS-WAF challenge solver used during login. |
| `ds_identity.py` | This machine's device identity and browser profile. Shared by the two above. |
| `ds_config.json` | **Your credentials. Git-ignored. Never commit.** |
| `ds_identity.json` | The per-machine identity seed (auto-managed, git-ignored; honour `KILN_STATE_DIR`). |
| `ds_sessions.json` | Conversation → DeepSeek-chat map (auto-managed; honour `KILN_STATE_DIR`). |
| `sha3_wasm_bg.wasm` / `_pow_solver.cjs` | PoW assets (cached / generated on first use). |

---

## Security notes

- Credentials live **only** in `ds_config.json` (git-ignored). Keep it off
  shared/synced drives.
- Passwords are never logged, never returned across the API boundary, and never
  passed as command-line arguments.
- Config writes are owner-only (`0o600`) where the OS supports it, and atomic so
  a refresh can't corrupt or truncate the file.
