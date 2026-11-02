# efai-desktop 0.2.2-alpha.3

A one-fix release on **deepseek-harness 0.2.2-alpha.2**: compaction works again in any chat whose tool set changed.

## Install

Download `deepseek-harness-0.2.2-alpha.3-win-x64-unsigned.exe`, close DeepSeek Harness, and run it. The installer is not code-signed, so Windows SmartScreen asks first: **More info → Run anyway**.

The one-way `~/.dsh` migration belongs to 0.2.2-alpha.2; a profile already on it needs no migration here.

## The fix

Compacting a conversation failed with:

```
DeepSeek Messages cannot represent tool-change blocks outside developer messages
```

(or, on the pi-ai routes, `Tool-change blocks require developer role`.)

Every chat compacted fine until its tool set changed mid-run — a tool toggle, an MCP connect, a preset switch, a kernel remount. The agent loop records each change as a developer message holding `tool-addition` / `tool-removal` blocks. The fork's compaction request rewrites the whole transcript into one quoted user turn, and it pushed every non-text block onto that turn as live content, so one such message anywhere in the compacted region made every route refuse the request.

The quoted transcript now carries only an image and a file live; everything else becomes a line of text:

- `[tool added: <name>]`, `[tool removed: <name>]`
- `[tool call <name>] <arguments>` — which also repairs a silent loss: the DeepSeek and pi-ai routes had been dropping tool-call blocks from compaction requests, so the summarizer saw a call marker and the result but never the arguments.
- private reasoning is dropped, and a plugin-defined block keeps its tag as text.

## Validation

- New case in `packages/compaction/compaction-basic/tests/compaction-basic.spec.ts` fails on the previous source (`expected [ 'text', 'tool-addition', … ] to not include 'tool-addition'`) and passes on this one.
- `pnpm run test packages/compaction`: 270 passed. The one failure (`runtime-context-admission.spec.ts`, proactive compaction) also fails on the unmodified source.
- Overlay: 17 patches, 71 Tier-2 files, base `f3803c9697`, round-trip and frozen-seam checks green.
- `pnpm run build`: typecheck 5/5.

Installer: 326,686,460 bytes.

SHA-256 of the installer: `EADFE07C9A01618320F20D2ACC5A8B78812DC9346B0D380F11EFC791A603374F`

## Known regressions carried from 0.2.2-alpha.2

- The Tools page switches can no longer remove *every* tool from the request: a tool a preset registers in its own scope keeps its schema and is refused when called.
- Three settings packages removed as redundant (`ui-settings-tools`, `ui-personalization`, `ui-settings-accounts`) are unmounted but still installed.
