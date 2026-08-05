# Ticket 85 — records with no launch identity can never reach a terminal state

**Status:** done (2026-08-04)
**Tier:** cleanup of the wreckage 84 stops producing. Small, but without it every installation keeps a
permanent `running` job that no command can retire.
**Blocked by:** 84 (the identity must exist before "identity is absent" is a meaningful signal), and 82
(a record that becomes cleanable must not leave its worktree behind).

---

## Symptom

A job whose record has `worker_pid: null` and `worker_identity: null`, a heartbeat hours or days stale,
and no completion sentinel:

- reconciliation leaves `workerAlive` **undefined** — not `false` — so the job stays `running`;
- `cancel` has nothing to kill and reports `termination_unconfirmed` without changing state;
- `cleanup` only takes terminal jobs, so the record is permanent.

Two such records existed on this machine, four days old, from before any of this was understood.

## Why 84 does not cover it

84 makes new jobs provable. It does nothing for records already on disk, and nothing for any future path
where the identity genuinely could not be written (a spawn journaled at the wrong instant, a state root
restored from backup, a record written by an older version). "No identity" must therefore resolve to
something, and today it resolves to "wait forever" — invariant #3.

## The rule to implement

Anchor the decision to the job's **own recorded deadline**, not to a new tunable. A job is resolved to
`interrupted` when *all* of these hold:

- there is no worker identity and no worker pid to check;
- the heartbeat is absent or older than the liveness window;
- there is no completion sentinel;
- the job's own hard-timeout deadline has already elapsed.

The last condition is what makes this safe: if the worker were alive, hard-timeout enforcement would have
killed it by then, so a job past its own budget with no evidence of a worker is not a job that might
still finish. It also introduces no constant — the deadline is already in the record — and it cannot fire
against a job still inside its budget.

`failure_reason` must name the ambiguity (`worker_identity_missing`, or whatever the contract's
append-only vocabulary permits) so the record says *why* it ended. It must never be `cancelled`: that
claims the tool killed something, and it killed nothing. It must never be `done`.

## Acceptance criteria

- [x] **A.** A record with no identity, a stale heartbeat, no sentinel, and an elapsed deadline resolves
  to `interrupted` with a `failure_reason` that names the missing identity, on the next read.
- [x] **B.** The same record **inside** its deadline stays `running`. A job that might still be working is
  never retired by this rule.
- [x] **C.** A record with an identity is untouched by this path — it goes through 84's liveness proof.
- [x] **D.** Once resolved, the job is eligible for `cleanup`, and its worktree goes with it (82).
- [x] **E.** Reconciliation preserves `failure_reason` and `backend_session_id` across this transition —
  a past bug dropped both.
- [x] **F.** No new environment knob or tunable constant is introduced for the age judgement.
- [x] **G.** `npm run check` green; the state-machine addition documented in the design spec in the same
  commit, since terminal-state derivation is a binding contract.

## Notes

- 2026-08-04: the two records that motivated this were from synchronous `run` invocations, so whatever 84
  decides about `run` journaling its own identity changes how often this path is reached — but not
  whether it is needed, since older records will exist regardless.
- 2026-08-04 implementation: the reducer resolves identityless legacy records only after their recorded
  hard-timeout deadline, preserves existing failure metadata, and cleanup removes their worktrees with the
  job record. Regression coverage exercises the expired, in-budget, identity-backed, metadata-preserving,
  and cleanup paths.
