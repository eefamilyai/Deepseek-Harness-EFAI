# Local Overlay — the fork's mod layer

Every fork edit to a file upstream also owns lives here as a patch. The
working tree still contains those edits — that is how the fork builds and
runs — but this directory is the authoritative, machine-checkable record of
them, and `verify.mjs` proves the record matches the tree.

The point is an upstream update. Today a version bump means merging ~115
upstream-owned files by hand. With this layer it means: take upstream,
re-apply the patches, regenerate the generated files. A conflict lands in a
patch file that names its own subsystem instead of in a 900-line diff.

## Layout

| Path | Role |
| --- | --- |
| `BASE` | The pinned upstream commit the patches apply onto. Line 1 is the only line any script reads. |
| `rules.json` | The single source of truth: which path belongs to which patch, which files are generated, which paths are fork-owned. |
| `patches/*.patch` | The mod. One `git apply`-able unified diff per subsystem, generated. |
| `INVENTORY.md` | The manifest, generated: every patched path, every generated file and its command, every fork-owned path. |
| `lib.mjs` | Logic the scripts share: repository discovery, base lookup, rule loading, path classification, diff generation, pristine-base checkout. |
| `rebuild.mjs` | Regenerates `patches/` and `INVENTORY.md` from the working tree. |
| `apply.mjs` | Applies the patches, or checks that they still apply to a pristine base. |
| `verify.mjs` | Proves that base + patches reproduces the fork's tree exactly. |

`patches/` and `INVENTORY.md` are generated. Edit `rules.json`, then run the
rebuild; never hand-edit a patch.

## The three tiers

`rules.json` and `HARNESS-EDITS.md` describe the same split from two
directions. `HARNESS-EDITS.md` is the contract a maintainer reads; `rules.json`
is the machine-readable form the scripts enforce.

| Tier | What it is | How the layer treats it |
| --- | --- | --- |
| 1 — fork-owned | A path upstream does not have: a new package, `python/kiln/`, a root fork document. | Listed in `tier1Prefixes`. Not patched, because a file that does not exist upstream cannot conflict. |
| 2 — seam | An upstream file the fork modifies. | The entire merge cost. One patch group covers it; every path must match a group. |
| 3 — upstream-owned | Everything else. | Never edited. A change here belongs in Tier 1, or upstream as a PR. |
| generated | A file a generator owns. | Excluded from patches. On an update, take upstream's side and re-run the generator. |

`rules.json` decides the tier from the path. A path that is neither added,
nor generated, nor claimed by a patch group fails the rebuild and prints
itself — that is how an unregistered seam edit is caught rather than silently
merged forever.

## Commands

```sh
# Regenerate patches/ and INVENTORY.md from the working tree.
node local-overlay/rebuild.mjs

# Report drift without writing: exit 1 when a patch, or the manifest, is stale.
node local-overlay/rebuild.mjs --check

# Confirm every patch still applies to a pristine checkout of BASE.
node local-overlay/apply.mjs --check

# Prove BASE + every patch reproduces the working tree exactly.
node local-overlay/verify.mjs

# Apply the patches to this checkout (already-applied patches are reported as failures).
node local-overlay/apply.mjs
```

All four run from the repository root and need no arguments. `--check` modes
write nothing and are safe in CI.

### After changing an upstream-owned file

1. `node local-overlay/rebuild.mjs` — fold the edit into its patch.
2. `node local-overlay/verify.mjs` — prove the patch set still reproduces the tree.
3. `node local-overlay/apply.mjs --check` — prove each patch applies to a clean base.

Step 3 is not redundant with step 2. Verification re-derives the diffs from the
same working tree, so it stays green even if a patch file on disk has gone
stale; `apply --check` reads the files that are actually committed.

If the rebuild reports a path no rule claims, add a `patchGroups` entry in
`rules.json` for it, or move the edit into a fork-owned file.

### Checking a working tree against its patches

```sh
node local-overlay/rebuild.mjs --check
```

Exit 0 means the committed patches and manifest are exactly what the working
tree produces. Use it in a pre-push hook or a CI gate.

## How verification works

`verify.mjs` and `apply.mjs --check` both build a throwaway checkout of `BASE`:

1. `git init` a temporary directory.
2. Point its `.git/objects/info/alternates` at this repository, so base blobs
   resolve by hash without copying an object database and without writing to
   the real repository.
3. Stage every patched path at its base blob and mode through
   `git update-index --index-info`, then `git checkout-index` it into the tree.

Going through the index rather than writing files directly is what makes the
comparison exact: a deleted symlink, an executable bit, and an ordinary edit
all reproduce faithfully, and `git apply` sees the index it expects.

Content is compared with CRLF collapsed to LF. `.gitattributes` sets
`* text=auto eol=lf`, so a Windows checkout presents CRLF while the patch is
always LF; the two forms are the same file.

## Updating upstream

```sh
git fetch upstream
git merge upstream/master

# Generated files: take upstream's side wholesale. Never resolve these by hand.
git checkout --theirs pnpm-lock.yaml tsconfig.base.json \
  docs/config-catalog.md docs/tool-catalog.md apps/cli/composition.md \
  docs/capability-seams.md THIRD_PARTY_NOTICES.md
git checkout --theirs snapshots/web/lifecycle-chrome/hero.expected.md \
  snapshots/web/lifecycle-chrome/plan-active.expected.md

# Re-apply the fork's side of the seam.
node local-overlay/apply.mjs

# Regenerate everything a generator owns.
pnpm install --no-frozen-lockfile
pnpm run gen-tsconfig-paths
pnpm run gen-config-catalog && pnpm run gen-tool-catalog
pnpm run gen-doc-graphs && pnpm run gen-third-party-notices

# Prove the result.
node local-overlay/verify.mjs
pnpm run typecheck
```

A patch that no longer applies is the signal to look at, not a failure to work
around: upstream changed the code around the fork's edit. Resolve it inside the
patch's subsystem, then re-run the sequence. When the fork's version of a file
becomes upstream's version — because the change landed upstream — delete the
edit from the tree and let the rebuild drop its hunk.

When the base moves, update `BASE` to the new upstream commit and re-run
`rebuild.mjs`. Record which upstream commit the patches were regenerated
against; that is what makes the next update reproducible.

## Regenerated, never patched

| File | Command |
| --- | --- |
| `pnpm-lock.yaml` | `pnpm install --no-frozen-lockfile` |
| `tsconfig.base.json` | `pnpm run gen-tsconfig-paths` |
| `docs/config-catalog.md` | `pnpm run gen-config-catalog` |
| `docs/tool-catalog.md` | `pnpm run gen-tool-catalog` |
| `apps/cli/composition.md` | `pnpm run gen-doc-graphs` |
| `docs/capability-seams.md` | `pnpm run gen-doc-graphs` |
| `THIRD_PARTY_NOTICES.md` | `pnpm run gen-third-party-notices` |
| `snapshots/web/lifecycle-chrome/{hero,plan-active}.expected.md` | `pnpm run test:snapshot:record` |

`rules.json` is the authority for this list; the table mirrors it for readers.

## Extending the layer

Adding a fork-owned package needs no change here: it is an added path, so it
appears under Tier 1 in the regenerated `INVENTORY.md`.

Adding an edit to an upstream file needs one thing — a `patchGroups` entry in
`rules.json` whose `paths` prefix covers it, placed before any broader group
that would otherwise claim it, because the first match wins. Then run the
rebuild and the verify. See `.agents/skills/dsh-harness-edit` for the full
procedure.
