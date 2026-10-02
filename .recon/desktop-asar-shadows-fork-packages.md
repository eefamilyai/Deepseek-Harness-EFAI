# Desktop app.asar shadows the fork's core packages

## Symptom
In the official Desktop app, Settings -> Accounts renders the fork's section copy
("Add a DeepSeek web login here instead of editing ds_config.json by hand") but the
body reports:

    Could not read the provider list.
    ctx.remote.llm.listAccountProviders is not a function

No kiln route appears in Accounts. The kiln sidecar IS running as a child of the
Desktop Host (PID 18740 -> 6448, `python/kiln/provider_bridge.py`), so `llm-kiln`
loaded far enough to spawn its bridge.

## Cause
The Desktop ships its own copy of the harness inside `resources/app.asar`:

    app.asar/dsh/node_modules/@deepseek-ai/<pkg>    289 packages

That set includes `dsh-llm`. The fork's `dsh-llm` carries the account seam
(`registerAccountProvider`, `registerAccountAdmin`, `listAccountProviders`,
`addAccount`, `listAccounts`, `reloginAccount`, `reprofileAccount`,
`removeAccount`, `accountLog`). The asar's copy carries **none** of them:

    registerAccountProvider   asar 0   fork 3
    listAccountProviders      asar 0   fork 3
    accountAdders             asar 0   fork 6
    registerAdapter           asar 6   fork 6

So the mounted `llm` service is upstream 0.2.0-rc.2, the fork's client-side Remote
vocabulary is never published, and `ctx.remote.llm.listAccountProviders` does not
exist.

## Why the profile cannot win
`dsh-app-boot` resolves each bundle layer with:

    function resolveBundleDir(binName, packageName, installAnchor, profileDir) {
      for (const anchor of [installAnchor, join(profileDir, "package.json")]) {
        const dir = packageDirFromAnchor(anchor, packageName);
        if (dir !== void 0) return dir;
      }

`installAnchor` is `app.asar/dsh`, and it is tried FIRST. Any package the asar
supplies therefore always resolves to the asar copy, never to the profile's.

The runtime router agrees: `findInterceptionLayer` returns `undefined` for a path
inside `installationPaths`, so a module imported *from the asar* resolves natively
to the asar copy. Only importers inside the profiles tree or a linked root are
routed through the profile's entries - and those entries still name the
installation-scope copy.

`collectProfileScopePackages` reinforces it: it walks the dependency closure of the
bundle layers the installation does NOT supply, **excluding every name the
installation already has**.

Result: `dsh-llm`, and 18 other Tier-2 packages, are permanently shadowed.

## Measured shadow set
Tier-2 packages whose names the asar also ships - these cannot take effect:

    @deepseek-ai/dsh-llm                          packages/llm/llm
    @deepseek-ai/dsh-agent                        packages/core/agent
    @deepseek-ai/dsh-tools                        packages/core/tools
    @deepseek-ai/dsh-compaction                   packages/compaction/compaction
    @deepseek-ai/dsh-compaction-basic             packages/compaction/compaction-basic
    @deepseek-ai/dsh-command-compact              packages/compaction/command-compact
    @deepseek-ai/dsh-tool-pwsh                    packages/shell/tool-pwsh
    @deepseek-ai/dsh-tool-workflow                packages/workflow/tool-workflow
    @deepseek-ai/dsh-session-format-v0-to-v1      packages/session/session-format-v0-to-v1
    @deepseek-ai/dsh-client-ui-brand-official     packages/client/ui-brand-official
    @deepseek-ai/dsh-client-ui-chat               packages/client/ui-chat
    @deepseek-ai/dsh-client-ui-conversation       packages/client/ui-conversation
    @deepseek-ai/dsh-client-ui-input-trigger      packages/client/ui-input-trigger
    @deepseek-ai/dsh-client-ui-model-selection    packages/client/ui-model-selection
    @deepseek-ai/dsh-client-ui-primitives         packages/client/ui-primitives
    @deepseek-ai/dsh-client-ui-settings           packages/client/ui-settings
    @deepseek-ai/dsh-client-ui-sidebar            packages/client/ui-sidebar
    @deepseek-ai/dsh-client-ui-skill              packages/client/ui-skill
    @deepseek-ai/dsh-client-ui-tool               packages/client/ui-tool

Tier-1 fork-only packages (489 paths, no asar counterpart) DO load: `llm-kiln`,
`kernel`, `tool-roster`, `client-ui-effects`, `client-ui-flow-accents`,
`client-ui-settings-accounts`, `client-ui-settings-tools`, `efai-base`, `efai-web`.

## Consequence for the port
A Tier-2 seam edit on a package the asar ships is invisible in the Desktop build.
That is a standing constraint, not a one-off: it is the same reason the 27
cosmetic UI conflicts were resolved to upstream during the merge.

## Fix direction
Re-express the account surface as fork-owned packages with their OWN Remote
namespace, instead of extending the upstream-owned `llm` namespace:

    packages/llm/ai-accounts              (new, FORK)  host service + @Remote methods
    packages/llm/llm-kiln                 (FORK)       registers account ops with it
    packages/client/ui-settings-accounts  (FORK)       talks to ctx.remote.aiAccounts

Then the asar's `dsh-llm` is irrelevant to the feature, and the seam edit on
`packages/llm/llm/src/index.ts` can be retired.

The operator named the package `ai-accounts` (not the `llm-accounts` /
`account-pool` / `accounts` labels that were offered), so the package is
`@deepseek-ai/dsh-ai-accounts` and its Remote namespace is `aiAccounts`.

## Evidence
    .merge-port/shadow-set.json     the shadowed vs loading Tier-2 package sets
    desk4-out.log                   the live Desktop app's own stdout

## Implementation notes (2026-10-02, second session)

### What the package is
`packages/llm/ai-accounts` is a dual-face package: `src/index.ts` is the Host
service (`AiAccounts extends TypertRemoteService`, namespace `aiAccounts`, seven
`@Remote` methods), `src/types.ts` carries the wire types plus the
`RemoteErrorDetailsMap` augmentation, and `src/client/index.ts` mounts the
namespace from the package's own generated descriptors:

    import contribution from '@deepseek-ai/dsh-ai-accounts/remote'
    export const inject = ['remote']
    export async function apply(ctx) { await ctx.remote.$mount(contribution) }

That self-mount is what makes the surface unshadowable: no shared assembly
(`dsh-api-remotes`) has to know the namespace exists.
`packages/llm/llm/src/index.ts` no longer carries any account API, so the Tier-2
seam on it is retired in the tree (`git diff <base> -- packages/llm/llm` is empty).

### Traps this class of package hits

1. **The host aggregate must reference the FACE, not the package root.**
   `packages/llm/ai-accounts/tsconfig.json` is a solution (`files: []`) that
   references both leaves, so `{ "path": "./packages/llm/ai-accounts" }` in
   `tsconfig.host.json` builds the Client program during the HOST pass. The host
   pass runs before the typert tsdown pass, so `lib/typert.remote-client.d.ts`
   does not exist yet and the Client half fails with
   `TS2307: Cannot find module '@deepseek-ai/dsh-ai-accounts/remote'`.
   Every one of the 24 dual-face packages in the tree is referenced as
   `./packages/<group>/<pkg>/tsconfig.host.json` in the host aggregate and
   `.../tsconfig.client.json` in the client aggregate. Any other package that
   references a dual-face sibling must do the same: `llm-kiln/tsconfig.json` and
   `ui-settings-accounts/tsconfig.json` both referenced `.../ai-accounts` and
   produced `TS6306: Referenced project ... must have setting "composite": true`.

2. **The order that makes `/remote` resolvable.** `build:lib:host` is
   `tsc -b tsconfig.host.json && tsdown --env.DSH_BUILD_FACE host`; the root
   tsdown config runs `typertPlugin({ mode: 'workspace', faces: ['host'] })`,
   which emits `typert.host.*` and `typert.remote-client.*` for every contributor
   workspace-wide. So the CLIENTS' typecheck (`tsc -b tsconfig.client.json`) only
   sees `/remote` because the host tsdown pass ran first. A client package that
   calls a Host Remote namespace needs a type-only import of that namespace's
   generated declaration — `import type {} from '@deepseek-ai/dsh-ai-accounts/remote'`
   in `ui-settings-accounts/src/client/index.ts` — or `ctx.remote.<ns>` is
   `TS2339: Property ... does not exist on type 'Context'`.

3. **A hand-written alias has no generator to restore it.** `tsconfig.base.json`
   is generated, but the generator only maps a package whose declared name is
   exactly `@deepseek-ai/dsh-<directory>`. The 0.2.0-rc.2 merge took upstream's
   side of the file and dropped six hand-written aliases, which made
   `pnpm run gen-tsconfig-paths` fail outright:
   `dsh-client-ui-effects`, `dsh-client-ui-flow-accents`,
   `dsh-client-ui-settings-accounts`, `dsh-client-ui-settings-tools`,
   `dsh-host-version-route`, `dsh-tool-roster` (+ `/invariant`). They are
   restored in the hand-written region, before the BEGIN marker. Re-check this
   file after every merge: the generator's `--check` fails loudly, which is the
   only signal.

4. **The profile row must not be duplicated.** `~/.dsh/profiles/desktop/cordis.patch.yml`
   carried two `- id: ui-settings-account` rows: the fork's
   `@deepseek-ai/dsh-client-ui-settings-accounts` and upstream's singular
   `@deepseek-ai/dsh-client-ui-settings-account`, whose only copy lives inside the
   asar. The singular row was removed. `- id: ui-settings / enabled: false` stays:
   that field is `Volatile<boolean>` = "developer tools enabled", not the Settings
   page.

### Verified end to end (2026-10-02, second session)

Committed as `2e3965b03f` (with `8beccb08d8` for the gate-driven manifest
normalization). Host and client faces both build clean; `verify-fork-overlay` is
green at 17 patches / 60 Tier-2 files; the 13 new package specs pass.

The proof that the shadowing is defeated is a **desktop-profile host booted in a
separate process**, so the running Desktop app was never disturbed:

    node apps/cli/lib/bin.js web --no-open --port 50124      # DSH_PROFILE=desktop is inherited

Settings → Accounts then lists the route and every pooled login
(`.recon/accounts-tab-verified.png`):

    Account pool:  kiln-deepseek        ("The provider route that accepts new logins.")
    Existing accounts: 11 accounts      (Configured rows, Relogin / Reprofile / Remove)
    Account debug log: (empty)

That exercises `listAccountProviders` and `listAccounts` over the `aiAccounts`
namespace, i.e. the exact calls that reported "Could not read the provider list."
against the asar's `dsh-llm`.

### OPERATOR ACTION: restart the Desktop app once

`ai-accounts` is mounted by rows in `packages/bundle/efai-base` and `efai-web`,
and **bundle-layer rows do not hot-reload** — only the profile and home patch
layers are watched (`patchReload: live`). The app that is running now booted
before those rows existed, so its composition has no `aiAccounts` service. Quit
and relaunch `DeepSeek Harness.exe` after this commit; no profile edit is needed
(the bundles already carry both rows).

An alternative that avoids the restart is to add both rows to
`~/.dsh/profiles/desktop/cordis.patch.yml` (the live layer), but the browser
still has to re-read the boot graph for the client half, so it is not obviously
cheaper than one restart.

### Next phase: the remaining Tier-2 UI edits

Measured with `git diff --numstat <base> -- packages/client/`: 68 paths, but
most are fork-owned *added* files (the accounts section, `ui-effects`,
`ui-flow-accents`, `ui-settings-tools`) which are Tier 1 and already load. The
upstream files the fork still modifies are the conversion target:

| Package | Upstream file | Δ | What it does |
|---|---|---|---|
| `ui-sidebar` | `src/client/SidebarRoot.module.css` | +28 −9 | sidebar row accents/geometry |
| `ui-chat` | `src/client/chat/ContextInjectionRow.module.css` | +18 −2 | row accent |
| `ui-chat` | `src/client/chat/AssistantMarkdown.module.css`, `AssistantMarkdown.tsx`, `SystemPromptRow.tsx` | +18 | markdown/row styling |
| `ui-brand-official` | `src/client/Brand.tsx`, `src/client/index.ts`, `Brand.module.css` (added) | +16 −4 | the fork's own brand mark, which upstream gates behind `DSH_CLIENT_BUILD_PROFILE=official` |
| `ui-conversation` | `src/client/skeleton/EmptyHero.tsx`, `src/client/locales.ts` | +5 −2 | empty-hero copy |
| `ui-settings` | `src/client/config-form.ts` | +36 −3 | config-form behaviour |
| `ui-tool` | `src/client/tool/models/tool-call-model.ts` | +3 | kernel tool-call model row |
| `ui-skill`, `ui-input-trigger`, `ui-primitives` | tests only | — | spec coverage, not product behaviour |

Each one goes through the mechanism ladder in `dsh-harness-edit`
(composition row → extension point in a fork package → Config field → upstream
PR → recorded seam). `ui-flow-accents` and `ui-effects` are the working
precedents: a theme override layer and a slot registration, both fork-owned. The
whale backdrop stays where it is — explicitly out of scope.

### Conversion round 1 (2026-10-02, third session)

The `pnpm run test:gui` baseline after the 0.2.0-rc.2 merge was 14 failing files
/ 20 tests, and **six of those failures were this fork's own Tier-2 UI edits** —
the merge had kept the fork's specs and dropped the rules they assert. What the
first conversion round changed:

**Retired as dead** (the merge moved on; nothing reads them):

| Edit | Why it could simply go |
|---|---|
| `ui-model-selection/src/client/locales.ts` (15 keys) | only the definitions remain — nothing in the tree reads `provider.accounts`, `account.testAdd`, or any sibling key |
| `ui-input-trigger/src/client/MenuView.module.css` + its spec | the CSS classes style `button[data-trigger-heading]` toggle markup that upstream's `MenuView.tsx` no longer renders; the spec asserted it and failed |

**Restored as merge fallout, in upstream's own shape.** The merge dropped the
flow-row accent rebinds from `ui-tool`'s `ToolRow.module.css` (12 lines),
`ui-primitives`' `DisclosureRow.module.css` (3), `ui-chat`'s
`ReasoningRow.module.css` (3), and `ui-tool`'s `bash-sample.module.css` (5). The
first restoration also brought back each row's *restated* text colours, and that
was wrong: upstream has since moved row text colour into the shared header
("leaves row text color to the shared disclosure header" in
`ui-tool/tests/tool-row-styles.client.spec.ts`, which the restoration made fail).
The shape that satisfies both is:

* `DisclosureRow` reads `var(--dsh-row-accent, <neutral label token>)` for
  `.leading` and `.title` — one file, and it is what makes the token mean
  anything;
* each row family rebinds `--dsh-row-accent` on its own `.row`
  (`[data-variant='read']`, `[data-variant='bash']`, cordis tools after the
  variant rules) and colours only its own separator dot;
* no row sheet restates a `.title`/`.leading` colour, so hover keeps following
  the shared process-row colours.

`ToolRow`'s `.chevron` rule stays out entirely: upstream stopped passing
`chevronClassName`, so the rule had no consumer. Sixteen accent assertions and
upstream's two row-style specs pass.

**Converted into a fork-owned package**: the sidebar brand.
`packages/client/ui-brand-efai` owns the whale mark and the live-text wordmark,
registers `sidebar.brand.mark`/`sidebar.brand.name` unconditionally, and
`efai-web` mounts it while switching upstream's `ui-brand-official` row off. The
five-file edit on upstream's brand package is retired, and its two
fork-added files (`Brand.module.css`, `css-modules.d.ts`) moved into the new
package. Verified live on a spare-port host: the plugin inventory reads
`ui-brand-official  Disabled` / `ui-brand-efai  Enabled`, and the sidebar renders
the fork's mark and wordmark.

**What a plugin cannot carry, and why** — the remaining 17 upstream client files
fall into two groups:

1. *Needs a DOM hook upstream does not emit.* The accent system has two halves:
   the header's read of `--dsh-row-accent`, and each family's rebind on `.row`.
   A fork-injected stylesheet can reach neither — `ui-tool` puts
   `data-variant`/`data-tool` on the row ROOT, so a global rule cannot address
   `.row` (whose class is hashed as `[hash]_[local]`), and matching on the
   local-name suffix would break the moment upstream renames a class. Two ways
   out, both real: upstream sets `data-row-family` on the row element (or reads
   `--dsh-row-accent` in `DisclosureRow`), or the fork owns the rows.
2. *Ownable as fork components.* `tool.call.toolview` is a **keyed slot whose
   registration replaces the view**: "Registering an occupied key replaces its
   view; unclaimed keys use the generic row." A fork package can therefore own
   `kernel`, `bash`, `think`, and each context row outright — its own component,
   its own stylesheet, its own accent — with no upstream edit at all. That is the
   next round's work, and it also covers the `EmptyHero` badge, the
   `AssistantMarkdown` empty-block rule, and the `ui-conversation` copy, because
   those are the same rows' chrome.

`ui-settings/src/client/config-form.ts` stays a seam: it is a memoization fix
inside an upstream class, with no extension point between construction and use,
and its EXIT is an upstream PR. `ui-tool`'s `kernel` variant/title map is the
same kind of three-line internal constant.

**Evidence for the round** (committed as `ffcd461cbe`): the client tree's failing
files went from 14/20 to 6/8, and all six files that were this fork's own edits
are green — `menu-view`, `disclosure-row-styles`, `tool-row-accent-styles`,
`flow-row-accent-styles`, `skill-row-styles`, and `ui-brand-official`'s
browser-plugin spec. `ui-tool`, `ui-chat`, and `ui-primitives` run 2395 tests
green, the new brand package runs 6, `verify-fork-overlay` is green at 14 patches
/ 56 Tier-2 files, and the client face plus the web shell rebuild clean.
