# DeepSeek Direct (`ds_direct.py`)

English | [中文](README.ds-direct.zh.md)

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

| Model id | Label | Tier | Thinking | Web search |
| --- | --- | --- | --- | --- |
| `deepseek-default` | DeepSeek | default | – | – |
| `deepseek-reasoner` | DeepSeek · Reasoner | default | ✓ | – |
| `deepseek-search` | DeepSeek · Search | default | – | ✓ |
| `deepseek-reasoner-search` | DeepSeek · Reasoner + Search | default | ✓ | ✓ |
| `deepseek-expert` | DeepSeek · Expert | expert | ✓ | – |
| `deepseek-expert-reasoner` | DeepSeek · Expert Reasoner | expert | ✓ | – |
| `deepseek-expert-offline` | DeepSeek · Expert Reasoner (web off) | expert | ✓ | – |
| `deepseek-expert-search` | DeepSeek · Expert Search | expert | – | ✓ |
| `deepseek-vision` | DeepSeek · Vision | vision | – | – |
| `deepseek-vision-reasoner` | DeepSeek · Vision Reasoner | vision | ✓ | – |

> **Why the expert tier ships with search *off*.** Sending
> `search_enabled: true` tells the web model a tool is available, which primes it
> to emit its native tool-call markup (DSML) instead of a fenced code block — and
> on this endpoint there is nothing to dispatch that markup. Web search stays
> available on the explicit `*-search` ids for chat that needs it.

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
| `models()` | The available model ids (empty until configured). |
| `is_dsfree(model)` | True for a `deepseek-*` id this connector owns. |
| `account_ids()` | Stable list of configured account ids (ids only — never a credential). |
| `stream(model, messages, conv_id=…, account=…, …)` | Generator yielding `{type: reasoning\|content\|refs\|title\|meta, …}` deltas. The main entry point. |
| `messages_to_prompt(messages)` | Flatten a role-tagged message list into the single prompt string the web endpoint takes. **Adds no instructions.** |
| `describe_files(files, prompt, …)` | Vision: upload images and return `{name: description}`. |
| `add_account(email, password, …)` | Test a login and persist it as a new pooled account. |

> `messages_to_prompt` deliberately injects **no** provider-authored guidance —
> it only relabels the caller's own turns (`User:` / `Assistant:` /
> `[Tool result]:`) and appends a trailing `Assistant:` completion cue. Any
> persona or tool-protocol text is owned by whoever owns the system prompt.

---

## Vision & file uploads

Image description goes through **one shared vision chat** (not one per
conversation): opening a chat costs a session call plus a PoW solve, and the
descriptions are independent of each other and of whatever chat you're in.
Each file is uploaded independently, so one bad file fails only itself; a
multi-file reply is best-effort split back into a description per file.

Uploads require a content type DeepSeek recognises (it routes on it) and their
**own** PoW challenge minted for the upload path.

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

**Answers show as "thinking" and then stop** — historically a fragment-typing
bug; the parser now honours `THINK → RESPONSE` type flips and dict-shaped
`fragments APPEND` events. If you see it, capture the raw SSE with `--debug`.

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
| `ds_config.json` | **Your credentials. Git-ignored. Never commit.** |
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
