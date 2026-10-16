# Register the fork's plugins as external plugins in the Plugins tab

## Operator request (verbatim)

> All my added externel plugins are not refistered in the plugins tab. Please register these plugins as external plugins

Session `session-74ece1e9-c91c-46b3-8dbb-f78dc2b1d038`, 2026-10-07 01:25.

## What "the plugins tab" is

The sidebar **Plugins** page = `packages/client/ui-plugin-manager` (browser half) over the
`pluginManager` Host service (`packages/boot/plugin-manager`). It renders two groups:

- **Official** — bundles the installation ships switched off (`OPTIONAL_BUNDLES`) plus the
  official plugins that registered a configuration page (`plugins.item` contributions).
- **Installed** — the bundles the profile holds.

Client filter, `PluginManagerPage.tsx:1280`:

```ts
const listed = state.packages.filter(pkg => !BUILTIN_PROFILE_BUNDLES.has(pkg.name)
  && (pkg.installed || pkg.optional || pkg.error !== undefined))
const mine = listed.filter(pkg => pkg.installed || !pkg.optional)
```

Host flag, `packages/boot/plugin-manager/src/index.ts:289`:

```ts
const installed = dependencies.includes(name)   // profile package.json "dependencies"
```

So a bundle that is **selected** on the profile's `dsh.profile.bundles` list but **not declared
in its `dependencies`** gets `installed === false`, `optional === false`, `error === undefined`,
and is dropped from the page entirely. That is the whole defect: the fork's plugins composed and
ran, and the page showed nothing of them.

## Measured state before the fix (running Desktop app, profile `desktop`)

Plugins page: **Official 8**, no `Installed` group at all.

    4 optional bundles  Agent Teams / Auto Review / Automation tasks / Voice input
    4 config pages      Shell / Agent loop / Subagent / Web search

`C:\Users\eejar\.dsh\profiles\desktop\package.json`:

    dependencies: {}                                     <- nothing counts as installed
    dsh.profile.bundles: [dsh-base, dsh-efai-base, dsh-web-app, dsh-efai-web]

Cross-check on a spare host running the `web` profile (which does declare three community
plugins): its Plugins page showed `Installed 3` — `dshmarket` (Problem),
`@goodandready/dsh-dsml-artifact-guard`, `@linxin666/dsh-remote-web-ui` — and **neither**
`dsh-efai-base` nor `dsh-efai-web`, although both are on that profile's layer list. The rule
above is the only reading consistent with both observations.

## Fix

Register the fork's bundles as **external plugins**: name each selected fork bundle in the
profile's `dependencies` — the entry `dsh plugin add` writes and the Plugins page reads as
installed — while leaving `dsh.profile.bundles` untouched. The layer list keeps deciding whether
a bundle composes; the dependency decides whether it is listed and whether its rows are
individually switchable.

Durable path is the fork's own registration script, `efai/ensure-profile-bundles.mjs`, run by
`install.ps1`, `install.sh`, `start.cmd`, `start.sh`. It gained:

- `FORK_BUNDLES` (bundle → the checkout directory that produces it).
- `forkBundleVersion()` — the shared profile `node_modules` copy first (what a profile really
  resolves), the checkout second (the state an installer runs in).
- `forkPluginsToRegister(manifest, bundles)` — the composed fork bundles the manifest has not
  installed; exported, and spec'd.
- `ensureProfile()` now writes both the layer list and the dependencies, reports each change,
  and `--check` reports both kinds of drift without writing.
- `defaultTargets()` — the shipped templates **plus every profile directory that already
  exists**. The Desktop app owns the reserved `desktop` profile and the operator's custom
  profiles (`general`, `harness`, `school`) sit beside it; no launcher of theirs runs this
  script, so scanning the directory is what keeps them current. An existing profile outside the
  templates is repaired, not extended: only a bundle it already names is registered.
- The top-level run is now guarded by `import.meta.url === pathToFileURL(process.argv[1]).href`,
  so the module can be imported by its spec (it used to run and `process.exit` on import).

Profiles updated on this machine:

    desktop, general, harness, school, web   -> dependencies += the two fork bundles
    headless                                 -> left alone (see below)

`headless` still composes `[dsh-base, dsh-headless]` with no fork bundle. The script reports it
as drift under `--check` and a bare installer run would repair it (that is pre-existing behavior
for the shipped templates); it was left alone here because changing a profile's composition is
not what this request asked for and the operator does not boot it.

## Verified

- `node --test efai/ensure-profile-bundles.test.mjs` — 11 specs, all pass (placement,
  idempotence, the upstream-only list, registration selection, manifest repair, the no-op
  second run, `--check` drift without a write, template initialization, unknown profile).
- Scratch profile `extcheck` (temporarily created, then removed) booted on port 50151 with the
  fork bundles in `dependencies`: the Plugins page listed `Installed 2` and the
  `dsh-efai-base` card listed **19 components** — efai-identity, llm-text-toolcalls,
  llm-markdown-fidelity, ai-accounts, llm-kiln, web-access, profile-hub,
  session-recovery-context, output-masking, kernel, kernel-python, tool-kernel, agent-memory,
  token-usage-lifetime, skill-injection, command-session-info, tool-str-replace-editor,
  web-browser, tool-roster — each with its own switch.
- **Live in the running Desktop app** (pid 5676, port 19387, profile `desktop`), no restart:
  the Plugins page now shows `Installed 2` with `@deepseek-ai/dsh-efai-base` and
  `@deepseek-ai/dsh-efai-web`. Evidence: `plugins-tab-installed.png`.
- `node local-overlay/rebuild.mjs --check` — `local-overlay is current: 13 patch(es), 49
  Tier-2 file(s)`. `node local-overlay/verify-seam-frozen.mjs` — `seam is frozen at 49 upstream
  file(s)`. Both edit sites are fork-owned (Tier 1), so no patch, marker, or register row.

## Why the registration is inert at boot

`installedProfilePackageNames()` (`packages/boot/app-boot/src/profile.ts:477`) only counts a
dependency that exists at `<profileDir>/node_modules/<name>/package.json`. This fork installs
its packages into the **shared** `$DSH_HOME/profiles/node_modules`, which Node reaches by walking
up a directory, so the new dependency entries add nothing to the runtime resolution. The profile
directory keeps `patchReload: live` working against an unchanged bundle selection.

## Files

    efai/ensure-profile-bundles.mjs                    registration (fork-owned)
    efai/ensure-profile-bundles.test.mjs               new node:test specs (fork-owned)
    HARNESS.md                                         § The four layers
    packages/bundle/efai-base/README.md                Use this package
    packages/bundle/efai-web/README.md                 Use this package + the one-row-id Dev Note
    packages/bundle/efai-web/cordis.patch.yml          the two duplicate rows removed
    packages/boot/profile-hub/src/profiles.ts          readProfileDependencies + the copied install entries
    packages/boot/profile-hub/src/index.ts             createProfile passes the running entries
    packages/boot/profile-hub/tests/profile-hub.spec.ts  two new cases
    packages/boot/profile-hub/README.md                createProfile contract + the package-set limitation

Gates: `node local-overlay/rebuild.mjs --check` and `verify-seam-frozen.mjs` are green (all edit
sites are Tier 1). `pnpm run test:docs` is red on five pre-existing failures from other
in-flight work (`packages/agent-memory/agent-memory/README.md` skeleton,
`packages/boot/profile-hub/README.md`'s CRLF heading, bilingual pairs the fork packages never
had, concrete-term hits in `.agents`/`apps/web`/`local-overlay` patches) — none in a file this
job touched. `verify-package-dependencies` reports three pre-existing
`@deepseek-ai/dsh-app-boot` export classifications for `profile-hub`, also not from this job.

Uncommitted: the working tree also carries another session's in-flight desktop work
(`apps/desktop-host`, `apps/desktop`, `packages/boot/profile-hub/`, generated catalogs), so this
change was left in the tree rather than committed into it.

## Traps found on the way

- `browser`-driven spare hosts: `node apps/cli/lib/bin.js web --no-open --port N` boots the
  **web** profile (the positional is the profile), so `DSH_PROFILE` is not what selects it —
  use `--profile <name>`. The accidental web-profile boot is what produced the cross-check above.
- The `show()` kernel helper raises on a Windows path (it compiles the path as a regex
  containing `\U`); `read_image` works.
- The app's Plugins page re-reads `listBundles` on mount and on **Refresh**, so a profile
  manifest edit is visible without restarting the app.

## Second defect the fix exposed: two rows declared by both bundles

Making the fork bundle appear on the Plugins page also exposed why two of its 19 component
switches would not move. `ai-accounts` and `profile-hub` are declared by **both** `efai-base`
and `efai-web`; `applyEntryPatches` appends each layer's `insert` list without deduplicating
ids (`vendor/include/src/index.ts:93`), so the composed list carries each id twice.
`plugin-manager.listPlugins` marks a row whose composed candidates are not exactly one as
`readOnlyReason: 'unaddressable'` (`packages/boot/plugin-manager/src/index.ts:266`), and
`setPluginEnabled` refuses it (`:429`) — the row runs while its switch is locked.

Measured with `.recon/_bundle-row-probe.mjs` (composes both bundle patch files through the
repo's own `applyEntryPatches`):

    before: composed rows: 30; distinct ids: 28   DUPLICATE ai-accounts x2, profile-hub x2
    after:  composed rows: 28; distinct ids: 28   every row id is declared once

Fix: the two rows stay with `dsh-efai-base` (which mounts `ai-accounts` ahead of the providers
that register into it, and `profile-hub` on the host plane), and `efai-web` keeps a comment
where each was. Recorded as a bundle rule in `packages/bundle/efai-web/README.md`'s Dev Note.
No profile layer addressed either row, so nothing else moved. Bundle-layer rows do not
hot-reload: this takes effect at the next host boot.

## Desktop-side durability: a new profile created in the app

`packages/boot/profile-hub` is the Desktop app's own profile creator (the Profiles page). Its
`createProfileDirectory` called `initProfile`, which writes `dependencies: {}`, so a profile
created from the running one copied its bundle layers but none of their install entries —
every new profile reproduced the operator's complaint. It now carries the running manifest's
entries for the layers it copies (`readProfileDependencies`, filtered to those layers), and
`createProfile` passes them. Specs: 56 in `packages/boot/profile-hub`, including the new
carry-over case.

Build note that cost a round: a package whose `tsdown.config.ts` calls `clientBundle(...)`
without `hostPhase: true` is **skipped during the host pass** (`SKIP_WORKSPACE_BUILD`,
`packages/client/tsdown.client.ts:121`); its `lib/index.js` is emitted by the **client** pass.
`pnpm run build:lib:host` therefore left `dsh-profile-hub/lib/index.js` stale, and the app
would have kept the old node half. Both faces were built.

## Traps found on the way

- `browser`-driven spare hosts: `node apps/cli/lib/bin.js web --no-open --port N` boots the
  **web** profile (the positional is the profile), so `DSH_PROFILE` is not what selects it —
  use `--profile <name>`. The accidental web-profile boot is what produced the cross-check above.
- The `show()` kernel helper raises on a Windows path (it compiles the path as a regex
  containing `\U`); `read_image` works.
- The app's Plugins page re-reads `listBundles` on mount and on **Refresh**, so a profile
  manifest edit is visible without restarting the app.
