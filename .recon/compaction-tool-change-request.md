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

## Live application: attempted, rejected, reverted

Overriding the shipped `standard` preset with the checkout's build (a patch keyed
by `preset-standard` whose `compaction-basic` row named
`D:/deepseek-kernel-harness/packages/compaction/compaction-basic/lib/index.js`)
does NOT work. The preset mount rejected its own composition:

```
new session failed: SessionCreateError: session create failed:
agent-preset/invalid: compaction-basic
(D:/deepseek-kernel-harness/packages/compaction/compaction-basic/lib/index.js): never started
```

Every new session failed to create for as long as the row was in place, in the
running harness and in a test instance alike. The override was removed within
minutes and all four presets resolve `@deepseek-ai/dsh-compaction-basic` from the
installation again (`fiberState: 2` on each).

The likely cause is that the checkout build imports its own copies of
`@deepseek-ai/dsh-compaction`, `@deepseek-ai/dsh-llm` and
`@deepseek-ai/schemastery` from the checkout's `node_modules`, so its
`schemastery` `Config` object is a foreign instance in the host process and the
preset activation audit never sees the row start. An absolute-path row works in
the *profile* composition (that is how `kernel-python` runs from this checkout);
it does not work for a row inside an agent preset.

Consequence: this fix reaches a running installation only through a build.

## Shipped

Version 0.2.2-alpha.3 (commit `90c8a222de` bumped the family, `6930524359` carries
these notes), tag `efai-desktop-v0.2.2-alpha.3`, release
https://github.com/eefamilyai/Deepseek-Harness-EFAI/releases/tag/efai-desktop-v0.2.2-alpha.3

Installer `deepseek-harness-0.2.2-alpha.3-win-x64-unsigned.exe`, 326,686,460 bytes,
SHA-256 `EADFE07C9A01618320F20D2ACC5A8B78812DC9346B0D380F11EFC791A603374F` (GitHub
reports the same digest). `app.asar` inside the built package carries
`[tool added: ` exactly once — the fixed renderer — and the packaged
`dsh/package.json` reads `0.2.2-alpha.3`.

The family-wide bump (414 manifests) is what `pnpm run release:dsh 0.2.2-alpha.3`
does, and it re-pins upstream-owned manifests to the fork's version line. The next
upstream merge will therefore see version-only conflicts on the manifests upstream
changed; `efai/merge_upstream.py` resolves that class by rule.
