# RLM removal and fork-package renames

## Scope
Remove the Recursive Language Model engine and everything registered around it, then
rename three fork-owned packages to names that match what they do.

## RLM removal — DONE

### Deleted
- `packages/rlm/` (engine, protocol, tests, manifest)
- `packages/kernel/kernel-rlm-context/` (whole package)
- `python/kiln/runtime/rlm_context.py`
- `.agents/notes/implemented/architecture/2026-09-07-kernel-rlm-context-readback-hardening.md`

### Edited
- `packages/kernel/roster/src/index.ts` — dropped `RLM_ENABLED_DEFAULT`, `RLM_TOOL_NAME`,
  `Roster.rlmEnabled`, `Config.rlm`; `resolveRoster(tools, kernelEnabled)`.
- `packages/kernel/roster/tests/roster.spec.ts`, `README.md`
- `packages/client/ui-settings-tools/src/client/{ToolsSection.tsx,locales.ts,index.ts}` + `README.md`
- `packages/bundle/efai-base/{package.json,cordis.patch.yml,README.md}`
- `packages/agent-memory/agent-memory/package.json`
- `tsconfig.host.json`
- `packages/kernel/kernel-python/src/{seam.ts,provider.ts}` — `dispatchRlm` and its arm removed
- `packages/kernel/kernel/src/types.ts`, `packages/kernel/tool-kernel/README.md`
- `python/kiln/runtime/kernel_child.py` — import, install block, `_STATE_ALWAYS_SKIP`
- `efai/ensure-profile-bundles.mjs`, `local-overlay/rules.json`, `README.md`, `README.zh.md`
- `HARNESS.md`, `HARNESS-EDITS.md` — every RLM reference; stale counts corrected
  (packages 26 -> 17, python/kiln 49 -> 58, doc-sync gates 5 -> 4)

## Verification (all green)
| Check | Result |
|---|---|
| registration sweep (bundle/preset/overlay/app/root manifests) | 937 files scanned, **0 hits** |
| `rlm` references repo-wide | **0** in HARNESS.md, HARNESS-EDITS.md, tsconfig.base.json, INVENTORY, all docs catalogs |
| `verify-seam-frozen` | seam frozen at **87**, 87 in tree |
| `verify-md-links` | 2224 files, all links resolve |
| `typecheck` | `tsc -b tsconfig.client.json` -> **exit 0**, 0 `error TS` |
| generated artifacts | pnpm-lock, tsconfig.base, INVENTORY, config/module/tool catalogs, doc graphs, plugin-packages all regenerated |

## Package renames — DONE

| Was | Now | Note |
|---|---|---|
| `@deepseek-ai/dsh-roster` (`packages/kernel/tool-roster`) | `@deepseek-ai/dsh-tool-roster` (`packages/kernel/roster`) | the package name matches its `tool-roster` row id; the directory moved out of the `tool-*` leaf namespace `scripts/gen-tool-catalog.ts` globs |
| `@deepseek-ai/dsh-llm-dsml` (`packages/llm/llm-dsml`) | `@deepseek-ai/dsh-llm-text-toolcalls` (`packages/llm/llm-text-toolcalls`) | the reader is provider-neutral: it rewrites the text channel, not a DeepSeek-specific dialect |
| `@deepseek-ai/dsh-agent-memory-mode` | folded into `@deepseek-ai/dsh-agent-memory` | one package now owns both halves: the engine in `src/engine.ts` (`name = 'agent-memory-engine'`, `EngineConfig`) and the live switch in `src/index.ts` (`name = 'agent-memory'`, `enabled` + `engine`) |

All `efai-*` package names were kept as-is.

### Fold details
- `src/index.ts` (engine) -> `src/engine.ts`; its config interface renamed `Config` -> `EngineConfig` because
  `gen-config-catalog` pastes config declarations verbatim and rejects a package-local aliased type.
- `tests/agent-memory-mode.spec.ts` -> `tests/switch.spec.ts`; tmpdir prefix `dsh-agent-memory-mode-` -> `dsh-agent-memory-`.
- Merged `package.json`, `tsconfig.json`, and the two READMEs; deleted the whole `agent-memory-mode/` directory
  including its deep `node_modules` chain (`cmd /c rmdir /s /q`; `shutil.rmtree`/`os.rmdir` tripped on the symlink chain).
- Repointed every hand-edited reference: `HARNESS.md`, `HARNESS-EDITS.md`, `.agents/skills/dsh-harness-edit/SKILL.md`,
  `packages/bundle/efai-base/{cordis.patch.yml,package.json,README.md}`, `tsconfig.host.json`, `tsconfig.base.json`,
  `scripts/verify-package-readme-model-experience.ts`.

### Declaration repairs
The fold pulled `@deepseek-ai/cordis-plugin-loader` (peer `workspace:~`) and `@deepseek-ai/dsh-settings`
(peer `workspace:^`) into the merged source; both were declared, and a tsconfig project reference to
`../../settings/settings` was added so `tsc -b` resolves the settings declaration merge.

### Generator collision
`tsconfig.base.json` regenerates its package-alias region from directory names, so a package whose name is not
`@deepseek-ai/dsh-<directory>` cannot be generated. The `dsh-tool-roster` and `/invariant` aliases were therefore
moved **above** the `// BEGIN generated package aliases` marker, with a comment stating why.

## Final verification (all green, clean tree)

| Check | Result |
|---|---|
| `pnpm run typecheck` | exit 0, **0** `error TS` (212 KB log) |
| `node local-overlay/verify-seam-frozen.mjs` | seam is frozen at **87** upstream file(s); 87 in the tree |
| `pnpm run verify-fork-overlay` | 17 patch(es) against base `00102833df`; round-trip reproduces 87 Tier-2 paths |
| `pnpm run verify-md-links` | **2223** file(s) checked, all relative cross-links and fragments resolve |
| `gen-tsconfig-paths --check` | aliases current |
| `gen-config-catalog --check` | up to date |
| `gen-tool-catalog --check` | up to date |
| `gen-plugin-packages --check` | up to date |
| `gen-module-graph --check` | 3 artifacts up to date |
| `gen-third-party-notices --check` | up to date |
| `pnpm-lock.yaml` | regenerated; 0 hits for `agent-memory-mode`, `llm-dsml`, `dsh-roster` |
| stale-name sweep | `.agents/skills/dsh-repair-dsml-parser/SKILL.md` now says `llm-text-toolcalls` |

### Pre-existing, not caused by this work
`vendor/loader` emits `TS7053`/`TS18048` in its own build face and `pnpm run build:lib:host` prints
`UNRESOLVED_IMPORT` notes for `@deepseek-ai/dsh-home-paths` / `@deepseek-ai/dsh-deepseek-account`; both are
bundler-resolution notices, not type errors, and neither moved with this change.

### Resolved during the pass
`pnpm run clean` (`tsx scripts/clean.ts`) and stale in-place `tsc` emits had left 164 untracked
`*.js`/`*.d.ts`/`*.map` artifacts under `packages/**/src` and `vendor/**/src`; these were purged and are not
part of the change.

## Open question
`packages/client/ui-settings-tools/` is fork-created but appears in neither `local-overlay/SEAM.json` nor
`rules.json` `tier1Prefixes`. Left as-is: it is a Tier-1-style fork package that the seam does not need to
record, and adding it would change the frozen 87 count.
