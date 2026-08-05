<#
.SYNOPSIS
    Install dcli agent integration — skills, commands, rules.
.DESCRIPTION
    Installs to one or both targets:
      claude  -> ~\.claude   (skills, commands, rules, worker-prompts)
      agents  -> ~\.agents   (skills only)
    For each selected target it stages the subtree at a staging path, then
    swaps it into the target location. Refuses to overwrite content it
    cannot identify as its own. Verifies byte-match after install.
.PARAMETER InstallDir
    Claude Code integration directory (default: ~\.claude).
.PARAMETER AgentsDir
    Cross-agent skills directory (default: ~\.agents).
.PARAMETER Targets
    Which targets to install: claude, agents, or both. When omitted, the
    script asks interactively with both pre-selected; with -Force and no
    -Targets, both are installed.
.PARAMETER Force
    Skip confirmation prompts.
#>

param(
    [string]$InstallDir = "$env:USERPROFILE\.claude",
    [string]$AgentsDir = "$env:USERPROFILE\.agents",
    [string[]]$Targets,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'

# --- Paths ---
$RepoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$GeneratedDir = Join-Path (Join-Path $RepoRoot 'integration') 'generated'
$StateRoot = "$env:LOCALAPPDATA\dcli"

$DcliMarkerFile = '.dcli-installed'

# Namespaced directories dcli owns outright. Emptied before the swap so a
# file removed in a newer version cannot survive as a ghost (AGENTS.md §9).
# rules\ is deliberately absent: it is shared with other tools' rule files.
$OwnedDirs = @(
    'skills\dcli',
    'skills\dcli-opencode',
    'skills\dcli-codex',
    'skills\dcli-claude',
    'commands\dcli-opencode',
    'commands\dcli-codex',
    'commands\dcli-claude'
)

# Top-level subtrees of integration\generated each target receives.
$TargetSubtrees = @{
    claude = @('skills', 'commands', 'rules', 'worker-prompts')
    agents = @('skills')
}

if (-not (Test-Path $GeneratedDir)) {
    Write-Error "Generated integration tree not found at $GeneratedDir. Run the generator first."
    exit 1
}

# --- Target selection ---
$TargetRoots = @{
    claude = $InstallDir
    agents = $AgentsDir
}

function Read-YesNoDefaultYes([string]$question) {
    $response = Read-Host "$question [Y/n]"
    return ($response -eq '' -or $response -eq 'y' -or $response -eq 'Y')
}

if (-not $PSBoundParameters.ContainsKey('Targets')) {
    if ($Force) {
        $Targets = @('claude', 'agents')
    }
    else {
        Write-Host "Select installation targets (both selected by default):"
        Write-Host ""
        $selected = @()
        if (Read-YesNoDefaultYes "  Install Claude Code integration to $InstallDir?") {
            $selected += 'claude'
        }
        if (Read-YesNoDefaultYes "  Install shared agent skills to $AgentsDir?") {
            $selected += 'agents'
        }
        $Targets = $selected
    }
}

# Accept both `-Targets claude,agents` (one comma-joined token, which is what
# `pwsh -File` hands over) and `-Targets claude agents`. Validate the names
# ourselves rather than with [ValidateSet]: an unrecognized target must be a
# named refusal, never a silently discarded argument.
$Targets = @(
    $Targets |
        ForEach-Object { $_ -split '[,\s]+' } |
        Where-Object { $_ -ne '' } |
        Select-Object -Unique
)

$knownTargets = @('claude', 'agents')
foreach ($target in $Targets) {
    if ($knownTargets -notcontains $target) {
        Write-Error "Unknown target '$target'. Valid targets: $($knownTargets -join ', '). Refusing to install."
        exit 1
    }
}

if ($Targets.Count -eq 0) {
    Write-Host "No targets selected. Installation cancelled."
    exit 0
}

# --- Per-target file list ---
function Get-TargetFiles([string]$target) {
    $files = @()
    foreach ($subtree in $TargetSubtrees[$target]) {
        $subtreePath = Join-Path $GeneratedDir $subtree
        if (-not (Test-Path $subtreePath)) { continue }
        Get-ChildItem $subtreePath -Recurse -File | ForEach-Object {
            $files += $_.FullName.Substring($GeneratedDir.Length + 1)
        }
    }
    return $files
}

# --- Refusal guards (all targets checked before anything is written) ---
$resolvedState = [System.IO.Path]::GetFullPath($StateRoot)

foreach ($target in $Targets) {
    $root = $TargetRoots[$target]

    # Guard 1: target root must not collide with the job-state root.
    $resolvedRoot = [System.IO.Path]::GetFullPath($root)
    if ($resolvedRoot -eq $resolvedState -or $resolvedRoot.StartsWith("$resolvedState\")) {
        Write-Error "Target '$target' directory $root collides with state root ($StateRoot). Refusing to install."
        exit 1
    }

    # Guard 2: refuse to replace foreign content at the exact file paths dcli
    # is about to write. A target root is typically a real agent home that
    # legitimately holds unrelated content (settings.json, memory\, agents\,
    # CLAUDE.md, other rules\*.md, other tools' skills\, ...) that dcli never
    # touches and must never be treated as a reason to refuse. Some targets
    # live in directories dcli does not own outright (rules\ is shared), so
    # directory-level emptiness is the wrong granularity — only the specific
    # generated files matter.
    if (-not (Test-Path $root)) { continue }
    if (Test-Path (Join-Path $root $DcliMarkerFile)) { continue }
    foreach ($rel in Get-TargetFiles $target) {
        $destPath = Join-Path $root $rel
        if (Test-Path $destPath) {
            Write-Error "Target file $destPath already exists and $root lacks the dcli marker file ($DcliMarkerFile). Refusing to overwrite foreign content."
            exit 1
        }
    }
}

# Guard 3: two selected targets must not resolve to the same directory, or
# the second install would see the first one's files.
$resolvedRoots = @{}
foreach ($target in $Targets) {
    $resolvedRoot = [System.IO.Path]::GetFullPath($TargetRoots[$target])
    if ($resolvedRoots.ContainsKey($resolvedRoot)) {
        Write-Error "Targets '$($resolvedRoots[$resolvedRoot])' and '$target' resolve to the same directory ($resolvedRoot). Refusing to install."
        exit 1
    }
    $resolvedRoots[$resolvedRoot] = $target
}

if (-not $Force) {
    Write-Host ""
    Write-Host "This will install dcli integration to:"
    foreach ($target in $Targets) {
        Write-Host "  [$target] $($TargetRoots[$target])  ($($TargetSubtrees[$target] -join ', '))"
    }
    Write-Host ""
    $response = Read-Host "Continue? [y/N]"
    if ($response -ne 'y' -and $response -ne 'Y') {
        Write-Host "Installation cancelled."
        exit 0
    }
}

# --- Install each target ---
function Install-Target([string]$target) {
    $root = $TargetRoots[$target]
    $subtrees = $TargetSubtrees[$target]

    # Stage the new tree
    $stagingDir = "$root.dcli-staging"
    if (Test-Path $stagingDir) {
        Remove-Item -Path $stagingDir -Recurse -Force
    }

    Write-Host "[$target] Staging integration tree..."
    New-Item -ItemType Directory -Path $stagingDir -Force | Out-Null

    foreach ($subtree in $subtrees) {
        $subtreePath = Join-Path $GeneratedDir $subtree
        if (Test-Path $subtreePath) {
            Copy-Item -Path $subtreePath -Destination $stagingDir -Recurse -Force
        }
    }

    # Write marker file
    $null = New-Item -ItemType File -Path (Join-Path $stagingDir $DcliMarkerFile) -Force

    # Swap staging into place
    Write-Host "[$target] Installing to $root..."
    New-Item -ItemType Directory -Path $root -Force | Out-Null

    # Empty the namespaced directories dcli owns outright to remove ghosts
    foreach ($ownedDir in $OwnedDirs) {
        if ($subtrees -notcontains $ownedDir.Split('\')[0]) { continue }
        $fullPath = Join-Path $root $ownedDir
        if (Test-Path $fullPath) {
            Remove-Item -Path "$fullPath\*" -Recurse -Force -ErrorAction SilentlyContinue
        }
    }

    # Copy staging to target (a swap, not a merge, because the namespaced
    # subdirs were cleaned out first)
    Copy-Item -Path "$stagingDir\*" -Destination $root -Recurse -Force

    Remove-Item -Path $stagingDir -Recurse -Force

    # Post-install verification: every file this target installed must
    # byte-match the repository.
    Write-Host "[$target] Verifying installed files..."
    $mismatch = $false
    foreach ($rel in Get-TargetFiles $target) {
        $repoPath = Join-Path $GeneratedDir $rel
        $installedPath = Join-Path $root $rel
        if (-not (Test-Path $installedPath)) {
            Write-Warning "[$target] Missing installed file: $rel"
            $mismatch = $true
            continue
        }
        $repoHash = (Get-FileHash $repoPath -Algorithm SHA256).Hash
        $installedHash = (Get-FileHash $installedPath -Algorithm SHA256).Hash
        if ($repoHash -ne $installedHash) {
            Write-Warning "[$target] Hash mismatch: $rel"
            $mismatch = $true
        }
    }
    return -not $mismatch
}

$allOk = $true
foreach ($target in $Targets) {
    if (-not (Install-Target $target)) { $allOk = $false }
}

if (-not $allOk) {
    Write-Warning "Some installed files do not byte-match the repository."
    exit 1
}

Write-Host "dcli integration installed successfully to: $($Targets -join ', ')"
