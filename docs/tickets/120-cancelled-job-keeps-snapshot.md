# 120 — a cancelled implement-mode job loses its worktree snapshot

**Status:** done
**Blocked by:** —
**Tier:** Three of four terminal exits finalize the implement worktree snapshot; cancel is the
exception. A job cancelled after doing real work has no `result_commit`, so `diff`/`apply` refuse
it with exit 11 and the partial work is only recoverable by hand until `cleanup` sweeps it —
data-loss-shaped on a documented flow, for a one-line omission.
**Filed from:** 2026-08-11 dual-backend audit (claude F-6)

---

## Symptom / Goal

In `core/commands/attempt-driver.js`, the terminal transitions differ:

- `finishTimedOut()` journals `...finalizeWorktreeSnapshot()` (`:239`);
- the `process_exited` branch (`:375`) and the observe-ended branch (`:433`) do the same;
- `finishCancelled()` (`:248-264`) journals `{ finished_at, command_exit_code, phase }` with
  **no** snapshot finalize, and — unlike `abandon()` (`:268-271`) — keeps the worktree in place
  with no record of what it contains.

Result: `dcli diff`/`dcli apply` on a cancelled implement job refuse it (exit 11 —
"no usable assistant result", `core/commands/apply.js:54-57`), because the snapshot was never
finalized.

## Root cause

The snapshot finalize was added to three of four terminal exits; `finishCancelled` predates it.

## Binding constraints — quoted, do not go looking for them

`docs/design-spec.md` §7: "`11` | No usable assistant result" — unchanged; the point is that a
cancelled job with a finalized snapshot stops being one.

`docs/design-spec.md` §5: `"worktree": { "path": ..., "base_commit": ..., "result_commit": ...,
"changed_files": ... }` — the snapshot fields the cancelled job must now carry.

## Files to read and trace first

- `core/commands/attempt-driver.js` — `finishCancelled` (`:248-264`) vs `finishTimedOut`
  (`:239`), `abandon` (`:268-291`), and where `finalizeWorktreeSnapshot()` is defined (it must
  be callable from `finishCancelled` — same scope; verify it returns `{}` when there is no
  worktree, so run-mode cancels are unaffected).
- `core/worktree.js` — `finalizeSnapshot`'s bounded git operations (already deadline-bounded via
  `resolveDeadline('SNAPSHOT_FINALIZE_MS')` — `attempt-driver.js:103`); verify the cancel path
  has no reason to skip it (cancel already waits bounded rungs, and the backend is being disposed
  concurrently — dispose happens *after* the journal in `finishCancelled` (`:260`), so ordering
  is unchanged).
- `core/commands/apply.js:48-63` and `core/commands/diff.js` — the exit-11 refusals that motivate
  the fix.
- `tests/core/commands/attempt-driver.test.js` (or wherever the driver's cancel is tested) — the
  cancel test to extend.

## What to build

1. **Add `...finalizeWorktreeSnapshot()` to `finishCancelled`'s journal detail** in
   `core/commands/attempt-driver.js:254-258`, mirroring `finishTimedOut` (`:239`). A cancelled
   implement attempt with a worktree then carries `result_commit`/`changed_files`, and `diff`/
   `apply` work on the partial result exactly as they do after a timeout. Run-mode cancels
   (no worktree) are byte-identical because the helper returns `{}`.
2. **Test.** In the existing driver tests: cancel an implement-mode attempt that has written to
   its worktree mid-run; assert the terminal record's `status.worktree.result_commit` is non-null
   and `diff`/`apply` accept the job.

## Non-goals

- **No change to `abandon()`'s worktree removal** — a genuine adapter-start failure still
  removes the worktree; only the *cancel* path changes.
- **No change to the snapshot helper, its deadline, or exit codes.**

## Acceptance criteria

- [ ] **A.** A cancelled implement-mode job's terminal record carries a non-null
  `worktree.result_commit` (and `changed_files` when the backend changed files).
- [ ] **B.** `diff` and `apply` work on such a job (no exit 11 refusal).
- [ ] **C.** A cancelled run-mode job (no worktree) produces the same record as before.
- [ ] **Z.** `npm run check` green; the tracker table regenerated.

## Agent checks

```bash
# What this proves: the cancel path finalizes the snapshot like every other terminal path.
rg -n "finalizeWorktreeSnapshot" core/commands/attempt-driver.js
# expect: four sites — timed-out, process-exited, observe-ended, and finishCancelled

# What this proves: the fix is covered.
npm test -- --grep "cancel"   # expect: green, including the result_commit assertion
```

## Notes

**What changed and where.**

- `core/commands/attempt-driver.js` — `finishCancelled()` (`:254-258`) now spreads
  `...finalizeWorktreeSnapshot()` into its terminal journal detail, mirroring `finishTimedOut`
  (`:239`). A cancelled implement attempt with a worktree now carries `worktree_result_commit`
  (projected to `status.worktree.result_commit`, and `base_commit` as fallback when the backend
  changed nothing); run-mode cancels are byte-identical because the helper returns `{}` with no
  worktree. Ordering is unchanged: the journal (now with the snapshot) still precedes
  `tryDisposeAdapter`.
- `tests/core/attempt-driver.test.js` — new "Ticket 120" block after the criterion G cancel test:
  an implement-mode attempt is cancelled mid-run after the fake backend wrote `feature.txt` into
  the worktree; asserts `status.worktree.result_commit` is a 40-hex commit hash, `executeDiff`
  (name-only) shows `feature.txt`, and `executeApply` lands it into the main repo. Covers
  acceptance A and B. Acceptance C (run-mode cancel, no worktree) is covered by the unchanged
  criterion C / criterion G cancel tests, which still pass byte-identically.

**Build and suite results.** `npm run check` green: eslint clean; full suite 99 passed (33
adapters + 2 contract + 60 core + 1 helpers + 3 integration), no failures. The new test passes
standalone (`node tests/core/attempt-driver.test.js`) and in the suite.

**Agent checks' actual output.**

```
$ rg -n "finalizeWorktreeSnapshot" core/commands/attempt-driver.js
100:  function finalizeWorktreeSnapshot() {
239:        ...finalizeWorktreeSnapshot(),      # finishTimedOut
258:        ...finalizeWorktreeSnapshot(),      # finishCancelled (this ticket)
343:              ...finalizeWorktreeSnapshot(), # result_persistence_failed branch
376:            ...finalizeWorktreeSnapshot(),  # process_exited branch
434:      ...finalizeWorktreeSnapshot(),        # observe-ended branch
```

The ticket expected "four sites"; there are actually five call sites. The fourth, the
`result_persistence_failed` branch (`:343`), predates this ticket — it was already finalizing when
the ticket's line count was written, not a site this work added or missed. `finishCancelled` was
the only terminal path without it.

`npm test -- --grep "cancel"` cannot run as written — the repo's runner (`tests/run-tests.js`) has
no `--grep` flag. Ran the full suite instead; all cancel-path tests (criterion C, criterion G,
`cancel.test.js`, `cancel-cli.test.js`, `worker-cancel-watcher.test.js`, `taskkill-tree-cancel.test.js`)
pass.

**Deviations.** None from the ticket's scope: no change to `abandon()`, the snapshot helper, its
deadline, or any exit code. The only differences from the ticket's wording are the two noted above
(five call sites, not four; `--grep` unavailable).
