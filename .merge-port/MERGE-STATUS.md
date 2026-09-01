# Upstream sync: what is done and what is left

This branch merges `deepseek-ai/deepseek-harness` (`upstream/master`) into this
repository's `master`. **All 14 conflicts are resolved, the workspace builds, and
the built CLI runs.** What remains is one deferred feature, recorded below.

## The shape of the merge

| | count | note |
|---|---|---|
| Upstream commits merged | 11,947 | base was `47f94385`, 2026-08-13 |
| Our new packages | 146 files, ~50k lines | no upstream path collision; merged untouched |
| Files upstream deleted under us | 12 | resolved as deletions; work preserved as a patch |
| Conflicts resolved | 26 | 12 during the merge, 14 afterwards |

Verified after the merge: `pnpm run build` completes, `node apps/cli/lib/bin.js
--version` answers `0.1.2-alpha.3` (upstream's line), and every generator —
`gen-tsconfig-paths`, `gen-tool-catalog`, `gen-config-catalog`,
`gen-client-catalog`, `gen-doc-graphs`, `gen-cordis-catalog` — regenerates clean.

## What the merge required beyond conflict markers

Upstream moved several things our packages depended on. Each was ported:

- **`packages/client/runtime` was deleted.** `ClientContext` is now `Context`
  from `@deepseek-ai/cordis`; `SnapshotStore`/`createSnapshotStore` come from
  `@deepseek-ai/dsh-client-store`; `SettingsScope` from
  `@deepseek-ai/dsh-client-ui-settings/client`. `ui-dock` and `ui-effects` were
  repointed, with their manifests and project references.
- **`settingsNamespace()` is gone.** Namespaces are plain string constants now
  (`kernel-mode`, `llm-kiln`, `ui-effects`).
- **`installSettingsSection()` became `SettingsService.installSection`**, so
  `llm-kiln` now owns the `ctx.inject(['settings'])` the helper used to do.
- **`CallId` folded into `ToolCallId`** (`llm-kiln`'s adapter).
- **`JsonValue` moved** to `@deepseek-ai/dsh-util-values`.
- **The `@deepseek-ai/dsh-*` path wildcard was replaced** by generated explicit
  aliases; `ui-dock`, `ui-effects` and `sidebar-bridge` carry hand-written
  entries because their package names do not match their directories.
- **The client transport moved** from `connection.api.*` to `ctx.remote.*`, and
  results now arrive as `RemoteResult<T>` (`{ok, value} | {ok, error}`). The
  Advanced settings section was ported onto it.

## Decisions made during resolution

Three were product calls rather than mechanics. Each is a one-line revert:

- **The system-prompt identity keeps this fork's text** — "You are an AI agent in
  a fully enclosed sandbox for windows related testing and software
  development." — on upstream's `getSectionOrder('HARNESS_IDENTITY')` rather than
  the hardcoded `order: -100`. `packages/core/system-prompt/tests/system-prompt.spec.ts`
  asserts it. **If that text was a local experiment rather than a deliberate
  identity, revert both to upstream's "You are an AI agent powered by DeepSeek
  Harness."**
- **`EmptyHero` takes upstream's preview badge**; both `hero.headline` and
  `hero.preview` locale keys exist, so switching back is a one-line change.
- **The minimal preset gates bash on both conditions** — `process.platform ===
  'win32' || dshSettingFlag('kernel.enabled', true)` — matching how
  `packages/bundle/base/cordis.patch.yml` writes the same pair.

## The one deferred feature: account-pooled logins

Upstream removed `packages/host/apiproxy` in `4f00a8b8`, splitting it into
`packages/api/{gateway,remotes,session-controller,settings-controller,workspace-controller}`.
The `llm.addAccount` RPC our fork added lived in that package, so the browser
half of the multi-account DeepSeek login is not wired on this branch:

- **Kept:** `LlmRuntime.registerAccountProvider`, `listAccountProviders` and
  `addAccount` on the service, and the whole `llm-kiln` account implementation.
- **Dropped:** `ModelDirectory.addAccount`, its `ModelSelectInjected` slot
  contract entry, and the ModelSelect UI that called it.
- **To restore it:** add a `@Remote('addAccount')` wrapper on `LlmRuntime`
  beside the existing `remoteDiscoverModels`, then re-add the client directory
  method and the picker affordance on top of `ctx.remote`.
  [`apiproxy-and-fixtures.patch`](apiproxy-and-fixtures.patch) holds the
  original implementation of all of it.

One upstream convergence worth noting: our widening of `exposedNamespaces()`
matches upstream, whose settings controller already serves
`settings.describe({ redactSecrets: true })` for every registered namespace.

## Still outstanding, not caused by the merge

- `kernel.enabled` defaults to `true`, which switches off `tool-bash`,
  `tool-pwsh`, `tool-jobs`, `tool-fs` and `tool-fs-search`. The headless example
  still expects a bash round trip, so its snapshot records
  `Error: unknown tool "bash"`. Either pin `kernel.enabled: false` for that
  example or rewrite it around the kernel tool, then re-record.
- The new packages still owe documentation: several have no README, and
  `verify-export-jsdoc` reports missing contracts. `pnpm run doc-sync` names them.
