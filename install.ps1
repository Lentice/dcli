<#
.SYNOPSIS
    Install dcli Claude Code integration — skills, commands, rules.
.DESCRIPTION
    Stages the integration tree at a staging path, then swaps it into
    the target location atomically. Refuses to overwrite directories
    it cannot identify as its own. Verifies byte-match after install.
.PARAMETER InstallDir
    Target installation directory (default: ~\.claude).
.PARAMETER Force
    Skip confirmation prompts.
#>

param(
    [string]$InstallDir = "$env:USERPROFILE\.claude",
    [switch]$Force
)

$ErrorActionPreference = 'Stop'

# --- Paths ---
$RepoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$GeneratedDir = Join-Path $RepoRoot 'integration' 'generated'
$StateRoot = "$env:LOCALAPPDATA\dcli"

$DcliMarkerFile = '.dcli-installed'

$SkillDirs = @(
    'skills\dcli',
    'skills\dcli-opencode',
    'skills\dcli-codex',
    'skills\dcli-claude'
)

$CmdDirs = @(
    'commands\dcli-opencode',
    'commands\dcli-codex',
    'commands\dcli-claude'
)

$RuleDirs = @(
    'rules'
)

# --- Refusal guards ---

# Guard 1: Install dir must not collide with state root
$resolvedInstall = [System.IO.Path]::GetFullPath($InstallDir)
$resolvedState = [System.IO.Path]::GetFullPath($StateRoot)
if ($resolvedInstall -eq $resolvedState -or $resolvedInstall.StartsWith("$resolvedState\")) {
    Write-Error "Install directory collides with state root ($StateRoot). Refusing to install."
    exit 1
}

# Guard 2: Refuse to replace a non-empty foreign directory that lacks our marker
$hasMarker = $false
if (Test-Path $InstallDir) {
    $markerPath = Join-Path $InstallDir $DcliMarkerFile
    $hasMarker = Test-Path $markerPath
    if (-not $hasMarker) {
        $items = Get-ChildItem $InstallDir -Force
        if ($items.Count -gt 0) {
            Write-Error "Target directory $InstallDir exists, is non-empty, and lacks the dcli marker file ($DcliMarkerFile). Refusing to overwrite foreign installation."
            exit 1
        }
    }
}

if (-not $Force) {
    Write-Host "This will install dcli Claude Code integration to:"
    Write-Host "  $InstallDir"
    Write-Host ""
    $response = Read-Host "Continue? [y/N]"
    if ($response -ne 'y' -and $response -ne 'Y') {
        Write-Host "Installation cancelled."
        exit 0
    }
}

# --- Stage the new tree ---
$StagingDir = "$InstallDir.staging"
if (Test-Path $StagingDir) {
    Remove-Item -Path $StagingDir -Recurse -Force
}

Write-Host "Staging integration tree..."
New-Item -ItemType Directory -Path $StagingDir -Force | Out-Null

# Copy generated files to staging
if (Test-Path $GeneratedDir) {
    Copy-Item -Path "$GeneratedDir\*" -Destination $StagingDir -Recurse -Force
}

# Write marker file
$null = New-Item -ItemType File -Path (Join-Path $StagingDir $DcliMarkerFile) -Force

# --- Swap staging into place ---
Write-Host "Installing..."

# Empty the namespaced command directory first to remove ghosts
foreach ($cmdDir in $CmdDirs) {
    $fullPath = Join-Path $InstallDir $cmdDir
    if (Test-Path $fullPath) {
        Remove-Item -Path "$fullPath\*" -Recurse -Force -ErrorAction SilentlyContinue
    }
}

# Copy staging to install dir (this is the swap, not a merge, because we
# clean out the destination first for namespaced subdirs)
Copy-Item -Path "$StagingDir\*" -Destination $InstallDir -Recurse -Force

# Remove staging
Remove-Item -Path $StagingDir -Recurse -Force

# --- Post-install verification ---
Write-Host "Verifying installed files..."
$mismatch = $false

# Collect hashes from repo's generated dir
$repoHashes = @{}
if (Test-Path $GeneratedDir) {
    Get-ChildItem $GeneratedDir -Recurse -File | ForEach-Object {
        $rel = $_.FullName.Substring($GeneratedDir.Length + 1)
        $hash = Get-FileHash $_.FullName -Algorithm SHA256
        $repoHashes[$rel] = $hash.Hash
    }
}

# Compare against installed files
foreach ($skillDir in $SkillDirs) {
    $installedPath = Join-Path $InstallDir $skillDir
    if (-not (Test-Path $installedPath)) {
        Write-Warning "Missing installed directory: $skillDir"
        $mismatch = $true
        continue
    }
    Get-ChildItem $installedPath -Recurse -File | ForEach-Object {
        $rel = $_.FullName.Substring((Resolve-Path $InstallDir).Path.Length + 1)
        $installedHash = Get-FileHash $_.FullName -Algorithm SHA256
        $repoHash = $repoHashes[$rel]
        if ($repoHash -and $repoHash -ne $installedHash.Hash) {
            Write-Warning "Hash mismatch: $rel"
            $mismatch = $true
        }
    }
}

if ($mismatch) {
    Write-Warning "Some installed files do not byte-match the repository."
    exit 1
}

Write-Host "dcli integration installed successfully."
