# @deepseek-ai/dsh-harness-dev-tools

## Summary

Two tools for changing the harness and seeing the result. `desktop_test_instance` starts a separate test copy of the installed Desktop app on its own profile and drives its window over the Chrome DevTools Protocol, so a GUI change is checked in a real Desktop window while the operator keeps working in theirs. `build_workspace_package` builds one workspace package the way the root build would, without building the whole workspace.

## `desktop_test_instance`

| Action | Effect |
|---|---|
| `launch` | Copy the app when stale, clone the profile when missing, start the copy with a debugging port, and wait until its window is debuggable. A running copy is stopped first, which is also how a rebuilt plugin bundle is loaded. `fresh: true` recopies and reclones. |
| `stop`, `status`, `log` | End the copy and every process it started; report whether it runs, its targets, and the end of its log (the window console is in it). |
| `prepare` | Copy and clone only. |
| `targets` | The window and every embedded webview. |
| `eval`, `wait` | Run JavaScript in a target and return its JSON value; poll an expression until it is truthy. |
| `screenshot` | Save a PNG and, when the calling route accepts images and an attachment store is mounted, attach it to the result. |
| `click`, `type`, `key`, `reload` | Real pointer clicks at CSS pixels, text insertion, key presses, and a cache-less reload. |

`target` selects what an action drives: empty for the app window, `webview` for the first embedded webview (the sidebar Browser and the AI Browser pages), or text a target's address or title contains.

How the copy stays separate from the operator's app:

- Electron allows one running instance per user-data directory and derives the directory from the `name` in `resources/app.asar`'s manifest; `--user-data-dir` does not change it. The copy's manifest name has its last character changed, in place at the same byte length, so every offset in the archive header stays valid.
- The Host runs as the Desktop executable in Node mode, where Electron's archive support presents `app.asar` as a directory. The copy runs in a child process with `process.noAsar` set, and the archive's own size and time are read through `original-fs`.
- The Host's environment carries `ELECTRON_RUN_AS_NODE`; the launch removes it, or the copy would start as Node and exit.
- The test profile is cloned from the profile the Desktop starts on (`DSH_DESKTOP_PROFILE`, then the `profile-hub.json` launcher) without `sessions`, `storages`, or `node_modules`.

The copy, `instance.json`, `desktop.log`, and screenshots live under `<dsh home>/desktop-test-instance`. The copy is refreshed when the installed `app.asar` changes size or modification time.

## `build_workspace_package`

The package is named by directory (`packages/web/web-browser`), full name (`@deepseek-ai/dsh-web-browser`), or short name (`web-browser`). The steps, in order:

1. `typecheck` — `tsc -b` over the package's `tsconfig.json`.
2. `typert` — the built Typert generator for this package alone, when it exports `./typert`, `./client/typert`, or `./remote`. A package with a `tsconfig.host.json` is typed Host face first, because the generator reads that emit, and as a whole after generation, because the Client face imports the generated Remote declarations.
3. `bundle` — the package's own `tsdown.config.ts` (Client packages have one), otherwise the root build's Host pass over the `lib/types/{index,invariant,startup}.js` entries that exist.

The first failing command stops the rest. Generated configs go under `<dsh home>/desktop-test-instance/build`.

## The Python kernel

Both are ordinary registered tools, so the kernel's `tools.*` seam lists them and the kernel installs `desktop_test_instance(...)` and `build_workspace_package(...)` functions. `tool_help()` lists every harness tool as `tools.<name> -- <first sentence of its description>`, and a generated function's first docstring line carries the same sentence.

## Composition

```yaml
- id: harness-dev-tools
  name: '@deepseek-ai/dsh-harness-dev-tools'
  config:
    port: 9333
    testProfile: desktop-test-instance
```

Every other field defaults to the Desktop app this Host runs inside; under plain Node set `desktopDir` and `desktopExecutable`. The row is in `@deepseek-ai/dsh-efai-base`.

## Layout

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Config, path resolution, and registration |
| [`src/tools.ts`](src/tools.ts) | The two tool definitions |
| [`src/desktop-instance.ts`](src/desktop-instance.ts) | Prepare, launch, drive, and stop the test copy |
| [`src/app-copy.ts`](src/app-copy.ts) | The copy child and the manifest rename |
| [`src/cdp.ts`](src/cdp.ts) | A minimal DevTools Protocol client |
| [`src/build-package.ts`](src/build-package.ts) | One-package build planning and execution |

No invariant companion is published: each tool call reads the instance record and the package manifest afresh, and holds no second observation that could diverge from them.

## Model Experience

### `desktop_test_instance` and `build_workspace_package`

#### What the model sees

Two tool schemas. `desktop_test_instance` takes an `action` and the `expression`, `target`, `x`, `y`, `text`, `key`, `timeoutMs`, `lines`, and `fresh` fields the actions need; `build_workspace_package` takes `package` and optional `steps`. Results are plain text — a launch summary, a JSON value, a step list with each failing command's output — and a screenshot result carries the image when the route accepts images.

#### Token effect

Both schemas are billed once per request as part of the tool list. A `desktop_test_instance` result is capped at `maxOutputChars` (default 20000); `build_workspace_package` keeps `stepOutputChars` (default 6000) of each step's output and omits a passing typecheck's output.

#### KV Cache effect

The descriptions are static, so they do not invalidate the cached prefix; results append as ordinary tool results.

## Known Limitations and Deferred Work

- The copy duplicates the installed app (about 1.7 GB for the Windows build) and is refreshed whenever the installed archive changes.
- Session history is shared between profiles, so a conversation run in the test instance appears in the operator's session list.
- Only one test instance runs per plugin config; a second Host on the same port refuses to launch.
- `build_workspace_package` does not rebuild the package's dependencies; a change to a dependency needs its own build first.

Fork-owned: `packages/devtools/harness-dev-tools` is Tier 1, so it touches no upstream file.
