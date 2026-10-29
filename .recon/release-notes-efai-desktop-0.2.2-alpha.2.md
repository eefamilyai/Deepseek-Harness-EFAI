# efai-desktop 0.2.2-alpha.2

The fork on **deepseek-harness 0.2.2-alpha.2** (`f3803c9697`): 2176 upstream commits over 7435 files, merged onto the fork's own work.

## Install

Download `deepseek-harness-0.2.2-alpha.2-win-x64-unsigned.exe` and run it. The installer is not code-signed, so Windows SmartScreen asks first: **More info → Run anyway**.

The first start of this release migrates `~/.dsh` to the new upstream format. That migration is one way: an older build cannot read the profile afterwards.

## What is new from upstream

Everything in deepseek-harness 0.2.2-alpha.2 — see the upstream release notes for the full list. The changes this fork had to absorb:

- **Session projections return handles.** `register()` is awaitable and `stateOf(session, key)` is deprecated.
- **Tool declarations come from a step's admitted set.** `system-prompt/assemble` no longer carries tools, and `ctx.tools.execute()` takes a raw call batch.
- **A step's provider/model is fixed before `agent/request`.**
- **Tool executors are mounted plugins** (native or PTC) rather than a config mode.
- **Liveshare** joins the shipped surface.

## What the fork changed to fit

- The kernel seam, the roster, image masking, lifetime token usage and skill injection all read through the new projection handles.
- `profile-hub` reads `PROFILE_TEMPLATES` from `@deepseek-ai/dsh-official-bundles`.
- The Automation tasks page keeps its own creation form; upstream's new clear-ended action is wired beside it.
- `schedule/create` is classified in upstream's new Remote-endpoint completeness gate.

**One regression:** the Tools page switches can no longer remove *every* tool from the request. A tool the registry lets us mask disappears; a tool a preset registers in its own scope keeps its schema and is refused when called. Upstream's tool-admission redesign leaves no extension point for a third party to delete another owner's declaration.

## Validation

- `pnpm run build`: 10/10 gates, including the Desktop bundle and the Web build.
- Packaged runtime smoke: CLI plugin install/remove, packaged host boot, and DOCX/XLSX/PPTX to PDF all passed.
- Fork tests: 4211 passed; 5 pre-existing failures remain (four DSML prose cases and one proactive-compaction case), unchanged from 0.2.1-rc.3.
- Overlay: patches, round-trip verification, apply check and the frozen seam all green at the new base.

SHA-256 of the installer: `629284FE2E351F74D68392F2CACC05E230F05F9F6C19B6A446E0E1DDE3312D3C`
