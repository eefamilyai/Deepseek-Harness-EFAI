# DeepSeek Web Gateway

An OpenAI- and Anthropic-compatible API server backed by **DeepSeek web accounts**,
with one real Chromium profile per account and an API key that can be scoped to a
subset of them.

It exists because a plain HTTP re-implementation of the web client keeps getting
accounts muted. This one does not re-implement the client: it *is* the client.
Every upstream request is issued from inside the account's own persistent Chrome
profile, so the TLS fingerprint, HTTP/2 fingerprint, header order, client hints,
cookies and device identity are the browser's own — not a reconstruction that
DeepSeek's anti-abuse stack can tell apart from the real thing.

```
OpenAI SDK ─┐                            ┌─ account A (profile A, device A)
            ├── gateway ── account pool ──┼─ account B (profile B, device B)
Anthropic ──┘   (keys)                   └─ account C (profile C, device C)
```

---

## Why it is built this way

The web product has no API. Its client:

- solves a proof-of-work challenge with a WebAssembly module before each turn;
- presents a device fingerprint minted by obfuscated SDK JavaScript from canvas,
  GPU and audio entropy — a value that cannot be computed, only read back out of
  a browser that produced it;
- keeps that fingerprint stable for the life of a profile, because a fingerprint
  that changes is the signal the anti-abuse stack looks for;
- streams answers as *patches against a JSON document*, not as tokens.

Replaying all of that from Node means standing up a browser anyway. So the
gateway does exactly that, and keeps the browser for the life of the account:

| Concern | How the gateway handles it |
|---|---|
| TLS / HTTP2 fingerprint | the browser's own network stack issues every request |
| Header set and order | the browser sets its own; the gateway adds only the app-level `x-client-*` headers |
| WAF / CloudFront | solved by the browser as it browses, not by a solver |
| Device identity | minted once per profile by the site's own SDK, then reused forever |
| Proof of work | DeepSeek's own wasm, executed in the page |
| Login (now encrypted + MFA) | done by hand in a visible window; the gateway only reads the result |

A measurement drove the design: replaying the same turn from a captured token
worked, but the *profile* is what makes the device stable, and the device is what
keeps the account alive. See [DESIGN.md](DESIGN.md) for the measured protocol and
the reasoning behind each decision.

---

## Requirements

- **Node.js 22.19+** (24 recommended). The server runs TypeScript directly; there
  is no build step.
- **Google Chrome** installed (the gateway launches it with `channel: "chrome"`).
- One or more DeepSeek accounts that can sign in at <https://chat.deepseek.com>.

## Install

```sh
cd dswg
npm install            # installs playwright; Chrome itself is already on the machine
npm start              # http://127.0.0.1:8787
```

On first boot the gateway creates `dswg/data/`:

```
data/
  gateway.db          SQLite: accounts, API keys, usage
  secret.key          AES-256-GCM key that seals stored credentials
  profiles/<slug>/    one Chrome user-data directory per account
  identities/<slug>.json   a human-readable record of what each profile minted
```

Open <http://127.0.0.1:8787/admin> for the dashboard.

## Add an account

Two ways, both keep one profile per account.

**1. Sign in inside a fresh profile (normal case).**

Dashboard → *Accounts* → **Add account**. Enter a label and, optionally, the
email and password. A Chrome window opens on the DeepSeek sign-in page; sign in
(including any verification code), and the gateway captures the session:

- bearer token, cookies;
- `x-device-id`, the `did` query parameter, and the Shumei fingerprint;
- the user id and the browser's User-Agent.

The dialog reports each phase (`opening → waiting → detected → verifying → done`),
then the account appears as **active** with its device id.

**2. Adopt a profile that is already signed in.**

```sh
node scripts/import-profile.ts --profile "D:\some\chrome-profile" --email you@example.com
# then, with the server running:
curl -X POST http://127.0.0.1:8787/admin/api/accounts/<id>/check
```

The profile directory is linked (not copied) into `data/profiles/`, and `check`
reads the token and device ids straight out of it.

**3. When the site asks for a captcha.**

DeepSeek shows a human-verification challenge when it doubts the session, and that
challenge scores the browser it is running in. A window the gateway drives is a
window it can refuse, however carefully the puzzle is solved — the usual symptom
is "try again" forever on a captcha that looks correct.

**Sign in with Chrome** is the default for both *Add account* and *Relogin*. It
opens *the same profile directory* in your installed Chrome — no debugger, no
automation flags, nothing to detect — and then watches that profile:

- every 1.5 s it reads the profile's own local storage, which is where a successful
  sign-in writes the token and both device ids;
- the moment they appear, the account is adopted: **active**, with its device ids
  recorded, and the dashboard row changes by itself;
- **the window does not have to be closed first** — sign in, and the gateway has
  the session while the window is still open;
- when the window is closed, it fills in what only the page can answer (the user
  id, the user agent the site saw) and records a mute if the account carries one;
- on boot, a profile holding a session the database does not know about is adopted
  the same way, so a restart in the middle of a sign-in loses nothing.

The dashboard also warns in the capture dialog as soon as a challenge is on screen,
so a stuck sign-in says why instead of waiting silently.

Two properties make this work, and both are enforced:

- **No automation flags.** Playwright disables Chrome's sandbox by default, which
  raises an "unsupported command-line flag" banner and looks like a test harness.
  The gateway turns the sandbox back on and drops `--enable-automation`, so
  `navigator.webdriver` is `false`.
- **No headless tell.** Headless Chromium writes `HeadlessChrome/…` into the user
  agent, and the site reads that string from the page *and* from every request
  header. The gateway sends the profile's own user agent with that token removed.
  Set `DSWG_HEADLESS=0` to run visible windows instead.

> A profile is the account's device. Do not copy one profile between two
> accounts: two accounts sharing one device is exactly the pattern the anti-abuse
> stack watches for. The gateway creates a separate profile per account for you.

## Create an API key

Dashboard → *API keys* → **Create key**. Pick the accounts the key may use (leave
empty for all of them), optionally restrict models and set a requests-per-minute
cap. The secret (`sk-dswg-…`) is shown exactly once; only its hash is stored.

Requests without a key get `401`. A key whose accounts are all unavailable gets
`429` with `code: "no_account_available"` and a `Retry-After`. Revoked keys stay
listed for audit; delete one — or every revoked key at once — from the same tab.

---

## Using it

### OpenAI SDK

```python
from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:8787/v1", api_key="sk-dswg-...")

stream = client.chat.completions.create(
    model="deepseek-chat",
    messages=[{"role": "user", "content": "Hello"}],
    stream=True,
)
for chunk in stream:
    print(chunk.choices[0].delta.content or "", end="")
```

Tool calls arrive in the standard shape:

```python
tools = [{
    "type": "function",
    "function": {
        "name": "get_weather",
        "description": "Current weather for a city.",
        "parameters": {"type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"]},
    },
}]
completion = client.chat.completions.create(
    model="deepseek-chat", tools=tools,
    messages=[{"role": "user", "content": "Weather in Paris? Use the tool."}],
)
call = completion.choices[0].message.tool_calls[0]
# finish_reason == "tool_calls"; call.function.name == "get_weather"
# call.function.arguments == '{"city":"Paris"}'
```

### Anthropic SDK

```python
from anthropic import Anthropic

client = Anthropic(base_url="http://127.0.0.1:8787", api_key="sk-dswg-...")

message = client.messages.create(
    model="deepseek-chat",
    max_tokens=1024,
    messages=[{"role": "user", "content": "Weather in Tokyo? Use the tool."}],
    tools=[{"name": "get_weather", "description": "Current weather.",
            "input_schema": {"type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"]}}],
)
block = message.content[0]   # {"type": "tool_use", "id": "...", "name": "get_weather", "input": {"city": "Tokyo"}}
# stop_reason == "tool_use"
```

Streaming emits the real Anthropic event sequence: `message_start`,
`content_block_start`, `content_delta` (`text_delta` / `thinking_delta` /
`input_json_delta`), `content_block_stop`, `message_delta`, `message_stop`.

### Models

The web product has one model with two switches, so a model id here names a mode:

| id | Thinking | Web search |
|---|---|---|
| `deepseek-chat` *(default)* | – | – |
| `deepseek-reasoner` | ✓ | – |
| `deepseek-search` | – | ✓ |
| `deepseek-reasoner-search` | ✓ | ✓ |

Aliases are accepted (`deepseek-r1`, `deepseek-v3`, `deepseek-thinking`, …), and an
unknown id falls back to `deepseek-chat` rather than failing.

`reasoning_content` carries the thinking text on the OpenAI surface; Anthropic
clients receive it as a `thinking` block when they request extended thinking.

---

## Tool calling without a native channel

The web model has no `tools` field, so the gateway teaches a format and reads it
back:

```
<tool_call>
{"name": "get_weather", "arguments": {"city": "Paris"}}
</tool_call>
```

Measured against the current web model, that is the shape it produces natively —
the statement in [src/tools/protocol.ts](src/tools/protocol.ts) matches what the
model already does, which is why it is followed reliably.

Reading is deliberately more tolerant than writing. A reply is scanned for every
shape the model is known to produce when a long context degrades it:

| Shape | Handled |
|---|---|
| `<tool_call>{json}</tool_call>` (taught) | ✓ |
| `<｜tool_call｜>`, `<|tool_call|>` special-token framing | ✓ |
| `<tool_calls><invoke name="x"><parameter …>` (DSML) | ✓ |
| a bare JSON object at the start of a line | ✓ (only when it names a declared tool) |
| a fenced ```json block | ✓ (only when it names a declared tool) |
| the provider's own `{"tool_calls": [...]}` array | ✓ |
| JSON cut off by a length limit | ✓ salvaged by closing it |
| trailing commas, smart quotes, bare keys, raw newlines, comments | ✓ repaired |
| a tool name in the wrong case or camelCase | ✓ resolved against the declarations |
| a numeric string for an `integer` argument | ✓ coerced to the schema type |
| `<invoke name="x">` with no `<tool_calls>` wrapper | ✓ read from the element |
| a parameter written as a bare element (`<content>…</parameter>`) | ✓ |
| a stray `</parameter>` left between two parameters | ✓ ignored |
| the element's closer quoted inside its own argument | ✓ the argument wins |
| a key the model never gave a value to | ✓ dropped, reported as missing |
| many calls in one reply, however the stream splits them | ✓ all of them |
| an argument that itself contains `</tool_call>` | ✓ the payload survives |
| an element the model was still writing | ✗ reported, never half-run |

And when a turn produced nothing usable *and nothing has been streamed yet*, it is
sent once more in a clean context with a correction — which is exactly the failure
mode a long, rotated context produces. Three cases qualify:

- the reply was call-shaped but no call could be read from it;
- the markup parsed into nothing;
- the model **answered in the tool's voice** — wrote `Tool result:` itself, or
  pasted a result back verbatim instead of calling the tool. That reply is
  discarded and the correction says the model cannot see tool results at all.

Nothing is executed from a reply whose only markup is being *talked about*: a
fenced code listing, a quoted fixture, a parameter value that holds this format,
or a payload whose header was lost. Those are prose, and an explanation *of* the
format must not run. An unfinished element is likewise refused — writing half a
file is worse than spending a retry.

Precedence matters where the site contradicts itself. A refusal whose wording
describes a temporary condition ("server is temporarily unavailable") is read as
retryable even when it arrives under an authorization code, because the other
reading parks a working account until a human logs in again.

---

## Errors

Every failure is classified once, then rendered in the calling API's envelope.

| Condition | HTTP | OpenAI `code` | Anthropic `type` |
|---|---|---|---|
| dead session / expired token | 401 | `account_session_expired` | `authentication_error` |
| account muted by DeepSeek | 429 | `account_muted` | `rate_limit_error` |
| rate limit | 429 | `rate_limit_exceeded` | `rate_limit_error` |
| device refused | 429 | `device_risk_refused` | `rate_limit_error` |
| upstream busy | 503 | `upstream_busy` | `overloaded_error` |
| WAF interception | 503 | `upstream_waf_challenge` | `api_error` |
| captcha / human verification | 503 | `upstream_waf_challenge` | `api_error` |
| conversation too long | 400 | `context_length_exceeded` | `invalid_request_error` |
| key has no usable account | 429 | `no_account_available` | `rate_limit_error` |
| invalid request | 400 | `invalid_request` | `invalid_request_error` |

A mid-stream failure emits an `error` event in the stream's own format rather than
truncating silently. `Retry-After` is set whenever the wait is known.

## Retries

A refusal that describes a condition clearing on its own — "server is busy",
"temporarily unavailable", "service unavailable", "too many requests", a 502/503
page, a dropped connection — is **retried on the same account** with exponential
backoff and jitter, before the gateway gives up:

```
attempt 1  →  busy
   wait ~700 ms
attempt 2  →  busy
   wait ~1.4 s
attempt 3  →  answer            ← returned normally
```

- Budget is **time first**: a turn may keep retrying for `DSWG_RETRY_BUDGET_MS`
  (default 90 s), up to `DSWG_TRANSIENT_RETRIES` (default 8) extra attempts —
  whichever runs out first. The site throttles in windows of roughly three
  minutes, so an attempt count alone gives up while the window is still open.
- Delays: `DSWG_RETRY_BASE_MS` (700) doubling to `DSWG_RETRY_MAX_MS` (15 s), plus
  up to 250 ms jitter.
- Repeated busy refusals on one account widen its cooldown 15 s → 30 s → 60 s →
  120 s → 180 s, which is the observed window; the `Retry-After` the client sees
  matches it.
- **Retries stop the moment any text has reached the client.** Restarting after a
  partial stream would duplicate output, so a failure mid-answer is surfaced, not
  silently replayed.
- A client disconnect cancels a pending retry.
- Only after the retries are spent does the request fail over to another account
  in the key's scope, and only then does it return `503` / `429` with
  `Retry-After` set from the account's cooldown.
- **A key whose only account is resting waits for it.** When every account a key
  allows is cooling down, muted until a stated time, or paced, the request is not
  refused: the moment the account wakes is known, so the request holds until then
  and runs. The wait is capped by `DSWG_WAIT_FOR_ACCOUNT_MS` (default 5 minutes,
  which covers the site's observed throttle window); a window longer than that is
  refused with `429` and a `Retry-After` naming it. An account that needs a human
  — a re-login, a disabled row — is never waited on, and a client that disconnects
  ends the wait immediately. Each wait is recorded as a `turn.wait` event in the
  request log.

Deliberately **not** retried: a dead token (`reauth`), a mute (time only), a
refused device (retrying is another flag), and a malformed request.

## Account health

- **Every turn is a fresh chat.** A web chat accumulates turns server-side, and a
  long accumulated context is where tool-call formatting degrades first. Each
  request starts clean. (Set `DSWG_SESSION_CLEANUP=1` to delete the throwaway
  chat afterwards.)
- **One turn at a time per account**, with a configurable minimum gap and a
  per-minute ceiling — the site throttles by account.
- **A mute is never retried.** It is detected in the response body (where DeepSeek
  reports it, under HTTP 200), the account is marked, and the request fails over
  to another account in the same key scope.
- **A dead token is never rotated silently into a login burst.** The account is
  marked `reauth` and the dashboard offers a one-click re-login.

---

## When the parser misses: the corpus and the learning loop

A tool call that is not recognised is the most expensive bug in the system: the
call never runs, the raw markup is shown to the user, and to the model the action
returned nothing.

**Everything is captured.** Every turn's raw stream and assembled text are stored
(`data/raw/<day>/<turn>.json.gz`, pruned by age), with metadata in `raw_turns`.

**Misses are named.** When a reply with tools declared contains a call-shaped
signal — a declared tool name next to a JSON object, a stray `</tool_call>`, an
`"arguments"` key — but no call registered, the turn is recorded as a **leak**,
with the text that produced it.

**Recovery runs before the leak is declared.** After the primary reader finishes:

- an `<invoke>` element whose wrapper was eaten is read whole — its parameters,
  a bare element naming an argument, a stray closer, an element closer quoted
  inside a value;
- every balanced JSON object *anywhere* in the reply is tried as a call (not just
  at the start of a line or inside a fence);
- a closer with no opener pulls the nearest preceding object in;
- Python/JS dialects are normalised (`None`, `True`, `'quotes'`, trailing commas);
- wrapper objects are unwrapped (`{"tool": …, "parameters": …}`,
  `{"function": {"name": …, "arguments": "…"}}`);
- `tool(city="Paris")` call syntax is parsed;
- a long object repeated verbatim is collapsed to one copy.

A recovered call must name a tool the request declared — recovery can find a call
the reader missed, never invent one. Recovery also refuses material that only
*mentions* a call: a fenced listing, a string literal, a value being written, or
an element left open. `salvageCalls` reports that distinction as `unrecovered`, so
a reply that talks about the format is answered as prose while a reply that tried
to call is retried.

**Then the delimiters are learned.** `Mine corpus` (dashboard) or
`node scripts/mine.ts --apply` reads the leaks, induces every suffix/prefix pair
of the surrounding context, and keeps only pairs that recover at least two leaks
**and** never fire on replies that were plain prose. The winner is tightened to
its most general form at a token boundary, stored, and used by the reader from the
next turn on. That is how a format nobody wrote a parser for becomes readable.

```
Mine corpus        →  opener "BEGIN_CALL"  closer "END_CALL"  hits=4 falsePositives=0 score=4
```

## Forensics: finding what a mute correlates with

A mute is asynchronous — DeepSeek issues it minutes to hours after whatever
earned it, and delivers it inside an ordinary response. By the time it appears,
the traffic that caused it is over. So the gateway records everything it does,
permanently:

| Event | What it holds |
|---|---|
| `turn.start` | account, mode, thinking/search, tool names, message count, prompt size + SHA, prompt head and tail, device id, `did`, profile slug, browser UA, gap since the last turn on that account |
| `turn.http` | one row per upstream call: path, method, status, duration, **the exact request headers the browser sent** (token/cookie/PoW replaced by length + SHA), response headers, byte counts, and the response body for any refusal |
| `turn.end` | finish reason, token count, output size, tool calls, elapsed time, reader diagnostics |
| `turn.verdict` | the parsed refusal, raw payload included |
| `turn.retry` | a turn retried because its tool markup was unreadable |
| `account.state` | every transition (`active → muted`, `→ reauth`, cooldown) with the evidence that caused it |
| `account.identity` | what a profile minted, so a device change is visible in the timeline |

Two sinks: `wire_log` in SQLite for the dashboard, and append-only
`data/logs/wire-YYYY-MM-DD.jsonl` that survives a crash or a deleted database.

Credentials are never written. A token is `len=64,sha=a3a61d75` — enough to see
*whether the token changed* between two turns, which is the question that matters,
without storing a credential.

Browse it at **Logs** in the dashboard (filter by account, kind and window; click
a row for the full payload), or export the whole window as JSONL:

```sh
curl -s "http://127.0.0.1:8787/admin/api/logs/export?minutes=10080" -o week.jsonl
jq -r 'select(.kind=="account.state") | "\(.iso) \(.accountId) \(.data.to) \(.data.reason)"' week.jsonl
```

A useful first question when an account is muted: take its `turn.start` rows,
sort by time, and look at the `gapMs` series and the prompt sizes right before the
`account.state` transition.

## Configuration

Environment variables, all optional:

| Variable | Default | Meaning |
|---|---|---|
| `DSWG_PORT` | `8787` | listen port |
| `DSWG_HOST` | `127.0.0.1` | bind address; loopback by default |
| `DSWG_HOME` | `dswg/data` | state directory |
| `DSWG_ADMIN_TOKEN` | – | required for `/admin` from another machine |
| `DSWG_CHROME_CHANNEL` | `chrome` | Playwright channel, or a path to an executable |
| `DSWG_CHROME_ARGS` | – | extra Chromium flags |
| `DSWG_HEADLESS` | `true` | run profiles headless (adding an account always opens a window) |
| `DSWG_ACCOUNT_MIN_GAP_MS` | `1500` | minimum spacing between turns on one account |
| `DSWG_ACCOUNT_RPM` | `20` | turns per minute per account |
| `DSWG_MAX_QUEUE` | `8` | queued turns accepted per account |
| `DSWG_BROWSER_IDLE_MS` | `600000` | idle time before a profile is closed |
| `DSWG_TURN_TIMEOUT_MS` | `600000` | wall-clock budget for one turn |
| `DSWG_STREAM_IDLE_MS` | `150000` | stall detection between stream chunks |
| `DSWG_HEALTH_CHECK_MS` | `600000` | how often warm profiles are probed for expiry; `0` disables |
| `DSWG_MAX_PROMPT_CHARS` | `1000000` | safety ceiling for one prompt (the site allows 2,621,440) |
| `DSWG_SESSION_CLEANUP` | `false` | delete each turn's upstream chat afterwards |
| `DSWG_RETRY_MALFORMED_TOOL_CALL` | `true` | retry a turn whose tool markup was unreadable |
| `DSWG_TRANSIENT_RETRIES` | `8` | max extra attempts after a busy / rate-limited / 5xx refusal |
| `DSWG_RETRY_BASE_MS` | `700` | first backoff delay, doubled per attempt |
| `DSWG_RETRY_MAX_MS` | `15000` | ceiling for one backoff delay |
| `DSWG_WAIT_FOR_ACCOUNT_MS` | `300000` | how long a request may wait for a resting account (0 = fail fast) |
| `DSWG_RETRY_BUDGET_MS` | `90000` | total time one turn may spend riding out a transient refusal |
| `DSWG_LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |

## Security

- The admin API is **loopback-only** unless `DSWG_ADMIN_TOKEN` is set.
- API keys are stored as SHA-256 hashes; the plaintext exists only in the creation
  response.
- Tokens, cookies and passwords are sealed with AES-256-GCM using
  `data/secret.key` (created `0600`).
- Browser profiles hold live session cookies. Treat `data/profiles/` like a
  browser profile directory: personal, not for sharing or syncing.
- Bind to `127.0.0.1` unless you put the gateway behind your own auth.

## Limitations

- **Text only.** Images and documents in a request are reported as omitted rather
  than silently dropped, and there is no upload path yet.
- **No native `temperature`/`top_p`/`max_tokens`.** The web endpoint takes none of
  them; `stop` is honoured by the gateway while relaying, and `max_tokens` is
  advisory.
- **One process per data directory.** SQLite in WAL mode plus in-memory browser
  state; do not run two gateways against one `DSWG_HOME`.
- **Accounts must be added interactively.** The login endpoint now encrypts its
  request body and can demand an MFA code, so a headless credential login is not
  offered by design.

## Operating it

```sh
npm run doctor     # is the install healthy? (Chrome, database, profiles, keys)
npm run soak       # long-horizon mixed workload, reports latency/memory/handles
npm run replay     # re-parse every captured model output with the current reader
npm run reset -- --yes            # clear keys/usage/logs/corpus, keep accounts
npm run reset -- --yes --all      # full wipe: profiles, identities, database
```

`soak` drives real turns through a running gateway — plain, streaming, tool call and
tool-result round trip — then prints p50/p95 latency per workload and how RSS and the
handle count moved. `replay` runs the reader over the corpus: it answers "did a
change break an output that used to parse, or fix one that used to leak" without
waiting for the model to reproduce a shape.

`doctor` exits non-zero when something that will fail later is already wrong — no
Chrome, a corrupt database, an account with no captured device id, a missing
profile, or no usable API key.

`reset` refuses to run without `--yes`, and keeps browser profiles by default
because a profile *is* the account's device identity: deleting it means redoing a
hand login.

### Production checklist

- [ ] `DSWG_ADMIN_TOKEN` set if anything other than `127.0.0.1` can reach the port.
- [ ] `DSWG_HOST` kept at loopback unless the gateway sits behind your own auth.
- [ ] `npm run doctor` green.
- [ ] One account per DeepSeek login; never share a profile between accounts.
- [ ] Keys scoped to the accounts they should use, and revoked when retired
      (revoked keys can also be deleted outright, individually or in bulk).
- [ ] `data/` backed up if you care about usage history; `data/secret.key` and
      `data/profiles/` are as sensitive as a browser profile.

## Development

```sh
npm test           # 195 unit and integration tests, no network needed
npm run typecheck  # strict TypeScript over src and test
```

The suites are organised by the question a failure answers:

| Suite | What it holds |
|---|---|
| `parser`, `salvage` | every reply shape, read directly |
| `cross` | the reply corpus through the real HTTP surface, in both dialects, streaming and not |
| `horizon` | a growing conversation against a model that keeps degrading |
| `faults` | split characters, bad patches, streams that stop early, payloads holding their own closer |
| `engine`, `pool`, `http`, `stream` | retries, rotation, pacing, both error envelopes |
| `store` | SQLite, sealed credentials, key scoping |

`cross` is the one that matters most for a client: it drives the fixtures through
`/v1/chat/completions` and `/v1/messages` and reads the result the way a client
would, so a reply that arrives as prose or as the wrong call fails there rather
than in production. Its fixtures live in
[test/fixtures/replies.ts](test/fixtures/replies.ts) — real captured replies plus
the shapes they named.

Two commands answer questions about live traffic rather than code:

```sh
npm run replay     # re-read every captured turn with the current reader
npm run doctor     # pre-flight: Chrome, database, identities, profiles, keys
```

Layout:

```
src/
  browser/     per-account Chrome profile, the in-page runtime, the pool
  upstream/    completion-stream decoder and verdict classification
  engine/      prompt building, account selection, health, turn orchestration
  tools/       the taught protocol, the multi-format extractor, JSON repair
  api/         OpenAI and Anthropic adapters, admin API
  store/       SQLite repositories
  util/        logging, errors, crypto, HTTP, async
ui/            the dashboard (vanilla ES modules)
test/          node:test suites
```

## Licence

Personal use. It drives a normal web login, not the paid platform API; DeepSeek's
terms and rate limits still apply.
