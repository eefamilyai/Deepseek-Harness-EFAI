---
name: dsh-harness-edit
description: Use before editing any file in the deepseek-harness fork, and again after the edit before committing, to place the change in the correct ownership tier, mark it per HARNESS-EDITS.md, and fold it into the local-overlay patch set so a future upstream release reapplies cleanly. Required whenever a request changes harness source, composition, docs, tests, or scripts rather than only reading them.
---

# Editing the deepseek-harness fork

This repository is a fork of `deepseek-ai/deepseek-harness`. Upstream rewrites its own source continuously, so every change the fork makes to a file upstream owns is a recurring merge cost that is paid again on every release.

Two artifacts make that cost bounded, and both must stay current:

- `HARNESS-EDITS.md` — the fork's contract: the three tiers, the nine rules, the seam register that records why each upstream file is touched and what removes the edit. This is what a maintainer reads.
- `local-overlay/` — the same split in machine-readable form: `rules.json` decides which path belongs to which patch, `patches/*.patch` hold the fork's side of every upstream file as a re-appliable diff, and three scripts regenerate and prove them.

Read `HARNESS-EDITS.md` before touching anything. It is fork-owned, so it never conflicts. This skill is the operating procedure; `HARNESS-EDITS.md` and `rules.json` are authoritative when they disagree with it.

## When this skill applies

Apply it to any change to harness source, composition, configuration, docs, tests, snapshots, or scripts.

Skip it for pure read, inspect, and search tasks, and for changes confined to `.agents/notes/`, `.merge-port/`, or `local-overlay/` itself, which no patch covers. `local-overlay/rules.json` is the authority for that list, not this paragraph.

For a change to the model-facing system prompt, follow [dsh-edit-system-prompt](../dsh-edit-system-prompt/SKILL.md) as well; it covers section selection and the paired test.

## The three tiers

Classify every path you touch. The tier decides what you must do afterwards.

| Tier | What it is | Cost | What you do |
| --- | --- | --- | --- |
| 1 — fork-owned | A path upstream does not have: a new package, `python/kiln/`, `desktop/`, a fork document, a fork script. | None. Upstream cannot conflict with a path it does not create. | Put the change here whenever it can go here. No patch, no marker, no register row. |
| 2 — seam | An upstream file the fork modifies. | The entire merge cost, paid every release. | `DSH-FORK` marker, an `EXIT:` clause, a seam-register row, and a patch group that claims the path. |
| 3 — upstream-owned | Everything else. | — | Never edit. Move the change to Tier 1, or send it upstream. |
| generated | A file a generator owns. | None, if handled correctly. | Never patched and never hand-merged. Take upstream's side and re-run the generator. |

Tier 1 is the target. A change that lands in Tier 1 costs nothing forever; the same change in Tier 2 costs a conflict-resolution decision on every upstream release for as long as it lives.

## Classify a path

Ask git, not memory. The tier is a function of the path and the recorded base commit:

```sh
# Every path the fork changes relative to the recorded base, including uncommitted edits.
git diff --name-status -M "$(head -1 local-overlay/BASE)"

# Fails when any changed path has no rule, or when patches/ or INVENTORY.md is stale.
node local-overlay/rebuild.mjs --check
```

`local-overlay/lib.mjs` classifies in this order, and the order matters:

1. Status `A` — the path does not exist at the base — is **Tier 1**. No patch group claims it and none is needed.
2. A path listed in `rules.json` `generated` is **generated**.
3. A path matching a `patchGroups` prefix is **Tier 2**.
4. Anything else is **unclaimed**, and the rebuild fails and prints it.

So a modified upstream file is Tier 2 because a patch group claims it, and an added file is Tier 1 regardless of which directory it lands in. `tier1Prefixes` in `rules.json` is documentation of the fork-owned surface for readers; classification does not consult it. Do not rely on a prefix in that list to register an edit.

A prefix match is `path === prefix || path.startsWith(prefix)`, evaluated group by group in declaration order. The first group with any matching prefix wins, so a narrow group must be declared before the broader group that would otherwise swallow it.

## Choose the mechanism before choosing the hunk

Try these in order and stop at the first that works. Rule 3 of `HARNESS-EDITS.md` owns this list.

1. **A new fork-owned package on a documented extension point.** Zero merge cost. Always try this first.
2. **A fork-owned bundle.** `packages/bundle/efai-<feature>/cordis.patch.yml`, applied by profile. Composition changes belong here, not in upstream's shipped presets.
3. **A settings value.** If it varies per deployment it is `Config`; `AGENTS.md` forbids hardcoded tunables in plugins.
4. **An upstream pull request.** For any bug in upstream code, or anything upstream would plausibly accept. Keep a local copy at `.merge-port/upstream-prs/<name>.patch` with a register row, and delete the local delta when the PR lands.
5. **A marked Tier-2 edit.** Last resort. Smallest possible hunk, marker, exit plan, register row, patch group.

A fork package is a real package: README, JSDoc on every export, tests, and a catalog entry. `pnpm run doc-sync` is the gate.

## The `DSH-FORK` marker

Every Tier-2 edit carries a marker on the line immediately above it, in the file's own comment syntax:

```ts
// DSH-FORK(kernel): dshSettingFlag lets a Loader `disabled` expression read the
// settings document. EXIT: upstream ships a settings reader in the !!js scope.
export function dshSettingFlag(...) { ... }
```

```yaml
# DSH-FORK(kernel): kernel.enabled picks the acting roster.
# EXIT: move to packages/bundle/efai-kernel/cordis.patch.yml.
```

```css
/* DSH-FORK(browser): collapsed provider groups. EXIT: upstream adopts provider collapse. */
```

The tag in parentheses names the feature: `kernel`, `kiln`, `dock`, `browser`, `memory`, `rlm`, `fix`, `brand`, or `all` for repository-wide infrastructure. `fix` marks an upstream bug carried as a fork delta, and those are the rows to send upstream first.

The `EXIT:` clause names the event that deletes the edit. An edit with no exit is a permanent tax, so write down the exit even when it is remote.

Coverage is a requirement, not an observation: a Tier-2 edit without a marker cannot be identified at a conflict, so it cannot be resolved deliberately. Confirm your own edit carries one:

```sh
git diff "$(head -1 local-overlay/BASE)" -- <path>
```

The marker appears in the fork's side of the hunk.

## The overlay scripts

All four run from the repository root, take no required arguments, and read only `local-overlay/BASE`, `rules.json`, and the working tree.

| Script | What it does |
| --- | --- |
| `node local-overlay/rebuild.mjs` | Regenerates `patches/*.patch` and `INVENTORY.md` from the working tree against the recorded base. Writes patch files with LF endings. Deletes a patch no rule produces and reports a path no rule claims. |
| `node local-overlay/rebuild.mjs --check` | Writes nothing, reports every stale patch and a stale manifest, and exits 1 on drift. This is the CI and pre-push gate. |
| `node local-overlay/verify.mjs` | Builds a throwaway checkout of the base, applies every patch, and compares the result byte-for-byte against the working tree. Proves base + patches reproduces the fork exactly. |
| `node local-overlay/apply.mjs --check` | Applies every patch file on disk to a throwaway checkout of the base, and checks that the patch set and `rules.json` agree. Writes nothing to this tree. |
| `node local-overlay/apply.mjs` | Applies the patches to this checkout. An already-applied patch fails; use it after merging upstream, not on a tree that already carries the edits. |
| `node local-overlay/apply.mjs --target <dir>` | Applies into another checkout. |

`patches/` and `INVENTORY.md` are generated. `rules.json` is the single source of truth for patch grouping; a patch file is never hand-edited, and `INVENTORY.md` is never hand-edited.

The same sequence is wired as one script, which is what CI and a push hook should call:

```sh
pnpm run verify-fork-overlay          # rebuild --check, verify, then apply --check
pnpm run verify-fork-overlay:rebuild  # the write side, when drift is intentional
```

## After an edit to an upstream-owned file

Run all three, in this order. Each catches a failure the others cannot.

```sh
node local-overlay/rebuild.mjs        # 1. fold the edit into its patch
node local-overlay/verify.mjs         # 2. prove base + patches == this tree
node local-overlay/apply.mjs --check  # 3. prove the committed patches still apply
```

**`rebuild.mjs`** is what makes the patch set describe the change you just made. Until it runs, `patches/*.patch` describe the previous state of the tree, and an upstream update would reapply a stale edit. It also fails on a path no rule claims, which is how an unregistered seam edit is caught instead of being merged by hand forever.

**`verify.mjs`** proves the partition is right: every Tier-2 path is produced by exactly the patch that claims it, and the content matches. It re-derives the diffs from the working tree, so it stays green even when a patch file on disk has gone stale.

**`apply.mjs --check`** reads the patch files that are actually committed and applies them to a pristine base. That is the check `verify.mjs` structurally cannot make, and it is the one that catches a stale patch file. It also reports a patch that `rules.json` declares but that does not exist, and one that exists but no rule declares.

`verify.mjs` compares content with CRLF collapsed to LF. `.gitattributes` sets `* text=auto eol=lf` while a Windows checkout presents CRLF, so both forms are correct and only the content is compared. Do not chase a line-ending difference.

### After an edit to a fork-owned file

No patch and no marker. Confirm the tree and the manifest still agree:

```sh
node local-overlay/rebuild.mjs --check
```

## Adding a seam edit

A new Tier-2 path needs a `patchGroups` entry whose `paths` prefix covers it, placed before any broader group that would otherwise claim it.

```jsonc
{
  "name": "client-shell",
  "paths": [
    "packages/client/ui-conversation/",
    "packages/client/ui-sidebar/"
  ]
}
```

Then run the full three-command sequence above. A directory prefix must end in `/` so it cannot match a sibling package whose name merely starts with the same characters.

Two consequences of the rules that are easy to miss:

- Every group declared in `rules.json` must keep at least one changed path, because `apply.mjs` requires a patch file for every declared group while `rebuild.mjs` writes one only for a group that has changes. When a group empties, delete its entry from `rules.json`.
- A root-level file that no group claims fails the rebuild. Root `package.json` and `.gitattributes` are claimed by the `root-meta` group; a new root file needs a group of its own, or the edit must move out of the root.

Adding a fork-owned package needs no change to the overlay. It is an added path, so it appears under Tier 1 in the regenerated `INVENTORY.md`.

## Never hand-merge and never hand-edit

At a conflict in any file below, take upstream's side wholesale and re-run the generator. Merging them by hand produces a catalog that describes the previous release.

| File | Regenerate with |
| --- | --- |
| `pnpm-lock.yaml` | `pnpm install --no-frozen-lockfile` |
| `tsconfig.base.json` | `pnpm run gen-tsconfig-paths` |
| `docs/config-catalog.md` | `pnpm run gen-config-catalog` |
| `docs/tool-catalog.md` | `pnpm run gen-tool-catalog` |
| `apps/cli/composition.md` | `pnpm run gen-doc-graphs` |
| `docs/capability-seams.md` | `pnpm run gen-doc-graphs` |
| `THIRD_PARTY_NOTICES.md` | `pnpm run gen-third-party-notices` |
| `snapshots/web/lifecycle-chrome/hero.expected.md` | `pnpm run test:snapshot:record` |
| `snapshots/web/lifecycle-chrome/plan-active.expected.md` | `pnpm run test:snapshot:record` |

`rules.json` `generated` is the authority for this list; `INVENTORY.md` renders it. Snapshot recording needs `DEEPSEEK_API_KEY`.

Never hand-edit any of these, which are all generated or authoritative:

- `local-overlay/patches/*.patch` — produced by `rebuild.mjs`. To change a patch, change the working tree or `rules.json`, then rebuild.
- `local-overlay/INVENTORY.md` — produced by `rebuild.mjs`.
- `local-overlay/rules.json` — hand-authored, and the only place patch grouping is declared. The scripts read it; nothing writes it.

## Credentials

`.gitignore` states intent; it does not enforce it. Keep secrets out of the working tree entirely: environment variables, or a file under `$DSH_HOME` outside the repository. The Kiln presets already name an environment variable per provider instead of storing a key.

Never add `ds_config.json` (a DeepSeek login password and WAF cookie) or `python/kiln/runtime/ds_sessions.json` (live session tokens) to the worktree. Verify before every push; the output must be empty:

```sh
git ls-files | grep -iE 'ds_config|ds_sessions|subkernels\.json|\.env$|KILN\.md'
```

A lockfile is never merged by hand either. A merged lockfile is not a resolvable one: take one side, then regenerate.

```sh
pnpm install --no-frozen-lockfile && git add pnpm-lock.yaml
```

## Registration lists

Keep every fork entry in `tsconfig.host.json` and `tsconfig.client.json` in one contiguous `DSH-FORK`-fenced block, so the file conflicts once instead of several times:

```jsonc
    // DSH-FORK(all): fork packages. Keep contiguous — one conflict hunk, not five.
    { "path": "./packages/kernel/kernel" },
    { "path": "./packages/kernel/kernel-python" },
    // DSH-FORK end
```

`tsconfig.base.json` needs none of this. It is generated by `pnpm run gen-tsconfig-paths`; append new fork packages to that generator's input instead of editing the output.

## Updating to a new upstream release

`HARNESS-EDITS.md` section "Updating to a new upstream release" owns the full sequence and the current seam register. The overlay adds four steps.

```sh
git fetch upstream
git merge upstream/master

# 1. Generated files: take upstream's side wholesale. Do not read these conflicts.
git checkout --theirs pnpm-lock.yaml tsconfig.base.json \
  docs/config-catalog.md docs/tool-catalog.md apps/cli/composition.md \
  docs/capability-seams.md THIRD_PARTY_NOTICES.md \
  snapshots/web/lifecycle-chrome/hero.expected.md \
  snapshots/web/lifecycle-chrome/plan-active.expected.md

# 2. Re-apply the fork's side of the seam.
node local-overlay/apply.mjs

# 3. Regenerate everything a generator owns.
pnpm install --no-frozen-lockfile
pnpm run gen-tsconfig-paths
pnpm run gen-config-catalog && pnpm run gen-tool-catalog
pnpm run gen-doc-graphs && pnpm run gen-third-party-notices

# 4. Prove the result, then build before testing.
node local-overlay/verify.mjs
pnpm run clean && pnpm install && pnpm run build
```

Then follow `HARNESS-EDITS.md`: resolve any remaining conflict from the seam register, verify the fork's own features rather than only that it compiles, record the merge in `.merge-port/MERGE-STATUS.md`, and update the register and `rules.json` for any Tier-2 edit added or removed.

A patch that fails to apply is the signal to inspect, not a failure to work around: upstream changed the code around the fork's edit. Resolve it inside that patch's subsystem, then re-run the sequence from step 2.

When upstream lands a change that makes the fork's edit unnecessary, delete the edit from the tree and let the rebuild drop its hunk. When the base moves, update `BASE` to the new upstream commit, run `rebuild.mjs`, and record which upstream commit the patches were regenerated against.

Delete stranded package directories before building. A package removed upstream leaves its `lib/` and `node_modules/` behind, and tsdown adopts the residue as a build target.

## Before committing

- Run the narrowest owning test for the changed behavior, then `pnpm run verify-fork-overlay`.
- Diff against the recorded base and confirm every modified path is either Tier 1 or a marked, registered Tier-2 edit.
- A Tier-2 edit that was not planned is a decision, not a detail: move it to Tier 1, send it upstream, or register it with a marker, an exit plan, and a patch group.
- A new Tier-2 file or a removed one updates the seam register in `HARNESS-EDITS.md` in the same change.
- Run the Web rebuild (`start.cmd --build-only`) after the project's changes are complete, so edited packages reach the served app.
- Follow [dsh-pre-push-checks](../dsh-pre-push-checks/SKILL.md) for the outgoing diff and [dsh-github](../dsh-github/SKILL.md) for commit and push mechanics.

## Diagnosing the overlay

| Message | Meaning | Action |
| --- | --- | --- |
| `Paths no rule claims — add a patchGroup in rules.json, or move the edit to a fork-owned file:` | A modified upstream path has no group. | Add a `patchGroups` entry covering it, or move the edit into a fork-owned file. |
| `DRIFT <name>.patch` | The patch on disk differs from what the tree produces. | `node local-overlay/rebuild.mjs`. |
| `STALE <name>.patch — no rule produces it` | The group has no changed paths, or the edit moved out. | The rebuild deletes it; also delete the now-empty group from `rules.json`. |
| `DRIFT INVENTORY.md` | The manifest is out of date. | `node local-overlay/rebuild.mjs`. |
| `The patch set and rules.json disagree:` / `declared by rules.json but absent` | A declared group has no patch file. | Rebuild, or delete the empty group from `rules.json`. |
| `on disk but not declared by rules.json` | An undeclared patch file exists. | Rebuild removes it; do not keep a hand-written patch. |
| `FAIL <name>.patch` from `apply.mjs --check` | The patch does not apply to the recorded base. | The base moved, or the edit changed; resolve inside that subsystem and rebuild. |
| `content differs: <path>` from `verify.mjs` | The patch does not reproduce the tree for that path. | Rebuild; if it persists, the path is claimed by two groups or by the wrong one. |
| `not produced by its patch: <path>` | A changed path is in no patch. | Add a `patchGroups` entry. |

## Related skills

- [dsh-prose-standard](../dsh-prose-standard/SKILL.md) — comments, docs, and visible strings in the change.
- [dsh-doc](../dsh-doc/SKILL.md) — documentation placement and the documentation gates.
- [dsh-pre-push-checks](../dsh-pre-push-checks/SKILL.md) — the smallest checks that cover the outgoing diff.
