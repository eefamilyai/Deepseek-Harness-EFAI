# DeepSeek Web Gateway (dswg) — recon and build record

Job: build a multi-account, key-scoped, OpenAI/Anthropic-compatible API gateway
over DeepSeek **web** accounts, with one Chromium profile per account, replacing
the older `python/kiln/runtime/ds_direct.py` connector whose accounts kept getting
muted.

Started 2026-10-24. Everything below is measured on this machine.

---

## 1. Prior art on disk (read first, do not re-derive)

- `python/kiln/runtime/ds_direct.py` — working Python connector: login, pow, SSE,
  session pinning, mute/auth verdict handling.
- `ds_profile.py` — per-account Chrome profile + identity capture (the idea the
  new gateway is built on).
- `ds_identity.py` — UA/client-hint/WAF fingerprint derivation.
- `.recon/ds-direct-mute-investigation.md`, `.recon/ds-mute-findings-summary.md`
  — what was tried about mutes: nine defects fixed, root cause not isolated, the
  72h/216h mute durations, the deterministic 10-turn rate-limit cycle.
- `.recon/ds-direct-flagging.md` — browser-vs-connector header diff from a real
  HAR.

Conclusion taken from them: the client-side differences that remain are about
*identity* and *request shape*, so the new build issues requests from the
account's own browser instead of reconstructing them.

## 2. Live protocol, measured 2026-10-24

Captured with Playwright driving installed Chrome 155 against a signed-in profile
(`.recon/dsw-live/`): `load-*.json`, `login.json`, `turn1.json`, `turns2.json`,
`toolformats.json`, `seeded.json`, `main.js` (site bundle). The probes that
produced them are kept in `dswg/recon/01-…08-*.mjs`.

- Model catalogue is now **one** enabled model: `default` ("Instant"); `expert`
  and `vision` are disabled in settings. Thinking and search are toggles.
- `/users/login` body is now **encrypted** (`x-request-encryption-key`), and the
  test account answers `biz_code: 14 MFA_VERIFICATION_CODE_REQUIRED`.
- `x-hif-leim` rides only `/chat/completion`, minted by a poller against
  `hif-leim.deepseek.com`; a completion without it succeeds.
- Client hints are the triple only; nine would assert an ungranted state.
- Completion stream is patch-based (`{p,o,v}`), fragments `THINK`/`RESPONSE`/`SEARCH`/`REQUEST`,
  bare `{v:"text"}` appends, and the stream continues after `FINISHED`.
- In-page fetch (real profile, real cookies, wasm pow in 78 ms at difficulty
  144000) completed a full turn in 820 ms — this is the transport the gateway uses.
- Tool-call behaviour: with no instruction the model already emits
  `<tool_call>{json}</tool_call>`. With the taught statement it follows it exactly
  on every probe (`toolformats.json`). This is why the taught format is that one,
  and why DSML-style parsing is kept only as a tolerant fallback.

## 3. What was built

`dswg/` — Node 24, TypeScript run directly (no build), `node:sqlite`, one
dependency (`playwright`).

- `src/browser/` — per-account persistent Chrome profile, in-page runtime
  (`page-runtime.js`: identity, wasm pow, SSE relay, abort), pool with one-turn
  concurrency, pacing, idle eviction.
- `src/upstream/` — the patch-stream decoder and the verdict reader (HTTP 200
  refusals, mute deadlines, WAF shape).
- `src/engine/` — prompt building, account selection, health state machine, turn
  orchestration with failover and a single repair retry.
- `src/tools/` — the taught protocol, the multi-format extractor, JSON repair.
- `src/api/` — OpenAI + Anthropic adapters (streaming and not), admin API.
- `ui/` — the dashboard (accounts, keys, usage).

## 4. Verification

- 66 unit/integration tests (`node --test "test/**/*.test.ts"`), no network.
- Live, against a real account, headless Chrome, through the HTTP surface:
  - non-streaming completion → `gateway-ok` in 1.06 s;
  - streaming → correct `chat.completion.chunk` deltas ending in `[DONE]`;
  - OpenAI tools → `finish_reason: "tool_calls"`, `arguments: {"city":"Paris","unit":"c"}`;
  - full tool loop (assistant call → tool result → prose answer) → 1.2 s;
  - streaming tool delta → `tool_calls` chunks + `finish_reason: tool_calls`;
  - Anthropic tools → `tool_use` block, `stop_reason: "tool_use"`;
  - Anthropic streaming → `message_start … content_block_delta(input_json_delta) … message_stop`;
  - bad key → 401 `authentication_error`; empty messages → 400.

## 4b. Forensic record (added after the first review)

The operator asked for everything to be logged so a mute can be explained after
the fact. Every upstream interaction and every account-state change is now
recorded twice: `wire_log` in SQLite (dashboard) and append-only
`data/logs/wire-YYYY-MM-DD.jsonl` (survives a crash or a deleted database).

- `turn.start` — mode, tools, message count, prompt size + SHA, prompt head/tail,
  device id, `did`, profile slug, browser UA, and `gapMs` since the account's
  previous turn.
- `turn.http` — per upstream call: path, method, status, duration, the exact
  request headers the browser sent (authorization / cookie / `x-ds-pow-response`
  replaced with `len=…,sha=…`), response headers, byte counts, and the response
  body for a refusal.
- `turn.end`, `turn.verdict`, `turn.retry`, `account.state`, `account.identity`.

Browsable at the dashboard's **Logs** tab, or exportable with
`GET /admin/api/logs/export?minutes=…` as JSONL for grepping and diffing.

Verified live: 40 events for 4 turns, header sets intact, refusals captured with
their body.

## 4c. Corpus and parser learning (second review)

The operator reported tool calls that leaked as raw text. Added:

- **Raw capture** of every turn (`data/raw/<day>/<turn>.json.gz` + `raw_turns`).
- **Leak detection**: a reply that is call-shaped (declared tool name beside a JSON
  object, stray `</tool_call>`, `"arguments"` key) but registers no call is
  recorded in `leaks`.
- **Salvage** (`tools/salvage.ts`): every balanced object anywhere in the text,
  orphan-closer pairing, Python/JS dialect normalisation, wrapper unwrapping,
  `name(k=v)` syntax, repeated-blob collapse. Only declared tools are accepted.
- **Induction** (`tools/learn.ts`): suffix×prefix delimiter candidates from leaks,
  validated by running the real extractor over leaks (positives) and prose
  (negatives), then tightened at a token boundary.

Verified: with four synthetic `BEGIN_CALL … END_CALL` leaks and two prose samples,
`POST /admin/api/mine` induced exactly `BEGIN_CALL` / `END_CALL` (hits=4,
falsePositives=0) and stored it; the reader uses stored patterns from the next
turn. Synthetic rows were removed after the check.

## 4d. Retry policy and production cleanup (third review)

Two operator reports:

1. **"Is it hardened against errors?"** — no. A `Server is temporarily
   unavailable` hint was not matched by the busy rules, so it became a generic
   upstream verdict → 502, and the engine only failed *over* (nothing to fail over
   to with one account). Fixed:
   - the busy rule now covers `temporarily unavailable`, `service unavailable`,
     `try again later`, `please retry`, 502/503/504 wording, and the Chinese
     equivalents;
   - transient kinds (`busy`, `rate_limit`, `upstream`, `network`, `waf`) are
     retried on the same account with exponential backoff + jitter
     (`DSWG_TRANSIENT_RETRIES`, base 700 ms, cap 6 s) before any failover;
   - a retry is abandoned once text has reached the client, because restarting
     would duplicate output;
   - only after the budget is spent does the request fail over, then return
     503/429 with `Retry-After`.

2. **Test debris in the install** — 14 smoke keys, 50 usage rows, 191 wire rows,
   20 captured turns, screenshots in `data/`, and an account labelled
   `test-account`. Fixed:
   - `scripts/reset.ts` (refuses without `--yes`, keeps profiles/accounts by
     default, `--all` for a full wipe, `--keep-usage`/`--keep-logs` to narrow);
   - `scripts/doctor.ts` — Chrome, database integrity, secret key, accounts,
     identities, profiles, active keys, non-zero exit on failure;
   - keys can now be **deleted** (`DELETE /admin/api/keys/:id`) and revoked keys
     cleared in bulk (`POST /admin/api/keys/clear-revoked`) — before this, revoke
     was the only path and the rows were permanent;
   - the install was reset and verified: 1 account (`main`), 0 keys, 0 usage, 0
     log rows; a temporary key proved a live completion and a live tool call, then
     was deleted.

Tests: 89 pass (4 new: transient wording, retry-then-succeed on one account,
rate-limit retry, and no-retry-after-output).

## 4e. Long-horizon test campaign

Built three harnesses: an injectable server (`buildServices` / `createApp` /
`start({pool})`) so failure paths are testable at HTTP level, `scripts/soak.ts`
(live mixed workload with latency/memory/handle reporting) and `scripts/replay.ts`
(every captured model output re-parsed by the current reader).

Bugs the campaign found and fixed:

1. **A synchronous throw in a route handler produced no response at all.**
   `Promise.resolve(handler(ctx))` evaluates the call first, so `GET /v1/models`
   without a key hung the connection instead of returning 401. Any admin route
   rejecting a missing account had the same shape. Now the call is deferred inside
   `Promise.resolve().then(...)`.
2. **`close()` never closed SQLite.** The database handle outlived the server; on
   Windows the temp data directory could not be removed (EPERM) and an in-process
   restart would have hit a locked file.
3. **Worker failure kinds were rendered as 502.** A page-level refusal or a dropped
   connection bypassed the verdict model; a `FAILURE_TO_VERDICT` table now maps
   `response`/`network`/`browser`/`pow` → `busy` so the status, the retry policy
   and the client's `Retry-After` agree.
4. **Leak detection fired on ordinary prose** — 11 of 23 real captured replies were
   recorded as leaks because "a declared tool name appears near a brace" matched
   text like ``open(p,\"a\")``. The learner would have been trained on noise.
   Detection is now structural (markup markers, `name(args)` with an attached paren
   and an argument-shaped body, or a tool name written as a JSON value), with `.`
   and `$` excluded from the boundary so `x.read()` is not a call.
5. **Salvage could execute a call the model merely described.** A 62k-character
   reply quoting `{"name":"kernel","arguments":{…}}` mid-essay would have run it.
   Recovery now only accepts a call in the last 400 characters of a reply (or
   anywhere in a reply shorter than 1000), and such replies are recorded as leaks
   without executing.
6. **Session expiry was invisible until a client turn failed.** A periodic
   warm-profile probe (`DSWG_HEALTH_CHECK_MS`, 10 min) marks the account `reauth`
   as soon as the upstream says `40003`.
7. **A locked profile produced a wall of Chromium launch flags.** It now reads
   "the browser profile for X is already open in another Chrome window".

Verified under load: one turn at a time per account, queue limit → 503, configured
pacing, idle eviction, gate release after a throw, 8 concurrent requests, client
disconnect mid-stream, per-key rpm, and both error envelopes. Live soak also
confirmed the expiry path end to end: the stored token now answers `40003`, the
account is marked `reauth`, later requests get `429 no_account_available` with a
reason, and no handle or memory growth appeared (rss 119 → 124 MB over the run).

Test suite: 137 tests across 18 suites.


## 4f. Cross-parser campaign and the defects it found (fourth review)

The open question from §4e was whether the reader is as good as the one the client
already ships. The DeepSeek Harness checkout keeps a far more developed text
tool-call reader at `packages/llm/llm-text-toolcalls/src/` (143 KB of `dsml.ts`
alone), and it imports cleanly under plain Node 24 type-stripping, so it can be
run as an oracle over the same corpus.

`scripts/oracle.ts` compares both readers on 159 replies: the 23 captured turns in
`data/raw` plus the 141 recorded leak transcripts in `.recon/leak-records.json`.
It reports four buckets — both dispatch, both see prose, harness only (a miss), and
ours only. The 141 leak records are not incidental: they are the replies this
machine's own agent produced while *building* the harness reader, which is exactly
the corpus that contains the degraded shapes a real agent loop hits.

Eleven defects came out of the campaign. Ordered by how much damage each would
have done:

1. **Only one envelope was read per chunk.** `#drain` returned after each unit of
   work, so a reply carrying forty calls in one stream chunk yielded one call and
   silently dropped thirty-nine. `multi-call` passed by luck (the test's chunk
   boundary happened to split the two blocks). Fixed by continuing the drain loop
   until nothing more is decidable.
2. **A payload could end its own block.** `{"content":"…</tool_call>…"}` closed the
   envelope inside the JSON string, and the repair then handed `write` a truncated
   file with no error anywhere. The closer search now tracks JSON string state and
   only accepts a closer outside one, at any chunk size.
3. **Streamed tool calls all carried `index: 0`.** An OpenAI client assembles
   `delta.tool_calls` by index, so two calls in one stream became one unparseable
   argument string.
4. **A parameter value was parsed as JSON.** `repairJson("const x = '{…}'")`
   returns the embedded object, so a `write` whose content quoted JSON arrived as
   that object instead of the file. Parameter values are now literal unless the
   element says `string="false"` or the whole value is one container.
5. **A busy refusal under an authorization code parked the account.** The numeric
   code won over the wording, so `{"code":40003,"msg":"Server is temporarily
   unavailable"}` was read as a dead session and the account needed a human login.
   Transient wording now outranks the code.
6. **A cooldown survived its own recovery.** `recover()` inspected the account row
   read when the turn started, which never contains a cooldown the same turn
   wrote, so a busy refusal followed by a successful retry left the account parked
   for its whole cooldown.
7. **A non-streaming request never got the repair retry.** `emittedText` meant
   "text was produced", not "text was delivered"; a non-streaming turn produces
   text before it answers, so every correction retry was suppressed for those
   clients. The flag now means delivery, which is what forbids a retry.
8. **`{"path":` repaired to invalid JSON.** A member that never got a value cannot
   be completed by adding a brace; such a member is dropped and reported missing.
9. **Markup inside code or a string literal executed.** `<tool_call>…</tool_call>`
   in a fenced listing, in a `'…'` literal, or inside an unterminated `<parameter>`
   was read as a call. The reader now tracks open elements and fences, and
   salvage refuses quoted spans — while keeping the case that matters (a fence
   whose whole body is the call).
10. **An `<invoke>` with no wrapper was invisible.** Complete elements are now
    read from the element itself: bare `<content>` tags, stray `</parameter>`,
    an element closer quoted inside a value.
11. **Roleplay went through as an answer.** Five of the 23 captured replies write
    `Tool result:` and then continue as `Assistant:` — the model playing both
    sides. Those replies are now discarded and re-asked with a correction that
    states the model cannot see tool results.

Two decisions instead of fixes, both deliberate:

- **An element the model was still writing is refused, not half-run.** The
  harness reader recovers a truncated `write`; writing half a file is worse than
  spending the retry, and the retry is what the correction exists for.
- **A single known false positive is accepted.** One captured reply embeds a
  complete, balanced `<invoke name="write">` inside a test fixture it is writing
  about this format, outside any fence. Rejecting it would also reject three
  genuine calls in the same corpus, so the balance rule that caught it was
  dropped in favour of the narrower protections (fences, literals, open values).

### Campaign shape

New permanent suites, all offline:

- `test/cross.test.ts` — 24 call fixtures and 5 prose fixtures through
  `/v1/chat/completions` and `/v1/messages`, streaming and not (29 tests).
- `test/horizon.test.ts` — a 16-turn conversation with a growing prompt where the
  model degrades, refuses, drops the connection, roleplays and recovers.
- `test/faults.test.ts` — split multi-byte characters, a patch that is not JSON, a
  stream that stops before its status, an upstream that never sends a byte, a
  payload holding its own closer, 40 calls in one stream, `Retry-After`, an edge
  HTML interception.
- `test/fixtures/replies.ts` — the frozen corpus.

Test suite: 195 tests across 27 suites, `tsc --noEmit` clean.

### Known state

The `main` account is still `reauth`. The stored token answers `40003`
(`Authorization Failed (invalid token)`) from the API directly, so this is a real
server-side expiry and not a gateway fault; `npm run doctor` reports
`FAIL accounts 1 account(s), none active` and everything else green. Live checks
(soak, mute forensics) resume after a login from the dashboard.


## 4g. The browser's own fingerprint (fifth review)

The operator hit two symptoms the campaign had not covered, because both come from
how the browser presents itself rather than from anything the gateway parses.

**"You are using an unsupported command-line flag: --no-sandbox."** Playwright
passes `--no-sandbox` by default (`chromiumSandbox` defaults to `false`). Every
window the gateway opened carried that banner across the top. Fixed by setting
`chromiumSandbox: true`.

**A captcha that would not accept a correct answer.** Playwright also passes
`--enable-automation`, which sets `navigator.webdriver`, and headless Chromium
writes `HeadlessChrome/155…` into the user agent. The challenge widget scores the
browser it is running in, so a window that announces itself as driven is refused
however carefully the puzzle is solved — and every upstream request carried the
`HeadlessChrome` string in its `user-agent` header, which is a stronger signal
than anything the session was doing.

Measured before and after, from inside a launched profile:

```
before: navigator.webdriver = true   ua = … HeadlessChrome/155.0.0.0 …
after:  navigator.webdriver = false  ua = … Chrome/155.0.0.0 …
chrome flags: no --no-sandbox, no --enable-automation
```

Three changes:

- `ignoreDefaultArgs: ['--enable-automation']` and
  `--disable-blink-features=AutomationControlled` (already present) keep
  `navigator.webdriver` false.
- `chromiumSandbox: true` removes the banner and the sandbox downgrade.
- the context is launched with `browserUserAgent(account.userAgent)`, which strips
  the `HeadlessChrome` token from the profile's own user agent. The account's user
  agent is captured during a *visible* login, so it is a real Chrome string.

**A captcha is now a classified failure, not an unexplained busy.** `looksLikeChallenge`
matches the challenge page in HTML or in a message, `readVerdictText` returns a
`waf` verdict for it, and a turn whose stream is nothing but a challenge page is
reported the same way. `waf` is never retried — retrying against a wall is what
made the operator solve the same puzzle repeatedly — and the message says what to
do.

**`Sign in with Chrome`** (`POST /admin/api/accounts/:id/sign-in-native`, button on
the accounts row and in the Relogin dialog) opens the account's own profile
directory in the installed Chrome with no automation attached, waits for that
window to close, and then reads the session the operator created. It is the path
for a sign-in the site gates behind human verification: same profile, same device,
nothing to detect.

The capture dialog also polls the page while it waits and reports as soon as a
challenge is on screen, so a sign-in that needs a human says so instead of sitting
on "sign in in the browser window" for fifteen minutes.

Test suite: 198 tests across 28 suites.

## 5. Still open

- Whether a muted account recovers cleanly through the new transport (needs an
  account to be muted; not induced deliberately). The wire log is what will answer
  this: sort an account's `turn.start` rows by time and read `gapMs`, prompt sizes
  and header fingerprints up to the `account.state` transition.
- Image/document forwarding (currently reported as omitted).
- Induced patterns are only as good as the corpus: with fewer than two leaks a
  shape cannot be learned, so a brand-new format still needs one manual look.
- A long rate-limit window (the site's observed ~181 s cycle) is not waited out
  inside a request: after the short retries the client gets 429 + `Retry-After`.
- Whether `x-hif-leim` matters for accounts under suspicion; it is deliberately
  not synthesized.
