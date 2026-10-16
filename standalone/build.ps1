#requires -Version 5.1
<#
    Build a self-contained Windows distribution of DeepSeek Harness.

    Output
    ------
      standalone\dist\dsh\                 the distribution folder
        dsh.exe                            launcher (compiled with the C# compiler in Windows)
        runtime\node.exe                   bundled Node runtime
        app\...                            the CLI plus its production dependencies
      standalone\dist\dsh-standalone.zip   zipped distribution (unless -SkipZip)

    The target machine needs no Node, pnpm, or Python. Building does require the
    repository to be built first (`pnpm run build` at the repo root), because the
    distribution ships the compiled lib\ output rather than TypeScript sources.

    Parameters
    ----------
      -SkipDeploy   reuse an existing app\ tree instead of running pnpm deploy
      -SkipZip      do not produce the zip
      -WithKernel   also include the vendored Python runtime (adds ~160 MB) so the
                    ctx.kernel Python backend works offline
      -NodeExe      explicit node.exe to bundle (defaults to the one on PATH)
      -StandaloneVersion  distribution version stamped into manifest.json and
                    compared against release tags. Defaults to the harness
                    version, so an unversioned build still updates correctly.
#>
[CmdletBinding()]
param(
    [switch]$SkipDeploy,
    [switch]$SkipZip,
    [switch]$WithKernel,
    [string]$NodeExe,
    [string]$StandaloneVersion
)

$ErrorActionPreference = 'Stop'

# pnpm asks for confirmation before purging a target directory and cannot be
# answered without a TTY; CI=true makes it proceed instead of failing.
$env:CI = 'true'

$StandaloneDir = $PSScriptRoot
$RepoRoot      = Split-Path -Parent $StandaloneDir
$DistRoot      = Join-Path $StandaloneDir 'dist'
$DistDir       = Join-Path $DistRoot 'dsh'
$AppDir        = Join-Path $DistDir 'app'
$RuntimeDir    = Join-Path $DistDir 'runtime'
$CscPath       = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'

function Step  { param([string]$m) Write-Host "==> $m" -ForegroundColor Cyan }
function Note  { param([string]$m) Write-Host "    $m" }
function Warn2 { param([string]$m) Write-Host "!!  $m" -ForegroundColor Yellow }

function Assert-File { param([string]$Path, [string]$What)
    if (-not (Test-Path -LiteralPath $Path)) { throw "$What not found: $Path" }
}

function Get-DirSizeMB { param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return 0 }
    $sum = (Get-ChildItem -LiteralPath $Path -Recurse -File -Force -ErrorAction SilentlyContinue |
            Measure-Object -Property Length -Sum).Sum
    if ($null -eq $sum) { return 0 }
    return [math]::Round($sum / 1MB, 1)
}

function Get-DirFileCount { param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return 0 }
    return (Get-ChildItem -LiteralPath $Path -Recurse -File -Force -ErrorAction SilentlyContinue).Count
}

# ------------------------------------------------------------------ preflight
Step 'Preflight'

$CliBin = Join-Path $RepoRoot 'apps\cli\lib\bin.js'
Assert-File $CliBin 'Built CLI entry (run "pnpm run build" at the repo root first)'

if (-not $NodeExe) {
    $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
    if (-not $nodeCmd) { throw 'node not found on PATH; pass -NodeExe <path-to-node.exe>' }
    $NodeExe = $nodeCmd.Source
}
Assert-File $NodeExe 'Node executable'

if (-not (Test-Path -LiteralPath $CscPath)) {
    throw "C# compiler not found at $CscPath (needed to build the launcher)"
}

Note ("repo        : {0}" -f $RepoRoot)
Note ("node        : {0} ({1:N1} MB)" -f $NodeExe, ((Get-Item -LiteralPath $NodeExe).Length / 1MB))
Note ("csc         : {0}" -f $CscPath)

# ------------------------------------------------------------------ clean
Step 'Preparing output'
if (Test-Path -LiteralPath $DistDir) { Remove-Item -LiteralPath $DistDir -Recurse -Force }
New-Item -ItemType Directory -Force -Path $AppDir, $RuntimeDir | Out-Null

# ------------------------------------------------------------------ node
Step 'Bundling the Node runtime'
Copy-Item -LiteralPath $NodeExe -Destination (Join-Path $RuntimeDir 'node.exe') -Force
Note ("runtime\node.exe ({0:N1} MB)" -f ((Get-Item -LiteralPath (Join-Path $RuntimeDir 'node.exe')).Length / 1MB))

# ------------------------------------------------------------------ deploy
if (-not $SkipDeploy) {
    Step 'Deploying the CLI with its production dependencies'

    $deployed = $false
    Push-Location $RepoRoot
    try {
        # pnpm deploy materialises workspace dependencies as real directories,
        # which is exactly what a portable tree needs.
        # The hoisted linker writes real directories rather than the symlink
        # farm the default linker produces, so the tree survives being zipped
        # and extracted on a machine where creating symlinks is not permitted.
        $attempts = @(
            @('--filter', '@deepseek-ai/dsh', 'deploy', '--prod', '--legacy', '--config.node-linker=hoisted', $AppDir),
            @('--filter', '@deepseek-ai/dsh', 'deploy', '--prod', '--legacy', $AppDir)
        )
        foreach ($a in $attempts) {
            Write-Host ("    pnpm " + ($a -join ' '))
            & pnpm @a 2>&1 | ForEach-Object { Write-Host "      $_" }
            $modules = Join-Path $AppDir 'node_modules'
            if ((Test-Path -LiteralPath $modules) -and (Test-Path -LiteralPath (Join-Path $AppDir 'package.json'))) {
                $deployed = $true
                break
            }
            Warn2 'deploy produced no node_modules; retrying.'
            if (Test-Path -LiteralPath $AppDir) { Remove-Item -LiteralPath $AppDir -Recurse -Force }
            New-Item -ItemType Directory -Force -Path $AppDir | Out-Null
        }
    }
    catch { Warn2 "pnpm deploy failed: $($_.Exception.Message)" }
    finally { Pop-Location }

    if (-not $deployed) { throw 'pnpm deploy did not produce a usable app tree; cannot continue.' }

    Step 'Completing the tree (peer-dependency closure)'
    & node (Join-Path $StandaloneDir 'complete-tree.mjs') $RepoRoot $AppDir
    if ($LASTEXITCODE -ne 0) { throw "tree completion failed with exit code $LASTEXITCODE" }
}
else {
    Step 'Reusing the existing app tree (-SkipDeploy)'
}

# pnpm always materialises a virtual store at node_modules\.pnpm and links the
# top level into it. Those links do not survive extraction, and the store's
# "<id>\node_modules\<pkg>" layout pushes paths past the Windows MAX_PATH
# limit. Flattening turns the top level into real directories and deletes the
# store, so the shipped tree is portable and the archive extracts anywhere.
Step 'Flattening the dependency tree'
& node (Join-Path $StandaloneDir 'flatten-tree.mjs') $AppDir
if ($LASTEXITCODE -ne 0) { throw "tree flattening failed with exit code $LASTEXITCODE" }

# A symbolic link or junction cannot be extracted by a zip tool that lacks the
# privilege, so any survivor means the tree is not portable. Hard links are
# ordinary files that merely share storage on this volume; they extract as
# regular files and are fine, so they must not be counted here.
$reparse = (Get-ChildItem -LiteralPath (Join-Path $AppDir 'node_modules') -Recurse -Force -ErrorAction SilentlyContinue |
            Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }).Count
if ($reparse -gt 0) { throw "app tree still contains $reparse symbolic link(s)/junction(s); it is not portable." }
Note ("no symbolic links remain ({0:N0} hard-linked files are ordinary entries)" -f
      (Get-ChildItem -LiteralPath (Join-Path $AppDir 'node_modules') -Recurse -Force -ErrorAction SilentlyContinue |
       Where-Object { $_.LinkType -eq 'HardLink' }).Count)

# ------------------------------------------------------------------ kernel (optional)
if ($WithKernel) {
    Step 'Including the vendored Python runtime (ctx.kernel backend)'
    $srcKernel = Join-Path $RepoRoot 'python'
    $dstKernel = Join-Path $AppDir 'python'
    if (Test-Path -LiteralPath $srcKernel) {
        robocopy $srcKernel $dstKernel /E /NFL /NDL /NJH /NJS /NP /XD '__pycache__' | Out-Null
        Note ("python\ ({0:N1} MB)" -f (Get-DirSizeMB $dstKernel))
    }
    else {
        Warn2 'python\ not found in the repository; skipping.'
    }
}

# ------------------------------------------------------------------ launcher
Step 'Compiling the launcher'
$LauncherSrc = Join-Path $StandaloneDir 'launcher.cs'
Assert-File $LauncherSrc 'Launcher source'
$LauncherExe = Join-Path $DistDir 'dsh.exe'

# The launcher is compiled together with the self-update implementation: the
# update path lives in the same executable so it can repair a broken payload
# before anything under app\ is read. The extra assemblies carry the release
# JSON, the zip reader, and the HTTPS client.
$UpdaterSrc = Join-Path $StandaloneDir 'updater.cs'
Assert-File $UpdaterSrc 'Updater source'

& $CscPath /nologo /target:exe /platform:anycpu /optimize+ /warn:3 `
    "/r:System.Web.Extensions.dll" `
    "/r:System.IO.Compression.dll" `
    "/r:System.IO.Compression.FileSystem.dll" `
    "/out:$LauncherExe" $LauncherSrc $UpdaterSrc 2>&1 | ForEach-Object { Write-Host "    $_" }

Assert-File $LauncherExe 'Compiled launcher'
Note ("dsh.exe ({0:N0} KB)" -f ((Get-Item -LiteralPath $LauncherExe).Length / 1KB))

# .NET Framework disables long paths by default and freezes that decision while
# the runtime starts, before any managed code runs, so calling
# AppContext.SetSwitch from Main is too late. This sidecar lifts the legacy path
# handling at app-domain initialisation instead, which is what lets an update be
# extracted into an install whose full path is already deep. It deliberately
# declares no <startup> sku: naming a framework version here makes the loader
# demand that exact version and the app fails side-by-side when it is absent.
$launcherConfig = @'
<?xml version="1.0" encoding="utf-8"?>
<configuration>
  <runtime>
    <AppContextSwitchOverrides value="Switch.System.IO.UseLegacyPathHandling=false;Switch.System.IO.BlockLongPaths=false" />
  </runtime>
</configuration>
'@
# A literal (single-quoted) here-string is required: PowerShell does not collapse
# a doubled double-quote inside a here-string, so an expandable one emits
# version=""1.0"" and the loader rejects the file as a side-by-side error.
# Written BOM-free through .NET so the file starts with '<'.
[System.IO.File]::WriteAllText($LauncherExe + '.config', $launcherConfig, (New-Object System.Text.UTF8Encoding($false)))
Note 'dsh.exe.config'

# ------------------------------------------------------------------ support files
Step 'Writing distribution metadata'
# Read the version from the deployed manifest: requiring lib\bin.js would load
# the ESM entry point and fail. Read the JSON as data instead.
$appManifest = Get-Content -LiteralPath (Join-Path $AppDir 'package.json') -Raw | ConvertFrom-Json
$nodeVersion = (& $NodeExe --version) 2>$null

# The distribution carries its own version line, separate from the harness
# version it packages: releases are tagged for the distribution, and the updater
# compares that number. Defaulting to the harness version keeps a build with no
# explicit stamp updateable rather than frozen.
if (-not $StandaloneVersion) { $StandaloneVersion = $appManifest.version }

$manifest = [ordered]@{
    name              = 'dsh-standalone'
    standaloneVersion = $StandaloneVersion
    version           = $appManifest.version
    builtUtc    = (Get-Date).ToUniversalTime().ToString('o')
    nodeVersion = "$nodeVersion".Trim()
    withKernel  = [bool]$WithKernel
    nodeExe           = $NodeExe
}
$manifestPath = Join-Path $DistDir 'manifest.json'
# Set-Content -Encoding UTF8 in Windows PowerShell 5.1 writes a byte-order mark,
# which makes the manifest invalid JSON for strict parsers. Write it BOM-free.
$manifestJson = ($manifest | ConvertTo-Json -Depth 4) + "`n"
[System.IO.File]::WriteAllText($manifestPath, $manifestJson, (New-Object System.Text.UTF8Encoding($false)))
Note ("manifest.json (standalone {0})" -f $StandaloneVersion)

$readme = @"
dsh-standalone
==============

Run:  dsh.exe --help
      dsh.exe --profile headless "list the files in this directory"

This folder is self-contained. It bundles its own Node runtime and the compiled
harness, so the target machine needs no Node, pnpm, or Python installed.

Layout
------
  dsh.exe          launcher; forwards every argument to the bundled harness
  runtime\         bundled Node runtime
  app\             the harness CLI and its production dependencies
  manifest.json    build metadata

The harness home (sessions, credentials, settings) defaults to
%LOCALAPPDATA%\dsh-standalone. Set DSH_HOME to override it.
"@
Set-Content -LiteralPath (Join-Path $DistDir 'README.txt') -Value $readme -Encoding UTF8

# ------------------------------------------------------------------ verify
Step 'Verifying the distribution'
# A native command writing to stderr is a terminating error under
# ErrorActionPreference=Stop in PowerShell 5.1, so relax it for this one probe
# and report the captured streams explicitly.
$previousEap = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
# The launch path may hand an update check to a detached worker. A build is not
# a place to talk to the network, so the probe asks for no check at all.
$previousNoCheck = $env:DSH_NO_UPDATE_CHECK
$env:DSH_NO_UPDATE_CHECK = '1'
try {
    $verify = & $LauncherExe --version 2>&1
    $verifyText = ($verify | Out-String).Trim()
}
finally {
    $env:DSH_NO_UPDATE_CHECK = $previousNoCheck
    $ErrorActionPreference = $previousEap
}
Note ("dsh.exe --version -> {0}" -f $verifyText)

if ($verifyText -notmatch '\d+\.\d+\.\d+') {
    throw "Launcher verification failed: expected a version string, got: $verifyText"
}

# ------------------------------------------------------------------ package
$totalMB = Get-DirSizeMB $DistDir
$fileCount = Get-DirFileCount $DistDir

if (-not $SkipZip) {
    Step 'Packaging'
    $zip = Join-Path $DistRoot 'dsh-standalone.zip'
    if (Test-Path -LiteralPath $zip) { Remove-Item -LiteralPath $zip -Force }
    # Windows PowerShell 5.1's Compress-Archive is far too slow on a payload
    # this size, so the in-box bsdtar writes the archive. The members are named
    # explicitly rather than passed as ".": bsdtar prefixes every entry of a
    # "." archive with "./", and Windows Explorer's own zip reader reports such
    # an archive as empty.
    Push-Location $DistDir
    try {
        $members = @(Get-ChildItem -LiteralPath $DistDir -Force | ForEach-Object { $_.Name })
        & tar.exe -a -c -f $zip @members
    }
    finally { Pop-Location }
    if ($LASTEXITCODE -ne 0) { throw "tar failed with exit code $LASTEXITCODE" }
    Note ("dsh-standalone.zip ({0:N1} MB)" -f ((Get-Item -LiteralPath $zip).Length / 1MB))
}

Write-Host ''
Write-Host 'Build complete.' -ForegroundColor Green
Write-Host ("  output : {0}" -f $DistDir)
Write-Host ("  size   : {0:N1} MB across {1:N0} files" -f $totalMB, $fileCount)
Write-Host ("  run    : {0}" -f $LauncherExe)
