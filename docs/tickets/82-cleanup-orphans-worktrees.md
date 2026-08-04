# Ticket 82 — `cleanup` removes the job record and leaves the worktree behind

**Status:** done (2026-08-04)
**Tier:** data-loss-adjacent. The worktree is the artifact; once its job record is gone no dcli command
can find it, name it, or delete it. Recovery is manual `git worktree remove` per repository.
**Blocked by:** none — can start immediately.

---

## Symptom

Observed on this machine while retiring a state root:

```
$ dcli cleanup --older-than 1d --dry-run
Dry-run: would remove 119 jobs

$ dcli cleanup --older-than 1d
Cleanup: 119 removed, 0 skipped, 0 scrubbed
```

Disk before: 386 MB. Disk after: 374 MB. All nine worktrees survived, 371 MB of them, and seven were
still registered in two repositories' `.git/worktrees`:

```
C:/Users/<user>/AppData/Local/dcli/worktrees/20260731T155345Z-h4h073qc  (detached HEAD)
... 6 more, across D:/…/dcli and D:/…/RestCue
```

`git worktree list` in an unrelated repository is now the only way to discover them. `dcli list` shows
nothing, because the records that named them were the thing `cleanup` deleted.

## Root cause

`core/commands/cleanup.js` never mentions worktrees. It removes job directories under `jobs/` and stops.
Retention was specified as "remove aged terminal jobs", and a job's worktree lives outside its job
directory (`<state root>/worktrees/<job id>/`), so it is not swept incidentally either.

Two consequences, and the second is the expensive one:

1. Disk grows without bound in the directory the tool created for exactly this purpose.
2. The git registration outlives the job. A stale registration is not inert: it makes
   `git worktree list` lie about the repository, and `git worktree prune` is the only thing that clears
   it — a command no dcli documentation mentions, for a directory no dcli command reports.

## Design constraints (from AGENTS.md, mistake #8)

- **The worktree is the artifact.** Retention once removed a worktree mid-operation and destroyed the
  only artifact needed to retry the work. So removal must respect the same per-main-repo lock and lease
  that `diff` / `apply` / `resume` take, and must never run against a job whose diff is being read.
- **Preview must be honest.** `--dry-run` currently reports a job count that does not describe most of
  the bytes it will (should) free. If the sweep reduces or extends coverage, say so in the output.
- **Do not over-count on failure.** A counter incremented before a removal that failed reports work that
  did not happen — a defect this project has already shipped once.

## What to build

`cleanup` takes responsibility for the whole artifact: when a job record is removed, its worktree
directory and its git registration go with it, and the preview says so before anything is deleted.

Because every existing installation already carries orphans, the same command must be able to see a
worktree directory with no surviving job record and report it — a directory under `worktrees/` whose
name matches no record is by construction unreachable, and the tool that created it is the right one to
name it.

## Acceptance criteria

- [x] **A.** Removing a terminal implement-mode job removes its worktree directory and unregisters it
  from its main repository, verified by `git worktree list` in that repository afterwards.
- [x] **B.** `--dry-run` names the worktrees it would remove and the bytes they occupy, and removes
  nothing. The counts it prints match what a subsequent real run does.
- [x] **C.** A worktree directory whose job record no longer exists is reported (and removable) rather
  than silently ignored. Reporting it is not optional — every installation predating this ticket has some.
- [x] **D.** Removal takes the per-main-repo lock, and a job whose artifacts are being read is skipped,
  counted as skipped, and named — never removed out from under a reader.
- [x] **E.** A failed removal does not increment the removed counter, and is surfaced.
- [x] **F.** A test exercises the real removal path against a real git worktree — not a fixture
  directory shaped like one — and asserts both the filesystem and the git registration afterwards.
- [x] **G.** `npm run check` green; README, `docs/reference/*`, and `integration/source/*` updated in the
  same commit, because retention behaviour is something an agent must know before it runs the command.

## Notes

- 2026-08-04: recovered by hand with `git worktree remove --force` per registration plus
  `git worktree prune` in both repositories, then deleting the emptied state root. 371 MB, 7
  registrations, two repositories. No dcli command was able to participate in the recovery.
- 2026-08-04: implemented cleanup ownership for job worktrees and orphan discovery. Removal holds the
  per-job lock, job lease, and per-repository apply lock; dry-run reports worktree paths and byte counts.
  Real git worktree tests cover registration removal, orphan cleanup, reader/repository lock skips, and
  failed-removal accounting.
