# 110 — `submit` leaks the job record and worktree when the worker launch fails

**Status:** ready
**Blocked by:** —
**Tier:** The documented worker-launch failure path (exit 18) leaves a `created` job and a
registered worktree behind. Every resource a job creates must have an owner that releases it on
every exit — including the failure one (the pattern ticket 90 established for setup).
**Filed from:** 2026-08-11 dual-backend audit (codex F-2; verified with an injected spawn
exception in a temporary git repository at ticket time)

---

## Symptom / Goal

`dcli submit --mode implement` (and run-mode submit) creates the job record and the implement
worktree in `openAttempt` (`core/job-setup.js`), then hands them to a detached worker via
`spawnWorker` (`core/worker-spawn.js`). If the spawn or its launch-identity persistence fails:

- the spawned child's `'error'` event path journals `to: 'failed'` with
  `failure_reason: 'worker_spawn_failed'` (`core/worker-spawn.js:89-107`) — but **the worktree is
  never removed**;
- the synchronous throw path (`spawn()` itself, or `store.recordWorkerLaunch` failing at
  `:71-79`) propagates out of `spawnWorker` with no journal at all, and `executeSubmit` has no
  `try/catch` (`core/commands/submit.js:82-85`), so the job stays `created` forever and the
  worktree stays registered.

Observed: injected spawn exception → `submit` exits 18, job record remains `created`, and
`git worktree list --porcelain` still lists the job worktree.

## Root cause

Resource ownership passes from setup (`openAttempt`'s `release()` escape hatch,
`core/job-setup.js:177-194`) to the detached worker with no handoff guard around the process
creation. The two failure paths disagree: the async one journals but does not clean the worktree;
the sync one neither journals nor cleans.

## Binding constraints — quoted, do not go looking for them

`docs/design-spec.md` §7: "`18` | Worker launch / startup-sentinel failure" — the exit code is
correct and unchanged; this ticket fixes the leftover state, not the code.

`docs/design-spec.md` §6: "`created` → `running` → one of `done` | `failed` | `timed_out` |
`cancelled` | `interrupted`" — a job whose worker never launched must end terminal (`failed`),
never remain `created`.

## Files to read and trace first

- `core/commands/submit.js:79-87` — the bare `await spawnWorker(...).launched;` with no cleanup.
- `core/worker-spawn.js` — the whole file: the sync-throw sites (`spawn` at `:54-61`,
  `recordWorkerLaunch` at `:71-79`), the `launched` promise (`:81-113`), the async failure
  journal (`journalSpawnFailure` at `:89-107`). Note the file already knows `store`, `jobId`,
  `repoKey` and `stateRoot` — everything needed to clean up the worktree from the async path.
- `core/job-setup.js:100-194` — `openAttempt`: how `worktreePath`/`worktreeCreated` are tracked
  and how `release()` (`:189-194`) removes the worktree and releases the admission slot.
- `core/worktree.js` — `removeWorktree` (the same helper `release()` and
  `core/commands/attempt-driver.js:270` use).
- `core/commands/attempt-driver.js:266-291` — `abandon()`: the established pattern for a
  failure-after-setup: dispose, remove worktree, journal terminal, throw exit 18. The submit
  failure should leave the same observable state.
- `tests/core/commands/submit.test.js` (or wherever submit is tested) — where the new failure
  tests go.

## What to build

1. **One owner performs both cleanup and failure publication.** The ticket decision: the *worker
   launch failure belongs to the spawn site*, because the async `'error'` path cannot be caught by
   `executeSubmit` (the promise settles, it does not reject).
   - In `core/worker-spawn.js`'s `journalSpawnFailure` (and in a new shared failure helper the
     sync path also calls): after journaling terminal `failed`, remove the job's implement
     worktree. Read `worktree_path` from the job's status record (or `params.json` — pick the
     record the status carries, `status.worktree.path` per §5) and call `removeWorktree`. Do this
     only when a worktree exists for this job — run-mode submits have none.
   - In `core/commands/submit.js`: wrap the `spawnWorker` call in `try/catch`; on a synchronous
     throw, journal the same terminal `worker_spawn_failed` transition (the sync path currently
     writes nothing) and call `attempt.release()` (`core/job-setup.js:189`) for the worktree and
     any admission resource, then rethrow (exit 18 preserved).
2. **Idempotence.** Both paths may run for one failed spawn (e.g. a throw after the child's
   `'error'` fired): worktree removal and journaling must be safe to run twice
   (`removeWorktree` already tolerates absence — verify; the journal transition is append-only
   so a duplicate transition must not corrupt the projection — verify against
   `core/job-store.js`'s reducer).
3. **Tests.** A submit-with-failing-spawn test asserting, on both the sync-throw and the
   `'error'`-event paths: the job ends terminal `failed` with `failure_reason:
   'worker_spawn_failed`; `git worktree list --porcelain` contains no job worktree; and the exit
   code is 18.

## Non-goals

- **No change to the queued-relaunch path.** `core/admission.js:239-241` already restores the
  queue claim on spawn failure; the relaunch worker owns its own cleanup.
- **No change to `exitCode 18` or the failure reason.**
- **No re-architecture of `spawnWorker`'s promise** — the sync/async split stays; only the
  cleanup and journaling change.

## Acceptance criteria

- [ ] **A.** On a synchronous `spawnWorker` throw, `submit` exits 18, the job is terminal
  `failed`, and no worktree remains registered.
- [ ] **B.** On a child `'error'` event, the same observable end state holds (journal already
  exists; worktree removal is the addition).
- [ ] **C.** A run-mode submit (no worktree) failing to launch leaves no worktree and a terminal
  `failed` job.
- [ ] **Z.** `npm run check` green; the tracker table regenerated.

## Agent checks

```bash
# What this proves: the failure paths share one cleanup owner.
rg -n "worker_spawn_failed" core/worker-spawn.js core/commands/submit.js
# expect: one journal site in worker-spawn (async) and one in submit (sync), both followed by
#         worktree removal/release; no other site writes the reason.

# What this proves: submit no longer hands resources over with no guard.
rg -n "spawnWorker" core/commands/submit.js
# expect: the call sits in a try/catch that journals and releases on throw

# What this proves: the fix is covered.
npm test -- --grep "submit"   # expect: green, including spawn-failure cases
```

## Notes

(Left empty by the author. The implementer fills it in: what was changed and where, build and suite
results, the Agent checks' actual output, any deviation from this ticket and why, and anything
discovered that contradicts the docs.)
