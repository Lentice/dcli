# Ticket 84 — launch identity is never persisted, so `cancel` kills nothing and no death can be proven

**Status:** done (2026-08-04)
**Tier:** blocker. This is AGENTS.md mistake #5 in the shipped code, and it produces both failures that
rule was written to prevent — simultaneously.
**Blocked by:** none — can start immediately.

---

## Symptom

Two jobs from 2026-07-31, still `running` four days later:

```
$ dcli debug 20260731T080301Z-1arf6zl1
State: running  Phase: agent_running  Attempt: 1
Worker: pid=null identity=- alive=unknown

$ dcli cancel 20260731T080301Z-1arf6zl1
Cancel termination_unconfirmed (state: running)
```

The state does not change, and `cleanup` only takes terminal jobs, so the record is permanent. This is
not specific to those two jobs: **no job has a worker identity.**

## Root cause

Nothing in production ever writes `worker_pid` or `worker_identity`:

- `core/commands/submit.js` spawns the detached worker and has `child.pid` in hand at that moment. It
  journals a spawn *failure*; it never journals the identity of a spawn that succeeded.
- `core/process-identity.js` exports the helper that builds `{ worker_pid, worker_identity }`. It has no
  caller.
- `core/job-store.js` initialises both fields to `null`, and reconciliation reads them to decide whether
  the worker is provably gone.
- `core/commands/cancel.js` reads `worker_pid` to decide what to kill.

So both consumers read a field no producer writes. Reconciliation cannot prove death, so a job whose
worker is gone stays `running` until something else terminates it. `cancel` has no pid, so it kills
nothing and reports `termination_unconfirmed` — the "wrote `cancelled` while killing nothing" failure
AGENTS.md §5 describes, one rung short of actually claiming success.

**Why the suite is green.** Every test that exercises the read side sets `worker_pid` on the record
directly, so `cancel`'s rungs and reconciliation's liveness logic are covered against fixtures while the
write side is covered by nothing. Same cliff as the `_testMode` short-circuit: a mocked-out path is an
uncovered path, and no test count reveals it.

## Design constraints

- **Persist before it can be lost.** The identity must be journaled at the instant the process exists,
  not after the launch sequence returns — a crash between those two points is the case that produced a
  permanently-stuck job in the predecessor.
- **Identity is `pid + creation time + image path`**, plus the execution token for proof of ownership. A
  bare pid is creation-time ancestry with no proof of who holds it now; `job-store.js` already prefers
  the recorded identity over the bare pid for exactly this reason.
- **Ownership of the backend is a separate fact** from the identity of the worker. Do not conflate them.

## What to build

A submitted job records who is executing it, at the moment that becomes true, so that afterwards:
`cancel` can kill the real process tree and confirm it; reconciliation can prove a dead worker and
resolve the job to `interrupted` on its own, with no new heuristic and no age threshold; and `debug`
reports a real pid and identity instead of `pid=null identity=-`.

## Acceptance criteria

- [x] **A.** After `submit` returns, the record carries a `worker_pid` and a `worker_identity` for the
  spawned worker. Asserted on the real spawn path, not by writing the fields in the test.
- [x] **B.** `cancel` on a live submitted job terminates the worker's process tree and confirms it — exit
  0 with a terminal state, not `termination_unconfirmed`.
- [x] **C.** Killing a worker out-of-band leaves a job that the next read resolves to `interrupted`,
  preserving `failure_reason` and `backend_session_id`.
- [x] **D.** The identity is durable across a crash of the launching process between spawn and the end of
  the launch sequence: a job whose launcher dies immediately after the child exists is still cancellable
  and still reconcilable.
- [x] **E.** Reconciliation prefers identity over bare pid, and a reused pid whose identity does not
  match is treated as "worker gone", not "worker alive".
- [x] **F.** A test asserts the child's own observable behaviour, never that `spawn` did not throw.
- [x] **G.** `npm run check` green; docs updated in the same commit.

## Notes

- Ticket 81's Notes record a sibling observation from the other direction: `status.json.backend_pid`
  stays `null` even after the adapter emits a `started` fact carrying a real pid. This ticket folds that
  field into the same fix: the shared engine now journals `backend_pid` and `backend_session_id` for a
  `started` fact, for both foreground attempts and detached workers.
- The synchronous `run` path has the same gap for a different reason: its "worker" is the CLI process
  itself, so a `run` killed by an outer tool's timeout leaves the same unprovable record. It already
  journals its own process identity before adapter startup; no additional run-path change was needed.

## Notes — 2026-08-04 implementation

- `submit` journals the detached child's pid, OS creation identity when available, and execution token
  immediately after `spawn` returns, before waiting for worker startup. The token is passed to the worker
  and retained across admission queue re-launches.
- Queued workers clear the exited launcher's identity and persist the replacement child's identity before
  it can be lost. If identity persistence fails, the child is terminated rather than left untracked.
- `tests/core/submit-launch-identity.test.js` delays worker startup, observes the real child pid and
  backend pid on disk, and confirms cancellation through the public command. It asserts live process
  behaviour and never treats "spawn did not throw" as success.
