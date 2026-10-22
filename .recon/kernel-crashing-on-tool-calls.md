# Kernel crashing on every tool call (2026-10-21)

## Symptom

The `kernel` tool failed on every call, including cells that could not fail on
their own:

```
ERROR: Kernel crashed mid-run; restarted. State lost. Variables in the namespace
are gone; anything you saved with remember() survived — recall() lists what is still there.
```

`tool_help()` and a bare `print("alive")` both took this path, so the fault was in
starting the kernel child, not in the cell.

A second, separate failure appeared in the same session: every `pwsh` call failed
with `SetNamedSecurityInfoW failed (Win32 5): grantWrite(D:\deepseek-kernel-harness)`.
That was the workspace-grant step of the file sandbox, not the kernel; it stopped
once the session moved to `danger-full-access`. It is unrelated to the kernel bug
below and is recorded only so the two are not confused later.

## Root cause

The Kiln Python runtime ships inside `app.asar`. Electron's patched `fs` lists
those files, but the kernel child is a **spawned interpreter**, which is an
ordinary process with no asar support:

```
py.exe: can't open file '...\app.asar\dsh\node_modules\@deepseek-ai\dsh-kernel-python\kiln\kernel_child.py':
[Errno 2] No such file or directory        (exit 2)
```

The child dies before its `ready` frame, `KernelChild` resolves its waiter with
`{ dead: true }`, and `KilnKernelProvider` reports `crashed` for the cell. Every
cell repeats it because the provider restarts the child per cell.

Why the guard did not catch it: `apply()` tested `existsSync(script)`, and inside
Electron that answers `true` for an archive-internal path. The check was correct
for a plain Node process and meaningless for the process that actually has to read
the file.

Facts confirmed on this machine:

| Fact | Evidence |
| --- | --- |
| Kiln runtime is inside the archive and not unpacked | asar index: `dsh/node_modules/@deepseek-ai/dsh-kernel-python/kiln/kernel_child.py`, `size 204782`, `unpacked` unset |
| A real interpreter cannot open it | `py -u <asar path>` → `[Errno 2]`, exit 2 |
| The runtime is healthy elsewhere | protocol probe against `python/kiln/runtime`: `{"ready": true, "engine": "exec"}`, cells execute, clean exit 0 |
| Packaging never unpacked it | `apps/desktop/scripts/electron-builder-config.mjs` `unpack` covers `*.node/dylib/dll/so/exe`, ripgrep, libreoffice only |
| The row set no runtime path | `packages/bundle/efai-base/cordis.patch.yml` `kernel-python` sets only `cwd` |

## Fix

### Immediate (running install)

`~/.dsh/profiles/general/cordis.patch.yml` now points the row at the checkout's
provisioned runtime, which also carries the `.venv` the packaged copy has none of:

```yaml
- id: kernel-python
  name: "@deepseek-ai/dsh-kernel-python"
  config:
    cwd: !!js process.env.DSH_KERNEL_CWD
    runtimeDir: D:/deepseek-kernel-harness/python/kiln/runtime
    python: D:/deepseek-kernel-harness/python/kiln/runtime/.venv/Scripts/python.exe
```

A patch replaces a row's whole `config` (it is not deep-merged), which is why `cwd`
is restated. Backup: `cordis.patch.yml.bak-kernel-fix`.

`packages/boot/hmr` watches the profile patch, so this applied live — the reload
landed a couple of minutes after the write, which is why the first kernel call
after the edit still crashed.

### Durable (source, fork-owned package)

`packages/kernel/kernel-python/src/index.ts` — Tier 1, no seam registration needed:

- `outsideAsar(path)` maps an archive-internal path to its `.unpacked` sibling.
- `defaultRuntimeDir()` prefers that sibling and never returns an archive path,
  falling through to the checkout runtime instead.
- `apply()` refuses an archive-internal runtime **before** the `existsSync` that
  used to pass, with an actionable `KERNEL_START_FAILED` naming `runtimeDir`.
  This converts the permanent silent crash loop into one load-time error.
- `bundledVenvPython(runtimeDir)` / `resolvePython(configured, runtimeDir)` inspect
  the configured runtime's `.venv`. Previously a configured `runtimeDir` was
  silently paired with a system interpreter that lacks `curl_cffi`/`playwright`,
  because the venv probe always read the default directory.

Regression test: `packages/kernel/kernel-python/tests/runtime-dir.spec.ts`
(archive mapping, unpacked-sibling not mistaken for an archive,
`defaultRuntimeDir()` never names an archive, `apply()` refuses an archive
runtime).

## Verification

- `pnpm exec vitest run packages/kernel/kernel-python/tests/runtime-dir.spec.ts` → 5 passed.
- `build_workspace_package packages/kernel/kernel-python` typecheck → ok.
- Scoped `tsc` over the package `src` + the new test → no errors in those files
  (the ad-hoc program surfaces pre-existing `vendor/` errors only).
- `node local-overlay/verify-seam-frozen.mjs` → `seam is frozen at 71 upstream file(s); 71 in the tree`.
- Live kernel, after the profile reload:
  - `print("alive")` → `alive`
  - `tool_help()` → 13 072-char helper listing
  - `sys.executable` → `D:\deepseek-kernel-harness\python\kiln\runtime\.venv\Scripts\python.exe`, Python 3.12.13
  - `os.getcwd()` → `D:\deepseek-kernel-harness`
  - namespace persistence across cells (`h`, then `len(h)`) → still 13 072
- Spawn watcher (40 ms poll) during a kernel call recorded exactly the intended
  launch:
  `...\.venv\Scripts\python.exe -u D:\deepseek-kernel-harness\python\kiln\runtime\kernel_child.py`

## Follow-ups

1. **Packaging.** The installed Desktop still ships an unreadable runtime by
   default. Unpacking it (`apps/desktop/scripts/electron-builder-config.mjs`
   `unpack`, adding `**/node_modules/@deepseek-ai/dsh-kernel-python/kiln/**/*`)
   would let the new `defaultRuntimeDir()` find it — but the packed copy carries
   no `.venv`, so it would still want a system interpreter without the runtime's
   dependencies. That file is a Tier-2 seam path (not currently in `SEAM.json`),
   so the change is a deliberate seam-growth decision, not a drive-by edit.
2. **The profile override is now the real configuration.** It points at the
   provisioned checkout runtime, which is strictly better than the packaged copy
   (dependencies present). Keep it after a rebuild unless the packaging story
   above changes.
3. **Pre-existing overlay drift, unrelated to this job.** `node local-overlay/rebuild.mjs --check`
   reports `DRIFT docs.patch (9 file(s))` and `DRIFT INVENTORY.md`: 24 `docs/`
   paths differ from the recorded base while `docs.patch` claims 9. Do **not**
   run `rebuild.mjs` to "fix" it — that would rewrite the fork's doc patch. It
   needs its own investigation.
4. `packages/llm/llm-kiln` has the same resolver shape (`bundledVenvPython` over
   `defaultBridgeDir()`), but resolves only the checkout path, so the asar case
   cannot arise there. Worth remembering if the bridge is ever packaged.
