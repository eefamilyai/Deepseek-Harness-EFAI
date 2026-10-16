# @deepseek-ai/dsh-llm-system-file

## Summary

Deliver the system prompt as an uploaded provider file.

The assembled system prompt is the largest fixed block in every request: identity, operating rules, and tool guidance, re-sent verbatim on every turn. A provider that can store a file does not need those bytes in the token stream. This package uploads the prompt once, caches the provider file id against a digest of the exact prompt revision, and replaces the inline copy with a short instruction naming the file.

## Use this package

```ts
import { SystemPromptFileStore } from '@deepseek-ai/dsh-llm-system-file'
const store = new SystemPromptFileStore()
const delivery = await store.deliver(promptText, { schema: 'openai', baseURL, apiKey })
// delivery.fileId is present only when the prompt really is reachable as a file.
```

## Inline text is the contract

`deliver` returns the caller's inline text whenever it cannot produce a *reachable* file reference — the schema has no file-capable system slot, the endpoint is empty, the upload failed, or the response was malformed. A file the model cannot open is worse than inline text, so every failure degrades to inline and nothing throws.

## Reuse, then re-upload on error

The provider file id is cached in `DSH_HOME/llm-system-file/files-v1.json` under an owner-private lock, keyed by `(scope, prompt revision digest)` where the scope is a non-secret hash of the endpoint and credential. That is what makes "upload once, reuse the same id on every later turn, including after a restart" true. When the provider rejects a stored id, `invalidate` removes the mapping so the next delivery uploads again.

## Layout

| Module | Responsibility |
| --- | --- |
| `store.ts` | `SystemPromptFileStore.deliver` / `.invalidate`, and the inline fallback |
| `upload-index.ts` | The durable `(scope, revision) -> file id` index and its locking |
| `files-api.ts` | The upload-only OpenAI-compatible `/files` client |
| `file-id.ts` | Branded file-id and scope types |

No runtime invariant companion is published: the only state is a cache of provider file ids keyed by prompt digest, and a stale id is detected and replaced by the provider's own error.

## Model Experience

### The system prompt delivered as a provider file

#### What the model sees

The assembled prompt, or a short instruction naming an uploaded file that holds it — whichever `deliver` could produce. The file path is taken only when the provider can genuinely resolve the reference; an unsupported schema, an empty endpoint, a failed upload, or a malformed response all degrade to the inline prompt, because a file the model cannot open is worse than text it can read.

##### Prompt section verbatim

```markdown
Your system prompt is attached as a file named '<filename>' (provider file id '<fileId>').
Read that file before acting: it holds your identity, your operating rules, and your tool
guidance. None of it is repeated inline.
```

#### Token effect

The prompt's bytes still bill as input either way. What changes is the request text: the inline copy leaves the message stream and a one-line reference takes its place, so the tokens the model *attends to* as instructions are read from the file rather than re-sent inline.

#### KV Cache effect

This is the reason the package exists. An inline prompt is re-sent verbatim on every turn, so any change to it — a new tool, a shifted date — invalidates the provider's cached prefix. A stable file reference keeps the prefix still across turns and across restarts, since the id is cached against a digest of the exact prompt revision.

## Known Limitations and Deferred Work

- Every failure degrades to inline text silently, which is correct and leaves an operator no signal that the file path was unavailable: the request is simply larger than it would have been.
