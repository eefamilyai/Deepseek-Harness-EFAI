# Profile: custom profiles and desktop parity

Job: operator asked whether profiles other than `desktop` can "boot like desktop" and whether
they can add their own profiles so the harness is not one cluttered profile.

All findings below were executed, not inferred, unless marked *(source read)*.

## Live state

`$DSH_HOME` = `C:\Users\eejar\.dsh`. Three profiles exist:

| profile | `dsh.profile.bundles` | own `cordis.patch.yml` | profile-local `node_modules` |
| --- | --- | --- | --- |
| `desktop` | base, efai-base, web-app, efai-web (`patchReload: live`) | 15,399 b, 81 id-targeted rows | none (`dependencies: {}`) |
| `web` | base, efai-base, web-app, efai-web, `@linxin666/dsh-remote-web-ui`, `@goodandready/dsh-dsml-artifact-guard`, experimental-voice-input-bundle | 16,612 b | yes (pnpm-lock present) |
| `headless` | base, headless | 217 b | none |

No home-level layer exists: `$DSH_HOME/cordis.patch.yml` is absent.

## What a profile is

`$DSH_HOME/profiles/<name>/` = `package.json` (out-of-tree deps + `dsh.profile.bundles`,
ordered) + `cordis.patch.yml` (the profile's own patch layer) + `cordis.yml`
(empty root list, rewritten at every boot) + `pnpm-workspace.yaml`.
Unlimited profiles; there is no registry and no GUI picker — the name is chosen on the
command line only. The Desktop app is hardwired to `profiles/desktop`
(`apps/desktop/src/paths.ts`).

Composition order (`packages/boot/app-boot/src/profile-context.ts`): bundle layers in
`dsh.profile.bundles` order, then the profile's `cordis.patch.yml`, then
`$DSH_HOME/cordis.patch.yml` (home layer — **outranks** the per-profile layer), then
`--patch` overlays, then the telemetry switch.

## Desktop is closed as a base (executed)

```
$ node apps/cli/lib/bin.js --profile desktop --dump-config
error: profile "desktop" is managed exclusively by the Electron application        (exit 1)

$ node apps/cli/lib/bin.js plugin --profile desktop add example-plugin
error: profile "desktop" is managed exclusively by the Electron application        (exit 1)

$ node apps/cli/lib/bin.js --profile mine --from-default-profile desktop --dump-config
Error: dsh: unknown default profile "desktop"; expected one of
       "acp", "headless", "sdk", "sdk-minimal", "web"                              (exit 1)
```

`PROFILE_TEMPLATES` (`packages/boot/app-boot/src/profile.ts`) holds exactly
`acp`, `web`, `headless`, `sdk`, `sdk-minimal`. `initializeProfileFromDefault` copies
**only the template's bundle list** — no inheritance metadata, no read of the same-named
shipped profile's local state, and the target name may not be a shipped name.
*(source read)*

## Desktop parity is reachable from an own profile (executed)

`--from-default-profile web` created `profiles/mine/` with `base + web-app` and an empty
`[]` patch layer. Replacing `dsh.profile.bundles` with the desktop tuple
(base, efai-base, web-app, efai-web) and booting:

- `--dump-config`: exit 0, **1346 composed rows, zero installs** — all four bundles are
  installation-owned (`apps/cli` dependencies), so no `dsh plugin add` is needed.
- real boot on a throwaway home and port: `dsh web: http://127.0.0.1:19553/?token=...`,
  `GET /` returned 200, `<title>DSH Local Build</title>`, client module
  `index-DX1gUq1G.js`, `__DSH_BOOT__` payload present — the same GUI the Desktop app serves.

What a custom profile does **not** get is only Electron shell furniture, injected by
`apps/desktop-host/src/index.ts` *after* `runProfile` (desktop office engine, update-task
control, quit inspection, platform-session publishing) plus the fixed
`--no-open --port 19387` arguments. None of it is a profile row.

## The clutter question

Cloning the real desktop profile (same bundles **plus** its 15 KB user layer) composed
**1773 rows** versus **1346** for the bare bundle tuple: ~427 rows come from the user layer.
That layer configures `system-prompt`, `tool-roster`, `ui-settings-general`,
`agent-default-model`, `permission`, `llm-pi-ai`, and ~70 model-catalogue rows.

So the split is: shared tuning belongs in `$DSH_HOME/cordis.patch.yml` (absent today);
per-profile files only need the `- id:` blocks they actually change, because a patch
replaces the targeted row's whole `config` rather than merging into it.

## Defect found in the desktop profile's user layer

`profiles/desktop/cordis.patch.yml` carries two entries with `id: ui-settings-account`:

- line 447 → `@deepseek-ai/dsh-client-ui-settings-accounts` (exists)
- line 457 → `@deepseek-ai/dsh-client-ui-settings-account` (singular; no such package)

The stale second row is skipped on every boot, printing to stderr:

```
dsh: [...\profiles\desktop\cordis.patch.yml] patch: name mismatch for "ui-settings-account"
(expected "@deepseek-ai/dsh-client-ui-settings-account", got "@deepseek-ai/dsh-client-ui-settings-accounts"),
skipping
```

Surfaced while dumping a clone of the desktop profile into a temporary `DSH_HOME`; the real
home was not modified.

## Commands

```sh
dsh <name> --from-default-profile web        # create <name> from a shipped template, then boot it
dsh plugin --profile <name> add <package>    # add an out-of-tree plugin bundle to <name>
dsh <name>                                   # boot <name>  (== dsh --profile <name>)
dsh <name> --dump-config                     # print the composed tree without mounting
```

---

# Second job: per-profile isolation and the profile-hub landing page

## Request (verbatim)

> Can you make 1 profile for deepseek harness works and 1 profile for general projects. actually the
> general projects one be just the orignial profile. then move the deepseek harness works folder into
> the profile. Also want a profile for school work. and then there should be a folder for school.
> these profiles might have and can have different deepseek accounts connected to it. furthermore it
> should be runnable by dsh --profile <profile name>

Follow-ups: the folder should **not** move — the point is moving the **chats** so they stop
cluttering; clone the desktop bundle stack; and instead of a clean "original" profile, build **an
external plugin that opens a landing page on startup where profiles can be created, deleted,
managed, and entered**.

## Profiles on disk

`harness` (works in `D:\deepseek-kernel-harness`), `general`, `school` (works in
`C:\Users\eejar\OneDrive\Desktop\School`, created on request). Each is the desktop profile's bundle
tuple (`base + efai-base + web-app + efai-web`, `patchReload: live`), the desktop profile's whole
patch layer copied as the starting tuning, and three isolation rows appended.

| Profile | bundles | chats | credentials |
|---|---|---|---|
| `harness`, `general`, `school` | 4 | own | own |
| `desktop`, `web`, `headless` | unchanged | shared | shared |

Isolation rows — a patch replaces the targeted row's whole `config`, which is why each restates the
fields its bundle layer set:

```yaml
- id: session-persistence-jsonl      # chats
  config: { root: '<profile>/sessions' }
- id: storage-json                   # workspaces + projection cache
  config: { root: '<profile>/storages' }
- id: credentials                    # API keys + the signed-in DeepSeek account
  config: { path: '<profile>/credentials.yaml' }
```

Settings need no row: `@deepseek-ai/dsh-config-editor` already persists settings into the running
profile's own `cordis.patch.yml`.

Verified live: a school-profile host wrote `profiles/school/storages/workspace.json` and left the
shared `~/.dsh/storages/*` mtimes untouched; a school child process ran
`bin.js --profile school --no-open --port 55240` with its own session root.

Each profile's `credentials.yaml` is seeded with the machine's provider **references** (`refs`) and
an empty `records` map, so keys work immediately and each profile signs in to its own DeepSeek
account.

## The plugin: `packages/boot/profile-hub` (Tier 1, no seam growth)

`@deepseek-ai/dsh-profile-hub`, dual-face, namespace `profileHub`:

| Remote method | Does |
|---|---|
| `listProfiles()` | every profile: title, working folder, bundles, chat count, reserved/current/launcher/running |
| `createProfile(request)` | the running profile's bundles and patch layer + the three isolation rows + a seeded credentials file |
| `removeProfile(name)` | deletes the directory; refused for the running profile and reserved names |
| `setLauncherProfile(name)` | records the profile whose startup opens the landing page (`<home>/profile-hub.json`) |
| `openProfile(name)` | spawns `dsh --profile <name> --no-open --port <free>` and answers the URL it prints |
| `stopProfile(name)` | stops a host this one started |

Client half: mounts its own namespace (so no shared assembly knows it exists) and contributes a
`shell.overlay` landing modal, a `main` panel page, and the `sidebar.panellist` entry beside Plugins.
Reserved names (`desktop`, every shipped template) are listed and enterable, never editable.

### Traps hit and fixed (each cost a rebuild)

1. **`remove`/`stop` as Remote method names fail at mount**:
   `client api: method "profileHub/remove" conflicts with its namespace service` — the namespace
   service is a cordis `Service`, and `REMOTE_NAMESPACE_FIELDS` plus the whole prototype are
   reserved. Every method is now `…Profile`-suffixed.
2. **`ctx.remote.<ns>` requires the namespace in `inject`** — and a plugin that mounts its own
   namespace would then wait on itself. Read it with `ctx.get('remote.profileHub')` after the mount.
3. **A `shell.overlay` chip collides with the sidebar's Settings row** (screenshot); the surface now
   lives in the sidebar panel list and the main column, with the overlay used only for the startup
   landing.
4. **The Modal caps at 380px**: the landing passes `className` through it, typed as a required string
   under `exactOptionalPropertyTypes`, so the class is spread in conditionally.
5. **`stringify` from `yaml` has no `sortKeys`** (that is js-yaml).
6. The client leaf needs `{"path": "../../client/ui-sidebar"}` and `include: ["src/client", "src/css-modules.d.ts"]`,
   or ui-sidebar's sources are pulled into this program.
7. **`readProfileMeta` must drop a `null` field**: `workdir: null` rendered as `Works in: null`.

### Wiring

Rows in `packages/bundle/efai-base` (host) and `efai-web` (browser), `workspace:^` in both bundle
manifests, the two aggregate tsconfig entries, and `pnpm run gen-tsconfig-paths`. The package also
needs a junction in `$DSH_HOME/profiles/node_modules/@deepseek-ai` (created, matching the ai-accounts
precedent).

`pnpm run gen-tsconfig-paths` was **already broken** in this tree:
`@deepseek-ai/dsh-client-ui-personalization` had no alias and the generator refuses to run. Its
hand-written alias was restored in `tsconfig.base.json` (the hand-written region, before the BEGIN
marker), which also unblocked this package's generated alias.

### Verification

- `pnpm exec vitest run packages/boot/profile-hub`: **43 tests green** (30 host, 13 client),
  including real child processes for the URL line, the exit-before-serving path, the timeout bound,
  and teardown.
- Live spare host on `19571`, driven by Playwright: the landing modal lists all six profiles;
  **Enter** on `school` spawned `--profile school` on `55240` and the browser navigated there; the
  school host showed no landing page (it is not the launcher). Evidence:
  `.recon/profile-hub-landing3.png`, `.recon/profile-hub-entered-school.png`; probes
  `.recon/profile-hub-probe.mjs`, `-measure.mjs`, `-enter.mjs`.
- `node local-overlay/rebuild.mjs` → 13 patches / 47 Tier-2 files; `verify.mjs`,
  `apply.mjs --check` and `verify-seam-frozen.mjs` (47 = 47) all green.
- `scripts/gen-cordis-catalog.ts` and `scripts/gen-doc-graphs.ts` already record a fork seam; the new
  namespace and its four types were classified there (`profileHub: 'boot.md'`,
  `TYPE_LINK_EXEMPTIONS`, a `SERVICE_ROLES` entry), and `gen-config-catalog`, `gen-doc-graphs`,
  `gen-module-graph`, `gen-plugin-packages` were regenerated.
- `verify-client-ui-i18n`: 976 sources pass (all copy goes through the `profileHub` dictionary).

## OPERATOR ACTION: restart DeepSeek Harness once

The hub's rows are **bundle-layer** rows, and only the profile and home patch layers hot-reload
(`patchReload: live`). The app running now booted before those rows existed, so it composes no
`profileHub` service. Quit and relaunch `DeepSeek Harness.exe`; no profile edit is needed (both
bundles already carry the rows and the junction exists). After the restart the Desktop app lands on
the profiles page; `desktop` is the launcher by default, because `<home>/profile-hub.json` is absent.

## Outstanding

- `pnpm run gen-client-catalog` fails on **ui-sidebar**, not on this package: its
  `src/client/contract/` carries both `slots.ts` and `slots.d.ts`, so seven slots are declared twice
  and seven owner-prop interfaces are unexported. Pre-existing in this tree; untouched here.
- The coverage gate (`test:coverage`, per-file 100%) has not been run against the new package; the 43
  specs cover the behavior and most error paths, not every branch.
- A profile's working folder is the spawned process's cwd; the GUI's workspace picker still defaults
  to the app's own default workspace for the first session. Each profile has its own workspace
  registry, so the choice is per profile once made.

---

# Third job: two ways to open, and a Desktop window that owns a profile

## Request (verbatim)

> Opening should open the desktop version not the web version. please edit that

then

> actually make it 2 different options, and also make the profile GUI much nicer and more appealing
> to the eye

Approved route (asked before touching an installed application): **patch both** — the repo change so
future builds carry it, and the installed `app.asar` so it works now.

## Why the shell had to change

`dsh <profile>` is a Web Host, and the Desktop application booted `profiles/desktop` and nothing else:
`apps/desktop/src/paths.ts` hardcoded it, `apps/desktop-host/src/index.ts` hardcoded both the profile
name and port `19387`, and the shell exposes no route to boot another profile (checked: the preload's
`dshDesktop` carries browser/deviceInfo/keyboard/shortcuts/updates, `dsh://open` only focuses the
primary window, and there is no argv or env override). A second window on another profile therefore
needs one new selection input, which is `DSH_DESKTOP_PROFILE`.

## Repository change (seam 47 → 49, recorded)

`apps/desktop/src/paths.ts` — `desktopProfileName()` reads `DSH_DESKTOP_PROFILE`, and
`resolveDesktopPaths(dshHome, profile = desktopProfileName())` owns that profile's directory and lock.
`main.ts` needed no edit: both of its call sites take the default.

`apps/desktop-host/src/index.ts` — `desktopProfileName()` and
`args: ['--no-open', '--port', name === 'desktop' ? '19387' : '0']`. The primary window keeps its
stable port; a second window takes whichever port is free, so two instances serving two profiles
coexist. Checked out of the built file:

```
DSH_DESKTOP_PROFILE=undefined -> profile=desktop, port=19387
DSH_DESKTOP_PROFILE=""        -> profile=desktop, port=19387
DSH_DESKTOP_PROFILE="school"  -> profile=school,  port=0
```

`node local-overlay/rebuild.mjs` folded both into `apps.patch`; `verify-seam-frozen.mjs` reported
`NEW SEAM apps/desktop-host/src/index.ts` and `NEW SEAM apps/desktop/src/paths.ts`, and `--record`
raised the frozen list to 49. All four overlay checks pass.

## Hub change

`openProfile(name, target)` with `target: 'app' | 'browser'`, `ProfileHubState.canOpenDesktop`, and
Config `desktopExecutable` (default: `process.execPath` when it is Electron, otherwise absent, so a
terminal-launched host reports `canOpenDesktop: false` and the button explains itself). A Desktop
window is spawned **detached and unreferenced** with `ELECTRON_RUN_AS_NODE` deleted from the
environment — inherited, the exe would start as a script and exit without showing a window.

## Client redesign

Two open actions per row (**Open in app** primary, **Browser** outline), sections **Your profiles**
and **Reserved**, an initials badge per profile, one accent bar for the current profile instead of a
chip, chat/bundle/folder as a dotted meta line, management (open-on-startup, stop, delete) moved into
an overflow `Menu`, and the create form collapsed behind **+ New profile**.

## The installed application

`app.asar` is locked by the running application (verified: a write handle fails with "being used by
another process"; `Move-Item` and `cmd move /Y` both refuse), and this session *is* that application,
so the swap cannot happen from here. Built and verified, waiting:

- `.recon/repack-desktop-asar.mjs` — repacks faithfully rather than with `asar extract` + `pack`:
  a stock repack pulls the 1497 `unpacked` native modules **into** the archive (358 MB, and native
  modules inside an asar do not load). This one keeps them unpacked, so the result is 115.7 MB.
- Data base is `16 + jsonSize` (not `+ headerSize`), confirmed by reading `dsh/desktop-runtime.json`
  at offset 0.
- Verified: 11470 packed entries rewritten in document order, 1497 unpacked kept, exactly the two
  intended files differ, and `@electron/asar list` accepts the result. Both patched files pass
  `node --check`.
- `D:\Deepseek-Desktop\resources\app.asar.new` is the result;
  `D:\Deepseek-Desktop\apply-profile-windows-patch.cmd` installs it (refusing while the app runs) and
  relaunches. The pre-patch archive is also kept as
  `app.asar.orig-20261005-201825-pre-profile-windows`.
- The exe is a GUI-subsystem binary, so running the patched host directly captures no console output;
  the selection semantics were checked by evaluating the built block instead.

## OPERATOR ACTION

Close every DeepSeek Harness window, then run **`D:\Deepseek-Desktop\apply-profile-windows-patch.cmd`**.
It swaps the patched archive in and starts the Harness. That single step covers both the new bundle
rows and the shell's profile selection; after it, **Open in app** opens a real Desktop window on the
chosen profile, and **Browser** keeps the previous behaviour.

## Outstanding

- The one test that proves the *installed* shell end to end (a second window on another profile) can
  only run after that restart; everything up to the process boundary is verified above.
- The suite is now 54 specs (35 host, 19 client), all green; the per-file coverage gate still has not
  been run against this package.
- `pnpm run gen-client-catalog` still fails on ui-sidebar's duplicated contract files (pre-existing).

---

# Fourth job: the second window never appears

## Report

> I dont think the desktop app is opening. I think there something preventing from 2 different desktop
> instances from opening simultaneously?

> no it gave an error message. use visual tools / there was a error message box.

## Root cause: Electron's single-instance lock

The packaged shell carries

```js
function claimDesktopSingleInstance(application, focusOwner) {
	if (!application.requestSingleInstanceLock()) {
		application.quit();
		return false;
	}
	application.on("second-instance", focusOwner);
	return true;
}
```

so a second launch never shows a window: it fails the lock, calls `application.quit()`, and the running
instance only focuses itself. Measured with the app running, launching the exe directly:

| second launch | result |
| --- | --- |
| default user-data dir | exited in < 500 ms, code 0 — refused silently by the lock |
| `--user-data-dir=<own dir>` | **still running after 12 s** |

The lock is per user-data directory, so a second window needs its own. Two false starts on the way:
`Start-Process` inherits `ELECTRON_RUN_AS_NODE` from the app's own host process, so the first probes
ran the exe as *Node* and exited 0 with no lock involved; the probes now clear that variable first,
and `capture_screen` at the moment of launch showed no dialog in the working case.

The error box the operator saw was **mine, not the app's**: the `--user-data-dir` probe launched a real
second instance that then booted the still-unpatched `profiles/desktop` and failed to bind port 19387,
so the shell showed its Host-failure dialog on their screen. That is itself the confirmation that both
halves are required together — the lock escape *and* the profile/port patch.

## Fix

`packages/boot/profile-hub`: `openDesktopWindow` now takes the command-line switches it launches with,
and the service passes `--user-data-dir=<home>/desktop-windows/<profile>` — one window data set per
profile, so the lock is per profile exactly as chats and credentials already are. Config
`desktopProbeMs` (default 2000) watches a launched window for that bound; a window that is already gone
is reported ("the Desktop application closed the window for X as soon as it opened") rather than the
silent success the first report produced.

Verified in the built artifacts: `lib/index.js` carries `--user-data-dir=`, `desktop-windows`,
`desktopProbeMs`, and the refusal message, and the junction under `$DSH_HOME/profiles/node_modules`
resolves them. Suite: **54 specs green** (35 host, 19 client), including a stand-in application that
records the environment and switches it was launched with — asserting the window is told which profile
it owns and does **not** inherit `ELECTRON_RUN_AS_NODE`.

## Why the app still has to restart

The host half is loaded when the application starts, so the running host still carries the previous
hub. The `.cmd` restarts the application, which is also what installs the shell patch — one step for
both, and afterwards the second window can be proven end to end.

## Fifth job: the first installer run failed twice over

Two independent faults, both found from the operator's console output rather than from reasoning:

1. **The batch file was written with LF line endings**, so `cmd.exe` read `move` as `m` and printed
   `'m' is not recognized as an internal or external command` for every swap line. A Windows batch
   file must be CRLF; it is now written as bytes with `\r\n` (43 CRLF, 0 bare LF), and the swap logic
   was self-tested on a scratch copy with dummy archives: `app.asar` → new content, the previous one
   held as `app.asar.orig-pre-profile-windows`, `app.asar.new` consumed, relaunch reached.
2. **Closing the window does not quit the app.** It keeps running in the system tray
   (`backgroundNoticeBody`: "Running tasks will continue. You can reopen the window from the system
   tray."), so the installer's wait loop never ended and the session stayed alive with no window. The
   operator must quit from the tray; the wait message now says so explicitly.

Both facts were visible in the operator's own output — the loop message and the `'m'` lines — and
neither was in any log I had been reading.

---

# Sixth job: "Opens first" did not open the app there

## Report

> starting the app doesnt open the "start first" profile

## What was actually wrong: my label promised more than it did

`profile-hub.json` recorded `{"launcher":"general"}`, and the app still booted `profiles/desktop`.
Both true, because in patch v1 the launcher choice only decided **which profile's host opens the
landing page** — never which profile the application starts on, which the shell hardcoded to
`profiles/desktop` unless `DSH_DESKTOP_PROFILE` was set for that one launch. So with `general` marked
"Opens first", the desktop window opened with no page (it is not the launcher) and nothing started in
`general`. The control was misnamed, and the honest fix is to make it mean what it says rather than to
rename it.

## Repo change (no new seam: `paths.ts` is already seamed)

`apps/desktop/src/paths.ts`: `desktopProfileName(dshHome, environment)` now resolves, in order,
`DSH_DESKTOP_PROFILE` (a single launch — the second-window path), then the profile recorded in
`<dshHome>/profile-hub.json` when that profile still has a manifest, then `desktop`.

## Shell patch v2

`app.asar.new` rebuilt from the pristine archive with the same logic inside the bundled
`resolveDesktopPaths` region — the bundle already imports `existsSync` and `readFileSync` by name, so
the read needs no new import. Behaviour checked out of the built archive with a stubbed filesystem,
8 cases:

```
nothing recorded            -> desktop
recorded launcher exists    -> general
recorded launcher is gone   -> desktop
recorded launcher is blank  -> desktop
record is not JSON          -> desktop
record has no launcher      -> desktop
launch names a profile      -> school      (explicit launch wins)
launch names a blank profile-> general
```

## Follow-on guard

With the app able to boot any profile, "Open in app" on the row of the profile this window already
runs would start a second owner of the same profile directory and fail its lock. That row's Desktop
button is now disabled with "This window already runs this profile." Suite: **57 specs green**
(38 host, 19 client).

## What the operator sees after installing v2

The application opens in **general** (the profile marked "Opens first") and shows the profiles page
there, because the launcher profile is now also the running one. This conversation lives in the
*desktop* profile's sessions and will not appear in the general window's sidebar; "…" → "Open on
startup" on the desktop row (or deleting `<dshHome>/profile-hub.json`) moves the application back.
