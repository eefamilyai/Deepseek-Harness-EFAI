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
