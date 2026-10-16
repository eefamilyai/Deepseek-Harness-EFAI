# Personalization choices, and the browser tool in the right-sidebar browser

## Request (verbatim)

> I want the personalization plugin to be more wide, more choices. also after that is done, I want to move the
> browser tool, from the headless chrome to the build in browser in the right sidebar. When the AI is using the
> browser and I open it, i should see the AIs tab already opened on the same page.

> BTW this request is for the desktop app

## Where things run (measured)

- The operator runs the Desktop app: `D:\Deepseek-Desktop\DeepSeek Harness.exe`, profile `harness`
  (`C:\Users\eejar\.dsh\profiles\harness`). Port 57485 belongs to the desktop-host Node child (PID 20572).
- The Electron main process is `app.asar:/lib/main.js`; the app preload is `app.asar:/lib/preload-app.cjs`.
- Upstream packages the asar ships always win over the profile (see `desktop-asar-shadows-fork-packages.md`):
  `dsh-client-ui-sidebar-browser`, `dsh-client-ui-sidebar-right`, `dsh-client-ui-primitives` are asar copies
  (version 0.2.0-rc.2, same as the repo base). Fork packages (`dsh-client-ui-personalization`,
  `dsh-web-browser`) are not in the asar and load from the profile, so they can change without an asar repack.
- asar inspection helpers written this job: `.recon/_asar_get.cjs` (extract), `_asar_find.cjs`, `_asar_ls.cjs`,
  `_asar_stat.cjs`; asar paths must be passed with backslashes to `extractFile`. Extracts in `.recon/asar-extract/`.

## Part 1 — Personalization

Package: `packages/client/ui-personalization` (Tier 1, fork-owned).

Theme hooks found for the new choices:

| Choice | Token / selector |
|---|---|
| Code font | `--ds-font-family-code` (`:root`), composites on `body` resolve through it |
| Line spacing | `--dsw-font-markdown-base*` composites and `*-line-height` on `body` |
| Accent everywhere | `--dsw-alias-link`, `--dsw-specific-bubble`, `--dsw-specific-bubble-highlight`, `--dsw-specific-sidebar-nav-item-active-accent` |
| Conversation width | `[data-conversation-content]` declares `--dsh-chat-content-width`; drag handles are `[data-width-handle]` and write `--dsh-chat-user-width` inline on its parent |
| Settings panel width | `[data-shortcut-modal="settings"]` is the 800px settings panel (`ui-settings-general` SettingsRoot) |
| Scrollbars | `--dsh-scrollbar-width` (re-bound per surface) |
| Glass blur | `--dsw-menu-backdrop-filter` (`blur(40px) saturate(150%)` on body) |
| Shadows | `--dsw-shadow-lv1..3`, `--dsw-elevation-{panel,prominent,soft}` (declared on `body, body *`) |

## Part 2 — Browser tool in the sidebar browser

### Facts that shape the design

- The model's `browser` tool is `packages/web/web-browser` (Tier 1): Playwright Chromium, one page per session key.
- The sidebar Browser (`ui-sidebar-browser`, asar copy) creates `<webview src="about:blank#<lease>" partition=…>`
  only when its tab body mounts. Main (`DesktopBrowserGuests.bind`) approves a webview only with a lease from
  `dshDesktop.browser.acquire(workspace)`, forces `sandbox`, `contextIsolation`, `disableDialogs`, denies
  permissions/downloads/popups (popups arrive as `browserOpenRequested` to the owning lease).
- `dshDesktop.browser` (acquire/release/onOpenRequested) is exposed to every main-frame renderer script, so a
  fork client plugin can own its own guest without an asar change.
- `sidebarRight.openTab*` always expands the column (`openContent` plans `setExpanded(true)`), so the AI tab is
  opened when the operator expands the sidebar, not when the AI starts browsing.
- Host→client requests: `@Remote({ mode: 'stream' })` (as `account.watch`, `user-questions.attachWait`) plus a
  unary `@Remote` reply; the client consumes it with `ctx.remote.$stream({ name, open, ended })`.


## Part 1 — what changed (personalization)

Files (all Tier 1, `packages/client/ui-personalization`):

- `src/options.ts` (new): the shared vocabulary — field types, `APPEARANCE_DEFAULTS`, `APPEARANCE_FIELDS`,
  `APPEARANCE_RANGES`, and the enum lists (`CONTENT_WIDTHS`, `SETTINGS_WIDTHS`, `SCROLLBAR_STYLES`,
  `SHADOW_STRENGTHS`, `BACKDROPS`). Plain values only so the Host schema and the browser bundle share it.
  Added to `tsconfig.host.json` `files`.
- `src/index.ts`: `Config` grew from 7 to 18 volatile fields: `codeFontFamily`, `lineHeight`, `accentEverywhere`,
  `contentWidth`, `settingsWidth`, `scrollbars`, `glassBlur`, `backdrop`, `backdropImage`, `shadows`, `reduceMotion`.
- `src/client/appearance.ts`: engine emits the new overrides (see table above); `usableImageUrl` guards the
  backdrop `url("…")`; a translucent settings dialog now blurs by `glassBlur`.
- `src/client/appearance-store.ts`: the policy is now ONE `SnapshotStore<AppearanceValues>` (was one store per
  field) plus a `saveState` store. `set(field, value)` is generic; per-field write generations so only the latest
  write settles a field; a refused write marks the field in `saveState.refused` (the section shows a notice).
  Choosing a backdrop while shell and surface are both 100% lowers both to 80%.
- `src/client/AppearanceSection.tsx` + `.module.css`: five titled groups (Typography, Colour, Layout,
  Transparency, Effects); presets for fonts (8), code fonts (5), size, line spacing, 14 accent swatches + colour
  picker, corner scale, opacity, blur; backdrop tiles with gradient previews; image-address field with validation.
- `src/client/locales.ts`: zh/en copy for every new control.
- Tests: `appearance.client.spec.ts` (+11 engine cases), `appearance-store.client.spec.ts` (ported to the new
  API, +5 cases), `appearance-section.client.spec.tsx` (rewritten: drives every control), host specs extended.
- README rewritten (field table, companion reason); `package.json` description; regenerated
  `packages/preset/.../packages.md` with `pnpm run gen-plugin-packages`.

Verified live in an isolated Desktop copy (see "Test instance"): the section renders all groups, "Wider" settings
width gives a 1232px panel (window-capped), Aurora backdrop paints behind the translucent shell, writes persist to
the profile's `cordis.patch.yml`.

## Part 2 — what changed (browser tool → sidebar)

### New package `packages/web/web-browser-sidebar` (`@deepseek-ai/dsh-web-browser-sidebar`, Tier 1, dual face)

- Host `src/index.ts`: `AgentBrowser extends TypertRemoteService` registered as `ctx.agentBrowser`.
  `run(call, signal)` → newest subscribed window; `available()`; `@Remote({mode:'stream'}) commands(signal)`
  (first item is a `hello`); `@Remote respond(reply)`. Window disconnect fails held ops
  (`AgentBrowserUnavailableError`); silent window fails after `timeoutMs + replyGraceMs` (config, default 5000).
- `src/types.ts`: `AgentBrowserRequest` / `AgentBrowserReply` / `AgentBrowserOp` (Typert reads them).
- Client `src/client/index.ts`: mounts the generated Remote; only when `dshDesktop.browser` exists, waits on
  `ctx.inject(['remote.agentBrowser'])` (accessing `ctx.remote.agentBrowser` without that inject throws
  "cannot get property remote.agentBrowser without inject" — found live), registers the `agent-browser` tab kind
  (`keepMounted`), body + title, runs the command loop, and the reveal rule (navigate while expanded → `openTab`;
  400 ms poll opens the tab when the operator expands a sidebar with unseen agent activity).
- `src/client/pages.ts`: `AgentPages` — one `<webview>` per agent Session (`pageId`), created through
  `dshDesktop.browser.acquire(workspace)` with the same `cwd:`/`session:` storage key as the sidebar Browser;
  ops performed in order per page; webviews live in a `display: contents` layer on `document.body` (moving a
  webview reloads it); parked at `viewportWidth×viewportHeight`, opacity 0, inert; while the tab is visible the
  page is laid over the tab viewport every animation frame with `stackingOrder()` (outermost z-index of a
  positioned OR flex/grid-item ancestor + 1 — the sidebar `tabCell` is a static flex item with `z-index: 10`,
  which first hid the page; found live with `elementsFromPoint`).
- `src/client/keys.ts`: `Enter`/`ArrowDown`/`Control+A` → Electron `sendInputEvent` keyDown/char/keyUp.
- `src/client/AgentBrowserBody.tsx`: toolbar (back/forward/reload/address/open externally), status line
  ("The agent is clicking…"), viewport; chip title "AI Browser · <title>".
- Tests: `service.host.spec.ts`, `pages.client.spec.ts` (fake webview), `keys.client.spec.ts`,
  `body.client.spec.tsx`.
- Typert artifacts: generated with `.recon/_typert_one.ts` (WorkspaceTypertGenerator for this package only);
  the root `pnpm run build` regenerates them normally.

### `packages/web/web-browser` changes

- `src/driver.ts` (new) `BrowserDriver` + `BrowserPageTarget {pageId, displaySessionId, signal}`.
- `src/browser.ts`: `BrowserManager implements BrowserDriver` (target-keyed); fetch provider unchanged (headless).
- `src/sidebar-driver.ts` (new): actions composed from window ops (click = scrollIntoView + centre point + real
  mouse events; type = focus/select + `insertText`; scroll = nearest scrollable under viewport centre; screenshot
  = `capturePage`).
- `src/index.ts`: config `driver: auto|sidebar|headless` (default auto), `viewportWidth` 1280, `viewportHeight` 800;
  per-call driver resolution; subagent pages shown in the root conversation (walk `header.parentSession` while
  `origin === 'subagent'`). Prompt: "drives a real browser" + one paragraph that the desktop user sees the page
  live and can sign in for the agent. Tool description: "Drive a real browser by text…".
- Tests: `tool.spec.ts` ported; `sidebar-driver.spec.ts` new (driver ops + driver selection + subagent display).

### Wiring

- `packages/bundle/efai-base/cordis.patch.yml`: new row `web-browser-sidebar` before `web-browser`;
  `package.json` dependency; README sentence.
- Root `tsconfig.host.json` / `tsconfig.client.json` aggregates; `tsconfig.base.json` via `pnpm run gen-tsconfig-paths`;
  `pnpm install --offline` (lockfile); `node local-overlay/rebuild.mjs` (tsconfig.patch refreshed; seam frozen at 49).
- Regenerated: `docs/config-catalog*.md`, `docs/tool-catalog.md`, `packages.md`.

## Test instance (how live verification was done without touching the operator's app)

- The operator's Desktop holds the Electron single-instance lock (userData `%APPDATA%\@deepseek-ai\dsh-desktop`,
  from the asar `package.json` name; `--user-data-dir` is NOT honoured).
- Copy: `robocopy D:\Deepseek-Desktop D:\tmp\DeepseekTest /E /XF app.asar.orig* app.asar.broken*`, then a
  same-length in-place rename of the asar `package.json` name to `@deepseek-ai/dsh-desktoq`
  (`.recon/_asar_rename.cjs`; asar integrity fuse is off). Profile `browsertest` = copy of `harness` without
  sessions. Launch with `DSH_DESKTOP_PROFILE=browsertest` and `--remote-debugging-port=9333`.
- **The kernel env carries `ELECTRON_RUN_AS_NODE=1`**; it must be removed or the exe runs as Node and exits.
- CDP helpers: `.recon/_cdp.mjs` (eval/shot/key/click/type/front/reload), `.recon/_cdp_guest.mjs` (guest target).
- A client bundle change needs a test-instance restart (plugin URLs carry a boot-time `rev`).

Measured end to end with the real model (Claude Opus 5.5 route):
1. "navigate to example.com" with the sidebar collapsed → page carried by a webview; expanding the sidebar opened
   the "AI Browser · Example Domain" tab automatically.
2. With the sidebar open on the Start tab: navigate + type + press Enter on html.duckduckgo.com → the AI tab was
   selected on navigate and showed the live results page; `elementFromPoint` over the viewport = the webview.
3. Sidebar collapsed: click first result + screenshot (parked page, 1280×800) → the model described the
   3-column Electron docs page; expanding the sidebar showed that same page.

Side effect: the test session "Read example.com page heading" was written to the shared `~/.dsh/sessions`, so it
appears in the operator's session list too.

## For the operator

Restart the Desktop app once: the Host loads the new `web-browser-sidebar` row, the new `web-browser` code, and the
wider personalization schema (until then new personalization fields apply to the window only and the section
says they are not saved).

## Gates run

`vitest` on the three packages + efai-base (108 tests pass), `tsc -b` per package, oxlint (one pre-existing
finding in personalization `client/index.ts:60`), `verify-client-packages`, `verify-client-ui-i18n`,
`verify-package-readme-*`, `verify-plugin-packages`, `verify-export-jsdoc` (one pre-existing: `browserTool`
return annotation), `verify-package-invariants` (pre-existing `web-browser` invariant findings remain),
`local-overlay/rebuild.mjs --check` current.


## Part 3 — harness-dev-tools plugin (the tools that would have made this job easier)

Request: "add those tools that you want to a new plugin", "wire it to the python kernel too and also make sure the
tool help has a description of the tool", "dont make the tool name too vague".

### New package `packages/devtools/harness-dev-tools` (`@deepseek-ai/dsh-harness-dev-tools`, Tier 1, Host only)

- `desktop_test_instance` (`src/desktop-instance.ts`, `src/app-copy.ts`, `src/cdp.ts`): actions launch, stop,
  status, prepare, targets, eval, wait, screenshot, click, type, key, reload, log; `target` = "" (app window),
  "webview", or address/title text. Automates exactly what Part 2 did by hand: copies the installed app to
  `<dsh home>/desktop-test-instance/app` in a `process.noAsar` child (the Host runs as the Desktop exe with asar
  support, where `app.asar` reads as a directory; the archive stat goes through `original-fs`), renames the asar
  manifest name in place at the same length (last char → `x`), clones the Desktop's start profile (DSH_DESKTOP_PROFILE
  → profile-hub launcher → `desktop`) to `desktop-test-instance` without sessions/storages/node_modules, strips
  `ELECTRON_RUN_AS_NODE`, launches with `--remote-debugging-port=9333`, waits for a debuggable page. Screenshots are
  saved and attached as images when the route accepts images.
- `build_workspace_package` (`src/build-package.ts`): one package by dir, full name, or short name; steps
  typecheck → typert → bundle. Typert packages with `tsconfig.host.json` type the Host face first, generate,
  then type the whole package. Bundle = own `tsdown.config.ts` or a generated root-Host-pass config.
- Config: desktopDir, desktopExecutable (default: the Desktop this Host runs inside), stateDir, sourceProfile,
  testProfile, port, launchTimeoutMs, commandTimeoutMs, maxOutputChars, repoRoot, stepOutputChars.
- Tests (33): cdp, app-copy (synthetic asar), desktop-instance (prepare/clone/locate), tools (dispatch, missing-arg
  messages), build-package (stand-in toolchain records call order), kernel-seam (REAL ToolRegistry + plugin →
  `dispatchSeam` `tools.schemas` lists both with descriptions; `tools.call` runs build_workspace_package).
- Wiring: `efai-base` row `harness-dev-tools` + dependency + README; root `tsconfig.host.json`; group README
  `packages/devtools/README.md`; `gen-tsconfig-paths`, `gen-plugin-packages`, `gen-config-catalog`,
  `gen-tool-catalog`; overlay rebuilt (current, seam 49).

Real end-to-end (built lib run as the Desktop exe in Node mode, like the Host): launch 23 s (copy + clone + start),
wait for the sidebar toggle, eval `document.title` → "DeepSeek Harness", click (140,113) → "span New Session",
screenshot saved, status running with 1 target, stop. The same plugin code also built web-browser-sidebar,
web-browser and itself (`.recon/_build_one.ts`).

### Python kernel (`python/kiln/runtime/kernel_child.py`, fork-owned)

Harness tools already reach the kernel as `tools.<name>` and generated functions; what was missing was the
description in `tool_help()`. Now:
- `_harness_tool_summaries()` returns name → first sentence; `_harness_tool_names()` derives from it.
- `tool_help()` lists `tools.<name> -- <first sentence>`, and `tool_help(pattern=...)` also matches summaries.
- A generated function's first docstring line is "Run the `<name>` harness tool: <first sentence>".
- `_tool_summary()` sits in the generator block so the offline test extracts it; `test_harness_tools.py` +5 checks
  (43 pass), `test_harness_introspection.py` 232 pass.
- Tool descriptions were shortened so the first sentence fits the 140-char line:
  `tools.desktop_test_instance -- Start, drive, and stop a separate test copy of the installed DeepSeek Harness Desktop app.`
  `tools.build_workspace_package -- Build ONE package of the DeepSeek Harness workspace without running the whole root build.`

The running kernel/Host load all of this only after the Desktop app restarts.
