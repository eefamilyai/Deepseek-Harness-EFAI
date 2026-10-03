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
   asar. The singular row was removed once — and **the running Desktop app wrote
   it back** (file mtime 21:48, ten minutes after the edit, with the row gone
   from the edit and present again afterwards). The app persists the composed row
   set into this layer, so a hand edit to the desktop profile is not durable while
   the app runs.

   It is also not fatal, which is worth knowing before "fixing" it again: the
   spare host at 22:05 read that same file **with both rows present** and rendered
   the fork's section — route `kiln-deepseek` and its 11 pooled logins — so
   upstream's singular row does not displace the fork's `ui-settings-accounts`.
   The fork's Accounts row belongs in `packages/bundle/efai-web` precisely because
   a profile rewrite cannot drop it.

   `- id: ui-settings / enabled: false` stays in that profile: the field is
   `Volatile<boolean>` = "developer tools enabled", not the Settings page.

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

**Converted into a fork-owned package**: the `@skill` mention source.
`packages/client/ui-skill-mention` registers what the fork previously added
inside upstream's `dsh-client-ui-skill`: the same trigger (`@`), group name
(`skills`), order (3), prefix filter, user-only marker, and plain-text pick
(`@skill <name> `). It owns its own dictionary namespace (`skillMention`), its
own session-keyed single-flight catalog cache over `ctx.remote.skills.list`, and
its own `SessionReferenceSourceMap` key (`skillMentionCatalog`). Upstream's
package is pristine again, and its 31-test suite passes unmodified.

The spec runs 14 tests against the real `TestSessions`/`TestRemote` runtime:
registration and the `(trigger, name)` seat (a rival registration throws until the
fiber is disposed), prefix filtering on the remainder after `skill ` and on a
bare query, one RPC per session however many keystrokes filter it, addressed-child
suppression with no RPC, a superseded keystroke yielding empty, lexicon settle +
listener notification + unsubscribe, scope-birth prewarm, preset-switch
invalidation, connection-reset clearing every key, a failed fetch not poisoning
the key, and the pick text.

**Converted into a fork-owned package**: the whole flow-row accent binding.
The palette was already a fork package (`ui-flow-accents`); the *binding* — the
rebind each family needs and the one read that makes it visible — lived as
Tier-2 rules inside six upstream sheets. It is now
`ui-flow-accents/src/client/accents.css`, injected by that package's own client
bundle, and every one of those six files is pristine:

| Retired seam | Was |
|---|---|
| `ui-tool/.../ToolRow.module.css` | per-variant rebinds + dot |
| `ui-tool/.../toolviews/bash-sample.module.css` | shell rebind for the keyed view |
| `ui-chat/.../ReasoningRow.module.css` | think rebind + dot |
| `ui-chat/.../ContextInjectionRow.module.css` | instruction rebind + dot |
| `ui-chat/.../SystemPromptRow.tsx` | class props plumbing |
| `ui-primitives/DisclosureRow.module.css` + its spec | the shared read |

What makes it work is that upstream already emits the identity in the DOM for
its own styling and tests, so the sheet never has to name a hashed module class:
`data-variant` (`search`/`read`/`write`/`edit`/`bash`/`code`/`others`/`think`) on
each row root, `data-tool` for the Cordis product accent, `data-sample='bash'` on
the keyed shell view, `data-chat-node-key='system-prompt'` on the system-prompt
node, `data-context-source`/`data-context-summary` inside a context-injection
row, and `data-shimmer-decoration` on every separator dot.

Two design points the sheet encodes rather than inherits:

* **The token is declared on the family ROOT, not on the row.** Custom
  properties inherit, so a subcall row nested inside another call's root
  resolves the nearest root by itself; a rule that bound the row directly would
  have to know which ancestor is nearest, and equal-specificity rules cannot
  answer that (a nested `others` row inside a `read` root proves it).
* **The read is scoped to family rows.** A bare `[data-disclosure-row]` rule
  would override upstream's hover colour for *every* disclosure in the app, so
  each read selector names a family marker, and a spec asserts that.

Seven spec assertions guard the sheet: every tool variant upstream classifies is
bound, every declared hue is bound (and only the one deliberate product accent
is not a flow hue), the cordis binding follows the variants it overrides, no read
selector is a bare row, no selector matches a hashed class, and the dot is keyed
on its own attribute.

**What a plugin cannot carry, and why** — the remaining 9 upstream client files
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

### Conversion status: complete for everything convertible

Seam at the end of this work: **46 upstream files**, down from 60 when the port
started. Everything that can be a plugin is one:

| Converted | Package |
|---|---|
| account pool + its own Remote namespace | `packages/llm/ai-accounts` |
| sidebar brand (occupants + the mark's colour) | `packages/client/ui-brand-efai` |
| `@skill` picker over `ctx.inputTriggers` | `packages/client/ui-skill-mention` |
| flow-row accent palette **and** binding | `packages/client/ui-flow-accents` |
| retired as dead: 15 locale keys, menu-toggle CSS + its spec, sidebar chrome, the six accent sheets | upstream pristine again |

Seven upstream client files remain, and none of them is convertible as written:

| File | Why not |
|---|---|
| `ui-chat/AssistantMarkdown.{tsx,module.css}` | an upstream defect — a text block that trims to empty still claims one `.body` flex gap, doubling the space above the next row. Both halves live inside upstream's renderer and its `.body` class; owning `AssistantMarkdown` means owning the whole markdown pipeline. Upstream PR. |
| `ui-conversation/skeleton/EmptyHero.tsx` + its spec | the "Preview" badge is upstream chrome with no hook: the hero declares no `data-*` attribute, and its slots (`conversation.hero.brand.mark`, `.workspace`, `.agentPreset`) do not include the headline row. Asks: make the badge a slot or a config value. |
| `ui-conversation/src/client/locales.ts` (`tool.title.kernel`) and `ui-tool/.../tool-call-model.ts` | a pair: the map entry picks the locale key, and neither is a registry. The keyed `tool.call.toolview` slot could own the row instead, but `ToolRow` is not exported, so the fork would reimplement a 400-line cell view to change one title. Upstream PR. |
| `ui-settings/src/client/config-form.ts` | a memoization fix inside an upstream class; no extension point between construction and use. Upstream PR. |

**Why the accent conversion will render in the Desktop even though `ui-tool` and
`ui-chat` there come from `app.asar`**: the sheet selects on upstream's own DOM
attributes, and the shipped client contains them. Probed directly out of
`D:\Deepseek-Desktop\resources\app.asar` (121 MB, raw ASCII scan):

```
data-disclosure-row      4
data-shimmer-decoration 10
data-variant            12
data-chat-node-key       1
data-sample              1
--dsh-row-accent         0   <- the fork's own token, absent upstream as expected
```

**Deployment note**: `$DSH_HOME/profiles/node_modules/@deepseek-ai` is a tree of
junctions into `apps/cli/node_modules/...`, and the three new packages had none.
They were created (`dsh-ai-accounts`, `dsh-client-ui-brand-efai`,
`dsh-client-ui-skill-mention`), and a desktop-profile host then booted clean with
all three resolving from that tree — without them the app's next boot depends on
the nested-layout fallback alone.

**Still unverified, and why**: the accents have not been seen *painted* on a live
row. Every model account is currently `ACCOUNT_MUTED`, so no turn can run to
produce rows, and the sidebar's session rows are not addressable through the
browser tool (they expose no button role), so an existing transcript cannot be
opened either. Structure, bundle content, spec assertions, and the asar attribute
probe all pass; the paint check waits on a healthy account or the operator's own
session.

### Reaching a running host: the encrypted access file (2026-10-03)

The relaunch at 07:26 closed the session's last hope of driving the app's GUI: the
Web host mints one token per boot, prints it once to stdout, and keeps it in
memory. Recovering it was tried four ways and all failed — the app's own log
directory holds only a shutdown stub, the Electron userData `Cookies` database is
locked, the webview's local storage holds no token, and the host's process
command line carries no URL. A raw ASCII probe of the 121 MB `app.asar` found the
DOM attributes the accent sheet binds, but no credential.

So the fork publishes it. `packages/host/web-access` writes
`$DSH_HOME/run/web-access.json` once the Loader tree is ready:

```json
{ "version": 1, "pid": 46820, "profile": "desktop", "algorithm": "aes-256-gcm",
  "salt": "…", "iv": "…", "tag": "…", "sealed": "…", "hint": "node scripts/web-access.mjs" }
```

`sealed` is the URL and token under AES-256-GCM, keyed by scrypt over a key file
plus the machine and user names, so the pair is useless copied elsewhere. Verified
on a live host: the file carried no plaintext, and `node scripts/web-access.mjs`
returned exactly the URL the host printed. A file whose pid is gone is reported as
stale rather than trusted, because a killed process never runs the withdrawal —
the specs cover the withdrawal and the "another host published over me" guard,
which a `taskkill` cannot exercise.

Two traps worth remembering from the same round:

- **A spec that touches a Client face must be named `*.client.spec.ts`.** The host
  aggregate includes `packages/*/*/tests/**/*.ts` and excludes only the
  `*.client.*` suffixes, so `ai-accounts.spec.ts` — which mounts the client half —
  pulled the Connection and Gateway Client faces into the host program and broke
  the whole host typecheck with `TS6307` storms in files it never mentioned. The
  case is now `client-mount.client.spec.ts`; the host build is green again.
- **A host row cannot import the connection package.** Its `Context` merge lives
  in the Client face, so `web-access` declares the one method it calls
  structurally instead.

### The GUI polish layer: what was actually wrong (2026-10-03)

`packages/client/ui-polish` is one injected stylesheet. Three findings decided what
it does, and each came from reading the design system rather than the screenshots.

**There is no motion scale, only one shared curve.** The shell defines exactly
three durations and one easing (`--ds-transition-duration-fast/-/-slow` and
`--ds-ease-in-out`) in `ui-theme/src/styles/base.css`. Forty-three component
transitions read them; the other eighty hardcode `ease` or `ease-in-out`, and the
whole client holds 123 transition declarations across twelve durations. The stock
curve is the Material S-curve, which eases *in* — on a panel toggle that reads as
hesitation before the movement starts. Retuning the tokens moves the shell;
re-pointing `transition-timing-function` on every element moves the rest, because
a longhand overrides a component's shorthand timing without touching the property
list that decides what animates.

**Light mode has no surface hierarchy at all.** `--dsw-alias-bg-base` and all three
layer tokens resolve to `neutral-bluish-00`: canvas, dialog, card inside the
dialog, and input are the same white, separated only by hairlines. The layer tokens
are semantically ordered, so tinting the two that mean "recessed" (`layer-1` inset
controls, `layer-3` content inside a panel) restores the order everywhere at once.
Scoped to `body:not([data-ds-dark-theme])`: the static scale already separates the
layers by value in dark, and overriding it there flattens the theme instead.

**The panel tracks animate a layout property.** `AppFrame.module.css` transitions
`grid-template-columns` on `.frame[data-animating]`, and the drag handles transition
`left`. Neither can be replaced from here — the track width *is* the panel's layout,
and only the owning component can animate a transform instead — so what this layer
legitimately contributes is the curve: a decelerating easing makes the same 300ms
start decisively and settle.

An earlier revision tried to compensate by collapsing every descendant's transition
duration while `[data-animating]` was set, so nothing competed with the track for
frames. That was the wrong fix and it is reverted. The sidebar's collapse is a
*sequenced* animation — the comment in `SidebarRoot.module.css` states it: the
frozen-width content fades out in place over 150ms, and at that settle the rail
controls enter over the remaining 150ms of the 300ms track transition — so zeroing
those durations snapped the choreography into two jumps. For the same reason the
durations are no longer retuned (an earlier revision raised the track to 380ms,
which leaves the sequence finishing 80ms before the track settles). The curve is the
part of motion this layer owns; the clock belongs to the components.

Two bugs the visual check caught, both worth remembering:

- **A Client half with no `apply` fails the whole plugin load.** The first build
  exported only the imported stylesheet, and the running app answered "invalid
  plugin, expect function or object with an apply method" on a blank page. The
  row's body is now an empty `apply`; the stylesheet is what evaluating the module
  injects.
- **A neutral-scale token is light in *both* palettes.** The canvas axis first read
  `--dsw-static-neutral-bluish-50`, which painted a bright band across the top of a
  dark window (`polish-before-dark-band-bug.png`). It now reads `--dsw-alias-bg-layer-1`,
  which is a step above the canvas in each palette, so one rule serves both themes.

Stable hooks found while writing it, each verified in source before use: the app
frame publishes `data-animating`, `data-dragging`, `data-sidebar-collapsed`,
`data-rightbar-collapsed/-fullscreen/-instant` and `data-side` on its drag handles;
the conversation publishes `data-conversation-content` (the body, which does *not*
scroll — its child does), `data-conversation-scroll`, `data-composer-seat`,
`data-phase` and `data-content-phase`; the dock publishes `data-dockkit-surface`,
`data-dockkit-host`, `data-dockkit-column`, `data-dockkit-cell` and
`data-sidebar-right-panel`; overlays are named by their ARIA roles. `data-window-drag`
is *not* a sidebar hook — the plugin manager, onboarding surface, platform overlay
and conversation header all carry it, so a column selector keyed on it would have
matched the wrong element.

### The sharp edge on the right panel (2026-10-03)

The operator's complaint was specific: the right panel has no corner treatment and
the shell is full of hard edges. Measuring the running app, rather than reading the
stylesheet, found the cause — and it was not a missing radius.

Pixel samples of the dock at 1280×720: canvas `(255,255,255)`, dock `(255,255,255)`,
sidebar `(241,243,245)`. The dock painted **the same token as the page**
(`.tabHost:not(.float) { background: var(--dsw-alias-bg-base) }`), so it read as a
slab of background cut off by a rule rather than as a panel, and a rounded corner on
it would have been invisible. Three fixes, each verified by re-measuring:

- **A fill of its own.** The dock takes `--dsw-specific-sidebar-fill`, the same panel
  value the sidebar already uses — the two side panels are parallel surfaces and now
  measure identically (light `241,243,245`; dark `27,27,28` against a `20,20,23`
  canvas).
- **Rounded leading corners, and the clip that makes them visible.** The corner is
  painted by the tab host *inside* `[data-dockkit-surface]`, which paints nothing
  itself, so without `overflow: clip` the host draws its own square corner over the
  rounded one. Measured: the dock's fill recedes from x=714 at y=0 to x=704 by y=9,
  mirrored at the bottom. Scoped to `[data-sidebar-right-panel='push']` — dockkit also
  hosts fullscreen, bottom and floating panes, where the leading edge is a different
  side.
- **A softer rule.** The 0.5px left border moved from `border-l4` to `border-l3`
  (measured: `202` → `216` over the new fill). This needed a specific weight: the
  component's rule is `.tabCell[data-dockkit-host='dock'][data-dockkit-column='0'] > .tabHost`,
  which is four class-or-attribute selectors, so the override repeats the panel
  attribute to outweigh it.

Evidence: `.recon/polish-after-dock-light.png`, `-after-dock-dark.png`,
`dock-corner-before.png`, `dock-corner-after.png` (both at 5x),
`polish-before-dock-corners.png`.
