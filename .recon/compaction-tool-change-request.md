# Compaction fails: "DeepSeek Messages cannot represent tool-change blocks outside developer messages" (2026-11-01)

## Symptom

Compacting a chat failed with:

```
DeepSeek Messages cannot represent tool-change blocks outside developer messages
```

Every chat compacted fine until its tool set changed mid-conversation. The
`llm-pi-ai` routes fail the same conversation with their own wording
(`Tool-change blocks require developer role`), so the fault is in the request
this fork builds, not in one provider.

## Root cause

`packages/llm/llm-deepseek/src/serialize.ts` rejects a non-developer message that
carries a `tool-addition` or `tool-removal` block; core session admission
(`packages/core/session/src/surface.ts`) rejects the same thing, and the agent
loop only ever writes those blocks inside a `developer/message` (it appends one
each time the request header's tool set changes — a plugin toggle, an MCP
connect, a preset change, a kernel remount).

The fork's compaction request flattened the replayed conversation into one quoted
user turn and pushed **every** non-text block onto that turn as live content:

```ts
const rendered = message.content.map((block) => {
  if (block.type === 'text') return block.text
  media.push(block)                       // <- tool-change blocks landed here
  return `[${block.type} attached]`
})
```

So one `developer/message` anywhere in the shadowed region put a tool-change
block into a user turn, and every route refused the whole request. Nothing about
an image was involved; the media list existed for images, and tool-change blocks
rode it by accident.

## Fix

`packages/compaction/compaction-basic/src/summarizer.ts` — `quotedLine()` replaces
the inline map: only an `image` and a `file` travel live (the image-offload
recovery reads live image blocks; request assembly projects a file to its handle
text), and every other block becomes its own transcript line.

| Block | Transcript line |
|---|---|
| `tool-addition` | `[tool added: <name>]` |
| `tool-removal` | `[tool removed: <name>]` |
| `tool-call` | `[tool call <name>] <arguments>` |
| `reasoning` | none — private reasoning is not checkpoint material |
| plugin-defined | `[<tag>]` |

`tool-call` previously rode the media list too, where the DeepSeek and pi-ai
routes silently dropped it: the summarizer saw `[tool-call attached]` and the
result, never the arguments. Rendering it as text matches what the `llm-kiln`
route already did (`flattenMessage` renders the call as its DSML block).

## Verification

- New case in `tests/compaction-basic.spec.ts`: a region holding a
  `developer/message` with both a tool-addition and a tool-removal. It asserts the
  request carries no `tool-addition`/`tool-removal` block and that the quoted
  transcript reads `[tool added: web_search]` / `[tool removed: pwsh]`.
- That case fails on the pre-fix source (`expected [ 'text', 'tool-addition', … ]
  to not include 'tool-addition'`) and passes after.
- `npx vitest run packages/compaction`: 270 passed; the one failure
  (`runtime-context-admission.spec.ts`, proactive compaction) also fails on the
  unmodified source, so it predates this change.
- `pnpm run verify-fork-overlay`: 17 patches, 71 Tier-2 files, base `f3803c9697`,
  round-trip verified.

## Live application (no restart)

The installed 0.2.2-alpha.2 build still carries the old module, so the profile
`cordis.patch.yml` now overrides the shipped `standard` preset with the checkout's
build for that one row:

```yaml
- id: preset-standard
  name: '@deepseek-ai/dsh-agent-preset'
  config:
    ...
    - id: compaction-basic
      name: 'D:/deepseek-kernel-harness/packages/compaction/compaction-basic/lib/index.js'
```

A patch keyed by the preset row replaces its complete `config`, so the block
restates the shipped plugins list verbatim apart from that row. Delete the `name`
override once a release carries the fix; the backup of the pre-override patch is
`cordis.patch.yml.bak-compaction-live`.

Caveat: the checkout module resolves `@deepseek-ai/dsh-llm` and
`@deepseek-ai/dsh-compaction` from the checkout's `node_modules`, so it holds a
second copy of those classes. `LlmError` `instanceof` checks in
`compaction-image-offload` (overflow recovery for image-heavy conversations) do
not cross that copy boundary; everything else keys on service names or error
codes.
