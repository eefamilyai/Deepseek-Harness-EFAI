# Agent Note: A tsdown workspace member is a directory with a package manifest

Status: implemented

English | [中文](2026-09-03-tsdown-workspace-manifest-membership.zh.md)

## Problem

`tsdown.config.ts` handed `vendor/*`, `packages/*/*`, and `apps/cli` to tsdown as workspace patterns. tsdown globs those with `onlyDirectories` and no manifest check, so every directory two levels under `packages/` becomes a build target, and it names each target after the nearest enclosing package.json — for a directory without one, the repository root.

Deleting a package leaves its `lib/` and `node_modules/` behind in every existing checkout, because git removes tracked files and leaves generated ones. Switching between a branch that has the package and one that does not therefore strands directories that are no longer packages; one branch pair in this repository strands forty of them. Once such a directory holds no `lib/types/{index,invariant,startup}.js`, the entire build fails with `[@deepseek-ai/dsh-root] Cannot find entry`, which names the repository root instead of the offending directory and reports no path at all.

## Decision

`tsdown.config.ts` expands `WORKSPACE_PATTERNS` against the filesystem and keeps only directories holding a package.json. A `*` segment matches child directories and every other segment is literal, which covers the three patterns the build declares; tsdown receives the resolved repository-relative paths rather than the patterns.

Stranded build output is therefore not a build target, and a real missing entry now names the package that owns it.

## Alternatives considered

**Rely on `pnpm run clean`.** Rejected as the fix: it repairs one checkout after the failure, and the next branch switch across a package deletion recreates the condition. It remains the way to reclaim the stranded directories themselves.

**Exclude the stale directories by name.** Rejected because the set changes with every package deletion, and a name list would rot into a second source of truth about which directories are packages.

**Wait for tsdown to require a manifest.** Rejected because the build must work on every existing checkout now, and the config already owns the pattern list, so the filter belongs there.

## Consequences

- A directory under `packages/` without a package.json takes no part in the build, whatever it contains.
- Adding a package still requires only its package.json; membership is discovered from the filesystem, never listed.
- The config reads the filesystem at load, resolving from `import.meta.dirname` rather than the process working directory.
- A missing `lib/types` entry for a real package still fails the build, now reported under that package's name.

## Testing

`tsdown.config.ts` sits outside the repository's TypeScript programs and oxlint paths, so this change carries no automated gate; it was verified by hand on a tree whose build output matches its sources. Removing `lib/` from one stranded directory reproduced `[@deepseek-ai/dsh-root] Cannot find entry` exactly; the manifest filter then carried the same tree through config resolution to `Build start`, resolving 244 packages without naming the stranded directory. Standalone `tsc --strict` accepts the file.
