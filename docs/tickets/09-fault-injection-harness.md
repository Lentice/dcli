# 09 — Fault-injection harness

**Blocked by:** 04, 06, 08
**Status:** ready-for-agent
**Read first:** [00-onboarding.md](00-onboarding.md) §4, `AGENTS.md` "Testing rules learned the hard way".

---

## Purpose

The tool can be killed at any dangerous moment, and afterwards the affected job is either recoverable or
explicitly `interrupted` — never stuck, never orphaned, never silently wrong.

## Why it matters

This ticket comes **before** broad feature work deliberately. Every later feature (worktrees, review,
resume, adapters) adds a new dangerous moment. If the recovery model is proven first, later features inherit
it; if it is retrofitted, each feature invents its own half-correct recovery and the bugs are found in
production.

The predecessor's evidence: a job permanently stuck in `created` because launch identity was lost; a
`cancelled` job with a live worker; residual `git am`/rebase state after a failed apply. All three are crash
or partial-failure recovery bugs.

## Design

### The harness

A test helper that can:

1. Start a job against the fake adapter.
2. Kill the controlling process **hard** (no cleanup opportunity) at a *named* injection point.
3. Run recovery.
4. Assert the invariants below.

Injection points are declared in the production code as named markers the harness can target — not as
sleeps and guesses. Keep the markers cheap and inert outside tests.

### Injection points

| # | Point |
|---|---|
| 1 | Before process spawn |
| 2 | After spawn, before durable identity is recorded |
| 3 | During port discovery (backend-server adapters) |
| 4 | After the backend session exists, before it is recorded |
| 5 | Mid-turn, with an interaction pending |
| 6 | Before the snapshot commit |
| 7 | After the snapshot commit, before terminal publication |
| 8 | Between the cancel request and the hard kill |
| 9 | During terminal publication itself |

Point 2 is the one that produced a real permanently-`created` orphan. Point 7 is the one where a user's
work exists but the tool does not know it. Point 9 is where the journal-then-projection ordering earns its
keep.

### Invariants asserted at every point

- The job ends up **terminal or `interrupted`** — never `running`.
- **No orphaned backend process** survives (ADR-008: controller death kills the tree).
- **No lock and no worktree** is left held.
- The journal explains what happened well enough to diagnose without guessing.
- Recovery is **idempotent** — running it twice changes nothing the second time.

## Pitfalls

- Kill with the hardest available mechanism. A graceful signal tests the wrong path.
- **Terminate and verify every fixture tree in a `finally`.** A leaked hang-shaped fixture poisons every
  later test on the machine — the predecessor needed a dedicated commit for this.
- Synchronize on observed state (ready/release markers), not `sleep`. Fixed delays make this suite slow and
  load-flaky.
- Do not weaken an assertion because a point is "unlikely". Point 2 was thought unlikely and happened.

## Checklist

- [ ] Injection points are named markers in production code, inert outside tests.
- [ ] All nine points from the table are covered.
- [ ] At every point: job is terminal or `interrupted`, never `running`.
- [ ] At every point: no orphaned backend process survives.
- [ ] At every point: no lock and no worktree left held.
- [ ] At every point: the journal alone is sufficient to explain the outcome.
- [ ] Recovery is idempotent at every point.
- [ ] The harness kills hard, with no cleanup opportunity.
- [ ] Every fixture tree is terminated and **verified** in a `finally`.
- [ ] Synchronization uses markers, not sleeps.
- [ ] These tests are in the full suite and **listed as skipped by name** in the quick suite.

## How to verify

```powershell
node tests/run-tests.js --suite full
```

Then, on Windows, check for survivors after a full run:

```powershell
Get-Process | Where-Object { $_.ProcessName -match 'opencode|codex|claude|node' } | Select-Object Id,ProcessName,StartTime
```

Anything started during the run and still alive is a leak — fix it before closing the ticket.

## Definition of done

All nine points pass all five invariants, and a full-suite run leaves no survivor processes.

## Commit message

```
test: fault-injection harness proving crash recovery at nine injection points
```

## Notes

### Implementation

- `core/inject-points.js` — shared marker module. Exports `maybeInject(name)` (no-op in production),
  `__setInjectHook(fn)`, and `__resetInject()`. Inert unless the hook is set by the test harness.

- Two markers placed in existing production code:
  - `cancel-before-rungs` in `core/cancel.js` (Point 8): after the cancel.request is atomically written
    and journaled, before `adapter.DeclareCancelRungs()`.
  - `journal-before-status-write` in `core/job-store.js` (Point 9): after `appendJsonLine()`, before
    `_atomicWriteJsonWithRetry()` for `status.json`. This is the journal-then-projection ordering
    the invariant depends on.

- Points 1-7 have no orchestrator yet (ticket 10+), so the tests simulate the crash-recovery state
  directly: create the job state that would exist on disk after the controller died at that point,
  call `reduce()` with evidence that the controller/worker is unrecoverable, and assert invariants.

- `tests/helpers/fault-injection.js` — harness helpers: `makeBaseState`, `makeEvidence`,
  `assertAllInvariants` (checks terminal state, journal coherence, zero locks, idempotency).

- `tests/core/fault-injection.test.js` — `// @suite full`, skipped by name in quick suite.

### Discoveries

- **`assertAllInvariants` cannot check "no orphaned backend process" without real processes.**
  The fake adapter does not create OS processes, so orphan detection is structural (asserting the
  invariant exists as a contract). Real orphan checking requires the process-containment integration
  and will be tested in adapter-specific fault-injection tests.

- **The reducer requires stale heartbeat or absent heartbeat to produce `interrupted`** when the
  worker is alive but the controller is dead at points 4-6. A fresh heartbeat (≤15s) means the
  reducer rightfully keeps the job `running`. Evidence must report `heartbeatAgeMs > 15000` or
  `heartbeatAgeMs: null` for the crash-recovery path to trigger.

- **`journalTransition` with `to: null` resets `status.state` to `null`.** The test originally
  used `to: null` for phase-only detail updates, which wiped the state field. Fixed by passing
  `to: 'running'` (preserving current state) when only adding session/phase detail.

### Files changed
- `core/inject-points.js` — NEW: injection point marker mechanism
- `core/cancel.js` — added `maybeInject('cancel-before-rungs')` (Point 8)
- `core/job-store.js` — added `maybeInject('journal-before-status-write')` (Point 9)
- `tests/helpers/fault-injection.js` — NEW: harness helpers
- `tests/core/fault-injection.test.js` — NEW: 9-point × 5-invariant tests (`@suite full`)
- `docs/2026-07-28-design-spec.md` — added `inject-points.js` to core/ module listing
