@echo off
setlocal EnableExtensions

rem The directory the launcher was invoked from, captured before we cd into the
rem repo. The kernel starts here by default so the agent works on your project,
rem not the harness source tree.
set "LAUNCH_DIR=%CD%"

rem Start the DeepSeek Harness web UI with the kernel roster.
rem
rem Usage:
rem   start.cmd              start the web UI on the default port
rem   start.cmd --port 3100  pass any dsh flag straight through
rem   start.cmd --build      force a rebuild before starting
rem
rem The first run needs `pnpm install` and a build; both are done here when the
rem build output is missing, so a fresh checkout starts with one command.

cd /d "%~dp0"

rem ── Version banner ──────────────────────────────────────────────────────
rem Show which commit this launcher is about to run (full + short hash) so the
rem operator can confirm the checkout matches the running build. The script has
rem already cd'd to the repo root above, so plain `git rev-parse` (no -C flag,
rem whose trailing-backslash path trips cmd's quote rules) reads THIS checkout.
rem Best-effort: a missing git binary or a vendored install with no .git prints
rem `unknown` and never blocks startup.
set "DSH_GIT_COMMIT=unknown"
set "DSH_GIT_SHORT=unknown"
git rev-parse HEAD >nul 2>&1
if not errorlevel 1 (
  for /f "delims=" %%V in ('git rev-parse HEAD') do set "DSH_GIT_COMMIT=%%V"
  for /f "delims=" %%V in ('git rev-parse --short HEAD') do set "DSH_GIT_SHORT=%%V"
)
echo [start] version: %DSH_GIT_COMMIT% ^(short: %DSH_GIT_SHORT%^)

set "FORCE_BUILD="
set "DSH_ARGS="
:parse
if "%~1"=="" goto parsed
if /i "%~1"=="--build" (
  set "FORCE_BUILD=1"
) else (
  set "DSH_ARGS=%DSH_ARGS% %1"
)
shift
goto parse
:parsed

rem The working directory the kernel should start in. Defaults to wherever you
rem launched this script from; set DSH_KERNEL_CWD in the shell to override.
if not defined DSH_KERNEL_CWD set "DSH_KERNEL_CWD=%LAUNCH_DIR%"

where pnpm >nul 2>&1
if errorlevel 1 (
  echo [start] pnpm was not found on PATH. Install it with: npm install -g pnpm
  exit /b 1
)

rem ── Bundled Python via uv ───────────────────────────────────────────────
rem The kernel and the DeepSeek ds_direct bridge run on a SELF-CONTAINED CPython
rem that uv provisions from python\kiln\runtime\pyproject.toml, so a fresh
rem machine needs no system Python and no manual pip installs. Best-effort at
rem every step: if uv or the network is unavailable, this falls through to a
rem system-Python probe, and the harness still starts (the kernel row just
rem reports an unavailable provider with a message naming the problem).
set "RUNTIME_DIR=%~dp0python\kiln\runtime"
set "VENV_PY=%RUNTIME_DIR%\.venv\Scripts\python.exe"

where uv >nul 2>&1
if errorlevel 1 (
  echo [start] uv not found - installing it once...
  powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://astral.sh/uv/install.ps1 | iex" >nul 2>&1
  rem The installer drops uv in %USERPROFILE%\.local\bin; add it for this session.
  set "PATH=%USERPROFILE%\.local\bin;%PATH%"
)

where uv >nul 2>&1
if not errorlevel 1 (
  echo [start] Provisioning the bundled Python runtime ^(uv sync^)...
  pushd "%RUNTIME_DIR%"
  call uv sync
  if errorlevel 1 (
    echo [start] WARNING: uv sync failed; falling back to a system Python.
  ) else (
    rem The browser toolset needs Chromium. Best-effort so a download hiccup
    rem never blocks startup - the browser tool reports if it is missing.
    call uv run python -m playwright install chromium >nul 2>&1
  )
  popd
)

rem The bundled interpreter, when provisioned, is authoritative: export it so
rem BOTH backend rows (kernel-python and llm-kiln) use the exact same Python.
if exist "%VENV_PY%" (
  set "DSH_KERNEL_PYTHON=%VENV_PY%"
  echo [start] Using bundled Python: %VENV_PY%
  rem ── Dependency verification with the bundled interpreter ─────────────
  rem uv sync normally provisions everything; this is a cheap idempotent
  rem safety net: check the pinned requirements with the SAME interpreter
  rem (a small helper does the distribution-to-module name mapping), then
  rem reinstall only what is actually missing. Never fails startup.
  set "REQ_FILE=%RUNTIME_DIR%\requirements.txt"
  set "CHECK_DEPS=%RUNTIME_DIR%\_check_deps.py"
  if exist "%REQ_FILE%" if exist "%CHECK_DEPS%" (
    "%VENV_PY%" "%CHECK_DEPS%" "%REQ_FILE%" >nul 2>&1
    if errorlevel 1 (
      echo [start] Installing missing runtime dependencies with the bundled Python...
      "%VENV_PY%" -m pip install --disable-pip-version-check -r "%REQ_FILE%" >nul 2>&1
      if errorlevel 1 (
        echo [start] WARNING: pip install failed; the kernel will still start and disabled features will report themselves.
      )
    )
  )
  goto py_done
)

rem ── System Python fallback (probe) ──
rem A name on PATH is not enough - the Windows Store shim answers with an
rem advertisement - so each candidate is executed and only a clean exit counts.
set "KERNEL_PY="
for %%P in (py python python3) do (
  if not defined KERNEL_PY (
    %%P -c "print('ok')" >nul 2>&1
    if not errorlevel 1 set "KERNEL_PY=%%P"
  )
)
if not defined KERNEL_PY (
  echo [start] WARNING: no working Python interpreter found.
  echo [start]          The kernel tool and the Kiln providers will be unavailable.
  echo [start]          Install uv ^(https://astral.sh/uv^) or Python 3, or set DSH_KERNEL_PYTHON.
)
if defined KERNEL_PY set "DSH_KERNEL_PYTHON=%KERNEL_PY%"

:py_done

rem ── First-run onboarding: DeepSeek credentials ──────────────────────────
rem The DeepSeek connector needs a token (or an email/mobile + password) in
rem ds_config.json, or the DEEPSEEK_* environment variables. A fresh clone has
rem none, so point the way and keep going - the web UI's own setup dialog
rem finishes onboarding in-app.
set "DS_CONFIG=%RUNTIME_DIR%\ds_config.json"
if defined KILN_DS_CONFIG set "DS_CONFIG=%KILN_DS_CONFIG%"
if exist "%DS_CONFIG%" goto onboarded
if defined DEEPSEEK_TOKEN goto onboarded
if defined DEEPSEEK_EMAIL goto onboarded
if defined DEEPSEEK_MOBILE goto onboarded
echo.
echo [setup] First run: no DeepSeek account is configured yet.
echo [setup]   1^) Sign in at https://chat.deepseek.com
echo [setup]   2^) Finish setup in the app's DeepSeek dialog when it opens,
echo [setup]      or create python\kiln\runtime\ds_config.json by hand.
echo [setup]   Guide: python\kiln\runtime\README.ds-direct.md
echo.
:onboarded

if not exist "node_modules" (
  echo [start] Installing dependencies...
  call pnpm install || exit /b 1
)

if defined FORCE_BUILD goto build
if not exist "apps\cli\lib\bin.js" goto build
goto run

:build
echo [start] Building...
call pnpm run build || exit /b 1

:run
rem Prefer the built CLI when it exists: source mode (`pnpm dsh web`) re-runs
rem the whole TypeScript tree through tsx on every cold start, which costs
rem ~10x the startup time of the built entry.
if not exist "apps\cli\lib\bin.js" goto source
echo [start] Starting the harness web UI (built binary)...
node apps\cli\lib\bin.js web%DSH_ARGS%
exit /b %errorlevel%

:source
echo [start] Starting the harness web UI (source mode)...
call pnpm dsh web%DSH_ARGS%
exit /b %errorlevel%
