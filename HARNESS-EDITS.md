# Harness edits: what this fork changed, and how to change it so upstream updates keep working

This repository is a fork of [`deepseek-ai/deepseek-harness`](https://github.com/deepseek-ai/deepseek-harness). It carries local features — a Python kernel, a multi-provider LLM registry, a browser and sidebar surface — on top of a codebase that upstream rewrites continuously.

This file is the fork's own contract. It records every deviation from upstream, states which deviations are safe and which are not, and gives the rules that keep a future `git merge upstream/master` from re-litigating all of them. It is fork-owned: upstream will never create a file at this path, so it never conflicts.

Read [Rules](#the-standard) before you edit any file that upstream also owns. Read [Updating to a new upstream release](#updating-to-a-new-upstream-release) before you merge.

For what the fork *is* — every plugin it adds, where each mounts, and which switch turns it on — read [HARNESS.md](HARNESS.md). This file covers only the seam with upstream.

## Where the fork stands

| | commit | note |
|---|---|---|
| Fork point | `47f943859b` | upstream merge of PR #2519, 2026-08-13 |
| Upstream base | `00102833df` | `deepseek-harness` 0.1.7-alpha.2; recorded in `local-overlay/BASE` |
| Upstream merge landed | `merge/upstream-0.1.7-alpha.2` | `deepseek-harness` 0.1.7-alpha.2 (3,009 commits) absorbed; the previous base was `c291e7961a` (0.1.5-rc.2) |
| `master` | merge + 43 commits | kernel-rlm-context, tool-notebook-edit, kernel-python provider, session-recovery-context |
| `upstream/master` | `00102833df` | the current base |

`upstream/master` is not an ancestor of `master`: this is a divergent fork, and what separates the two is ordinary work rather than a pending sync.

Measured against the base `00102833df`, the fork modifies **75 upstream files** (16 patch groups) and regenerates 25 more. Everything else it adds is a path upstream does not own, and therefore free forever. `local-overlay/INVENTORY.md` enumerates all of it from the rules that produce the patches, so it cannot drift the way a hand-written table can; every count in this document is re-derived from it.

Those 75 files are the entire cost of every future update, and the list is **frozen**: `local-overlay/SEAM.json` records it, and `pnpm run verify-seam-frozen` fails a tree that modifies an upstream file absent from it.

The seam below is grouped by why each edit exists, because the fix differs per group.

## The consolidated inventory

### Tier 1 — fork-owned (zero merge cost)

Paths upstream does not and will not use. Nothing here can conflict.

| What | Path | Size |
|---|---|---|
| Python kernel seam | `packages/kernel/**` | 44 files |
| Kiln LLM provider registry | `packages/llm/llm-kiln` | 11 files |
| Text-channel tool-call reader | `packages/llm/llm-dsml` | 10 files |
| System prompt as a file upload (work in progress) | `packages/llm/llm-system-file` | 10 files |
| Python runtime (providers, `ds_direct`, WAF, memory, compaction, browser tools, tool-result file delivery) | `python/kiln/**` | 49 files |
| Browser capability | `packages/web/web-browser` | 11 files |
| Client settings sections (accounts, tools) | `packages/client/{ui-settings-accounts,ui-settings-tools}` | 22 files |
| Post-compaction context | `packages/session/session-recovery-context` | 13 files |
| Observation masking | `packages/compaction/output-masking` | 8 files |
| The fork's own composition | `packages/bundle/{efai-base,efai-web}` | 10 files |
| The identity opener | `packages/core/efai-identity` | 4 files |
| The `/version` route | `packages/host/version-route` | 4 files |
| Lifetime usage projection | `packages/llm/token-usage-lifetime` | 4 files |
| Skill-body injection | `packages/skill/skill-injection` | 4 files |
| Flow-accent theme layer | `packages/client/ui-flow-accents` | 7 files |
| Profile-bundle registration for the launchers | `efai/ensure-profile-bundles.mjs` | 1 file |
| Client effects layer | `packages/client/ui-effects` | 14 files |
| Session-info command | `packages/session/command-session-info` | 5 files |
| Launchers | `start.cmd`, `start.sh` | 2 files |
| Publish script | `upload_to_git.py` | 1 file |
| This document | `HARNESS-EDITS.md` | 1 file |
| Merge record | `.merge-port/**` | 2 files |
| Agent Notes the fork added | `.agents/notes/implemented/**` | 13 files |
| Windows desktop browser shell — Electron `BaseWindow` with `WebContentsView` panes, a native toolbar, and a CDP endpoint that `python/kiln/runtime/browser_tools.py` attaches to | `desktop/harness-desktop` | 8 files |

Each **Size** is the count of files under that row's path. `local-overlay/INVENTORY.md` is the
authority — it enumerates every fork-owned path from the tree, and this table is a curated selection
rather than a partition. The Agent Notes row is the exception to the section's premise: upstream owns
`.agents/notes/implemented/` and keeps 926 files there, and the notes counted here are fork-owned
only because upstream holds no file by those names.

Five files are still *added inside* packages upstream owns — two in `ui-brand-official`, one each in
`ui-chat`, `ui-primitives`, and `ui-tool`. They never conflict, which is exactly the risk: if
upstream restructures the package, the file survives the merge and fails to compile far from the
cause. The four that used to sit inside `ui-settings-general` and `ui-theme` are gone — they moved
into fork packages, and the `ui-primitives` terminal bridge went with the fork's code-block chrome
in the 0.1.7-alpha.2 merge. See T2-J.

`desktop/` is deliberately outside every workspace glob in `pnpm-workspace.yaml` and every tsconfig, so the shell is never a pnpm workspace member, never enters the lockfile, and never enters a project reference. Adding it under `apps/` would make it all three.

### Tier 2 — the seam with upstream (the whole problem)

The seam is **75 patched paths**, down from 138 and then 92: composition, the identity opener,
skill injection, and usage projection moved into fork-owned packages, and the 0.1.7-alpha.2 merge
retired the edits upstream now covers itself (the turn-process fold, the code-block chrome, the icon
glyph, the transcript-width fix, and the locale verbs). One path was then taken on deliberately: the fork deletes `.github/dependabot.yml`, because upstream's nightly dependency PRs against this fork's GitHub repository are noise, not updates it takes. The groups below are a curated selection — the edits worth understanding before
a merge — not an exhaustive partition of those 75;
`local-overlay/INVENTORY.md` is the authority for the full list, and
`local-overlay/rules.json` for which group owns which path. The counts in each heading
are that group's curated membership as written, not the total for its subsystem.

Grouped by why the edit exists, because the fix differs per group.

**T2-A · Registration lists and manifests — 3 files, mechanical**

`tsconfig.host.json`, `tsconfig.client.json`, and `apps/cli/package.json` (two bundle names). `tsconfig.base.json` and `pnpm-lock.yaml` are generated, so neither is patched or merged by hand.

Adding a package requires an entry in each. They conflict on any release where upstream also adds a package — which is most of them — and they are the irreducible floor: a package that lives in this repository has to be listed by this repository. Fork entries stay in one contiguous `DSH-FORK`-fenced block so each file conflicts once.

**T2-B · Composition edited inside upstream files — RETIRED**

This group was six files — upstream's four shipped presets and both bundle patches — and it was the largest recurring conflict source, because upstream reshuffles preset rosters on most releases and the fork's rows sat in the middle of them.

It is gone. The fork's rows live in `packages/bundle/efai-base/cordis.patch.yml` and `efai-web/`, stacked after upstream's bundles by the profile's own layer list. The fork ships no presets at all: upstream's are declared as `agent-preset` rows now, and the kernel tool is a host row that every preset agent sees through the layered tools registry. `efai/ensure-profile-bundles.mjs` keeps the profile naming both bundles, and upstream's files are pristine.

**T2-C · Behavior injected into upstream source — 9 files**

| File | Δ | What it adds |
|---|---|---|
| `packages/llm/llm/src/index.ts` | +91 | `LlmAccountDraft`/`LlmAccountAdder`/`registerAccountProvider` — account pooling on the upstream `LlmRuntime` service |
| `packages/compaction/compaction-basic/src/summarizer.ts` | +113 −14 | compaction prompt and summary parsing |
| `packages/llm/token-meter/src/usage-projection.ts` | +85 −29 | usage projection |
| `packages/extensions/tool-cordis/src/api-catalog.ts` | +80 | catalog entries |
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

These never produce a merge conflict, which is exactly why they are dangerous. `ui-settings-general` is upstream's package; the fork placed two new files inside it and wired them in through the six modified files in that directory. If upstream restructures or deletes the package, the files survive the merge, compile against nothing, and fail at a point far from the cause. This is what happened last merge when upstream deleted `packages/client/runtime` under the fork's `ui-dock` (since retired into `ui-sidebar-terminal`) and `ui-effects`.

A file that only works because of an upstream directory belongs in a fork-owned package that imports from it.

## Why this does not survive an upstream update

Seven concrete failures, in order of cost.

**1. The ownership boundary was undeclared.** `local-overlay/rules.json` and the generated `INVENTORY.md` now declare it: every changed path is classified as fork-owned, seam, or generated, and a path no rule claims fails the rebuild. The remaining gap is the markers — see failure 5 — which are what make an individual conflict legible rather than what defines the boundary.

**2. The repository's own extension mechanism is bypassed.** `AGENTS.md` states the rule: *"Plugins, not loop changes: new behavior goes on documented extension points"*, and `packages/bundle/*` exists so composition changes ship as patch layers rather than preset edits. The fork instead edits four upstream presets in place. A fork-owned bundle package would have delivered the same composition with zero upstream files touched.

**3. Fixes and features are entangled.** T2-D is two upstream bugs. Kept as fork deltas they conflict on every merge, forever, and upstream never fixes them, so the fork pays the cost permanently. Sent upstream they disappear from the diff the moment they land.

**4. Generated files are committed as hand edits.** T2-F is ~260 lines that a generator rewrites in seconds. Every one is a conflict that costs review attention and yields a catalog describing the previous release.

**5. The marker convention is applied unevenly.** Rule 2 asks every Tier-2 edit to carry a marker, and most do: `DSH-FORK` appears in 109 of the 138 patched paths. The other 29 are invisible to the convention — 5 `package.json` manifests, 6 `README.i18n.yaml` files, the three `compaction-basic` README pages, one package `tsconfig.json`, the two generated catalog modules (`packages/extensions/tool-cordis/src/api-catalog.ts`, `packages/extensions/cordis-client-runner/src/client/slot-catalog.ts`), two specs, one client component (`packages/client/ui-conversation/src/client/skeleton/EmptyHero.tsx`), and 8 `docs/` pages. The 29th path, `.claude/skills`, is the one file the fork deletes — a symlink, with nowhere to put a comment. Markers are not the inventory and cannot be: a grep cannot tell a marked edit from a marked file, and a diff against `upstream/master` is mostly upstream's own churn across 1,934 commits. `local-overlay/INVENTORY.md` supplies the inventory mechanically. What the 29 unmarked files cost is legibility at conflict time: the resolver reads a hunk with no stated reason and no exit condition.

**6. `doc-sync` is red on five gates, and the fork packages cause two of them.** `pnpm run test:docs` fails on markdown links, translation pairing, markdown wrap, package README summaries, and the documentation-standard spec. The fork's own packages drive the last two: the sixteen READMEs under `packages/kernel/*`, `packages/rlm/*`, `packages/agent-memory/*`, `packages/client/ui-effects`, `packages/web/web-browser`, `packages/llm/llm-kiln`, `packages/fs/tool-notebook-edit`, and `packages/session/command-session-info` were written without the `## Summary` heading the summaries gate requires, and without the frontmatter, Table of Contents, and Dev Note the doc-standard spec requires. The documentation exists and is detailed; it does not carry the skeleton the gates read. The cost is that five red gates hide a sixth real breakage: a genuine documentation regression lands on top of known failures and nobody notices.

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

**Tier 2, seam.** An upstream file the fork must touch. Every one is listed in [the seam register](#the-seam-register) with a reason and an exit plan, covered by a patch group in `local-overlay/rules.json`, and **recorded in `local-overlay/SEAM.json`**. That last file is what makes "a decision, not a side effect" enforceable: `pnpm run verify-seam-frozen` fails a tree that modifies an upstream file the list does not already carry. The list shrinks freely — retiring an edit is the whole point — and grows only when someone records the growth in the same commit.

**Tier 3, upstream-owned.** Everything else. **Never edit.** An edit here is a defect in the change, not a feature of it — move it to Tier 1, or send it upstream.

**Generated.** Not a fourth tier so much as an exclusion: a file a generator owns is neither patched nor merged by hand. Rule 4 governs it, and `local-overlay/rules.json` lists every one with its regeneration command.

This document is the contract a maintainer reads. `local-overlay/rules.json` is the same split in the form the scripts enforce, and `local-overlay/INVENTORY.md` is the generated list of what each side currently holds. The two must agree: when they do not, the rebuild fails rather than picking a winner.

### Rule 2 — Every Tier-2 edit carries a marker

One line, immediately above the edit, in the file's comment syntax:

```ts
// DSH-FORK(fix): installModelSelection is re-entrant on resume and redeclares the
// accessor. EXIT: upstream PR — this is an upstream bug, not a fork feature.
```

```yaml
# DSH-FORK(all): the fork's own gate, which upstream's hook config cannot know about.
# EXIT: upstream gains a hook-extension point a fork can register into.
```

The tag in parentheses is the feature: `kernel`, `kiln`, `dock`, `browser`, `memory`, `rlm`, `fix`, `brand`. Use `all` only for a file the whole fork shares, such as a tsconfig or the lockfile. The `EXIT:` clause names the event that deletes the edit. An edit with no exit is a permanent tax; write it down as one.

The marker is what makes a conflict legible while it is being resolved: the fork's side of a hunk carries the reason it exists and the condition that retires it. It is not the inventory. `local-overlay/INVENTORY.md` is the inventory, and it is generated, so it cannot go stale the way a hand-maintained grep result does.

After editing an upstream-owned file, fold the edit into its patch and re-prove the layer — `.agents/skills/dsh-harness-edit` has the exact command sequence.

### Rule 3 — Choose the mechanism in this order

1. **A row in a fork-owned bundle.** `packages/bundle/efai-base/cordis.patch.yml`, or `efai-web/` for the browser profile. A later bundle layer inserts rows, replaces a row's whole `config`, and switches a row off by id — everything composition can express. The profile names the bundles, and `efai/ensure-profile-bundles.mjs` keeps them there.
2. **A new fork-owned package on a documented extension point.** Zero merge cost, forever. `efai-identity` rewrites the prompt opener on `system-prompt/assemble`; `version-route` adds an HTTP route; the roster (`tool-roster` row) filters tools per turn.
3. **A host row, for something every agent should have.** The tools registry is layered, so a host registration reaches every preset agent. Never replace an upstream preset row: preset rows are not groups, so a patch can only restate the whole preset.
4. **A switch decided at runtime.** A `.volatile()` field on the row that enforces it, re-read on `loader/volatile-update` — the roster for tool visibility, `agent-memory-mode` for a subsystem that must stop running. Settings edits it by row id. Never a Loader `disabled: !!js` expression: it is read once at boot, which makes the setting a restart.
5. **A settings value.** If it varies per deployment it is `Config`, per `AGENTS.md`: *"No hardcoded tunables in plugins"*.
6. **An upstream pull request.** For anything that is a bug, or that upstream would plausibly accept.
7. **A recorded seam edit.** Last resort. Smallest possible hunk, marker, exit plan, register entry, patch group, and `verify-seam-frozen --record` in the same commit.

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
    { "path": "./packages/kernel/kernel-python" },
    { "path": "./packages/kernel/tool-kernel" },
    { "path": "./packages/llm/llm-kiln" },
    { "path": "./packages/web/web-browser" },
    { "path": "./packages/session/command-session-info" },
    // DSH-FORK end
```

Both files carry that fenced block now, which is why each conflicted exactly once in the 0.1.7-alpha.2 merge. `tsconfig.base.json` needs none of this — it is generated.

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
| ~~1~~ | 4 preset `agent.cordis.yml` | `kernel` | **RETIRED** — the fork rosters were retired in turn by the 0.1.7-alpha.2 merge: upstream declares presets as `agent-preset` rows, and the kernel tool is a host row every preset agent sees | done |
| ~~2~~ | `bundle/{base,web-app}/cordis.patch.yml` | `kernel` `kiln` | **RETIRED** — every fork row moved to `packages/bundle/efai-base` and `efai-web` | done |
| ~~3~~ | `boot/app-boot/src/index.ts` | `kernel` | **RETIRED** — no composition row reads a setting any more, so `dshSettingFlag` was deleted; the three switches decide at runtime | done |
| 4 | `llm/llm/src/index.ts` | `kiln` | `registerAccountProvider` on `LlmRuntime` | Upstream PR, or a fork-owned service that wraps it |
| ~~5~~ | `compaction-basic/{index,summarizer}.ts` | `kiln` | **RETIRED** — first into `compaction-efai`; then, when presets began isolating their own `compaction-basic`, its summarizer statement moved into `llm-kiln` (keyed on `purpose: 'compaction'`) and the package was removed | done |
| ~~6~~ | `llm/token-meter/**` (3 files) | `kiln` | **RETIRED** — `packages/llm/token-usage-lifetime` registers its own projection unit beside upstream's | done |
| ~~7~~ | `extensions/tool-cordis/src/api-catalog.ts` | `kernel` | **RETIRED** — the file is generated (`gen-cordis-api`), so it is declared generated and regenerated rather than patched; the client slot catalog went with it | done |
| ~~8~~ | `client/ui-settings-general/**` (6 files) | `kernel` | **RETIRED** — first into `ui-settings-advanced`; then upstream's generated per-plugin pages and **Open configuration file** replaced it outright | done |
| 9 | `core/agent/src/model-selection.ts` | `fix` | **upstream bug** — accessor re-entrancy on resume | **Upstream PR** |
| 10 | `tsdown.config.ts` | `fix` | **upstream bug** — manifest-less workspace members | **Upstream PR** |
| ~~11~~ | `core/system-prompt/src/index.ts` | `brand` | **RETIRED** — `packages/core/efai-identity` rewrites the opener on `system-prompt/assemble`, and upstream's own tests pass unmodified again | done |
| 12 | 2 CSS modules, 3 `locales.ts` | `brand` | styling and copy inside upstream components; the *token* half retired into `packages/client/ui-flow-accents` | Upstream adopts the chrome, or the components are forked |
| 13 | 3 `scripts/gen-*.ts` | `kernel` | generators must see fork packages | Upstream PR if the change is general |
| 14 | `tsconfig.{host,client}.json` | `all` | project references | Contiguous fenced block (Rule 6) |
| 15 | `pnpm-lock.yaml` | `all` | dependencies | `merge=ours` + regenerate (Rule 7) |
| 16 | `.gitignore`, `.gitattributes` | `all` | credentials, CRLF for `*.cmd` | Permanent; append at end of file only |
| 17 | `docs/subsystems/llm-streaming.*` | `kiln` | hand-written docs for a fork feature | Move to fork-owned `docs/` pages |
| 18 | 8 test files | various | mirror 3–6 above | Follows whatever those become |
| ~~19~~ | 2 files inside `client/ui-settings-general` | `kernel` | **RETIRED** — see row 8 | done |
| 20 | `client/ui-model-selection/src/client/{ModelSelect.tsx,ModelSelect.module.css}` | `browser` | collapsible per-provider groups in the model dropdown, with account routes folded under a single base-provider header and an account picker | Upstream adopts provider collapse and account grouping in `ModelSelect` |
| ~~21~~ | `packages/skill/tool-skill/src/index.ts` | `kernel` | **RETIRED** — the `@skill <name>` gesture is a second `agent/pre-step` listener in `packages/skill/skill-injection` | done |
| ~~22~~ | `packages/skill/tool-skill/src/index.ts` | `kernel` | **RETIRED** — `alwaysLoadSkills` moved to `packages/skill/skill-injection`, which re-injects a pruned body from the same hook | done |
| 23 | `packages/client/ui-skill/src/client/index.ts` | `kernel` | `@skills` picker registers a second trigger source beside `skill` | Upstream PR, or a fork-owned client package |
| 24 | `packages/client/ui-input-trigger/src/client/{MenuView.tsx,MenuView.module.css}` and `tests/menu-view.client.spec.tsx` | `browser` | collapsible `@` trigger-menu sections (the highlighted section is expanded by default; the rest start minimized) | Upstream adopts collapsible trigger-menu sections |
| ~~25~~ | `packages/bundle/base/cordis.patch.yml` + 4 preset `agent.cordis.yml` | `rlm` | **RETIRED** — the engine mounts unconditionally in `efai-base`; `tool-roster` decides per turn whether `kernel` or `rlm` is the acting surface | done |
| ~~26~~ | `client/ui-chat` turn-process fold (6 sources, 2 tests) | `brand` | **RETIRED** by upstream: 0.1.7-alpha.2 renders the process row for a running Turn, handles partly-loaded history, and keeps interleaved input visible with the row held open | done |
| ~~27~~ | `packages/bundle/base/cordis.patch.yml`, `apps/cli/package.json` | `memory` | **RETIRED** — `agent-memory-mode` mounts and unmounts the engine from the live setting, in `efai-base`; `apps/cli` now declares only the two fork bundles | done |
| 28 | `.agents/skills/dsh-code-review/SKILL.md`, `.agents/skills/dsh-pre-push-checks/SKILL.md` | `all` | upstream's review and pre-push skills cannot know about this fork: the tier split, the `DSH-FORK` marker, `local-overlay/`, or the `verify-fork-overlay` gate. Each carries one added section plus its marker. | Permanent fork delta: the upstream skills would need a fork-extensibility mechanism for these sections to move out. |
| 29 | `scripts/verify-package-readme-model-experience.ts` | `all` | the fork ships package READMEs for fork-owned packages, so the audited `NO_MODEL_EXPERIENCE_SECTION` / `SENTENCE_MODEL_EXPERIENCE` allowlists must name them; without entries the gate rejects a correct README. | Upstream accepts a model-experience declaration inside each package manifest, so the allowlists stop being a central file. |
| 30 | `client/ui-brand-official/**` (3 `README*`, `src/client/Brand.tsx`, `src/client/index.ts`, `tests/browser-plugin.client.spec.tsx`), `apps/web/tests/built-boot.expected.e2e.ts` | `brand` | the sidebar brand is the fork's in **every** build profile — upstream gates the registration behind `DSH_CLIENT_BUILD_PROFILE=official`, so an unprofiled build falls through to the shell's `DSH Local Build` label and its version badge; the name is live text carrying a specular sweep rather than the upstream name artwork, and the built-boot smoke pins that wordmark instead of the profile-dependent shell brand | A fork-owned client package owns the sidebar chrome, so the registration stops being a gate on an upstream package |
| 31 | `client/ui-settings/src/client/config-form.ts` | `settings-freeze` | memoizes a decoded settings section per raw value and rehydrates the namespace schema once, so a settings write does not re-validate every section on the main thread; carried across upstream's `settings-scope.ts` → `config-form.ts` rename | **Upstream PR** |

If row 4 moves to a fork-owned package and rows 9, 10, and 31 go upstream, what remains is the client chrome (rows 12, 20, 23, 24, 30) and the lists and infrastructure, which conflict predictably in one place each.

## Known fork debt

Recorded at the v1.0.0 commit. These are real, verified gaps, not suspicions. The fork's
own gate (`pnpm run verify-fork-overlay`) and `typecheck` are green; five `doc-sync` gates are
**not**, and this is why.

| Gate | Cause | Exit |
|---|---|---|
| `verify-translation-pairing` | 16 fork package READMEs have no `README.zh.md` pair, plus 4 fork docs (`python/kiln/runtime/README.ds-direct.md`, `README.vision-tools.md`, `local-overlay/README.md`, `HARNESS-EDITS.md`); 4 existing pairs are also out of sync (`README.md`, `docs/event-producer-consumer.md`, `docs/tool-catalog.md`). | Add counterparts; re-record with `--write`. |
| `verify-package-readme-summaries` and the doc-standard spec | 16 fork package READMEs lack the `## Summary`, `## Table of Contents`, and Dev Note sections and YAML frontmatter the gates read. | Add the skeleton to all 16. |
| `verify-md-links` | One broken relative link: the fork Agent Note `2026-09-07-kernel-rlm-context-readback-hardening.md` names a `.zh.md` sibling that does not exist. (The code-review skill's missing `#reporting-findings` anchor was fixed in the 0.1.7-alpha.2 merge: an older fork hunk had replaced upstream's last two sections instead of appending after them.) | Write the sibling. |
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

**3. Resolve real conflicts using the register.** A remaining conflict usually shows a `DSH-FORK` marker on the fork's side, carrying the reason and the `EXIT:` clause. A hunk with no marker is not proof that the edit was never registered — 29 patched paths carry none — so look the path up in `local-overlay/INVENTORY.md` before concluding anything about it.

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
3. **Finish the marker pass.** 29 of the 138 patched paths still carry no marker; the list and the grouping are in failure 5. Each one is a conflict a resolver reads cold.
4. **Fence the `tsconfig.host.json` / `tsconfig.client.json` entries.** Ten minutes; turns eight conflicts into two.
5. **`pnpm-lock.yaml merge=ours`.** One line; removes the single largest conflicting file.
6. **Move `ds_config.json` and `ds_sessions.json` out of the repository tree.**
7. **Give the sixteen fork package READMEs the required skeleton** — `## Summary`, `## Table of Contents`, the Dev Note section, and YAML frontmatter. Clears the package README summaries gate and the documentation-standard spec.
8. **Wire `rebuild.mjs --check` into the push path**, so a stale patch set cannot reach a branch.
9. **Move row 11** — the system-prompt identity string — to a prompt section registered by a fork plugin. One line today, but it is in a file upstream edits often.