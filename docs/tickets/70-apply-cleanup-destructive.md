# 70 — `apply --hardReset` deletes user untracked files unconditionally; `cleanup` check-then-release-then-delete race

**What to build:** two destructive operations stop destroying work they can't prove they own — (A) `apply`'s `--hardReset` fallback stops `fs.unlinkSync`-ing every untracked file that appeared during a failed cherry-pick, and (B) `cleanup` no longer deletes a job directory between releasing its lease probe and removing the dir: it either holds the lease through the delete, or skips the delete if a diff/apply has since acquired the lease. Both are `AGENTS.md` Mistake #8 ("Snapshot and apply are where data gets destroyed").

**Blocked by:** None — can start immediately

**Status:** ready-for-agent

## Acceptance criteria

### A. apply `_hardReset` does not delete untracked files it cannot prove it owns
- [ ] `core/commands/apply.js` `_hardReset` (around line 184-195): the `git reset --hard preHead` runs (restoring tracked files to preHead state). The untracked-file sweep is REMOVED — the cherry-pick's untracked files (the set `postUntracked ▸ preUntracked`) are LEFT in place, NOT `fs.unlinkSync`'d.
- [ ] Per Mistake #8: "if unexpected modifications appeared, skip the reset and report non-restoration rather than discarding a user's work." The hard-reset is preceded by a check that the working tree matches the snapshot the apply expected; if unexpected changes appeared (the user edited something mid-apply), `--hardReset` is SKIPPED, the apply returns exit 25 with `non_restoration: true` and a list of unexpected paths.
- [ ] A follow-up `apply --force-untracked-cleanup` flag may delete the cherry-pick's untracked files only when the user explicitly requests it. Default behaviour: leave them.
- [ ] Test: an apply whose cherry-pick produced new untracked files AND then fails → the untracked files remain on disk post-failure, NOT deleted; apply returns 25 with `non_restoration: false` (we restored tracked files) and `untracked_preserved: [<paths>]`.
- [ ] Test: an apply where the user modified an unrelated file mid-apply AND then it fails → `--hardReset` is skipped, no tracked changes are reset, apply returns 25 with `non_restoration: true` listing the unexpected paths.

### B. cleanup check-then-release-then-delete race
- [ ] `core/commands/cleanup.js` (around line 163-181): the JOB_LEASE acquired for the probe is HELD THROUGH the directory deletion (released AFTER `fs.rmSync(jobDir, {recursive:true})` returns), NOT released-then-deleted. A diff/apply that calls `locks.acquire(LOCK_SCOPES.JOB_LEASE, jobId)` between today's release-at-line-170 and today's delete-at-line-181 no longer wins — it blocks on the held lease until cleanup is done.
- [ ] Alternative acceptable shape: cleanup does NOT acquire the lease; instead it records intent and lets a separate "owned cleanup" path take the lease and delete. Pick one shape consistently — don't introduce two paths.
- [ ] Test: a concurrent `apply` (acquiring JOB_LEASE) running in parallel with `cleanup` on the same job never has the job directory pulled out from under it — either apply wins the lease and completes, or cleanup completes and apply gets exit 3 "job not found". No "apply found the lease, then cleanup deleted the dir, then apply failed strangely" race.

### Other
- [ ] Full suite green.

## Development guidance

- For A: the existing `_rollbackOrReport` already checks tracked modifications before `--hardReset`; extend it to also record `untracked_preserved` for the leftover untracked files and to skip the reset entirely when unexpected modifications are detected (today's tracked-only check is partial).
- For B: holding the lease through the delete risks a crash mid-delete stranding the lease. Use a `try/finally` — `finally { lock.release(); }` — so the lease is always released. The journal-locking infra `core/locking.js` supports acquire-with-budget; reuse it.
- This is the documented expensive race: "Retention cleanup once deleted a worktree mid-operation, destroying the only artifact needed to retry" (`AGENTS.md` Mistake #8). The principle: any operation that deletes an artifact must either hold a lease covering the delete, or check-again-just-before-delete.
- Don't introduce a "soft delete then hard delete" — that's a half-measure. Either the lease covers the delete or it doesn't.

## Why it matters

The untracked-file deletion is catastrophic for a user who runs a failed apply, examines the leftovers, then runs `apply --hardReset` to retry — losing notes/state they added between apply attempts. The cleanup race is the documented "stored artifacts destroyed mid-operation."

## How to verify

```powershell
node tests/run-tests.js --suite full
```

## Commit message

```
fix(apply,cleanup): preserve untracked files on hard reset and hold the lease through cleanup delete
```