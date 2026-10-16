# Shared profiles, provider visibility, literal transparency, peak-hour send dialog, Skills tab

Session `session-acd47678-ff54-4ef8-89bf-0f10d466aa33`, turn 2 (2026-10-09). Prior work in this session:
`.recon/deepseek-peak-hour-warning-and-table-parser-fixes.md`.

## Operator request (verbatim, condensed only by line breaks)

> Standardization for providers across profiles. so when i edit the profiles, the providers in all the profiles get
> updated too. And then I want a provider toggle to turn on and off visibility of a provider in the model picker.
> Also, when you editted the personalization package, a few things broke. transparency is literal. Which means it
> literally means how transparent a window is, not seeing the backdrop only. I dont know if desktop selection under
> the backdrop choice is meant to provide literal transparency, or not because i cant see the process running behind
> the harness. Next, I want an actual warning pop up box after I press send during a deepseek peak hour to ask if I
> want to proceed, or schedule a send when the peak hour ends, or just not send and keep the message in the prompt
> box. There is an official plugin called automation tasks, perhaps you can use that to schedule the prompt to run
> once the peak hour is over. Also make sure to be smart when managing, if theres a message scheduled before the next,
> ofc add options to either schedule the second message after the full run of the first message is settled or both
> at the same time. On the left side bar where plugin, profiles and automation tasks. The tabs are, I want to add a
> skills tab as well to allow users to. Write their own skills. [...] I would also like to get feedback for the tools
> in this harness from you at the end of this session, However don't do it during this run.

Follow-ups: "plugins should be standardized across all profiles, Such that if a certain plugin is enabled in one
profile, it should be enabled across all profiles." / "add to todo if you forgot".

Do NOT give tool feedback until the operator asks at the end.

## Status at start

- Table-repair archive installer ran: `.recon/markdown-repair-install.json` → `installed` 2026-10-08 16:02,
  backup `.recon/install-backups/app.asar.orig-20261008-160257`.

## Recon: where per-profile state lives

Profiles: `C:\Users\eejar\.dsh\profiles\{desktop,desktop-test-instance,general,harness,headless,school,web}`.
Desktop app runs profile `harness` (command line of `DeepSeek Harness.exe` on port 56153).

- Providers: `cordis.patch.yml` row `llm-pi-ai` → `config.providers.<route>` (custom providers; written by
  `ui-settings-models` `CustomProviderCard` through `settings.mutate('llm-pi-ai', [{op:'set', path:['providers',
  route]}])`). Already drifted: harness/general/school/test = anthropic, deepseekfree, google, nvidia, qwen3-8,
  tokenharbor; web adds openrouter, no qwen3-8; desktop lacks qwen3-8 and tokenharbor.
- API keys: per-profile `credentials.yaml` `refs:` (ENV-name → value) and `records:` (grants: browser session,
  deepseek-account login). Written through the credentials service.
- Plugin enablement: `plugin-manager` `setPluginEnabled` → `writePluginEnabled(profile.patchPath, patchId, module,
  enabled)` (a `disabled` row in the profile patch); `setBundleEnabled` → `package.json` `dsh.profile.bundles`.
- Settings writes: `settings.write` → `configEditor.edit(entry, change)` (packages/boot/config-editor) which edits the
  profile patch YAML (preserving `!!js`), checks the effective result, writes atomically under a `package.json` file
  lock inside `hmr.runExclusive`, then `reconcileProfilePatches(root, patches, 'dsh', [id])`.
- A home-level patch exists: `readProfilePatches` applies `$DSH_HOME/cordis.patch.yml` after every profile patch.
  Rejected as the sharing mechanism: `configEditor.edit` throws "overridden by a home patch" for any row it touches,
  and `setPluginEnabled` reports `overridden`, so the Settings and Plugins pages could no longer edit shared rows.
  Using it would require patching upstream config-editor inside the Desktop asar.

## Decision for tasks 1 / 1b (in progress)

A fork Host plugin syncs a shared state through `$DSH_HOME/profile-sync/state.json`: provider rows' configs,
credential refs, plugin `disabled` rows, and bundle selection. Each running profile watches its own files and the
store; an edit in any profile pushes to the store and to every other profile's files; a running profile applies a
newer store live with `reconcileProfilePatches`; a stopped profile applies it at start.

## Operator decision (task 3)

> keep desktop in the backdrop as the main actual transparent window if thats not already the plan

The `Desktop` backdrop choice must make the window literally see-through: other applications behind the harness
window visible through it, scaled by the transparency sliders. Other backdrops (gradients, image) stay as painted
backgrounds.

## Tasks 1 + 1b — profile sync (done, ships at next restart)

New package `packages/boot/profile-sync` (`@deepseek-ai/dsh-profile-sync`, host-only), row `profile-sync` in
`packages/bundle/efai-base/cordis.patch.yml`. Store: `$DSH_HOME/profile-sync/state.json` (stamped values +
per-profile baselines), locked with `withFileLock`; profile files written under each profile's `package.json` lock
(the config-editor's lock). Shared: `providerRows` configs (llm-pi-ai, llm-deepseek, llm-deepseek-account, llm-kiln,
ai-accounts, deepseek-account, model-visibility), every row's `disabled`, `dsh.profile.bundles`, credentials `refs`.
Not shared: credential `records` (logins). Excluded by default: headless, desktop-test-instance.
First pass: backs up every profile to `profile-sync/backup-<iso>/<profile>/`, seeds from the running profile and
fills what others have that it lacks (`fillMissing` objects recursively, running profile wins on conflicts; bundles
union; refs union; plugins only-disabled-elsewhere → enabled). Dry run on a copy of the real profiles: harness gains
general/school/web's extra anthropic models and web's two third-party bundles (`@linxin666/dsh-remote-web-ui`,
`@goodandready/dsh-dsml-artifact-guard`), which `linkSharedBundles` junctions from `profiles/web/node_modules` into
`profiles/node_modules` so every profile resolves them. Spec: 21 tests, 100% coverage.
Junctions: `profiles/node_modules/@deepseek-ai/dsh-profile-sync` -> package.

## Task 2 — provider visibility (done, verified in Desktop test instance)

New package `packages/client/ui-model-visibility` (row `model-visibility` in efai-web). Host half wraps
`llm.listProviders()` (read by session.modelCatalog, the picker selection check, ACP) dropping `config.hidden` ids;
volatile, so no restart; turns route via the adapter table, so a session on a hidden provider keeps working. Browser
half: list in the `settings.models.footer` slot (Settings → Models, bottom), catalog groups + failures + hidden
entries (hidden entries store the provider name). Bug found in test instance: missing `remote.session` inject →
row failed activation; fixed. Verified: toggling nvidia off removed it from the real picker menu; persisted as
`model-visibility.config.hidden: [{id: nvidia, name: nvidia}]`; toggled back on. Spec 12 tests, 100% coverage.
`model-visibility` is in profile-sync's providerRows, so hidden providers are shared across profiles.

## Task 3 — literal transparency (done in test instance; deploys with the archive installer)

Root cause: the Desktop main window on Windows is created without `transparent` (installed `lib/main.js`, the
`process.platform === "win32" && primary` branch: `titleBarStyle: hidden` + opaque `titleBarOverlay` color), so CSS
translucency only exposed the window's own paint. The earlier `build-rounded-archive.py` had removed `transparent: true`
to get rounded corners; the app update since then shipped pristine. Personalization CSS already fades the shell
(`html` background) and surfaces by `shellOpacity`/`surfaceOpacity`; the "Desktop" backdrop (`backdrop: none`) paints
nothing behind them.
Fix: `.recon/build-desktop-archive.py` (combined, idempotent archive builder: table-repair + transparent) inserts
`transparent: true, backgroundColor: "#00000000"` and a transparent title-bar overlay into that branch. Trade-off:
Windows draws transparent windows square with no native shadow.
Verified: test instance at shell 35 / surface 50 over a Notepad window — Notepad text visible through the harness
(screenshot `screen_1791538211935.png` in the harness kernel screenshots). Test instance shown topmost for ~1 s via
SetWindowPos(HWND_TOPMOST, NOACTIVATE), then restored/minimized (`.recon/_front.ps1`, `.recon/_unfront.ps1`).
