#!/usr/bin/env bash
# Start the DeepSeek Harness web UI with the kernel roster (macOS/Linux).
#
# Mirror of start.cmd: provisions a SELF-CONTAINED CPython + the runtime
# dependencies via uv, so a fresh machine needs no system Python and no manual
# pip installs, then launches the built CLI. Every provisioning step is
# best-effort; if uv or the network is unavailable it falls back to a system
# Python and the harness still starts.
#
# Usage:
#   ./start.sh              start the web UI on the default port
#   ./start.sh --port 3100  pass any dsh flag straight through
#   ./start.sh --build      force a rebuild before starting
set -euo pipefail

# The directory the launcher was invoked from, captured before we cd into the
# repo, so the kernel starts on your project rather than the harness source.
LAUNCH_DIR="$PWD"

cd "$(dirname "$0")"

FORCE_BUILD=""
DSH_ARGS=()
for arg in "$@"; do
  if [ "$arg" = "--build" ]; then FORCE_BUILD=1; else DSH_ARGS+=("$arg"); fi
done

# The working directory the kernel should start in; defaults to wherever you
# launched this script from. Override with DSH_KERNEL_CWD in the shell.
: "${DSH_KERNEL_CWD:=$LAUNCH_DIR}"
export DSH_KERNEL_CWD

if ! command -v pnpm >/dev/null 2>&1; then
  echo "[start] pnpm was not found on PATH. Install it with: npm install -g pnpm"
  exit 1
fi

# ── Bundled Python via uv ────────────────────────────────────────────────
RUNTIME_DIR="$PWD/python/kiln/runtime"
VENV_PY="$RUNTIME_DIR/.venv/bin/python"

if ! command -v uv >/dev/null 2>&1; then
  echo "[start] uv not found - installing it once..."
  curl -LsSf https://astral.sh/uv/install.sh | sh >/dev/null 2>&1 || true
  # The installer drops uv in ~/.local/bin.
  export PATH="$HOME/.local/bin:$PATH"
fi

if command -v uv >/dev/null 2>&1; then
  echo "[start] Provisioning the bundled Python runtime (uv sync)..."
  if ( cd "$RUNTIME_DIR" && uv sync ); then
    # The browser toolset needs Chromium. Best-effort so a download hiccup
    # never blocks startup - the browser tool reports if it is missing.
    ( cd "$RUNTIME_DIR" && uv run python -m playwright install chromium ) >/dev/null 2>&1 || true
  else
    echo "[start] WARNING: uv sync failed; falling back to a system Python."
  fi
fi

# The bundled interpreter, when provisioned, is authoritative: export it so BOTH
# backend rows (kernel-python and llm-kiln) use the exact same Python.
if [ -x "$VENV_PY" ]; then
  export DSH_KERNEL_PYTHON="$VENV_PY"
  echo "[start] Using bundled Python: $VENV_PY"
  # Dependency verification with the bundled interpreter: uv sync normally
  # provisions everything; this is an idempotent safety net that checks the
  # pinned requirements with the SAME interpreter via a small helper that
  # handles the distribution-to-module name mapping. Never fails startup.
  REQ_FILE="$RUNTIME_DIR/requirements.txt"
  CHECK_DEPS="$RUNTIME_DIR/_check_deps.py"
  if [ -f "$REQ_FILE" ] && [ -f "$CHECK_DEPS" ]; then
    if ! "$VENV_PY" "$CHECK_DEPS" "$REQ_FILE" >/dev/null 2>&1; then
      echo "[start] Installing missing runtime dependencies with the bundled Python..."
      if ! "$VENV_PY" -m pip install --disable-pip-version-check -r "$REQ_FILE" >/dev/null 2>&1; then
        echo "[start] WARNING: pip install failed; the kernel will still start and disabled features will report themselves."
      fi
    fi
  fi
elif command -v python3 >/dev/null 2>&1; then
  export DSH_KERNEL_PYTHON="$(command -v python3)"
else
  echo "[start] WARNING: no working Python interpreter found."
  echo "[start]          The kernel tool and the Kiln providers will be unavailable."
  echo "[start]          Install uv (https://astral.sh/uv) or Python 3, or set DSH_KERNEL_PYTHON."
fi

# ── First-run onboarding: DeepSeek credentials ───────────────────────────
# The DeepSeek connector needs a token (or an email/mobile + password) in
# ds_config.json, or the DEEPSEEK_* environment variables. A fresh clone has
# none, so point the way and keep going - the web UI's own setup dialog
# finishes onboarding in-app.
DS_CONFIG="${KILN_DS_CONFIG:-$RUNTIME_DIR/ds_config.json}"
if [ ! -f "$DS_CONFIG" ] && [ -z "${DEEPSEEK_TOKEN:-}" ] && [ -z "${DEEPSEEK_EMAIL:-}" ] && [ -z "${DEEPSEEK_MOBILE:-}" ]; then
  echo ""
  echo "[setup] First run: no DeepSeek account is configured yet."
  echo "[setup]   1) Sign in at https://chat.deepseek.com"
  echo "[setup]   2) Finish setup in the app's DeepSeek dialog when it opens,"
  echo "[setup]      or create python/kiln/runtime/ds_config.json by hand."
  echo "[setup]   Guide: python/kiln/runtime/README.ds-direct.md"
  echo ""
fi

if [ ! -d node_modules ]; then
  echo "[start] Installing dependencies..."
  pnpm install
fi

if [ -n "$FORCE_BUILD" ] || [ ! -f apps/cli/lib/bin.js ]; then
  echo "[start] Building..."
  pnpm run build
fi

if [ -f apps/cli/lib/bin.js ]; then
  echo "[start] Starting the harness web UI (built binary)..."
  exec node apps/cli/lib/bin.js web ${DSH_ARGS[@]+"${DSH_ARGS[@]}"}
else
  echo "[start] Starting the harness web UI (source mode)..."
  exec pnpm dsh web ${DSH_ARGS[@]+"${DSH_ARGS[@]}"}
fi
