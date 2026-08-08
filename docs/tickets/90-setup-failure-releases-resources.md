# 90 — Release worktrees and admission slots on setup failure

**Tier:** Resource safety and lifecycle correctness. A setup exception must not strand a Git worktree or consume a durable concurrency slot until reconciliation.
**Filed from:** 2026-08-08 repository audit; injected `store.createJob` failure probe.

---

## Symptom / Goal

`executeRun()` and `executeResume()` create an implement-mode worktree and may acquire an admission slot before creating the job record and attempt artifacts. If `store.createJob`, `createAttemptDir`, or `persistInitFiles` throws, control exits without removing the worktree or releasing the slot.

The goal is an explicit setup ownership boundary: setup either hands both resources to `runAttempt()` or releases every resource it acquired before rethrowing.

## Root cause

Both commands clean up only when backend preparation fails or admission refuses the request. The later setup calls are outside a cleanup guard:

```js
const wt = createDetachedWorktree(repoRoot, worktreePath, undefined, stateRoot);
// ... prepareBackend(), admission.acquireSlot()
store.createJob({ ... });
store.createAttemptDir({ repoKey, jobId, attemptNum });
persistInitFiles({ ... });
return runAttempt({ ..., worktreePath, admission, acquiredSlotId });
```

An injected `store.createJob` failure reproduced both leaks:

```text
{"admissionSlotFiles":1,"worktreeEntries":[".../repo",".../state/worktrees/<job-id>"]}
```

## Binding constraints — quoted, do not go looking for them

From `docs/design-spec.md`:

> One lock per job, plus narrowly scoped locks for: job-id/index creation; worktree create/remove within a repository; applying to the main repository; cleanup; per-job server lifecycle.

> Each running job occupies a durable slot file in `<state-root>/locks/admission/<uuid>.json` containing the owner's pid, start time, hostname, execution token, backend, and acquisition time.

From `docs/engineering/testing.md`:

> Kill the controller at each point and assert the job is recoverable or explicitly `interrupted` — **never stuck `running`**, never orphaned, never holding a lock or worktree.

Keep the existing durable job/reconciliation model; this ticket closes only resources acquired by a command that never reaches `runAttempt()`.

## Files to read and trace first

- `core/commands/run.js` — trace worktree creation, admission acquisition, setup writes, and the handoff to `runAttempt`.
- `core/commands/resume.js` — trace the corresponding setup path and its parent/session cleanup.
- `core/commands/attempt.js` — identify the exact handoff point after which `runAttempt` owns cleanup and slot release.
- `core/worktree.js` — use `removeWorktree` and preserve Git registration cleanup.
- `core/admission.js` — use `releaseSlot` exactly once for an acquired slot.
- `tests/core/attempt-population.test.js`, `tests/core/admission.test.js`, and `tests/core/fault-injection.test.js` — reuse existing fake adapter, store, and fault-injection patterns.

## What to build

1. Add the smallest shared or local setup guard that tracks whether a worktree and admission slot were acquired.
2. On any setup failure before `runAttempt()` is called, remove the worktree and release the slot, preserving the original error and exit code.
3. Transfer ownership exactly once when calling `runAttempt()`; do not release resources in both the setup guard and attempt finalization.
4. Add regression coverage for a failure after worktree creation and after slot acquisition, asserting no Git worktree registration and no admission slot file remain.

## Non-goals

- Deleting a durable job record automatically — partial records remain subject to the existing reconciliation contract.
- Changing admission limits, queue ordering, or worktree path policy.
- Reworking `runAttempt()` cleanup — its post-handoff ownership is already centralized there.

## Acceptance criteria

- [x] **A.** Every exception before the `runAttempt()` handoff releases each resource acquired by `run` or `resume`.
- [x] **B.** A successful run/resume still releases the slot through the existing attempt finalization exactly once.
- [x] **C.** Regression tests prove no orphaned worktree registration or admission slot after injected setup failure.
- [x] **D.** `npm run lint` and the affected core tests pass; no job-state contract or exit-code meaning changes.

## Agent checks

```bash
# Run setup/resource lifecycle tests with a temp root outside this repository.
node tests/core/attempt-population.test.js
node tests/core/admission.test.js
# expect: both exit 0.

npm run lint
# expect: exit code 0.

# Confirm both commands still hand resources to the shared attempt engine.
rg -n "runAttempt|removeWorktree|releaseSlot|acquiredSlotId" core/commands/run.js core/commands/resume.js core/commands/attempt.js
# expect: setup cleanup and the single post-handoff ownership path are visible.
```

## Notes — 2026-08-09

Implemented by opencode as `ticket 90: release worktrees and admission slots on setup failure`.

- `core/commands/attempt.js` adds the shared `releaseSetupResources` helper; `run.js` and `resume.js` guard setup through the handoff and rethrow the original error after releasing only resources they acquired.
- `tests/core/setup-cleanup.test.js` covers run createJob failure, run prepareBackend failure, resume createAttemptDir failure, and successful exactly-once slot release.
- `node tests/core/attempt-population.test.js`, `node tests/core/admission.test.js`, and the new setup-cleanup test passed; `npm run lint` passed.
- Full-suite failures remained the known environment-only opencode password-environment and headless containment failures; no job-state contract or exit-code meaning changed.

(Left empty by the author. The implementer fills it in with changes, checks, results, deviations, and discoveries.)
