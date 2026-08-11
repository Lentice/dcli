# 120 — a cancelled implement-mode job loses its worktree snapshot

**Status:** ready
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

(Left empty by the author. The implementer fills it in: what was changed and where, build and suite
results, the Agent checks' actual output, any deviation from this ticket and why, and anything
discovered that contradicts the docs.)
