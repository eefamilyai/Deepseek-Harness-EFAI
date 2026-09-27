# SESSION-tool-output-file-delivery.md — tool-result file delivery (oversized-output upload) work log

> Purpose: durable memory across compaction. Append new sections at the bottom as work
> continues. Anything below that is contradicted by later code reading must be corrected
> in place (strike through + correct), not silently left wrong.

## 1. Objective (from the user, verbatim intent)

The harness system prompt / history is large enough that **tool-call outputs get
truncated**. The user wants:

- At every step, tool-call results should be **written to a file and uploaded to the AI**
  (delivered as a file attachment) instead of being sent as plain inline text.
- **If the AI/provider has no upload endpoint, fall back to plain text** (i.e. current
  clipping behaviour) — no choice in that case.
- Scope clarification from the user: **this must NOT be ds-direct-only. It must apply to
  every provider** (example given: ChatGPT / `api.openai.com`). The user's reasoning:
  provider endpoints are assembled in code (just like `/v1/models` is assumed valid), so
  the file-upload endpoint is presumably assembled somewhere too and can be reused.
- Also: **only oversized results should be uploaded** (confirmed via question), not every
  single tool result.
- Housekeeping the user asked for: **maintain this `session.md`**, appending as the session
  continues, containing all recon + progress so a post-compaction AI knows exactly where
  work stopped.

## 2. Key recon findings so far (with exact locations)

### 2.1 The actual truncation site (the bug)

- `python/kiln/runtime/ds_direct.py`
  - `DS_PROMPT_MAX = 48000` — hard ceiling on a DeepSeek prompt (comment says DeepSeek
    rejects oversized prompts with "Content is too long").
  - `_clip_body(body_msgs, budget, primed=True)` at **line 1894** — keeps what fits in
    `budget` chars, drops OLDEST first, never drops pinned messages, never reorders.
    Pinned = genuine user turns (`source-'user'`). `primed` distinguishes threaded vs
    brand-new chat, which only changes the omission note.
  - The omission marker string `"\n[... output truncated to fit the prompt budget ...]\n"`
    is at **line 1884**. **This exact marker exists ONLY in `ds_direct.py`** (verified by
    repo-wide grep) — i.e. the visible truncation the user sees is this path.
  - Also present: `_is_tool_result(msg)` (line ~1845) — "The TypeScript adapter flattens
    every tool result to `OUTPUT:\n<body>`". This is the hook that identifies tool results.
- The marker also appears in `docs/config-catalog.md` and
  `packages/agent-memory/agent-memory/src/index.ts` but for *different* reasons
  (an injected-index char ceiling), not the tool-output path.

### 2.2 Existing spill subsystem (TS) — already solves "keep full text retrievable"

- `packages/spill/spill` — `@deepseek-ai/dsh-spill`
  - `SpillStore extends Service`, registered as `ctx.spillStore`.
  - `abstract saveText(input: SaveTextSpill): Promise<SpillRef>` — persists `input.content`
    to a **session-scoped spill artifact**, returns opaque `SpillRef`, exact byte count,
    and retrieval guidance. Rejects on storage failure (caller decides how to degrade).
  - Deliberately narrow: no retention/replacement/retrieval/search operations.
- `packages/spill/spill-policy` — the transformer that already does "oversized → preview"
  - A **`tools/post-execute` result transformer**. When a final result's UTF-8 size exceeds
    `maxInlineBytes`, it: saves FULL text via `ctx.spillStore`, replaces the model-facing
    result with a **bounded head/tail preview + locator + retrieval guidance**.
  - Registers no service; preview comes from `@deepseek-ai/dsh-output-retention`
    (`TextRetainer`); storage is `ctx.spillStore`.
  - **Omitted `maxInlineBytes` ⇒ plugin registers nothing (true no-op).**
  - Plain-text results only: a result carrying any non-text block is left untouched.
  - Has a `hasSpillNotice(text)` helper with `OPEN`/`CLOSE`/`LOCATION`/`GUIDANCE_SEPARATOR`
    constants and an `isOmission()` check.
  - Second arm: `tools/ptc-dispatch-log` waterfall bounds the `tool/ptc-dispatch` event's
    copy of an oversized `run_code` sub-call result.
- `packages/spill/spill-local` — local persistence backend.
- Files: `packages/spill/spill-policy/src/{index.ts,notice.ts,types.ts}`.

### 2.3 Existing attachment subsystem (TS) — the "upload a file" primitive

- `packages/attachment/attachment` — `@deepseek-ai/dsh-attachment`
  - `AttachmentStore` (abstract Service) with `saveFile` / `saveFileStream` / `readFileStream`
    / `fileHostPath`; `FileAttachmentRef`, `ImageAttachmentRef`, `SaveFileAttachment`,
    `SaveFileStreamAttachment`, `ImageMediaType`, `RequestImageAttachment`.
- `packages/attachment/attachment-local` — `LocalAttachmentStore` (writes under `dshHome`),
  `file-store.ts` helpers (`fileLeafName`, `readFileStreamVerbatim`,
  `saveFileStreamVerbatim`, `saveFileVerbatim`, `storedFilePath`), `image.ts` /
  `detectImage`. Tests: `file-store.spec.ts`, `request-image.spec.ts`,
  `request-image-verification.spec.ts`, `image.spec.ts`.
- Consumers of `@deepseek-ai/dsh-attachment` (from package.json grep): `sdk/server`,
  `session-query/session-log-export`, `llm/llm`, `client/ui-trajectory`,
  `kernel/tool-kernel`, `client/ui-tool`.
- `packages/llm/llm/src/content.ts` defines the bridge:
  - `ImageAttachmentAccess { readonlyPath }` — execution-world read-only path.
  - `ImageAttachmentAccessResolver = (ref: ImageAttachmentRef) => ImageAttachmentAccess | undefined`
  - plus `AttachmentStore`, `FileAttachmentRef`, `ImageAttachmentRef`, `ImageMediaType`,
    `RequestImageAttachment` imports. So **file attachments are already a first-class
    concept in the LLM layer, not just images**.

### 2.4 LLM core content model (TS)

- `packages/llm/llm/src/types.ts` — `ContentBlock` union (text/image/…), `ToolResult`.
- `packages/llm/llm/src/{content.ts,message.ts,assembler.ts,assistant-stream.ts,call-config.ts}`.
- `packages/llm/llm-deepseek/src/adapter.ts`
  - ~line 474: `'DeepSeek image conversion requires the durable attachment service.'`
  - ~492 `attachments,`; ~536 `attachments: AttachmentStore | undefined`;
    ~556 `const resolveImageAccess = attachments === undefined`
    `? undefined : (ref: ImageAttachmentRef): ImageAttachmentAccess | undefined => this.config.resolveImageAccess?.(attachments, ref)`
    ~570 `const requestImages = attachments === undefined || model === undefined …`
  - ⇒ the DeepSeek adapter **already takes an `AttachmentStore` and an image-access resolver**.
    This is the natural insertion point for a *file* (non-image) block.

### 2.5 Kiln adapter (TS) — real, verified upload returning provider file ids

- `packages/llm/llm-kiln/src/bridge.ts`
  - `uploadFiles(...)`: takes **filenames + exact bytes, in upload order**, plus an
    `account` (login to upload as). Returns provider-assigned ids.
  - Upload receipts are per-file; **malformed entries are dropped rather than passing an
    empty id** to a later `ref_file_ids`.
  - Ids are **scoped to the login that uploaded them** — the returned `account` must travel
    with them into that stream call.
  - Stream request carries them as **`opts.ref_file_ids`**.
  - Comment: "The ids that come back are the only way a file reaches a chat".
  - A failed upload **surfaces as a failed turn**, not as a silent model that didn't see it.
  - "does not upload on a route that cannot store files" — i.e. **there is already a
    route-capability concept**.
  - Tests: `packages/llm/llm-kiln/tests/images.spec.ts`
    - `'carries uploaded file ids as ref_file_ids'` (expects `ref_file_ids: ['file-a','file-b']`)
    - `'omits ref_file_ids entirely when nothing was uploaded'`
    - `'does not upload on a route that cannot store files'` → `observed.uploads` length 0
    - `'the upload transport itself throws'` → turn fails
    - `'a delivered image is not …'`
  - NOTE: currently wired for **images** (`describe_files` / vision), not tool results.
- `python/kiln/provider_bridge.py` + `python/kiln/test_provider_bridge_wire.py` — the sidecar
  the TS bridge talks to. Commands seen: `validate`, `configure`, `login`, `stream`, `cancel`;
  frames carry `provider`, `config`, `opts`.

### 2.6 DeepSeek-direct upload endpoint (Python) — already implemented and verified

In `python/kiln/runtime/ds_direct.py`:

- `upload_file(self, filename, blob)` at **line 1148**:
  - `pow_response = solve_pow(self._pow("/api/v0/file/upload_file"))` (line 1164)
  - `r = self.sess.post(f"{BASE}/file/upload_file", headers=headers, …)` (line 1179)
  - Uses a real content type and a `files=`-equivalent; comment at ~1152: curl_cffi rejects
    the requests-style `files=` kwarg, hence the manual multipart.
  - Debug log: `ds_direct upload_file %s -> HTTP %s %s` (line 1185)
  - ~1158: error surfaces as `<reason>` on the attachment chip; `--debug` logs raw response.
  - ~1170–1174: discovered because the attachment path was tried first and the file "went
    straight to the attachment chip".
- `file_status(self, file_ids)` at **line 1215** — polls readiness; posts `{"file_ids": [...]}`;
  ~line 78 comments: the attachment chip is short on purpose, "a file that isn't ready in 20s".
- Comment ~line 130: "ordinary `default` chat as `ref_file_ids`, which is verified working".
- ~line 1223: "verified: an attachment uploaded and read back in the same turn".
- Stream signature at **line 2189**:
  `conv_id=None, preempt=False, account=None, oneshot=False, ref_file_ids=None`
  ⇒ `ref_file_ids` is threaded through the DeepSeek-direct stream call.
- ~line 1630–1636: a `describe_files`/`upload_files` helper exists specifically so callers
  don't reach `_Client.upload_file` directly; "That is what an image attachment …" DESCRIBE
  to the model returns prose.
- `python/kiln/runtime/README.ds-direct.md` **§ "File attachments" at line 356**; ~359: the
  website retired one tier and "the plain modes read attachments"; ~389: losing one of five
  attachments is reported under `errors`.
- `python/kiln/runtime/test_ds_direct_clip.py` — tests for the clipping behaviour.
- `python/kiln/runtime/test_ds_direct_modes.py:187` — "that knows whether losing one of five
  attachments is fatal".

### 2.7 Provider endpoint construction (the "/v1/models analog" the user pointed at)

- TS: `packages/llm/llm-pi-ai/src/discovery.ts`
  - OpenAI-family lists at **`{baseURL}/models`**.
  - Anthropic lists at **`{root}/v1/models`** via
    `return \`${root}/v1/models?limit=${String(ANTHROPIC_MODEL_LIMIT)}\`` (line ~121).
  - Line ~33: Anthropic needs `anthropic-version` at its native `GET /v1/models`; Azure absent.
  - `catalog.ts` (~443–561) documents/validates offered fields, incl. `baseUrl`; test asserts
    `models.every(model => model.baseUrl === 'https://api.openai.com/v1')`.
  - Tests: `tests/discovery.spec.ts` asserts `server.paths` values
    `['/v1/models']`, `['/openai/v1/models']`, `/v1/models?limit=1000`,
    OpenRouter `GET /api/v1/models`, Anthropic `GET /v1/models`.
  - `tests/catalog.spec.ts` asserts `['/v1/chat/completions']`.
- Python providers: `python/kiln/runtime/{providers.py, openai_provider.py,
  anthropic_provider.py, gemini_provider.py, ds_direct.py, config.py, app_settings.py}`.
  **NOT YET READ** — must inspect how base URLs and per-provider paths are built there.

### 2.8 Repo orientation / conventions

- Checkout: `D:\deepseek-kernel-harness` (also the cwd). Git branch `master`, tracking
  `origin/master`.
- **Pre-existing dirty tree at session start** (not mine, do not clobber):
  - `M packages/llm/llm-dsml/src/dsml.ts`
  - `M packages/llm/llm-dsml/tests/llm-dsml.spec.ts`
  - `M packages/session/session-recovery-context/{README.i18n.yaml,README.md,README.zh.md,src/index.ts,tests/session-recovery-context.spec.ts}`
  - `?? .research-compaction/`
- Skills loaded for this work: `dsh-harness-edit` (ownership tier + overlay patch rules;
  required for any harness edit), `dsh-edit-system-prompt` (only if the model-facing system
  prompt text changes — currently NOT expected to be needed).
- Governance docs at root: `AGENTS.md`, `HARNESS-EDITS.md`, `CONTRIBUTING.md`, `SAFETY.md`,
  `AI_BIG_PROJECT_DESIGN.md`, `docs/config-catalog.md`.
- `packages/` top level includes: `attachment`, `spill`, `llm`, `context`, `compaction`,
  `kernel`, `session`, `sdk`, `client`, `web`, `settings`, `storage`, `guard`, `hooks`, …

## 3. Working design (not yet approved/implemented)

Layering, from the user's requirement "apply to every provider, fall back to text":

1. **Detect oversize** — at the point a tool result is about to be clipped for the prompt
   budget. Today: `_clip_body` in `ds_direct.py`; TS: `spill-policy`'s `maxInlineBytes`
   `tools/post-execute` transformer.
2. **Persist full text** — reuse the existing `SpillStore.saveText` (TS) / a file write
   (Python) rather than inventing new storage.
3. **Upload, if the provider can** — provider capability flag + an endpoint builder that
   sits next to the model-listing endpoint builder (`{baseURL}/…`). DeepSeek-direct already
   has a working `upload_file` + `ref_file_ids`; OpenAI (`POST /v1/files` then a file content
   part) and Anthropic (`POST /v1/files` then a `document` block) are the same shape.
4. **Replace inline** — swap the giant text for a short stub naming the file/attachment id
   (so the model knows a file exists and how to ask for it).
5. **Fallback** — provider with no upload capability ⇒ keep today's clip + omission note.
   Must be explicit and testable ("does not upload on a route that cannot store files" is the
   existing precedent for this behaviour in `llm-kiln`).

Open risks / to decide:
- Whether the TS `spill-policy` path or the Python `ds_direct` path is the primary home, or
  both (user says all providers ⇒ the shared/provider-agnostic layer is TS `llm` + adapters;
  Python providers each need their own uploader).
- Turn-boundary ownership: an uploaded file id must be attached to the *right* turn/account
  (kiln ids are login-scoped).
- Cost/latency: readiness polling (ds-direct chip "not ready in 20s"); failed upload must
  degrade to text rather than failing the turn (opposite of the current kiln image choice).

## 4. Progress log

- [x] Located the real truncation site and marker (`ds_direct.py`).
- [x] Found the existing spill/preview subsystem (`packages/spill/*`).
- [x] Found the existing attachment subsystem + LLM `content.ts` bridge.
- [x] Found the working DeepSeek-direct upload endpoint + `ref_file_ids` plumbing.
- [x] Found the kiln TS `uploadFiles`/`ref_file_ids` route-capability precedent.
- [x] Found provider endpoint-construction precedents (`llm-pi-ai/src/discovery.ts`).
- [ ] Read `python/kiln/runtime/{providers.py,openai_provider.py,anthropic_provider.py,gemini_provider.py}`
      to find where their base URLs / paths are built and whether any upload exists.
- [ ] Decide exact insertion points per provider (capability flag + endpoint builder).
- [ ] Implement.
- [ ] Tests + docs (respect `dsh-harness-edit` overlay/patch rules).

## 5. Exact next action when resuming

Read the four Python provider modules listed in §4 and grep them for base-URL/path
construction and any existing file/attachment handling; then answer: *for each provider, is
there an upload endpoint reachable from the same base URL, and where does its prompt get
assembled?* Record the answer in this file before editing anything.

**ANSWERED — see §6.**

---

## 6. Provider-by-provider endpoint map (recon COMPLETE)

`python/kiln/runtime/` is a provider registry. The contract every provider module
implements (documented at the top of `providers.py`):

    PROVIDER_ID, DISPLAY_NAME, SCHEMA
    models(cfg=None) -> list[str]
    model_labels(cfg=None) -> dict[str, str]
    default_model(cfg=None) -> str
    check_config(cfg) -> (ok: bool, message: str)   # names the env var, never the key
    stream(model, messages, opts, cancelled, cfg) -> yields
        {"type": "reasoning" | "content" | "meta", ...}   # also refs/notice/title

Config (`app_settings.json`) stores `base_url`, `api_key_env` (the NAME of the .env
var; keys are read from `os.environ` at request time and are NEVER returned or
logged), and `schema` in {openai, anthropic, gemini, deepseek-web}.

Dispatch: `providers.py:401` `schema = (cfg.get("schema") or "openai").lower()`;
`:402` `base = (cfg.get("base_url") or "").rstrip("/")`; `:408-414` branches by
schema; `:413` `deepseek-web` returns `None, None, None` ("ds_direct has no
catalogue endpoint"). `_validate_base_url` (`:511`) is an SSRF guard at the shared
dispatch: http(s) only, no embedded credentials.

| schema | module | base_url shape | chat endpoint | upload endpoint (to add) |
|---|---|---|---|---|
| `deepseek-web` | `ds_direct.py` | own BASE | web session stream | ALREADY EXISTS: `POST {BASE}/file/upload_file` (PoW) -> id -> `ref_file_ids` |
| `openai` | `openai_provider.py` | includes `/v1` | `POST {base}/chat/completions` | `POST {base}/files` (multipart) |
| `anthropic` | `anthropic_provider.py` | root, no `/v1` | `POST {base}/v1/messages` | `POST {base}/v1/files` |
| `gemini` | `gemini_provider.py` | root | `{base}/models/{model}:streamGenerateContent?alt=sse&key=` | `POST {base}/upload/v1beta/files` |

Exact lines:
- `openai_provider.py:18` `DEFAULT_BASE = "https://api.openai.com/v1"`; `:119`
  `base = (cfg.get("base_url") or DEFAULT_BASE).rstrip("/")`; `:164`
  `def stream(model, messages, opts, cancelled, cfg)`; `:183`
  `payload = {"model": model, "messages": msgs, "stream": True, ...}`; `:215`
  `sse_client.post_sse(base + "/chat/completions", headers, payload, cancelled)`.
  **`base + "/files"` is exactly the `/v1/models`-style assumption the user described.**
- `anthropic_provider.py:5-6` documents "POST {base}/v1/messages with x-api-key +
  anthropic-version"; base is the ROOT, so upload is `{base}/v1/files`.
- `gemini_provider.py:122` `system_parts, contents = _to_gemini(messages)`; `:130`
  `payload = {"contents": contents}`; `:137` builds the `:streamGenerateContent` URL.
  `_to_gemini` (~78-93) is where a `file_data` part would be injected.
- `ds_direct.py` is adapted through a shim in `providers.py` (~470-508) because it
  predates the registry; the shim forwards every event type (`refs`, `notice`,
  `title`) rather than dropping any.

### Where the truncation the user actually sees comes from

The literal marker `[... output truncated to fit the prompt budget ...]` exists
ONLY in `python/kiln/runtime/ds_direct.py` (repo-wide grep confirmed), at line 1884.
So the visible damage is `_clip_body` on the DeepSeek-direct route:
- `ds_direct.py:1842` `DS_PROMPT_MAX = 48000` — hard ceiling; DeepSeek rejects
  oversized prompts with "Content is too long".
- `:1894 def _clip_body(body_msgs, budget, primed=True)` — keeps what fits,
  drops OLDEST first, never drops pinned messages, never reorders (DeepSeek
  caches on a stable prefix). `primed` says whether the DeepSeek chat already
  holds the dropped turns, which changes only the omission note.
- `:1969 def _prompt_for(messages, st)` — sends system/tool instructions plus only
  the messages this chat has not seen; `:2011` computes `budget`; `:2020`
  `clipped = _clip_body(fresh, budget, primed)`.
- `:1845 _is_tool_result(msg)` — "The TypeScript adapter flattens every tool result
  to `OUTPUT:\n<body>`". This is the marker that identifies tool results.

## 7. Confirmed decisions (from the user)

- **Only oversized results** are uploaded; small outputs stay inline.
- **All providers**, not just ds-direct (example given: ChatGPT / `api.openai.com`).
- **Fallback**: provider with no upload endpoint => plain text (today's behaviour).
- **Maintain `session.md`**, appending as work continues.

## 8. Ownership (checked, so no surprises later)

`HARNESS-EDITS.md:39` classifies **`python/kiln/**` as Tier 1 — fork-owned (zero
merge cost)**, 41 files. So files created under `python/kiln/runtime/` need no
`local-overlay` patch entry and no HARNESS-EDITS marker. (Verified: the overlay's
`local-overlay/rules.json` / `INVENTORY.md` list python files as fork-owned, not as
seam files.)

## 9. Implementation progress

DONE:
- Created `python/kiln/runtime/tool_result_files.py` — the provider-agnostic core:
  - `is_tool_result(text)` — the `OUTPUT:` marker test.
  - `spill_text(text, directory=, filename=)` — atomic write (temp + `os.replace`),
    UTF-8 with `errors="replace"`, removes the partial file on failure.
  - `safe_filename(label, body)` — sanitised stem + 12-char sha256 of the body, so
    identical text re-spills to one file and different results never collide.
  - `stub_text(record, preview=)` — the short in-prompt replacement naming the
    truncation, the local path, and the provider file id when there is one.
  - `process_messages(messages, uploader=, directory=, max_inline_chars=)` -> the
    model-facing list plus a list of `SpilledResult`. Returns a NEW list (the
    durable transcript and the UI keep the full text); only the model copy shrinks.
  - `DEFAULT_MAX_INLINE_CHARS = 6000`; `uploader(filename, data) -> str | None`.
  - Fallback semantics are deliberate: a missing uploader, an uploader returning
    None, a raising uploader, or a failed write all keep the original inline text
    and never fail the turn.

NOT DONE (next):
- Per-provider `upload_text(...)` + capability flag wired into
  `openai_provider.py`, `anthropic_provider.py`, `gemini_provider.py`, and the
  ds_direct shim (reusing ds_direct's existing `upload_file` + `ref_file_ids`).
- Call `process_messages` from each provider's `stream()` before payload assembly,
  and from the ds_direct clip path.
- Tests (mirror `python/kiln/runtime/test_ds_direct_clip.py` style): oversize =>
  stub + upload called; small => untouched; no capability => text; upload raises =>
  text, turn still succeeds.
- Docs: `python/kiln/runtime/README.ds-direct.md` "File attachments" section.

## 10. Next action when resuming

Wire `tool_result_files.process_messages` into `openai_provider.py` first (it is
the smallest adapter and the one the user named), with
`uploader = lambda name, data: <POST base + "/files" multipart, return id>`. Then
mirror into anthropic/gemini, then ds_direct. Add tests before touching ds_direct,
since that path also owns the clip logic.

## 11. Naming

This file was originally `session.md`; renamed to `SESSION-tool-output-file-delivery.md` so its purpose is legible from the filename alone.

## 12. Tooling note (learned the hard way)

Tool calls must be emitted as ONE well-formed `<tool_calls>` block with every
required parameter present. A malformed block is read as prose and **silently does
not run** — which is why an earlier attempt to append these sections to this file
had no effect and had to be redone. Verify a file changed by re-reading it.

---

## 12. Progress update (round 2)

DONE since §9:
- Created `python/kiln/runtime/provider_uploads.py` — per-provider upload layer.
  - `endpoint_candidates(schema, base_url)` returns an ORDERED list, because
    providers inside one schema disagree about the path:
      openai    -> `{base}/files`, then `{base}/files/upload`
      anthropic -> `{base}/v1/files`
      gemini    -> `{root}/upload/{version}/files`
    (`{root}` is the base with its API-version segment removed, so gemini's
    `/v1beta` is not doubled.)
  - `endpoint_for(...)` = first candidate (convenience/tests).
  - `multipart_body(...)` — hand-rolled multipart, because curl_cffi (the
    ds_direct client) rejects the requests-style `files=` kwarg. One encoder
    keeps every provider's wire format identical.
  - `parse_file_id(schema, payload)` — per-schema reply shape (openai/anthropic
    `{"id": …}`, gemini `{"file": {"name"|"uri": …}}`), rejects error-shaped and
    malformed replies.
  - `upload_text(...)` walks the candidates, returns the first usable id, and
    returns None on every failure path. Never raises.
- Wired OpenAI: `openai_provider.py` imports `provider_uploads` +
  `tool_result_files`, and `_deliver_tool_results(messages, base, key)` is called
  at the top of `stream()` BEFORE payload assembly, so oversized results become
  file-backed stubs instead of inline text.
- Verified by execution: compile OK for all three modules; endpoint candidates
  correct for openai/openrouter/anthropic/gemini; gemini no longer doubles
  `/v1beta`; `upload_text` returns None (never raises) for an unsupported schema,
  an unreachable host, and empty data.

## 13. Authoritative endpoint facts (from the user, round 2)

- **DeepSeek Files API**: `POST /files`, plus an Anthropic-compatible
  `POST /anthropic/v1/files`. 64 MiB/file, 10 min upload window, ~25 GiB and
  10,000 files per account. Returns a `file_id` usable in vision AND chat.
- **OpenAI Files API**: `POST https://api.openai.com/v1/files`. 512 MB/file,
  2.5 TB/project. `purpose` is REQUIRED (`assistants` | `fine-tune` | `batch`).
  A chunked `POST /v1/uploads` exists for very large files.
- **Anthropic Files API**: upload via the `files` endpoint (SDK:
  `client.beta.files.upload`). 500 MB/file. Referenced in the Messages payload as
  a `document` block carrying the `file_id`.

NOTE: this is exactly the "/v1/models-style assumption" the user described — the
upload path is assembled from the same base URL the chat call uses.

## 14. Remaining work

- [ ] Wire `_deliver_tool_results` into `anthropic_provider.py` and
      `gemini_provider.py` `stream()` (same shape as openai).
- [ ] Wire the ds_direct path (`ds_direct.py`): it already has a PoW-gated
      `upload_file()` + `ref_file_ids`; reuse it via the same
      `tool_result_files.process_messages` hook, and make the clip path spill
      instead of silently dropping.
- [ ] Tests: a `test_tool_result_files.py` / provider-upload test mirroring the
      existing `test_ds_direct_clip.py` style, asserting oversize => stub,
      small => untouched, no capability => text, upload raises => text, and the
      turn still succeeds.
- [ ] Docs: `python/kiln/runtime/README.ds-direct.md` "File attachments" section.

## 15. Tooling note (repeat of §11, worth restating)

Kernel `edit`/`read` calls must be emitted as ONE well-formed `<tool_calls>` block
with EVERY required parameter. Malformed blocks are read as prose and silently do
not run. When a large literal-match edit is fragile, prefer a `kernel` cell that
rewrites the region programmatically (as was done for `upload_text`) and then
verify by compiling and executing.
