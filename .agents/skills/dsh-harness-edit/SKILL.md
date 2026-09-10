---
name: dsh-harness-edit
description: Use before editing any file in the deepseek-harness fork, and after a change before committing, to place the edit in the correct ownership tier, mark it per HARNESS-EDITS.md, and keep future upstream merges cheap. Required whenever a request changes harness source rather than merely reading it.
---

# Editing the deepseek-harness fork

This repository is a fork of `deepseek-ai/deepseek-harness`. Every change to a file upstream also owns is a recurring merge cost. `HARNESS-EDITS.md` at the repository root is the fork's own contract and the authoritative record of what is fork-owned versus upstream-owned. Read it before touching any file and follow its rules; this skill is the operating checklist, not a substitute.

## When to use this skill

Use for any change to harness source, configuration, composition, docs, tests, or scripts. Skip it only for pure read/inspect tasks. Re-check after the change but before commit.

## Non-negotiable steps

1. Read `HARNESS-EDITS.md` first — including the seam register and the "What to fix first" list. It is required context for a valid edit.
2. Classify every touched path into one of three tiers:

   - **Tier 1 — fork-owned:** upstream does not use the path (new packages, `python/kiln/`, fork docs, `.merge-port/`). No conflict possible. Prefer this.
   - **Tier 2 — seam:** an upstream file the fork must touch. It must be listed in the seam register with a reason and an exit plan.
   - **Tier 3 — upstream-owned:** everything else. Never edit. Move the change to Tier 1 or send it upstream.

3. Choose the mechanism in this order (HARNESS-EDITS.md Rule 3):
   1. a new fork-owned package on a documented extension point
   2. a fork-owned bundle (`packages/bundle/efai-<feature>/cordis.patch.yml`)
   3. a settings value (no hardcoded tunables)
   4. an upstream pull request
   5. a marked Tier-2 edit (last resort)

4. Mark every Tier-2 edit with a `DSH-FORK(<tag>)` comment immediately above the edit and an `EXIT:` clause naming the event that deletes it. Tags: `kernel`, `kiln`, `dock`, `browser`, `fix`, `brand`. An edit with no exit is a permanent tax.

```ts
// DSH-FORK(kernel): dshSettingFlag lets a Loader disabled expression read
// the settings document. EXIT: upstream ships a settings reader in the !!js scope.
```

5. Keep the seam register current. A new Tier-2 file or a removed one updates the table in `HARNESS-EDITS.md` in the same diff.

## Non-negotiable exclusions

- Never hand-merge a generated file (`docs/config-catalog.md`, `docs/tool-catalog.md`, `apps/cli/composition.md`, `THIRD_PARTY_NOTICES.md`, `tsconfig.base.json`, snapshots). Take upstream wholesale and regenerate.
- Never hand-merge `pnpm-lock.yaml`. Take one side, then `pnpm install --no-frozen-lockfile`.
- Never let credentials rest on `.gitignore` alone. Keep them out of the worktree; verify with `git ls-files | grep -iE 'ds_config|ds_sessions|subkernels\.json|\.env$|KILN\.md'` before push — output must be empty.
- Upstream bugs go upstream, not into the fork diff. Keep a local copy under `.merge-port/upstream-prs/<name>.patch` with a register row, and delete the delta when the upstream PR lands.
- Keep fork entries in `tsconfig.host.json` / `tsconfig.client.json` in one contiguous `DSH-FORK`-fenced block.
- A fork package is a real package: README, JSDoc on exports, tests, catalog entry.

## Before committing

- Run the narrowest owning test for the changed behavior.
- After the whole project's changes are finished, run `start.cmd --build-only` to rebuild the Web artifacts so the edited packages are reflected in the served app.
- Re-run `git diff` against `upstream/master` and confirm each modified file is either Tier 1 or a marked, registered Tier-2 edit.
- If a Tier-2 edit appeared that was not planned, stop: either move it to Tier 1 / upstream, or register it with a marker and exit plan.
- Follow `dsh-pre-push-checks` for the outgoing diff; follow `dsh-github` for the commit/push mechanics.

## Updating to a new upstream release

Full sequence lives in HARNESS-EDITS.md "Updating to a new upstream release": fetch upstream, merge, take generated files wholesale, regenerate the lockfile, resolve real conflicts from the register, regenerate everything, build before testing, verify fork features, record in `.merge-port/MERGE-STATUS.md`, then update this file's register.
