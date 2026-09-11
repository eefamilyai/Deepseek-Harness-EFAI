# Harness edits: what this fork changed, and how to change it so upstream updates keep working

This repository is a fork of [`deepseek-ai/deepseek-harness`](https://github.com/deepseek-ai/deepseek-harness). It carries local features — a Python kernel, a multi-provider LLM registry, a browser and sidebar surface — on top of a codebase that upstream rewrites continuously.

This file is the fork's own contract. It records every deviation from upstream, states which deviations are safe and which are not, and gives the rules that keep a future `git merge upstream/master` from re-litigating all of them. It is fork-owned: upstream will never create a file at this path, so it never conflicts.

Read [Rules](#the-standard) before you edit any file that upstream also owns. Read [Updating to a new upstream release](#updating-to-a-new-upstream-release) before you merge.

## Where the fork stands

| | commit | note |
|---|---|---|
| Fork point | `47f943859b` | upstream merge of PR #2519, 2026-08-13 |
| Upstream base | `c291e7961a` | `deepseek-harness` 0.1.5-rc.2; recorded in `local-overlay/BASE` |
| Upstream merge landed | `0dfe2170bd` | `deepseek-harness` 0.1.5-rc.2 absorbed into the fork |
| `master` | merge + 87 commits | kernel-rlm-context, tool-notebook-edit, kernel-python provider |
| `upstream/master` | `c291e7961a` | 1,934 commits past the previous base |

`upstream/master` is not an ancestor of `master`: this is a divergent fork, and what separates the two is ordinary work rather than a pending sync.

Measured against the base `c291e7961a`, `master`'s surface is **354 paths** (221 added, 132 modified, 1 deleted). `local-overlay/INVENTORY.md` enumerates them from the rules that produce the patches, so it cannot drift from the tree the way a hand-written table can.

Of the 221 added paths, all are free: upstream owns no path among them, so they merge untouched, forever.

The remaining 133 paths are the entire cost of every future update: 118 are patched, and the other 15 are files a generator owns, which is why they are excluded from the patches and regenerated instead.

The seam below is grouped by why each edit exists, because the fix differs per group.

## The consolidated inventory

### Tier 1 — fork-owned (zero merge cost)

Paths upstream does not and will not use. Nothing here can conflict.

| What | Path | Size |
|---|---|---|
| Python kernel seam | `packages/kernel/**` | 33 files |
| Kiln LLM provider registry | `packages/llm/llm-kiln` | 10 files |
| Python runtime (providers, `ds_direct`, WAF, memory, compaction, browser tools) | `python/kiln/**` | 33 files |
| Browser capability | `packages/web/web-browser` | 10 files |
| Sidebar host bridge | `packages/host/sidebar-bridge` | 4 files |
| Client dock and effects | `packages/client/{ui-dock,ui-effects}` | 31 files |
| Session-info command | `packages/session/command-session-info` | 5 files |
| Launchers | `start.cmd`, `start.sh` | 2 files |
| Publish script | `upload_to_git.py` | 1 file |
| This document | `HARNESS-EDITS.md` | 1 file |
| Merge record | `.merge-port/**` | 2 files |
| Agent Notes the fork added | `.agents/notes/implemented/**` | 7 files |
| Windows desktop browser shell — Electron `BaseWindow` with `WebContentsView` panes, a native toolbar, and a CDP endpoint that `python/kiln/runtime/browser_tools.py` attaches to | `desktop/harness-desktop` | 8 files |

Each **Size** is the count of tracked files under that row's path. The 221 fork-owned
paths are the authority and this table is a curated selection of them, not a partition:
`local-overlay/INVENTORY.md` lists the remaining 74: 29 under `local-overlay/` (the tooling and the
patch set), 11 in `packages/agent-memory/`, 11 in `packages/rlm/`, 8 in `packages/client/` (ui-chat,
ui-primitives, ui-settings-general, ui-theme, ui-tool), 6 in `packages/fs/tool-notebook-edit/`, 5 under
`.agents/`, 3 loose root files, and 1 in `packages/session/`. The Agent Notes row is the exception to
the section's premise — upstream owns `.agents/notes/implemented/` and keeps 926 files there; the 7
counted are the notes the fork added, and they are fork-owned because upstream holds no file by those
names.

`desktop/` is deliberately outside every workspace glob in `pnpm-workspace.yaml` and every tsconfig, so the shell is never a pnpm workspace member, never enters the lockfile, and never enters a project reference. Adding it under `apps/` would make it all three.

### Tier 2 — the seam with upstream (the whole problem)

The seam is **118 patched paths**. The groups below are a curated selection — the
edits worth understanding before a merge — not an exhaustive partition of those 118;
`local-overlay/INVENTORY.md` is the authority for the full list, and
`local-overlay/rules.json` for which group owns which path. The counts in each heading
are that group's curated membership as written, not the total for its subsystem.

Grouped by why the edit exists, because the fix differs per group.

**T2-A · Registration lists and manifests — 9 files, mechanical**

`tsconfig.base.json` (+20), `tsconfig.host.json` (+8), `tsconfig.client.json` (+2), `pnpm-lock.yaml` (+287), and five manifests: `apps/cli/package.json`, `packages/bundle/{base,web-app}/package.json`, `packages/client/ui-settings-general/{package.json,tsconfig.json}`.

Adding a package requires an entry in each. `tsconfig.base.json` is generated by `pnpm run gen-tsconfig-paths` and is currently in sync, so it should never be merged by hand. The rest are hand-maintained lists, and they conflict on any release where upstream also adds a package — which is most of them.

**T2-B · Composition edited inside upstream files — 6 files**

`packages/preset/agent-presets/presets/{standard,minimal,ptc,cordis}/agent.cordis.yml` (+52, +29, +17, +17) and `packages/bundle/{base,web-app}/cordis.patch.yml` (+94, +21).

These add the `kernel.enabled` switch and the `llm-kiln` route to upstream's shipped presets and bundles. This is the largest recurring conflict source: upstream reshuffles preset rosters on most releases, and the fork's edits sit in the middle of them.

**T2-C · Behavior injected into upstream source — 11 files**

| File | Δ | What it adds |
|---|---|---|
| `packages/llm/llm/src/index.ts` | +91 | `LlmAccountDraft`/`LlmAccountAdder`/`registerAccountProvider` — account pooling on the upstream `LlmRuntime` service |
| `packages/compaction/compaction-basic/src/summarizer.ts` | +113 −14 | compaction prompt and summary parsing |
| `packages/llm/token-meter/src/usage-projection.ts` | +85 −29 | usage projection |
| `packages/extensions/tool-cordis/src/api-catalog.ts` | +80 | catalog entries |
| `packages/boot/app-boot/src/index.ts` | +62 | `dshSettingFlag()` — a settings reader injected into the Loader `!!js` scope |
| `packages/client/ui-settings-general/src/client/index.ts` | +14 | settings surface |
| `packages/llm/token-meter/src/projection.ts` | +13 | |
| `packages/llm/token-meter/src/index.ts` | +9 −4 | |
| `packages/extensions/cordis-client-runner/src/client/slot-catalog.ts` | +2 | dock slot |
| `packages/client/ui-tool/src/client/tool/models/tool-call-model.ts` | +2 | kernel tool-call model |
| `packages/compaction/compaction-basic/src/index.ts` | +5 | |

`dshSettingFlag` is the load-bearing one: nine files across the fork depend on it, and it lives in an upstream file.

**T2-D · Upstream bugs carried as fork deltas — 2 files**

| File | Δ | The bug |
|---|---|---|
| `packages/core/agent/src/model-selection.ts` | +25 | re-entrant `installModelSelection` crashes resume with `property "modelSelection" is already declared as accessor` |
| `tsdown.config.ts` | +32 −1 | tsdown adopts manifest-less directories as workspace members and fails the build as `@deepseek-ai/dsh-root` |

Neither is a customization. Both are defects in upstream code that upstream users also hit.

**T2-E · Product strings and styling — 6 files**

`packages/core/system-prompt/src/index.ts` (one line — the harness identity string), `packages/client/ui-chat/src/client/chat/StatsLine.module.css`, `packages/client/ui-conversation/src/client/skeleton/HeroShell.module.css`, and three `locales.ts` files.

**T2-F · Documentation and snapshot artifacts — 13 files**

| File | Δ | Generator |
|---|---|---|
| `docs/config-catalog.md` | +191 | `gen-config-catalog` |
| `docs/subsystems/code-runtime.{md,zh.md,i18n.yaml}` | +104 | hand-written |
| `docs/tool-catalog.md` | +32 | `gen-tool-catalog` |
| `docs/subsystems/llm-streaming.{md,zh.md,i18n.yaml}` | +60 | hand-written |
| `apps/cli/composition.md` | +21 | `gen-doc-graphs` |
| `docs/capability-seams.md` | +11 | `gen-doc-graphs` |
| `snapshots/web/lifecycle-chrome/{hero,plan-active}.expected.md` | +2 | `test:snapshot:record` |
| `THIRD_PARTY_NOTICES.md` | +1 | `gen-third-party-notices` |

Seven of these (~280 lines, counting `tsconfig.base.json` from T2-A) are regenerable output. Merging them by hand is wasted work that also produces a catalog describing the previous release. The other six — the `code-runtime` and `llm-streaming` triplets — are hand-written documentation for fork features, placed in upstream-owned files; they belong in fork-owned pages.

**T2-G · Generator scripts — 3 files**

`scripts/gen-tool-catalog.ts` (+18), `scripts/gen-doc-graphs.ts` (+10), `scripts/gen-cordis-catalog.ts` (+9).

**T2-H · Tests mirroring the above — 9 files**

`token-usage-projection.spec.ts` (+150), `compaction-basic.spec.ts` (+40), `app-boot.spec.ts` (+34), `model-selection.spec.ts` (+17), plus `system-prompt.spec.ts`, `gen-tool-catalog.spec.ts`, `skeleton.client.spec.tsx`, and both `ui-settings-general` specs.

**T2-I · Infrastructure — 2 files**

`.gitignore` (+26 — credential and runtime-state exclusions), `.gitattributes` (+5 — CRLF for `*.cmd`/`*.bat`).

**T2-J · Files added inside an upstream package — 2 files**

`packages/client/ui-settings-general/src/client/AdvancedSection.{tsx,module.css}`.

These never produce a merge conflict, which is exactly why they are dangerous. `ui-settings-general` is upstream's package; the fork placed two new files inside it and wired them in through the six modified files in that directory. If upstream restructures or deletes the package, the files survive the merge, compile against nothing, and fail at a point far from the cause. This is what happened last merge when upstream deleted `packages/client/runtime` under the fork's `ui-dock` and `ui-effects`.

A file that only works because of an upstream directory belongs in a fork-owned package that imports from it.

## Why this does not survive an upstream update

Seven concrete failures, in order of cost.

**1. The ownership boundary was undeclared.** `local-overlay/rules.json` and the generated `INVENTORY.md` now declare it: every changed path is classified as fork-owned, seam, or generated, and a path no rule claims fails the rebuild. The remaining gap is the markers — see failure 5 — which are what make an individual conflict legible rather than what defines the boundary.

**2. The repository's own extension mechanism is bypassed.** `AGENTS.md` states the rule: *"Plugins, not loop changes: new behavior goes on documented extension points"*, and `packages/bundle/*` exists so composition changes ship as patch layers rather than preset edits. The fork instead edits four upstream presets in place. A fork-owned bundle package would have delivered the same composition with zero upstream files touched.

**3. Fixes and features are entangled.** T2-D is two upstream bugs. Kept as fork deltas they conflict on every merge, forever, and upstream never fixes them, so the fork pays the cost permanently. Sent upstream they disappear from the diff the moment they land.

**4. Generated files are committed as hand edits.** T2-F is ~260 lines that a generator rewrites in seconds. Every one is a conflict that costs review attention and yields a catalog describing the previous release.

**5. The marker convention is applied unevenly.** Rule 2 asks every Tier-2 edit to carry a marker, and most do: `DSH-FORK` appears in 98 of the 118 patched paths. The other 20 are invisible to the convention — 5 `package.json` manifests, 5 `README.i18n.yaml` pairs, one package `tsconfig.json`, the two generated catalog modules (`packages/extensions/tool-cordis/src/api-catalog.ts`, `packages/extensions/cordis-client-runner/src/client/slot-catalog.ts`), one client spec, one client component (`packages/client/ui-conversation/src/client/skeleton/EmptyHero.tsx`), and 4 `docs/` pages. The 20th path, `.claude/skills`, is the one file the fork deletes — a symlink, with nowhere to put a comment. Markers are not the inventory and cannot be: a grep cannot tell a marked edit from a marked file, and a diff against `upstream/master` is mostly upstream's own churn across 1,934 commits. `local-overlay/INVENTORY.md` supplies the inventory mechanically. What the 20 unmarked files cost is legibility at conflict time: the resolver reads a hunk with no stated reason and no exit condition.

**6. `doc-sync` is red on five gates, and the fork packages cause two of them.** `pnpm run test:docs` fails on markdown links, translation pairing, markdown wrap, package README summaries, and the documentation-standard spec. The fork's own packages drive the last two: the sixteen READMEs under `packages/kernel/*`, `packages/rlm/*`, `packages/agent-memory/*`, `packages/client/{ui-dock,ui-effects}`, `packages/host/sidebar-bridge`, `packages/web/web-browser`, `packages/llm/llm-kiln`, `packages/fs/tool-notebook-edit`, and `packages/session/command-session-info` were written without the `## Summary` heading the summaries gate requires, and without the frontmatter, Table of Contents, and Dev Note the doc-standard spec requires. The documentation exists and is detailed; it does not carry the skeleton the gates read. The cost is that five red gates hide a sixth real breakage: a genuine documentation regression lands on top of known failures and nobody notices.

**7. Credentials rest on `.gitignore` alone.** `ds_config.json` holds a DeepSeek login password and WAF cookie; `python/kiln/runtime/ds_sessions.json` holds live session tokens. Both are ignored, and nothing matching them is tracked today — verified. But `.gitignore` is one `git add -f`, one path rename, or one merge that drops the rule away from a published secret.

## The mod layer

`local-overlay/` holds the fork's edits to upstream-owned files as patches. The working tree still carries those edits — that is how the fork builds — but the patch set is the machine-checkable record of them, and it is what makes an upstream update a re-application rather than a negotiation.

| Path | Role |
|---|---|
| `local-overlay/BASE` | The pinned upstream commit the patches apply onto. Line 1 is the only line any script reads. |
| `local-overlay/rules.json` | The single source of truth: which path belongs to which patch group, which files are generated, which paths are fork-owned. |
| `local-overlay/patches/*.patch` | The mod. One `git apply`-able diff per subsystem, generated. |
| `local-overlay/INVENTORY.md` | The manifest, generated: every patched path, every generated file and its command, every fork-owned path. |
| `local-overlay/lib.mjs` | Logic the scripts share. |
| `local-overlay/rebuild.mjs` | Regenerates `patches/` and `INVENTORY.md` from the working tree. |
| `local-overlay/apply.mjs` | Applies the patches, or checks that they still apply to a pristine base. |
| `local-overlay/verify.mjs` | Proves that base + patches reproduces the fork's tree exactly. |

`patches/` and `INVENTORY.md` are generated. Edit `rules.json`, then rebuild; never hand-edit a patch.

```sh
node local-overlay/rebuild.mjs          # fold working-tree edits into the patches
node local-overlay/rebuild.mjs --check  # report drift, write nothing, exit 1 on drift
node local-overlay/apply.mjs --check    # confirm every patch applies to a pristine base
node local-overlay/verify.mjs           # prove base + patches == the working tree
```

The two checks are not redundant. `verify.mjs` re-derives the diffs from the working tree, so it stays green even when a committed patch file has gone stale; `apply.mjs --check` reads the files that are actually on disk. Run both after touching an upstream-owned file, and run `rebuild.mjs --check` before pushing.

`verify.mjs` works by building a throwaway checkout of `BASE`: it initializes a temporary repository, points its `.git/objects/info/alternates` at this checkout so base blobs resolve without copying an object database, stages every patched path through `git update-index`, checks the index out, applies the patches, and compares the result byte for byte. Nothing writes to the real repository, and a deleted symlink, a mode change, and an ordinary edit all reproduce faithfully.

## The standard

### Rule 1 — Three tiers, and you must know which one you are in

**Tier 1, fork-owned.** A path upstream does not use. New packages, `python/kiln/`, root fork docs, `.merge-port/`. No conflict is possible. **Put everything here that can go here.**

**Tier 2, seam.** An upstream file the fork must touch. Every one is listed in [the seam register](#the-seam-register) with a reason and an exit plan, and covered by a patch group in `local-overlay/rules.json`. Adding to this list is a decision, not a side effect.

**Tier 3, upstream-owned.** Everything else. **Never edit.** An edit here is a defect in the change, not a feature of it — move it to Tier 1, or send it upstream.

**Generated.** Not a fourth tier so much as an exclusion: a file a generator owns is neither patched nor merged by hand. Rule 4 governs it, and `local-overlay/rules.json` lists every one with its regeneration command.

This document is the contract a maintainer reads. `local-overlay/rules.json` is the same split in the form the scripts enforce, and `local-overlay/INVENTORY.md` is the generated list of what each side currently holds. The two must agree: when they do not, the rebuild fails rather than picking a winner.

### Rule 2 — Every Tier-2 edit carries a marker

One line, immediately above the edit, in the file's comment syntax:

```ts
// DSH-FORK(kernel): dshSettingFlag lets a Loader `disabled` expression read the
// settings document. EXIT: upstream ships a settings reader in the !!js scope.
```

```yaml
# DSH-FORK(kernel): kernel.enabled picks the acting roster.
# EXIT: move to packages/bundle/efai-kernel/cordis.patch.yml.
```

The tag in parentheses is the feature: `kernel`, `kiln`, `dock`, `browser`, `memory`, `rlm`, `fix`, `brand`. Use `all` only for a file the whole fork shares, such as a tsconfig or the lockfile. The `EXIT:` clause names the event that deletes the edit. An edit with no exit is a permanent tax; write it down as one.

The marker is what makes a conflict legible while it is being resolved: the fork's side of a hunk carries the reason it exists and the condition that retires it. It is not the inventory. `local-overlay/INVENTORY.md` is the inventory, and it is generated, so it cannot go stale the way a hand-maintained grep result does.

After editing an upstream-owned file, fold the edit into its patch and re-prove the layer — `.agents/skills/dsh-harness-edit` has the exact command sequence.

### Rule 3 — Choose the mechanism in this order

1. **A new fork-owned package.** Register on a documented extension point. Zero merge cost. Always try this first.
2. **A fork-owned bundle.** `packages/bundle/efai-<feature>/cordis.patch.yml` — the harness's own patch-layer mechanism, applied by `dsh --profile`. Composition changes belong here, not in upstream presets.
3. **A settings value.** If it varies per deployment it is `Config`, per `AGENTS.md`: *"No hardcoded tunables in plugins"*.
4. **An upstream pull request.** For anything that is a bug, or that upstream would plausibly accept.
5. **A marked Tier-2 edit.** Last resort. Smallest possible hunk, marker, exit plan, register entry.

### Rule 4 — Never hand-merge a generated file

`local-overlay/rules.json` is the authority for which files these are; `local-overlay/INVENTORY.md` renders the list with each file's command, and `local-overlay/rebuild.mjs` refuses to patch any of them. At a conflict in any file below, take **upstream's side wholesale**, then regenerate:

```sh
git checkout --theirs docs/config-catalog.md docs/tool-catalog.md docs/capability-seams.md \
                      apps/cli/composition.md THIRD_PARTY_NOTICES.md tsconfig.base.json
pnpm run gen-tsconfig-paths
pnpm run gen-config-catalog && pnpm run gen-tool-catalog
pnpm run gen-doc-graphs && pnpm run gen-cordis-catalog
pnpm run gen-client-catalog && pnpm run gen-persistence-catalog
pnpm run gen-third-party-notices
```

Snapshots are re-recorded, not merged: `pnpm run test:snapshot:record` (needs `DEEPSEEK_API_KEY`).

### Rule 5 — Upstream bugs go upstream

A fix to upstream code that is not fork-specific is not a customization. Open it as a pull request against `deepseek-ai/deepseek-harness`, and keep the local copy in `.merge-port/upstream-prs/<name>.patch` with a row in the register recording the PR link. When it lands, delete the local delta — the merge brings it back for free.

Two are outstanding now: the `model-selection.ts` accessor re-entrancy guard, and the `tsdown.config.ts` workspace-manifest fix.

### Rule 6 — Keep registration-list edits in one contiguous block

In `tsconfig.host.json` and `tsconfig.client.json`, put every fork entry together, fenced:

```jsonc
    // DSH-FORK(all): fork packages. Keep contiguous — one conflict hunk, not five.
    { "path": "./packages/kernel/kernel" },
    { "path": "./packages/kernel/kernel-mode" },
    { "path": "./packages/kernel/kernel-python" },
    { "path": "./packages/kernel/tool-kernel" },
    { "path": "./packages/llm/llm-kiln" },
    { "path": "./packages/web/web-browser" },
    { "path": "./packages/host/sidebar-bridge" },
    { "path": "./packages/session/command-session-info" },
    // DSH-FORK end
```

The entries are not fenced today: `tsconfig.host.json` and `tsconfig.client.json` contain no `DSH-FORK` block, so each file conflicts at every scattered insertion point instead of at one. Fencing them is a pending item, not a description of the current file. `tsconfig.base.json` needs none of this — it is generated.

### Rule 7 — The lockfile is regenerated, never merged

`pnpm-lock.yaml` is the single largest conflicting file (+287 lines) and merging it by hand produces an install that resolves differently from either side. Add to `.gitattributes`:

```gitattributes
# DSH-FORK(all): a merged lockfile is not a resolvable lockfile. Take one side, then `pnpm install`.
pnpm-lock.yaml merge=ours
```

Then after every merge, unconditionally:

```sh
pnpm install --no-frozen-lockfile && git add pnpm-lock.yaml
```

### Rule 8 — Credentials never rest on `.gitignore` alone

`.gitignore` states intent; it does not enforce it. Keep secrets out of the working tree entirely — environment variables, or a file under `$DSH_HOME` outside the repository. Per `AGENTS.md`: *"Never commit credentials."* The Kiln presets already do the right thing by naming an environment variable per provider rather than storing keys; `ds_config.json` and `ds_sessions.json` are the exceptions to move.

Verify before every push:

```sh
git ls-files | grep -iE 'ds_config|ds_sessions|subkernels\.json|\.env$|KILN\.md'
```

Output must be empty.

### Rule 9 — A fork package is a real package

README, JSDoc on every export, tests, and an entry in the catalogs. `packages/agent-memory`, `packages/kernel`, and `packages/rlm` have no README, which keeps `doc-sync` red and hides real drift behind expected noise. A gate you have learned to ignore is not a gate.

## The seam register

Every Tier-2 edit, its owner, and what removes it. Keep this table current; it is the exit plan.

The table is the human-facing record. `local-overlay/rules.json` is the machine-readable one: it assigns each of these paths to a patch group, and `local-overlay/rebuild.mjs` fails when a changed path matches no group. A row added here without a matching rule, or a rule without a row, leaves the two records disagreeing.

| # | Files | Tag | Why it is in an upstream file | Exit |
|---|---|---|---|---|
| 1 | 4 preset `agent.cordis.yml` | `kernel` | `kernel.enabled` switches the acting roster | Move to `packages/bundle/efai-kernel/cordis.patch.yml` |
| 2 | `bundle/{base,web-app}/cordis.patch.yml` | `kernel` `kiln` | mounts `tool-kernel` and `llm-kiln` | Same — a fork-owned bundle, applied by profile |
| 3 | `boot/app-boot/src/index.ts` | `kernel` | `dshSettingFlag()` in the Loader `!!js` scope | Upstream PR: a settings reader is generally useful |
| 4 | `llm/llm/src/index.ts` | `kiln` | `registerAccountProvider` on `LlmRuntime` | Upstream PR, or a fork-owned service that wraps it |
| 5 | `compaction-basic/{index,summarizer}.ts` | `kiln` | prompt and parsing for text-only routes | A fork-owned compaction provider — the seam already supports one |
| 6 | `llm/token-meter/**` (3 files) | `kiln` | usage projection for Kiln routes | Upstream PR, or a provider-supplied projection |
| 7 | `extensions/tool-cordis/src/api-catalog.ts` | `kernel` | catalog entries | Regenerate if generated; otherwise upstream PR |
| 8 | `client/ui-settings-general/**` (6 files) | `kernel` | settings surface for the kernel switch | Register the section from `kernel-mode` instead |
| 9 | `core/agent/src/model-selection.ts` | `fix` | **upstream bug** — accessor re-entrancy on resume | **Upstream PR** |
| 10 | `tsdown.config.ts` | `fix` | **upstream bug** — manifest-less workspace members | **Upstream PR** |
| 11 | `core/system-prompt/src/index.ts` | `brand` | one-line identity string | A prompt section registered by a fork plugin |
| 12 | 2 CSS modules, 3 `locales.ts` | `brand` | styling and copy | Fork-owned client package or locale overlay |
| 13 | 3 `scripts/gen-*.ts` | `kernel` | generators must see fork packages | Upstream PR if the change is general |
| 14 | `tsconfig.{host,client}.json` | `all` | project references | Contiguous fenced block (Rule 6) |
| 15 | `pnpm-lock.yaml` | `all` | dependencies | `merge=ours` + regenerate (Rule 7) |
| 16 | `.gitignore`, `.gitattributes` | `all` | credentials, CRLF for `*.cmd` | Permanent; append at end of file only |
| 17 | `docs/subsystems/llm-streaming.*` | `kiln` | hand-written docs for a fork feature | Move to fork-owned `docs/` pages |
| 18 | 8 test files | various | mirror 3–6 above | Follows whatever those become |
| 19 | 2 files inside `client/ui-settings-general` | `kernel` | new files placed in an upstream package directory | Move to a fork-owned client package |
| 20 | `client/ui-model-selection/src/client/{ModelSelect.tsx,ModelSelect.module.css}` | `browser` | collapsible per-provider groups in the model dropdown, with account routes folded under a single base-provider header and an account picker | Upstream adopts provider collapse and account grouping in `ModelSelect` |
| 21 | `packages/skill/tool-skill/src/index.ts` | `kernel` | `@skill <name>` is a second user-explicit skill load gesture beside `/name` | Upstream PR, or a fork-owned pre-step plugin |
| 22 | `packages/skill/tool-skill/src/index.ts` | `kernel` | `alwaysLoadSkills` re-injects a named skill body whenever compaction prunes it from the surface, so a recovery procedure survives context loss | Upstream gains a per-skill declaration that keeps a body on the surface across compaction |
| 23 | `packages/client/ui-skill/src/client/index.ts` | `kernel` | `@skills` picker registers a second trigger source beside `skill` | Upstream PR, or a fork-owned client package |
| 24 | `packages/client/ui-input-trigger/src/client/{MenuView.tsx,MenuView.module.css}` and `tests/menu-view.client.spec.tsx` | `browser` | collapsible `@` trigger-menu sections (the highlighted section is expanded by default; the rest start minimized) | Upstream adopts collapsible trigger-menu sections |
| 25 | `packages/bundle/base/cordis.patch.yml` + 4 preset `agent.cordis.yml` | `rlm` | mounts `rlm-mode`/`rlm` engine rows with `rlm.enabled` defaulting on; `rlm.enabled` unmounts the standalone `tool-kernel` and mounts the engine, while the subsumed shell/fs/search/jobs rows follow `kernel.enabled` | Move to `packages/bundle/efai-rlm/cordis.patch.yml` (a fork-owned bundle applied by profile) |
| 26 | `client/ui-chat/src/client/{chat/ChatNodeSeat.tsx,chat/TurnProcessNodeView.tsx,contract/slots.ts,contract/store.ts,stores.ts,locale.ts}` + new `contract/turn-tool-summary.ts`, with `tests/{chat-view.client.spec.tsx,chat-store.client.spec.ts}` | `brand` | the folded Turn-process row names what the Turn's tool calls did (`Created a.mjs, ran a command +53 -0`) instead of only counting them, exists while the Turn is still running, and lets the reader fold it; `store.ts`/`stores.ts` record the reader's open/closed choice so a running Turn can default expanded | Upstream gives the folded process row a content-derived label |
| 27 | `packages/bundle/base/cordis.patch.yml`, `apps/cli/package.json` | `memory` | the base bundle mounts the `agent-memory-mode`/`agent-memory` rows gated by `agent-memory.enabled` (default off), and `apps/cli` must declare both packages because it is the installation dependency closure the profile module fallback mirrors | Move the bundle rows to `packages/bundle/efai-memory/cordis.patch.yml` (a fork-owned bundle applied by profile); the `apps/cli` manifest row stays until profiles resolve bundles from the checkout |
| 28 | `.agents/skills/dsh-code-review/SKILL.md`, `.agents/skills/dsh-pre-push-checks/SKILL.md` | `all` | upstream's review and pre-push skills cannot know about this fork: the tier split, the `DSH-FORK` marker, `local-overlay/`, or the `verify-fork-overlay` gate. Each carries one added section plus its marker. | Permanent fork delta: the upstream skills would need a fork-extensibility mechanism for these sections to move out. |
| 29 | `scripts/verify-package-readme-model-experience.ts` | `all` | the fork ships package READMEs for fork-owned packages, so the audited `NO_MODEL_EXPERIENCE_SECTION` / `SENTENCE_MODEL_EXPERIENCE` allowlists must name them; without entries the gate rejects a correct README. | Upstream accepts a model-experience declaration inside each package manifest, so the allowlists stop being a central file. |

If rows 1, 2, 4, 5, 8, and 11 move to fork-owned packages and rows 9 and 10 go upstream, the seam drops to roughly a dozen files — and the survivors are lists and infrastructure, which conflict predictably in one place each.

## Known fork debt

Recorded at the v1.0.0 commit. These are real, verified gaps, not suspicions. The fork's
own gate (`pnpm run verify-fork-overlay`) and `typecheck` are green; five `doc-sync` gates are
**not**, and this is why.

| Gate | Cause | Exit |
|---|---|---|
| `verify-translation-pairing` | 16 fork package READMEs have no `README.zh.md` pair, plus 4 fork docs (`python/kiln/runtime/README.ds-direct.md`, `README.vision-tools.md`, `local-overlay/README.md`, `HARNESS-EDITS.md`); 4 existing pairs are also out of sync (`README.md`, `docs/event-producer-consumer.md`, `docs/tool-catalog.md`). | Add counterparts; re-record with `--write`. |
| `verify-package-readme-summaries` and the doc-standard spec | 16 fork package READMEs lack the `## Summary`, `## Table of Contents`, and Dev Note sections and YAML frontmatter the gates read. | Add the skeleton to all 16. |
| `verify-md-links` | Seven broken relative links: four `docs/user/**` links to `README.md#run-from-source` / `#run` anchors that do not exist, one `.agents/notes/` `.zh.md` sibling, one `packages/host/sidebar-bridge/README.md` → `src/invariant.ts`. | Fix or repoint. |
| `verify-md-wrap` | Hard-wrapped prose in the generated `docs/tool-catalog.md`. | Regenerate, or widen the wrap exemption. |

`verify-subsystem-pages` also fails — `packages/agent-memory`, `packages/kernel`, and `packages/rlm` are fork package groups with no group `README.md` — but it is not one of the five `doc-sync` gates.

The debt is documentation-shaped: it does not affect the built harness, the mod layer, or
any runtime behavior. It is recorded here so a future release does not mistake a red
`doc-sync` for a broken fork.

## Updating to a new upstream release

```sh
git fetch upstream
git switch -c sync/upstream-$(date +%Y-%m-%d) master
git merge upstream/master
```

Then, in order:

**1. Take upstream wholesale for generated files.** Rule 4. Do not read those conflicts.

**2. Resolve the lockfile by regenerating.** Rule 7. Do not read that conflict either.

**3. Resolve real conflicts using the register.** A remaining conflict usually shows a `DSH-FORK` marker on the fork's side, carrying the reason and the `EXIT:` clause. A hunk with no marker is not proof that the edit was never registered — 22 patched paths carry none — so look the path up in `local-overlay/INVENTORY.md` before concluding anything about it.

**4. Re-apply the mod and regenerate everything.**

```sh
node local-overlay/apply.mjs             # the fork's side of the seam, patch by patch
pnpm install --no-frozen-lockfile
pnpm run gen-tsconfig-paths
pnpm run doc-sync
```

A patch that no longer applies names the code upstream moved around the fork's edit. Resolve it inside that patch's subsystem, then re-run from here. When the fork's version of a file becomes upstream's version — because the change landed upstream — delete the edit from the tree and let `rebuild.mjs` drop its hunk.

If the update moved the base commit, point `local-overlay/BASE` at the new upstream revision and re-run `node local-overlay/rebuild.mjs` before continuing, so the patches are keyed to what the tree actually sits on.

**5. Build before testing.** Delete stranded package directories first — a package deleted upstream leaves its `lib/` and `node_modules/` behind, and until `tsdown.config.ts` carries the manifest filter, tsdown adopts the residue as a build target and fails the build under the name `@deepseek-ai/dsh-root`:

```sh
pnpm run clean && pnpm install && pnpm run build
```

**6. Verify the fork's own features**, not just that it compiles. Compilation proves nothing about whether the kernel still mounts.

```sh
pnpm run typecheck
pnpm run test
pnpm run lint
node apps/cli/lib/bin.js --version
pnpm dsh --profile headless "read package.json and tell me the version"   # kernel path, needs a key
```

**7. Record what moved.** Append to `.merge-port/MERGE-STATUS.md`: the upstream range, conflicts resolved, upstream APIs that moved and how the fork was repointed, and anything deferred. The existing entry for the `47f94385 → dd6322d6` merge is the model — it is genuinely good, and it is the reason this merge was tractable at all.

**8. Prove the layer still round-trips.**

```sh
node local-overlay/rebuild.mjs
node local-overlay/verify.mjs
node local-overlay/apply.mjs --check
```

Step 8 comes after the merge is resolved, not before: until then the tree is mid-merge and the patches describe neither side.

**9. Update this file.** New Tier-2 edits get register rows and a `patchGroups` entry in `local-overlay/rules.json`; removed ones get deleted from both. `INVENTORY.md` regenerates itself.

## What to fix first

Ordered by how much each removes from the next merge.

1. **Send rows 9 and 10 upstream.** Two self-contained bug fixes; they leave the fork's diff entirely when they land.
2. **Create `packages/bundle/efai-kernel` and `packages/bundle/efai-kiln`.** Moves rows 1 and 2 — six files, the highest-churn upstream files the fork touches — to Tier 1.
3. **Finish the marker pass.** 20 of the 118 patched paths still carry no marker; the list and the grouping are in failure 5. Each one is a conflict a resolver reads cold.
4. **Fence the `tsconfig.host.json` / `tsconfig.client.json` entries.** Ten minutes; turns eight conflicts into two.
5. **`pnpm-lock.yaml merge=ours`.** One line; removes the single largest conflicting file.
6. **Move `ds_config.json` and `ds_sessions.json` out of the repository tree.**
7. **Give the sixteen fork package READMEs the required skeleton** — `## Summary`, `## Table of Contents`, the Dev Note section, and YAML frontmatter. Clears the package README summaries gate and the documentation-standard spec.
8. **Wire `rebuild.mjs --check` into the push path**, so a stale patch set cannot reach a branch.
9. **Move row 11** — the system-prompt identity string — to a prompt section registered by a fork plugin. One line today, but it is in a file upstream edits often.