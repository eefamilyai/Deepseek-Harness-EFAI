# Install (or update) DeepSeek Harness EFAI so `dsh` runs from any directory.
#
#   irm https://raw.githubusercontent.com/eefamilyai/Deepseek-Harness-EFAI/master/install.ps1 | iex
#
# Re-running this is how you update: it fast-forwards the checkout, reinstalls
# dependencies, and rebuilds. `dsh-update` is a shortcut for exactly that.
#
# What it touches:
#   %USERPROFILE%\.deepseek-harness   the source checkout (override: DSH_INSTALL_DIR)
#   %LOCALAPPDATA%\dsh\bin            the launchers on PATH (override: DSH_BIN_DIR)
#
# $DSH_HOME (~/.dsh) is the harness's own data home — settings, profiles,
# presets — and is deliberately NOT touched here, so reinstalling never
# disturbs your configuration.
$ErrorActionPreference = 'Stop'

$RepoUrl    = if ($env:DSH_REPO_URL)     { $env:DSH_REPO_URL }     else { 'https://github.com/eefamilyai/Deepseek-Harness-EFAI.git' }
$Branch     = if ($env:DSH_BRANCH)       { $env:DSH_BRANCH }       else { 'master' }
$SrcDir     = if ($env:DSH_INSTALL_DIR)  { $env:DSH_INSTALL_DIR }  else { Join-Path $env:USERPROFILE '.deepseek-harness' }
$BinDir     = if ($env:DSH_BIN_DIR)      { $env:DSH_BIN_DIR }      else { Join-Path $env:LOCALAPPDATA 'dsh\bin' }

function Say  { param($m) Write-Host "[dsh-install] $m" }
function Die  { param($m) Write-Error "[dsh-install] ERROR: $m"; exit 1 }
function Have { param($c) [bool](Get-Command $c -ErrorAction SilentlyContinue) }

# ── Prerequisites ────────────────────────────────────────────────────────
if (-not (Have git))  { Die 'git is required. Install it, then re-run this.' }
if (-not (Have node)) { Die 'Node.js is required (^22.19 or >=24). See https://nodejs.org' }

# The workspace declares node ^22.19 || >=24; an older runtime fails deep in
# the build with an unhelpful error, so check it here where the message helps.
$nodeCheck = @'
const [maj, min] = process.versions.node.split('.').map(Number)
const ok = maj >= 24 || (maj === 22 && min >= 19)
if (!ok) { console.error(`Node ${process.versions.node} is too old; this needs ^22.19 or >=24.`); process.exit(1) }
'@
node -e $nodeCheck
if ($LASTEXITCODE -ne 0) { Die 'Node version unsupported.' }

if (-not (Have pnpm)) {
  Say 'pnpm not found - enabling it through corepack...'
  cmd /c 'corepack enable' 2>$null | Out-Null
  cmd /c 'corepack prepare pnpm@latest --activate' 2>$null | Out-Null
}
if (-not (Have pnpm)) { Die 'pnpm is required. Install it with: npm install -g pnpm' }

# ── Fetch or update the checkout ─────────────────────────────────────────
if (Test-Path (Join-Path $SrcDir '.git')) {
  Say "Updating $SrcDir ..."
  git -C $SrcDir remote set-url origin $RepoUrl
  git -C $SrcDir fetch --quiet origin $Branch
  git -C $SrcDir diff --quiet
  $dirty = $LASTEXITCODE -ne 0
  git -C $SrcDir diff --cached --quiet
  if ($dirty -or $LASTEXITCODE -ne 0) {
    Die "$SrcDir has uncommitted changes. Commit, stash, or remove them, then re-run."
  }
  git -C $SrcDir checkout --quiet -B $Branch "origin/$Branch"
} elseif (Test-Path $SrcDir) {
  Die "$SrcDir exists but is not a git checkout. Move it aside, then re-run."
} else {
  Say "Cloning $RepoUrl into $SrcDir ..."
  git clone --quiet --branch $Branch $RepoUrl $SrcDir
}

Say "Installed revision: $(git -C $SrcDir rev-parse --short HEAD)"

# ── Build ────────────────────────────────────────────────────────────────
Push-Location $SrcDir
try {
  Say 'Installing dependencies (this is the slow part on a fresh machine)...'
  pnpm install --frozen-lockfile
  if ($LASTEXITCODE -ne 0) { pnpm install }
  Say 'Building...'
  pnpm run build
  if ($LASTEXITCODE -ne 0) { Die 'the build failed.' }
} finally { Pop-Location }

if (-not (Test-Path (Join-Path $SrcDir 'apps\cli\lib\bin.js'))) {
  Die 'the build finished but apps\cli\lib\bin.js is missing.'
}

# ── Bundled Python, best effort ──────────────────────────────────────────
# The kernel tool and the Kiln providers want their own interpreter. start.cmd
# provisions this on every web-UI launch; doing it once here keeps the `dsh`
# launcher fast. A failure never fails the install - the affected tools report
# their own unavailability.
$RuntimeDir = Join-Path $SrcDir 'python\kiln\runtime'
if (Test-Path $RuntimeDir) {
  if (-not (Have uv)) {
    Say 'Installing uv for the bundled Python runtime...'
    try { irm https://astral.sh/uv/install.ps1 | iex } catch { Say 'WARNING: uv install failed.' }
  }
  if (Have uv) {
    Say 'Provisioning the bundled Python runtime...'
    Push-Location $RuntimeDir
    # -Frozen honors the committed uv.lock. Without it uv rewrites the lock,
    # which leaves this checkout dirty and makes the NEXT update refuse to run.
    try {
      uv sync --frozen 2>$null | Out-Null
      if ($LASTEXITCODE -ne 0) { uv sync 2>$null | Out-Null }
    } catch { Say 'WARNING: uv sync failed; the kernel falls back to a system Python.' }
    finally { Pop-Location }
    # Whatever the fallback did to tracked files, the install checkout has to
    # end clean or dsh-update stops working.
    git -C $SrcDir checkout --quiet -- python/kiln/runtime/uv.lock 2>$null
  }
}

# ── Launchers on PATH ────────────────────────────────────────────────────
New-Item -ItemType Directory -Force -Path $BinDir | Out-Null

$venvPy = Join-Path $SrcDir 'python\kiln\runtime\.venv\Scripts\python.exe'
@"
@echo off
REM Generated by install.ps1 - re-run the installer to regenerate.
REM The kernel starts in the directory you invoked dsh from, not the checkout.
if not defined DSH_KERNEL_CWD set "DSH_KERNEL_CWD=%CD%"
if not defined DSH_KERNEL_PYTHON if exist "$venvPy" set "DSH_KERNEL_PYTHON=$venvPy"
node "$SrcDir\apps\cli\lib\bin.js" %*
"@ | Set-Content -Encoding ASCII (Join-Path $BinDir 'dsh.cmd')

@"
@echo off
REM Generated by install.ps1 - pulls the latest and rebuilds.
powershell -NoProfile -ExecutionPolicy Bypass -File "$SrcDir\install.ps1" %*
"@ | Set-Content -Encoding ASCII (Join-Path $BinDir 'dsh-update.cmd')

Say "Installed: $BinDir\dsh.cmd and $BinDir\dsh-update.cmd"

$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if ($userPath -notlike "*$BinDir*") {
  Say "Adding $BinDir to your user PATH (open a new terminal to pick it up)."
  [Environment]::SetEnvironmentVariable('Path', "$BinDir;$userPath", 'User')
}

Say ''
Say 'Done. Try:  dsh web        (the browser UI)'
Say '            dsh --help     (everything else)'
Say '            dsh-update     (pull the latest and rebuild)'
