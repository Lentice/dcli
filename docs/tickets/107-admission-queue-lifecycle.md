# 107 — the admission queue strands queued jobs and relaunches cancelled ones

**Status:** ready
**Blocked by:** —
**Tier:** A submitted job that never runs, or a cancelled job whose backend still starts, is the
single worst outcome for a delegation tool: work happens the caller was told was gone, and work is
lost the caller was told was done.
**Filed from:** 2026-08-11 dual-backend audit (claude F-1, codex F-1; claims re-verified against the
tree at `51e2d35` before this ticket was written)

---

## Symptom / Goal

Two observable defects in the admission queue:

1. **A queued job can wait forever.** When a worker cannot acquire a slot it journals `to: 'queued'`
   and exits (`core/commands/worker.js:85-105`). Dequeue runs **only** from `releaseSlot()`
   (`core/admission.js:141`). So when a job is queued for `reason: 'contention'` — the admission
   lock was held for a moment while the system is *below* capacity — or when every slot holder dies
   without releasing, there may be no future release event at all. `reconcile()` reclaims stale slot
   files on the next command (`cli/dcli.js:160`) but never dequeues, and the reducer's
   reconciliation only considers `running`/`created` states (`core/reducer.js:172-175`), so the job
   reports `queued` indefinitely — the design-spec §6 promise "`status` must never report a job as
   permanently `running`" evaded on a technicality rather than honoured.
2. **A cancelled queued job can still launch.** `cancelJob()` on a `queued` job journals
   `to: 'cancelled'` (`core/cancel.js:228-238`) but never removes `queue/<jobId>.json`.
   `tryDequeue()` (`core/admission.js:208-255`) spawns a worker for every queue entry without
   reading the job's state, so when capacity frees, the cancelled job's backend starts — after the
   caller was told cancellation succeeded.

## Root cause

Dequeue is edge-triggered on slot release only, and queue entries are treated as the source of
truth with no reference to the job's journal. The queue is the only coordination point between
`cancel` and the relaunch path, and it is not state-aware on either side.

## Binding constraints — quoted, do not go looking for them

`docs/design-spec.md` §6: "**Terminal state is decided by an engine-owned reducer over adapter
facts (ADR-007).**" — the queue fix must not let a dispatcher decide a job's state; the reducer
still owns terminality, the queue only removes/keeps entries.

`docs/design-spec.md` §14 amendment (2026-08-11): "The degraded tree kill (ticket 103) is wired.
On Windows, every termination path goes through the shared `terminateProcessTree` seam" — the
cancel path itself is unchanged by this ticket; only the queued-jobs cancel outcome gains a queue
removal.

## Files to read and trace first

- `core/admission.js` — the whole file. `acquireSlot` (`:110-136`) returns
  `{ queued: true, reason }` for both contention (`:113-116`) and capacity (`:121-128`);
  `releaseSlot` (`:138-142`) is the sole `tryDequeue` caller; `tryDequeue` (`:208-255`) spawns
  without state checks; `_claimQueueEntry`/`_restoreQueueClaim`/`_reconcileQueueClaims`
  (`:168-206`) are the launch-lease mechanics that must not be broken; `reconcile` (`:261-279`)
  only touches slots.
- `core/cancel.js` — `cancelJob` (`:35-241`): the terminal-state early return (`:47-49`), the
  cancel-request write (`:82-83`), the journaled `to: 'cancelled'` (`:228-238`). Note a `queued`
  job reaches the end of this function with `pidKnown=false`, `started=false` and exits 0.
- `core/commands/cancel.js` — the command wrapper; `containment: null` hardcoded at `:43`.
- `core/commands/worker.js` — the queued path (`:85-105`): journals `queued`, renames the queue
  claim back to a plain entry (`:97-98`) or enqueues (`:100-104`), then `process.exit(0)`.
- `core/reducer.js` — the reconciliation gate (`:172-175`) that skips `queued`; the evidence shape
  near it (workerAlive, hasSentinel, tokenMismatch) so a `queued` reconciliation can be added in
  the same style.
- `core/job-lookup.js` and wherever `reconcileStatus`/`regenerateStatus` collect evidence — the
  caller that would supply a "queue entry present?" fact to the reducer.
- `cli/dcli.js:160` — the startup `admissionController.reconcile()`.
- `tests/core/admission.test.js`, `tests/core/cancel.test.js` — existing coverage to extend.

## What to build

1. **`cancelJob` removes the queue claim for a queued job.** In `core/cancel.js`, before (or
   instead of) the cancel-request write when `status.state === 'queued'`: delete
   `queue/<jobId>.json` and any `queue/<jobId>.launching-*.json` claim **under the admission lock**
   (use `LockManager.tryAcquire('admission','global')` — never an unlocked unlink racing a
   `_claimQueueEntry` rename). Idempotent: absence is fine. The existing exit-0 cancelled outcome
   for queued jobs is preserved — the only change is that the queue entry is gone. Release the lock
   even on error.
2. **`tryDequeue` skips jobs that are no longer queued.** Give `AdmissionController` a
   job-state reader (constructor option `readJobState: async (repoKey, jobId) => state | null`,
   defaulting to a `JobStore`-backed reader over `this._stateRoot` — `core/admission.js` already
   receives `stateRoot` and `JobStore` lives in `core/`, no backend dependency is introduced). In
   the dispatch loop (`:225-252`), skip an entry whose job state is terminal (`done`/`failed`/
   `timed_out`/`cancelled`/`interrupted`). The launch-lease (`_claimQueueEntry`) and its rename
   semantics are unchanged.
3. **Nudge the queue after every reconciliation.** After `admissionController.reconcile()` in
   `cli/dcli.js:160` and after `admission.reconcile()` in `core/commands/worker.js:68`, call
   `tryDequeue()` (or add the nudge inside `reconcile()` itself — one line at the end; `reconcile`
   is only called at CLI startup and worker startup, both safe places to dispatch). `tryDequeue`
   already respects capacity and the launch lease, so an unconditional nudge is safe. This is the
   fix for the "every slot holder died" path: the next command reclaims the slots *and* dequeues.
4. **A stranded `queued` job reaches a terminal state.** Extend the reducer's reconciliation gate
   (`core/reducer.js:172-175`) to include `queued`, and add a `queueEntryPresent` fact (boolean)
   to the evidence the reconciliation caller supplies. A `queued` job with
   `queueEntryPresent === false`, no live worker and no slot reconciles to terminal `failed` with
   `failure_reason: 'queue_stranded'`. Never reconcile a `queued` job to terminal while its queue
   entry (or a live launch claim) still exists — the relaunch path must stay the only path that
   makes it run.
5. **Doc the `queued` state.** `docs/design-spec.md` §6's state list
   ("`created` → `running` → one of `done` | `failed` | `timed_out` | `cancelled` | `interrupted`")
   gains the `queued` transition (`created` → `queued` → `running` → terminal) and a sentence
   describing the queue lifecycle this ticket makes true: a queued job always either runs or
   reaches a terminal state, and a cancelled job is never launched from the queue.

## Non-goals

- **No retry/backoff redesign.** `reason: 'contention'` queueing may still happen; this ticket
  only guarantees the queue drains and cancels stick. (Audit suggested bounded-backoff retry on
  contention instead of queueing; that is a separate design decision, and queueing is the shipped
  contract.)
- **No admission-capacity exit-code change.** Exit 14 for at-capacity is ticket 119's scope.
- **No change to the foreground path** (`run`/`resume` never queue; the reducers they drive must
  not see new behaviour).
- **No removal of the launch lease.** The `.launching-` claim mechanics are load-bearing against
  double-launch and stay as they are.

## Acceptance criteria

- [ ] **A.** Cancelling a `queued` job leaves no entry in `queue/` and the job ends `cancelled`
  with exit 0, and it is never launched later.
- [ ] **B.** Killing every slot holder (and the dispatcher) of a queued job, then running any
  command that reconciles (e.g. `dcli status`), causes the job to leave `queued`: either a worker
  starts (capacity freed) or the job reconciles to terminal `failed` (`queue_stranded`).
- [ ] **C.** A queued job whose entry still exists is never retired by reconciliation.
- [ ] **D.** The reducer still owns every terminal state; the queue code only adds/removes entries
  and facts.
- [ ] **E.** `npm run check` green; tracker table regenerated; `docs/design-spec.md` §6 updated in
  the same commit.

## Agent checks

```bash
# What this proves, in one line: a cancelled queued job leaves no queue entry.
# (follow the existing admission test fixtures; run the suite)
npm test -- --grep "admission"   # expect: green, including the new cancel-queued tests

# What this proves: no terminal state is decided outside the reducer.
rg -n "to: '(done|failed|timed_out|cancelled|interrupted)'" core/admission.js
# expect: (nothing)

# What this proves: tryDequeue consults job state before spawning.
rg -n "readJobState" core/admission.js
# expect: at least the declaration and one use in the dispatch loop
```

## Notes

(Left empty by the author. The implementer fills it in: what was changed and where, build and suite
results, the Agent checks' actual output, any deviation from this ticket and why, and anything
discovered that contradicts the docs.)
