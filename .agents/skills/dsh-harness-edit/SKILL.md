---
name: dsh-harness-edit
description: Use before editing any file in the deepseek-harness fork, and again before committing. Upstream-owned files are frozen — the fork's composition, prompt text, rosters, switches, and new behavior all ship as fork-owned packages, bundle rows, and presets, and `verify-seam-frozen` fails a build that modifies an upstream file it has not already taken on. This skill names the mechanism to use instead, and the overlay commands that keep the recorded seam honest. Required whenever a request changes harness source, composition, docs, tests, or scripts rather than only reading them.
---

# Editing the deepseek-harness fork

This repository is a fork of `deepseek-ai/deepseek-harness`. Upstream rewrites its own source continuously, so every change the fork makes to a file upstream owns is a recurring merge cost that is paid again on every release.

Two artifacts make that cost bounded, and both must stay current:

- `HARNESS-EDITS.md` — the fork's contract: the three tiers, the nine rules, the seam register that records why each upstream file is touched and what removes the edit. This is what a maintainer reads.
- `local-overlay/` — the same split in machine-readable form: `rules.json` decides which path belongs to which patch, `patches/*.patch` hold the fork's side of every upstream file as a re-appliable diff, and three scripts regenerate and prove them.

Read `HARNESS-EDITS.md` before touching anything. It is fork-owned, so it never conflicts. This skill is the operating procedure; `HARNESS-EDITS.md` and `rules.json` are authoritative when they disagree with it.

## The seam is frozen

**Do not edit a file upstream owns.** The list of upstream files this fork modifies
is recorded in `local-overlay/SEAM.json`, and a path that is not on it fails the
gate:

```sh
pnpm run verify-seam-frozen
```

The list may shrink whenever an edit moves into fork-owned code; that is the
direction of travel, and the gate prints the retired paths so the list can be
re-recorded. It grows only by a deliberate, reviewed act — you record the growth in
the same commit, and the diff shows exactly which upstream file the fork just took
on and pays for at every release forever.

So the question is never "where do I put this edit". It is **"which fork-owned
mechanism expresses it"**. Ask these in order and stop at the first that works; each
is strictly cheaper than the one below it, and every one of them is already carrying
real behavior in this repository, so none of them is theoretical.

| # | Ask | If yes | Precedent in this tree |
|---|---|---|---|
| 1 | Is this **composition** — a plugin to mount, a row's config to change, a row to switch off? | A row in `packages/bundle/efai-base/cordis.patch.yml`, or `efai-web/` for the browser profile. | Every fork row the harness runs. |
| 2 | Is this **behavior** that a documented extension point can carry? | A new fork-owned package mounted by that bundle. | `efai-identity` rewrites the prompt opener on `system-prompt/assemble`; `skill-injection` is a second `agent/pre-step` listener; `token-usage-lifetime` registers its own projection unit; `ui-settings-tools` is a `settings.section` slot registration; `ui-flow-accents` is a theme override layer; `llm-kiln` shapes a request by its `purpose`. |
| 3 | Is this something **every agent** should have? | A host row in `efai-base`. The tools registry is layered, so a host registration reaches every preset agent; a preset's own choices belong to upstream's preset editor. | `tool-kernel` is one host row serving every preset. Upstream's preset rows are not groups, so a bundle patch can only replace one wholesale — never do that. |
| 4 | Is this a **switch** someone should be able to flip? | A `.volatile()` field on the row that enforces it, never a Loader `!!js` gate. Settings edits it by row id; react on `loader/volatile-update`. | `tool-roster`'s `kernel`/`rlm`/`enabled`; `agent-memory-mode` mounts and unmounts the engine; `kernel-python`'s `browserWindow`. |
| 5 | Is this a **value that varies per deployment**? | A `Config` field. `AGENTS.md` forbids hardcoded tunables in plugins. | Every fork package's `Config`. |
| 6 | Is this a **bug in upstream code**, or something upstream would plausibly accept? | An **upstream PR**. Keep a local copy in `.merge-port/upstream-prs/<name>.patch` with a register row, and delete the local delta when it lands. | Seam-register rows 9 and 10. |
| 7 | None of the above, and you can say why in one sentence. | A recorded seam edit: smallest possible hunk, `DSH-FORK` marker, `EXIT:` clause, seam-register row, `patchGroups` entry, **and** `verify-seam-frozen --record`. | 74 paths, and every one of them is a cost. |

A Loader `disabled: !!js …` expression that reads a setting is never the answer to
step 4. The expression is evaluated once at boot, so gating composition on a setting
makes that setting a restart by construction — and the plugin it gates is unmounted,
which means the switch cannot even publish itself in its own off position. Decide at
runtime instead: filter what the model sees (`tool-roster`), or mount and unmount the
subsystem from its own switch (`agent-memory-mode`).

**A recorded seam edit is a mod, not a source change.** The working tree carries it —
that is how the fork builds — but `patches/*.patch` is what a future release
reapplies. An edit that only exists in the working tree is not a mod and is lost at
the next merge. Run the sequence below before you consider it finished.

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

## A fork package is a real package

README, JSDoc on every export, tests, and a catalog entry. `pnpm run doc-sync` is the gate, and [Wiring a new package](#wiring-a-new-package) is the checklist that makes the Loader able to load it at all.

The order in which to reach for each mechanism is [The seam is frozen](#the-seam-is-frozen) above; Rule 3 of `HARNESS-EDITS.md` owns the same list for maintainers.

## The `DSH-FORK` marker

Every Tier-2 edit carries a marker on the line immediately above it, in the file's own comment syntax:

```ts
// DSH-FORK(fix): installModelSelection is re-entrant on resume and redeclares the
// accessor. EXIT: upstream PR — this is an upstream bug, not a fork feature.
```

```yaml
# DSH-FORK(all): the fork's own gate, which upstream's hook config cannot know about.
# EXIT: upstream gains a hook-extension point a fork can register into.
```

```css
/* DSH-FORK(browser): collapsed provider groups. EXIT: upstream adopts provider collapse. */
```

A marker must use the **host file's own comment syntax**. A `//` marker in a file whose
comment character is `#` is not a comment — `.gitattributes` parses it as an attribute
name and warns, and `.gitignore` parses it as a live ignore pattern. Both silently do
the wrong thing. Check the lead character against the file type before writing it.

The tag in parentheses names the feature: `kernel`, `kiln`, `dock`, `browser`, `memory`, `rlm`, `fix`, `brand`, or `all` for repository-wide infrastructure. `fix` marks an upstream bug carried as a fork delta, and those are the rows to send upstream first.

The `EXIT:` clause names the event that deletes the edit. An edit with no exit is a permanent tax, so write down the exit even when it is remote.

Coverage is a requirement, not an observation: a Tier-2 edit without a marker cannot be identified at a conflict, so it cannot be resolved deliberately. Confirm your own edit carries one:

```sh
git diff "$(head -1 local-overlay/BASE)" -- <path>
```

The marker appears in the fork's side of the hunk.

### Where a marker cannot go

Most Tier-2 files take a marker. Some cannot, and forcing one breaks a gate. These are
the exceptions measured against this tree, not guesses:

| Class | Why no marker | What covers it instead |
|---|---|---|
| `*.json` manifests (`package.json`, `tsconfig.json`) | JSON has no comment syntax. | The `patchGroups` entry and the patch itself. |
| A bilingual pair's `README.md` / `README.zh.md` | Each side's git blob hash is recorded in the sibling `README.i18n.yaml`; editing one side without re-recording breaks `verify-translation-pairing`. | Mark **both** sides, then re-record with `pnpm run verify-translation-pairing --write <path>`. |
| A generated file (`rules.json` `generated`) | A generator rewrites it; a marker is erased on the next run. | Nothing. Take upstream's side and regenerate. |
| A file whose only diff is deletions | There is no added line to put a marker above. | The `patchGroups` entry. |

For a bilingual pair, marking both sides and re-recording is the correct move — a marker
on one side alone is a gate failure, and no marker at all is a missing exit plan.

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

One more gate guards the boundary itself rather than the patches:

| Script | What it does |
| --- | --- |
| `node local-overlay/verify-seam-frozen.mjs` | Fails when the tree modifies an upstream file that is not in `SEAM.json`. Reports retired paths so the list can shrink. `--record` rewrites it. |

The whole sequence is wired as one script, which is what CI and a push hook should call:

```sh
pnpm run verify-fork-overlay          # rebuild --check, verify, apply --check, seam-frozen
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

## Recipes: the same change, without touching upstream

Four patterns cover nearly everything this fork has needed. Each names a worked
example in the tree, so the next one is a copy rather than a design.

**Mount something, or change what a row does.** Add or patch a row in
`packages/bundle/efai-base/cordis.patch.yml` (`efai-web/` for browser-only rows).
A later bundle layer can insert rows, replace a row's whole `config`, and switch a
row off by id — that is how `efai-web` disables upstream's `agent-presets` row and
mounts the fork's roster in its place. Declare the package in that bundle's
`dependencies`, or the Loader cannot resolve it at boot.

**Change text the harness puts in the prompt.** Register a listener on
`system-prompt/assemble` and rewrite the assembled sections; the return value is
authoritative. `packages/core/efai-identity` replaces the identity opener this way
and holds whether upstream's opener is present, absent, or replaced by a third
party. Editing the string in `packages/core/system-prompt` instead would break
upstream's own tests, which byte-compare it.

**Give every agent a tool.** Mount it as a host row in `efai-base`. The tools
registry is layered, so a host registration reaches every preset agent's catalog;
resolve the calling agent per call (`exec.agent`) if the tool keeps per-agent state,
as `tool-kernel` does. Never replace an upstream preset row to add one: preset rows
are not groups, so a patch can only restate the whole preset, which is a fork that
drifts.

**Add a switch.** Declare it as a `.volatile()` field on the row that enforces it,
read it with `.get()`, and re-read it on `loader/volatile-update`: `tool-roster`
for tool visibility, `agent-memory-mode` for a subsystem that has to actually stop
running. Settings edits it by row id, and a custom page reaches it with
`ctx.configForms.get('<row id>')`. Never gate the row in YAML, and never add a
separate settings namespace.

## Recording a seam edit

Only after all of the above have been ruled out. Besides the marker and the register
row, a new Tier-2 path needs a `patchGroups` entry whose `paths` prefix covers it,
placed before any broader group that would otherwise claim it, and a re-record of
the frozen seam (`node local-overlay/verify-seam-frozen.mjs --record`) in the same
commit.

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

## Wiring a new package

A new Tier-1 package has no patch and no marker, which makes it feel finished the
moment the directory exists. It is not: a package the Loader cannot resolve, or a
client plugin the composition never mounts, is inert code that builds cleanly and
does nothing. The overlay scripts cannot see this — they classify paths, not
wiring — so it is the one class of fork bug no gate catches.

Adding a package means answering every question below. Each is a different layer
of the boot, so a miss at any layer surfaces only after the ones above it are
satisfied: you fix the missing mount, rebuild, and the *next* layer fails.

**Which bundle mounts it, and does that bundle depend on it?** These are two
edits, and the second is the one that gets forgotten. A row in a bundle's
`cordis.patch.yml` names a package, but the profile's module fallback is built by
walking the install anchor's `dependencies` + `peerDependencies`
(`packages/boot/app-boot/src/profile.ts` — `resolveModuleFallbackEntries`). A
package nothing declares is never linked into `$DSH_HOME/profiles/node_modules`,
so Node cannot resolve it from the profile directory and the boot dies with
`Cannot find package`. Add the `workspace:^` entry to the **same bundle's**
`package.json`, then `pnpm install` to create the link. Mounting the row without
the dependency, or declaring the dependency in a different bundle's manifest,
both fail.

**Is it registered in the aggregate tsconfig?** A package absent from
`tsconfig.host.json` / `tsconfig.client.json` is not in the build graph. See
[Registration lists](#registration-lists).

**For a client plugin: does the host half export `apply`?** The browser half owns
the behaviour, which makes `src/index.ts` look like it can be empty. It cannot:
`export {}` hands Cordis a module namespace with no `apply`, and the Loader
rejects it with *"invalid plugin, expect function or object with an 'apply'
method, received object"*. Every sibling client plugin ships an empty
`export function apply(): void {}` — the host entry must exist as a real plugin so
the row appears in the Loader at all. Copy a sibling's shape rather than
reasoning about it.

**Does `inject` name every service the plugin reads, including parents?** Cordis
resolves a dotted service through its parent, so reading `ctx.remote.settings`
requires BOTH `'remote.settings'` and `'remote'` in `inject`; naming only the leaf
throws *"cannot get property 'remote' without inject"*. The rule generalises: for
any `ctx.a.b` you read, list `'a'` and `'a.b'`. Check the sibling client plugins
before inventing a list — they all follow the
`['slots', 'locale', 'remote', 'remote.x']` shape.

**Does it need a `Config` default rather than a hardcoded value?** Anything that
varies per deployment belongs in `Config`, not a literal; `AGENTS.md` forbids
hardcoded tunables in plugins.

**Then boot it.** A clean `tsdown` build proves nothing about wiring — every
failure above compiles fine. The boot is the only check: restart the host and
confirm the row is actually live (a mounted plugin appears in the Loader; a client
plugin appears in the UI). A host that has not been restarted since the
composition edit still runs the old tree, and a bundle-layer row never
hot-reloads — only the profile and home patch layers are watched
(`patchReload === 'live'`). Rebuild, then restart.

**Then check what it actually registered.** A plugin can mount, apply, and still
register nothing useful because it read the world too early. `apply` runs in
loader order, which is not activation order: a plugin that snapshots a registry
inside its `ctx.inject` callback fires before its siblings have registered and
silently sees a partial world. If the plugin enumerates other packages' tools,
sections, or rows, verify the list is complete and not merely non-empty — and
have it re-read on the event that changes it rather than capturing once.

This is a Tier-1 checklist, not a Tier-2 one: none of it needs a marker, an
`EXIT:` clause, or a register row. It needs to actually run.

## Before committing

- Run the narrowest owning test for the changed behavior, then `pnpm run verify-fork-overlay`.
- For a new package, walk the wiring checklist above and boot it — a green build is not evidence the row is live.
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
