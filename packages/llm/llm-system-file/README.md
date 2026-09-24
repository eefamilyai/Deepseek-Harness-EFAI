# @deepseek-ai/dsh-llm-system-file

Deliver the system prompt as an uploaded provider file.

The assembled system prompt is the largest fixed block in every request: identity,
operating rules, and tool guidance, re-sent verbatim on every turn. A provider that
can store a file does not need those bytes in the token stream. This package uploads
the prompt once, caches the provider file id against a digest of the exact prompt
revision, and replaces the inline copy with a short instruction naming the file.

```ts
import { SystemPromptFileStore } from '@deepseek-ai/dsh-llm-system-file'

const store = new SystemPromptFileStore()
const delivery = await store.deliver(promptText, { schema: 'openai', baseURL, apiKey })
// delivery.fileId is present only when the prompt really is reachable as a file.
```

## Inline text is the contract

`deliver` returns the caller's inline text whenever it cannot produce a *reachable*
file reference — the schema has no file-capable system slot, the endpoint is empty,
the upload failed, or the response was malformed. A file the model cannot open is
worse than inline text, so every failure degrades to inline and nothing throws.

## Reuse, then re-upload on error

The provider file id is cached in `DSH_HOME/llm-system-file/files-v1.json` under an
owner-private lock, keyed by `(scope, prompt revision digest)` where the scope is a
non-secret hash of the endpoint and credential. That is what makes "upload once,
reuse the same id on every later turn, including after a restart" true. When the
provider rejects a stored id, `invalidate` removes the mapping so the next delivery
uploads again.

## Layout

| Module | Responsibility |
| --- | --- |
| `store.ts` | `SystemPromptFileStore.deliver` / `.invalidate`, and the inline fallback |
| `upload-index.ts` | The durable `(scope, revision) -> file id` index and its locking |
| `files-api.ts` | The upload-only OpenAI-compatible `/files` client |
| `file-id.ts` | Branded file-id and scope types |
