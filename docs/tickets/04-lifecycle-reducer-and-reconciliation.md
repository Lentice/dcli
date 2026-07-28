# 04 — Lifecycle reducer, reconciliation, `interrupted`

**Blocked by:** 02, 03
**Status:** ready-for-agent
**Read first:** [00-onboarding.md](00-onboarding.md) §4, and `AGENTS.md` §1 and §5.

---

## Purpose

One engine-owned reducer turns adapter facts into job state, and a job whose worker died is reported
honestly instead of appearing to run forever.

## Why it matters

Two of the predecessor's worst bugs live here.

**"Permanently running."** A job whose worker died with no completion evidence stayed `running` forever,
so `wait` never returned. Reconciliation needed several fixes: a malformed-evidence guard, a job-id
match, a producer exit-code contract, and PID-reuse-safe liveness.

**"`cancelled` that killed nothing."** Because the kill was gated on `state === 'running'`, cancelling a
`created` job wrote `cancelled` and skipped the kill, leaving a live worker that later overwrote the
record.

Both come from the same root cause: state was inferred ad hoc at several call sites instead of by one
reducer over recorded evidence.

## Design

### One reducer, one place

```
reduce(currentState, facts[], evidence) → { state, phase, failure? }
```

`evidence` is everything durable: process liveness by identity+token, the completion sentinel, the
result file and its size, the heartbeat age, the journal.

There is **no universal completion criterion.** For a single-shot child, `process_exited` + a validated
non-empty result + a completed drain may be terminal. For a server-backed backend, an idle
`backend_status` is one input among several. The reducer weighs evidence; adapters never declare
terminality.

### States and phases

States: `created` → `running` → `done` | `failed` | `timed_out` | `cancelled` | `interrupted`.

`interrupted` means the controlling process died. Recovery **never reattaches** to a running backend; it
records `interrupted` and a later `resume` starts a new attempt.

Phases are progress only: `validating`, `preparing`, `worktree_creating`, `worker_launching`,
`server_starting`, `session_creating`, `agent_starting`, `agent_running`, `result_collecting`,
`snapshot_committing`, `finalizing`, `terminal`.

### Reconciliation rules

Reconcile to a terminal state when **any** of these holds and the job claims to be running:

- Worker identity (pid + creation time + image path + execution token) is provably gone.
- The completion sentinel is absent and the heartbeat is stale beyond its threshold.
- The backend process is gone while result/event evidence indicates a terminal outcome.

Guards that must be present, each of which was a real bug:

- **Job-id match**: evidence files must name this job. Never accept a foreign sentinel.
- **Malformed-evidence guard**: unparseable evidence means "no evidence", not "success".
- **Producer exit-code contract**: an orphan reconciled from evidence goes to `failed` unless the
  evidence proves otherwise. Default to failure, never to success.
- **PID-reuse safety**: a recycled pid is not liveness.

### Zero-wait reads

`status`, `read`, `wait`, and `list` must reconcile **without** taking the writer's lock. They read the
projection and the journal; they never block behind a running worker. This was a deliberate performance
fix in the predecessor and it is a correctness property too — a diagnostic command that hangs is useless
precisely when you need it.

## Pitfalls

- **Never gate a kill on `state === 'running'`.** A `created` job may have a live worker.
- **Never treat `phase` as terminal.** Add a test that greps for phase-based terminality checks.
- Reconciliation must **preserve** `failure_reason` and `backend_session_id` — a past bug dropped both,
  destroying the diagnosis.
- Do not reconcile a job you do not own without proof; two reconcilers racing must converge, not fight.

## Checklist

- [ ] Exactly one reducer function decides state; a test asserts no other module writes `state`.
- [ ] States include `interrupted`; recovery never reattaches to a running backend.
- [ ] Phases are recorded as progress; a test asserts `phase` is never used as a terminal signal.
- [ ] A property-style test over generated fact/evidence sequences proves **no input leaves a job
      permanently `running`**.
- [ ] Job-id match, malformed-evidence guard, failure-by-default, and PID-reuse safety each have a test.
- [ ] Reconciliation preserves `failure_reason` and `backend_session_id` (regression test plants both).
- [ ] `status` warns when the process outlives the completion evidence.
- [ ] Heartbeat is written every 5 s while a worker owns the attempt; a stale heartbeat triggers
      reconciliation.
- [ ] `status`/`read`/`wait`/`list` are zero-wait: a test with a lock held by a fake worker proves they
      still return promptly.
- [ ] Cancelling a `created` job with a live worker kills it (asserted here, implemented in ticket 08).

## How to verify

```powershell
node tests/run-tests.js --suite full
```

Manually: start a fake-adapter job, kill the worker process hard, then run `status`. It must terminalize,
explain itself, and never say `running`.

## Definition of done

Full suite green including the "never permanently running" test and all four reconciliation guards.

## Commit message

```
feat: engine-owned lifecycle reducer with evidence-based reconciliation
```

## Notes

Implemented:

- `core/reducer.js` — single `reduce(state, facts, evidence)` function. Synchronous, zero-wait.
  Returns `{ state, phase, failure?, failure_reason?, backend_session_id?, warning? }`.
- `core/job-store.js#writeHeartbeat` — writes `heartbeat_at` via journal entry.
- `tests/core/reducer.test.js` — 16 tests covering all checklist items.
- `tests/core/job-store.test.js` — tests 17 and 18: heartbeat writer + zero-wait reads.

Design notes:
- PID-reuse safety is delegated to the evidence layer: the evidence layer must check
  `executionToken` against the stored `execution_token` and set `workerAlive = false` on
  mismatch. The reducer accepts `executionTokenMatch` as optional evidence input.
- The 5s heartbeat interval is the caller's responsibility (the engine that runs the
  worker calls `writeHeartbeat` every 5s). The reducer only reacts to stale heartbeats.
- Zero-wait is inherent: `readStatus` and `regenerateStatus` are O(1) file reads with
  no locking, and `reduce` is a pure synchronous function.
