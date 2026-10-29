# Design

What the gateway does, what it measured, and why each decision is what it is.

## 1. The transport decision

### What the web client actually does (measured 2026-10-24, Chrome 155)

| Step | Request | Notes |
|---|---|---|
| page load | `GET /` | first response is `202` + `x-amzn-waf-action: challenge`; the browser solves it and stores `aws-waf-token` |
| settings | `GET /api/v0/client/settings?did=<uuid>&scope=…` | five scopes on load: `web_upgrade`, `main`, `mode`, `provider`, `banner` |
| session | `POST /api/v0/chat_session/create` `{"character_id":null}` | → `data.biz_data.chat_session.id` |
| proof of work | `POST /api/v0/chat/create_pow_challenge` `{"target_path":"/api/v0/chat/completion"}` | → `{algorithm:"DeepSeekHashV1", challenge, salt, signature, difficulty, expire_at}` |
| turn | `POST /api/v0/chat/completion` | body below; response is `text/event-stream` |
| identity check | `POST /api/v0/users/auth_token/check_device` | `{"rotate": null}` on a healthy token |

The completion body:

```json
{
  "chat_session_id": "…", "parent_message_id": null, "model_type": "default",
  "prompt": "…", "ref_file_ids": [], "thinking_enabled": false,
  "search_enabled": true, "action": null, "preempt": false
}
```

Application-level headers on every `/api/v0` call:

```
accept: */*
x-client-bundle-id: com.deepseek.chat
x-client-locale: en_US
x-client-platform: web
x-client-timezone-offset: 28800
x-client-version: 2.7.0
x-device-id: <uuid>            (localStorage "deepseek-device-id:chat")
x-device-model: ""             (present and empty)
authorization: Bearer <token>  (localStorage "userToken")
```

The `did` query parameter comes from `localStorage["__ds_remote_feature_did"]`.
The Shumei fingerprint lives in the `.thumbcache_*` cookie (percent-encoded; the
login body restores a leading `B`). Client hints are the **triple only**
(`sec-ch-ua`, `-mobile`, `-platform`): the site never grants the high-entropy set,
so sending all nine asserts a browser state this origin cannot produce.

`x-hif-leim` / `x-hif-dliq` are minted by pollers against
`hif-leim.deepseek.com` / `hif-dliq.deepseek.com` on a ten-minute TTL. A turn
issued from inside the page **without** them completed normally, so the gateway
does not synthesize them — a stale replay is a sharper signal than sending none.

Login is a different story: `/api/v0/users/login` now sends an encrypted body with
`x-request-encryption-key`, and can answer `biz_code: 14 MFA_VERIFICATION_CODE_REQUIRED`.
That is why account setup is a hand login in a real window.

### The streaming format

Not tokens. A JSON document patched over time:

```
event: ready
data: {"request_message_id":1,"response_message_id":2,"model_type":"default"}

data: {"v":{"response":{"status":"WIP","fragments":[{"id":2,"type":"RESPONSE","content":"p"}]}}}
data: {"p":"response/fragments/-1/content","o":"APPEND","v":"ong"}
data: {"v":"  more"}                       ← bare append to the current fragment
data: {"p":"response/fragments","o":"APPEND","v":[{"type":"THINK",…}]}   ← a new fragment
data: {"p":"response","o":"BATCH","v":[{"p":"accumulated_token_usage","v":40}]}
data: {"p":"response/status","o":"SET","v":"FINISHED"}

event: title
data: {"content":"Pong reply"}
```

Fragment types are `THINK`, `RESPONSE`, `SEARCH` (with `queries` and `results`),
`REQUEST`. `-1` means "the last fragment", and a later `RESPONSE` fragment ends
the `THINK` one — a reader that ignores the type flip fills the thinking panel and
leaves the answer empty. The stream continues after `FINISHED`, so `title` and
`close` still arrive; only `[DONE]`/close ends decoding.

### Why the browser issues the requests

Given the above, three transports were possible:

1. **HTTP replay** (curl/undici) — needs TLS impersonation, header-order
   emulation, the wasm, the WAF token, and the cipher for the login body; the TLS
   fingerprint still differs.
2. **Browser for login, HTTP for turns** — the device identity is right but the
   network identity is not.
3. **Browser for everything** — the profile's own network stack, cookies,
   fingerprint and header order.

Option 3 was measured to work: a full turn (session → pow → completion) issued as
an in-page `fetch` from the account's profile returned a normal stream in 820 ms,
with the wasm solving a `difficulty: 144000` challenge in 78 ms. It also survives
protocol changes for free — the encrypted login was invisible to the gateway
because the page did it.

Cost: one Chromium per warm account (~150 MB). Mitigated by closing idle profiles
after ten minutes and relaunching on demand (about 2 s cold).

## 2. One profile per account

The device fingerprint is minted by the site's SDK from canvas, GPU and audio
entropy and stored in the profile. Two consequences drive the design:

- A fresh `browserContext` mints a **new device** every time, so an ephemeral
  context is the one thing that must not be used.
- Several accounts in one profile present as **one device with several logins** —
  the exact pattern the anti-abuse stack watches.

So `data/profiles/<slug>/` is a real Chrome user-data directory, one per account,
and the slug is derived from the account id so it is stable forever: a profile
that changes name is a profile that was lost.

## 3. Fresh context per request

The web chat keeps its history server-side. Reusing one chat across an agent's
turns means the model reads an ever-growing, self-inflicted transcript — and that
is where tool-call formatting degrades first: the envelope gets mangled, the JSON
gets clipped, a closer goes missing.

Every request therefore opens a new chat, sends the whole transcript the client
provided, and (optionally) deletes the chat afterwards. The cost is that the
server's prefix cache never hits; the benefit is that a turn always starts in a
context the gateway composed.

## 4. The tool protocol

The web model has no `tools` field. Two facts made the choice easy:

- An untutored prompt that lists tools already answers with
  `<tool_call>{"name":…,"arguments":…}</tool_call>`.
- The same model follows an explicit format statement reliably when the statement
  matches that instinct.

So the taught format is that envelope, and the reader accepts the shapes a
degraded context produces (see the table in the README). Two rules keep it safe:

- A shape that only means "call" when a declared tool backs it (bare JSON, fenced
  JSON) is **not** a call otherwise — an example in the reply cannot execute.
- Unreadable markup is **reported**, not dropped, so the turn can be retried once
  in a clean context instead of returning nothing.

`strict tool names`: a name is matched exactly, then by normalized equality, then
by suffix, then by edit distance ≤ 2. An unresolvable name is still forwarded (a
client may route it) but flagged.

## 4b. Learning from the corpus

The reader recognises what it knows. What it does not know arrives as prose, and
the failure is silent from the model's side: it believes it called something.

Three layers answer that:

1. **Salvage** (`tools/salvage.ts`) runs after the primary pass when a reply is
   call-shaped but produced no call. It scans *every* balanced object in the text,
   not just the taught positions, normalises Python/JS dialects, unwraps
   `{tool, parameters}` and `{function: {name, arguments}}` envelopes, parses
   `name(k=v)` call syntax, and pairs an orphan closer with the object before it.
   A recovered call must resolve to a declared tool.

2. **Leak records** capture what could not be recovered, with the text.

3. **Induction** (`tools/learn.ts`) treats leaks as positives and prose replies as
   negatives. It enumerates every suffix of the context before a recovered call
   crossed with every prefix of the context after it, counts how many *distinct*
   leaks each pair explains, then validates the survivors by running the real
   extractor over both corpora. A pair is kept only when it recovers at least
   `minSamples` leaks and fires on **no** prose sample. It is then tightened to its
   shortest form at a token boundary, so a marker does not degenerate into a
   common suffix that matches half the language.

That last constraint is what keeps the learning honest: the corpus is the oracle,
and the oracle includes the negative examples.

## 5. Account selection and health

- A key names accounts. Empty means all.
- Selection is round-robin within the key's scope, skipping accounts that are
  disabled, awaiting re-login, muted, or cooling down.
- A request may fail over to at most three accounts, and only for failures about
  the *account*: auth, mute, rate limit, busy, WAF, upstream/network.
- Failure of the *request* (invalid body, context too long) never fails over.

Transient refusals ("server is busy", "temporarily unavailable", "too many
requests", a 502/503 page) are retried on the same account with exponential
backoff before any failover, because the refusal is a statement about *right now*
rather than about the request. The retry is abandoned if anything was streamed to
the client, since a restart would duplicate output.

Verdicts are read from the response body, not the status code, because DeepSeek
reports most refusals as HTTP 200. Each kind writes different state:

| Verdict | State written | Retried? |
|---|---|---|
| auth (`40001`/`40003`) | `status: reauth` | no — the operator re-logs in |
| muted | `status: muted`, `muted_until` | no — time only |
| device risk (`40029`) | cooldown 10 min | no — rotating makes it worse |
| rate limit | cooldown 60 s | yes, next account |
| busy | cooldown 15 s | yes, next account |
| WAF (`202` + header) | cooldown 2 min | yes, next account |
| context length | none | no |

## 6. Pacing

The site throttles by account. The pool enforces one in-flight turn per account,
a configurable minimum gap (`DSWG_ACCOUNT_MIN_GAP_MS`, default 1.5 s) and a
per-minute ceiling (`DSWG_ACCOUNT_RPM`, default 20). A queue beyond
`DSWG_MAX_QUEUE` is refused with `503` rather than piling up.

## 7. Storage and secrets

SQLite (`node:sqlite`, no native build) holds accounts, keys and usage. Credentials
are AES-256-GCM sealed with `data/secret.key`; API keys are stored as SHA-256
hashes. The browser profile is the one place a live session cookie is readable,
which is the same trust level as a browser profile on the same machine.

## 8. What is deliberately absent

- **No headless credential login.** The login body is encrypted and may need MFA;
  a scripted login is a login burst waiting to happen.
- **No `x-hif` synthesis.** Measured unnecessary, and a frozen replay is a signal.
- **No image upload.** Reported as omitted rather than silently dropped.
- **No multi-process mode.** One gateway per data directory.
