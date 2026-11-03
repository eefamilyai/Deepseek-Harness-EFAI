# efai-desktop 0.2.2-alpha.4

Two visible changes since 0.2.2-alpha.3: wider tool-call colours, and image results that render when you expand the call.

## Install

Download `deepseek-harness-0.2.2-alpha.4-win-x64-unsigned.exe`, close DeepSeek Harness, and run it. The installer is not code-signed, so Windows SmartScreen asks first: **More info → Run anyway**. There is no `~/.dsh` migration in this release.

## Tool-call colours

The transcript palette went from eight families to nine, spaced in OKLCH at one perceived lightness per palette, so neighbouring hues stay distinguishable at 13px:

| family | dark | light |
|---|---|---|
| instruction (system prompt, context) | `#fc86bd` | `#ac3a75` |
| shell (pwsh, bash) | `#ff9069` | `#b73e00` |
| code (kernel, run_code) | `#dfa90c` | `#886600` |
| write | `#83c86a` | `#328000` |
| edit (str_replace_editor) | `#3fc9cd` | `#007b7f` |
| read | `#50c1ee` | `#00779b` |
| search (grep, glob, web_search) | `#85b3ff` | `#2c67c9` |
| think | `#c49bff` | `#7e4fb7` |
| generic (everything else) | `#adb2c0` | `#656b7e` |

`write` and `edit` used to share one green, and the generic lime sat next to it, so a transcript showed six distinguishable colours at best. Every value now clears 4.5:1 on its own background (8.0–9.1:1 dark, 4.9–5.8:1 light), and the steps moved into the plugin's own `--dsw-static-flow-*` namespace instead of overriding design-system tokens such as `--dsw-static-violet-400`.

## Images in expanded calls

Only `read_image` had an image card: the derivation required that exact tool name and the envelope its writer emits. A `desktop_test_instance` screenshot, a `browser` capture, or any tool added later expanded to text while its result carried real image blocks.

The card now derives from the result content alone. The Tool call tree declares the image slot once and hands every row the same gallery renderer, so the keyed `read_image` row and the generic fallback cannot drift, and a new image-bearing tool needs no UI change. The path line appears only when the call recorded one.

## Under the hood

`local-overlay` now treats a manifest whose only difference from the base commit is its version line as release-managed rather than a seam edit. Cutting a release rewrites that line on every workspace manifest, which previously failed the overlay gate with 373 unclaimed paths.

## Validation

- `packages/client/ui-tool`: 466 passed, including a tree-level case where a settled screenshot result shows its gallery on expand.
- `packages/client/ui-attachment` + `ui-chat`: 980 passed.
- `packages/compaction`: 270 passed (one pre-existing proactive-compaction failure, unchanged).
- `pnpm run build:check`: host and client aggregate checks pass.
- Overlay: 18 patches, 83 Tier-2 files, base `f3803c9697`, round-trip and frozen-seam checks green.

Installer: 326,686,452 bytes.

SHA-256 of the installer: `93B772D13569D24B8C9412AC96536D38280A33A4E34AD695D5CE3F614F26D03A`
