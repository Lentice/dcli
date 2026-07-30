# 74 — install.ps1: `worker-prompts` not whole-tree swapped; staging litter on abort; collision guard ignores `DCLI_STATE_ROOT`

**What to build:** `install.ps1` actually swaps the complete owned tree (`worker-prompts`, `skills\dcli*`, `commands\dcli-*`) rather than merging into the existing directory (the documented "copy-recursive merges" trap, `AGENTS.md` §9) — and wraps the staging/copy in `try/finally` so an abort doesn't litter the user's home with a `.dcli-staging` directory, and the state-root collision guard honors the runtime `DCLI_STATE_ROOT` override.

**Blocked by:** Ticket 37 (which landed the partial stage-and-swap; this is the unfinished half tracked by 37's acceptance bar)

**Status:** ready-for-agent

## Acceptance criteria

### A. worker-prompts whole-tree swap
- [ ] `install.ps1` `$OwnedDirs` (around line 42-50): adds `worker-prompts` (and any other owned subtree from `TargetSubtrees.claude` that is omitted today). The pre-copy empty-owned-dirs step empties ALL dcli-owned subtrees, so `Copy-Item -Recurse -Force` at the end never merges.
- [ ] Verify by listing every entry in `TargetSubtrees.claude` and `TargetSubtrees.agents` in `install.ps1` — each owned subtree is in `$OwnedDirs`. Don't merge; empty-then-copy (or use a true rename-swap atomic when feasible — see C).
- [ ] Test: install over an existing install where the user removed a previously-shipped `worker-prompts/foo.md` → after install the file is NOT present (file removals propagate). Today it survives.

### B. Staging litter / atomic swap
- [ ] The whole staging-dir-then-copy sequence (around line 193-226) is in `try { ... } finally { if ($stagingDir) { Remove-Item -Recurse -Force $stagingDir -ErrorAction SilentlyContinue } }`. An abort mid-copy leaves NOTHING behind — no `~\.claude.dcli-staging` litter.
- [ ] Better (preferred): a true whole-tree atomic swap. Stage the full owned tree, then `Rename-Item owned -> owned.old; Rename-Item staging -> owned; Remove-Item owned.old -Recurse -Force`. With the `OwnedDirs` empty-step already in place, the rename-swap removes the deletion-without-replacement window entirely (per AGENTS §9: "stage the new tree and swap it in whole").
- [ ] Post-install byte-match verification (line 234-249) is preserved — keep the existing check; the rename-swap can't leave a missing owned-dir because the swap is atomic.

### C. Collision guard honors DCLI_STATE_ROOT
- [ ] `install.ps1` `$StateRoot` (around line 35): derives from `$env:DCLI_STATE_ROOT` first, falling back to `Join-Path $env:LOCALAPPDATA 'dcli'`. The runtime precedence is: `DCLI_STATE_ROOT` → `$LOCALAPPDATA\dcli`. (Mirror `cli/dcli.js:117` minus the test-variable leak that ticket 73 fixes.)
- [ ] Guard 1 (state-root collision): `$resolvedState -eq $resolvedRoot` now works regardless of whether the user supplied `DCLI_STATE_ROOT` or relied on the LOCALAPPDATA default.

### D. Other
- [ ] Case-insensitivity on Windows for path comparison (per the M12 finding — `$resolvedRoot.Startswith($resolvedState\, [StringComparison]::OrdinalIgnoreCase)`) — applies to all collision checks, not just the state-root one.
- [ ] Full suite green; installer hand-run on a clean dir and over an existing install; verify the post-install byte-match check passes on both.

## Development guidance

- The "merge on recursive copy" trap is explicit in `AGENTS.md` §9: "Copy-Item -Recurse -Force over an existing install *merges*, so a module deleted in a newer version survives as a stale file." The atomic rename-swap is the prescribed fix; do it once for all owned subtrees rather than per-subtree.
- The `try/finally` for staging cleanup is security-of-installation, not just cleanliness: a `.dcli-staging` dir hanging around in `~\.claude` looks like a foreign directory and may trick the user into deleting more than they should.
- Don't add more refusal-mode tests here (ticket 37 added several); just close the worker-prompts and the staging-leak gaps. New refusal modes (e.g. `--force-into-existing` for installing into an arbitrary dir) are follow-ups.
- The HardRetry `Copy-Item -Recurse -Force` final step is what does the merge today; even with empty-then-copy, the rename-swap (B) is preferable — single atomic op.

## Why it matters

A feature that removes a `worker-prompts/foo.md` from a new version silently keeps the stale one on upgrade. The user's skills/agents continue to use the old role, and the new behaviour isn't loaded. That's how the predecessor shipped discrepancies between skill and binary. The staging litter is minor individually but cumulative — small "harmless" debris across the file system over many upgrade attempts.

## How to verify

```powershell
# Run the installer twice (over an existing install), verify byte-match passes
# and no .dcli-staging remains. Manually test: remove a worker-prompts/foo.md
# from staging, regenerate, install, verify the removed file is NOT in the install.
```

## Commit message

```
fix(installer): whole-tree atomic swap for all owned subtrees, no staging litter, DCLI_STATE_ROOT honored
```