# standalone/

Portable Windows distribution of the DeepSeek Harness, with self-update.

## What this is

`build.ps1` produces a self-contained folder whose entry point is a real
`dsh.exe`. The target machine needs **no Node, no pnpm, and no Python** - the
distribution carries its own Node runtime and the compiled harness. Once
installed, `dsh.exe` can check the GitHub repository for a newer release and
replace the installed tree in place.

## Build

```powershell
# once, at the repo root, so packages/*/lib exists
pnpm run build

# then
powershell.exe -NoProfile -ExecutionPolicy Bypass -File standalone\build.ps1
```

Only Windows PowerShell 5.1 is required (it ships with Windows). PowerShell 7
is not needed; the script declares `#requires -Version 5.1` and uses nothing
newer.

Useful switches:

| Switch | Effect |
|---|---|
| `-WithKernel` | also bundle the vendored Python runtime (~160 MB) so the `ctx.kernel` backend works offline |
| `-SkipZip` | skip the zip |
| `-SkipDeploy` | reuse an existing `app\` tree |
| `-NodeExe <path>` | bundle a specific `node.exe` |
| `-StandaloneVersion <v>` | stamp the distribution version compared against release tags; defaults to the harness version |

## Layout produced

```
standalone\dist\
  dsh-standalone.zip   the shippable archive (unless -SkipZip)
  dsh\                 the distribution folder
    dsh.exe            launcher, compiled with the C# compiler shipped in Windows
    dsh.exe.config     long-path opt-in for the .NET Framework loader
    runtime\node.exe   bundled Node runtime
    app\               the CLI plus its production dependencies
    manifest.json      build metadata, including standaloneVersion
    README.txt         end-user readme shipped inside the folder
```

## Why the entry point is a launcher rather than one fused binary

A true single-file executable is not achievable for this harness, and it is
worth being precise about why:

1. **Plugins are loaded from disk at runtime.** The Cordis Loader resolves
   roughly 330 workspace packages by path while the profile boots. Node's
   Single Executable Application (SEA) support embeds one script; it cannot
   serve a runtime plugin graph.
2. **The dependency tree is large.** The production closure is ~750 MB, so any
   "one file" is an archive with an extractor stub, not a single binary.
3. **The Python kernel backend is a separate process.** `kernel-python` spawns
   the vendored Kiln runtime and talks to it over a frame protocol, so it can
   never be linked into a Node executable.

What *is* achievable, and what this directory builds, is a single `.exe`
entry point over a self-contained payload: `dsh.exe` finds its sibling runtime
and CLI, sets a writable harness home, and forwards all arguments. To the user
it is one executable to run; the payload happens to sit beside it.

## Why the tree is completed after `pnpm deploy`

`pnpm deploy --prod` ships the production closure only. The Cordis loader also
imports plugin packages that arrive as **peer** dependencies - notably
`@deepseek-ai/cordis-plugin-group`, which lives at `vendor/group` - so the
deployed tree boots with `ERR_MODULE_NOT_FOUND` until they are present.
`complete-tree.mjs` walks the deployed manifests, copies every referenced
`@deepseek-ai/*` package that is missing, and repeats until the set stops
growing. On this checkout it adds 214 packages.

## Why the dependency tree is flattened

`pnpm deploy` always materialises a `node_modules/.pnpm` virtual store and
links the top level into it. Those links do not survive zipping and extraction,
and the `<id>/node_modules/<pkg>` layout pushes paths far enough to hit the
Windows `MAX_PATH` limit on a deep install. `flatten-tree.mjs` hoists every
stored package to a real top-level directory, rewrites the surviving links as
hardlinks or copies, and deletes the store. On the current tree it moves 311
packages out of the store, keeps 191, drops 2,452 links, and removes
`node_modules/.pnpm` outright - it exits non-zero if the store survives, so a
non-portable tree cannot be packaged.

## Packaging

The zip is written by the in-box `tar.exe` (bsdtar), not `Compress-Archive`:
the managed writer in Windows PowerShell 5.1 takes tens of minutes on a
payload this size and stalled outright.

The tar invocation names its members explicitly rather than passing `.`:

```powershell
$members = @(Get-ChildItem -LiteralPath $DistDir -Force | ForEach-Object { $_.Name })
& tar.exe -a -c -f $zip @members
```

This matters. `tar -c -f <zip> .` prefixes every entry with `./`, and Windows
Explorer's own archive reader reports such an archive as **empty** - it opens,
and there is nothing inside. `tar -tf`, Python's `zipfile`, and .NET's
`ZipFile` all read the same archive correctly, so an archive can pass every
scripted check and still be unusable for the person who double-clicks it.
`build.ps1` therefore verifies the produced zip through Explorer's own COM
reader (`Shell.Application`), not only through a library.

## Launcher configuration and long paths

.NET Framework disables long paths by default, and it freezes that decision
while the runtime starts - before any managed code runs - so calling
`AppContext.SetSwitch` from `Main` is too late. The launcher ships a sidecar
`dsh.exe.config` that lifts legacy path handling at app-domain initialisation:

```xml
<?xml version="1.0" encoding="utf-8"?>
<configuration>
  <runtime>
    <AppContextSwitchOverrides value="Switch.System.IO.UseLegacyPathHandling=false;Switch.System.IO.BlockLongPaths=false" />
  </runtime>
</configuration>
```

Two details are load-bearing:

- The here-string that emits it is **single-quoted** (`@'...'@`). PowerShell
  does not collapse a doubled double-quote inside a here-string, so an
  expandable one emits `version=""1.0""`; the loader rejects that as invalid
  XML and the executable fails with *"the side-by-side configuration is
  incorrect"* before any managed code runs.
- The file declares **no `<startup>` sku**. Naming a framework version makes
  the loader demand exactly that version, which fails the same way on a machine
  that has a different one.

The config is written BOM-free through `System.IO.File::WriteAllText`, so the
file starts with `<`. It is required only for deep installs: without it,
extraction into a path of roughly 250 characters or more fails.

## Self-update

`dsh.exe` checks the GitHub releases of the repository it was built from and
replaces the installed tree in place.

```powershell
dsh.exe --check-update          # is there a newer release? (exit 0 either way)
dsh.exe --check-update --json   # machine-readable, includes updateAvailable
dsh.exe --update-list           # every release the source offers
dsh.exe --self-update           # download, verify, swap, exit
dsh.exe --self-update --relaunch  # ...and start the new build afterwards
dsh.exe --auto-check            # the detached worker the launcher spawns
```

Flags: `--force` (install even when the version is not newer), `--prerelease`,
`--no-verify` (skip the sha256 check), `--yes`, `--quiet`, `--json`,
`--wait-pid=N` (wait for a process to exit before swapping).

Configuration is read from `update.json` beside `dsh.exe`, then
`manifest.json`, then the environment:

| Key | Environment | Meaning |
|---|---|---|
| `updateRepo` / `repo` | `DSH_UPDATE_REPO` | `owner/name`, default `eefamilyai/Deepseek-Harness-EFAI` |
| `apiBase` | `DSH_UPDATE_API` | default `https://api.github.com` |
| `manifestUrl` | `DSH_UPDATE_URL` | a direct zip URL, bypassing the release API |
| `prerelease` | - | consider prereleases |
| `autoCheck` / `autoUpdate` | `DSH_AUTO_UPDATE` | background check on launch |
| `checkIntervalHours` | - | rate limit for the background check |

Set `DSH_NO_UPDATE_CHECK=1` to disable the background check entirely.

The check compares only the leading dotted triple of the distribution version,
which is why `manifest.json` carries `standaloneVersion` separately from the
harness `version`: the distribution line and the harness line move
independently, and comparing a `0.1.x` distribution against a `0.1.7-alpha.2`
harness would otherwise never find an update.

Updates are staged in `_dsh-new` beside the install and applied by a generated
`.cmd` that waits for the running process, moves the old tree aside, moves the
new one in, and rolls back on failure. State lives in
`<DSH_HOME>\update-state.json` and the background worker appends to
`<DSH_HOME>\update.log`.

## Verifying

`build.ps1` runs the produced `dsh.exe --version` and fails the build unless a
version string comes back, with the background update check suppressed so a
build never talks to the network. A fuller check, against an isolated harness
home:

```powershell
$env:DSH_HOME = "$env:TEMP\dsh-check"
standalone\dist\dsh\dsh.exe --version
standalone\dist\dsh\dsh.exe --help
standalone\dist\dsh\dsh.exe --profile headless --dump-config
```

The last command composes the whole Cordis plugin graph and exits without
contacting a model, so a zero exit proves the deployed loader resolves every
plugin from the distribution tree alone.
