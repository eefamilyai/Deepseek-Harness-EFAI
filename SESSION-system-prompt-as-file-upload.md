# SESSION: System prompt delivered as a provider FILE UPLOAD

**Status:** IN PROGRESS - TS package written and registered, but NOT wired: it has no consumers.
The Python code the objective points at is a *different* feature (tool-result delivery).
**Updated:** goal round 11, repo `D:\\deepseek-kernel-harness`.

---

## 1. Objective

Deliver the **system prompt** as an uploaded provider file, in the TypeScript harness:
upload once, reuse the returned file id on every later turn, re-upload only when the
provider rejects the stored id, and fall back to inline text wherever no file route exists.

## 2. What exists today

### 2.1 TypeScript package `packages/llm/llm-system-file/` (Tier 1, added path)

| File | Role |
| --- | --- |
| `src/store.ts` | `SystemPromptFileStore.deliver` / `.invalidate`, inline fallback, `supportsSystemFile`, `promptFilename` |
| `src/upload-index.ts` | durable `(scope, variantId) -> fileId` index, `systemPromptFileScope`, `promptVariantId` |
| `src/files-api.ts` | upload-only OpenAI-compatible `POST {baseURL}/files` client |
| `src/file-id.ts` | branded `SystemPromptFileId` / `SystemPromptFileScope` |
| `tests/system-file.spec.ts` | reuse, re-upload, and inline-fallback cases |

Semantics implemented: `deliver(text, connection, policy) -> { text, fileId?, filename? }`.
The id is cached in `DSH_HOME/llm-system-file/files-v1.json` keyed by
`(scope, prompt revision digest)`; `invalidate(connection, text, fileId)` drops a mapping the
provider rejected so the next delivery uploads again. Every failure path returns the caller's
inline text and never throws.

### 2.2 Wiring status

| Check | State |
| --- | --- |
| `tsconfig.host.json` | registered |
| `pnpm-lock.yaml` | registered |
| `local-overlay/rules.json` | mentioned (Tier-1 prefix list) |
| `lib/index.js` built | **no** |
| Consumers outside its own tests | **none** |

The package is inert: nothing in `packages/` imports it. Mounting it (bundle row plus the
bundle's `workspace:^` dependency) and proving the boot is the outstanding wiring work.

### 2.3 Python side - not a system-prompt implementation

`python/kiln/runtime/provider_uploads.py` implements **tool-result** delivery, not the system
prompt: `deliver_tool_results(messages, schema, base, key)` uploads large tool results and
replaces them with a file reference. Imported by `anthropic_provider.py`, `gemini_provider.py`,
and `openai_provider.py`; covered by `test_tool_result_files.py` and `test_ds_direct_delivery.py`.

No Python file uploads the **system prompt**. So the objective's "remove the Python
implementation it replaces" has no exact target.

## 3. Open question

Removal scope for the Python side - see the question asked this round.

## 4. Next steps

1. Resolve the Python removal scope.
2. Mount the package and prove it boots.
3. `pnpm run verify-fork-overlay`.
