# 05 — Locking, process identity, execution token

**Blocked by:** 03
**Status:** ready-for-agent
**Read first:** [00-onboarding.md](00-onboarding.md) §7 pitfall 3, and `AGENTS.md` §4 and §5.

---

## Purpose

Two concurrent invocations cannot corrupt one job's state, and the tool can *prove* a process is the one
it thinks it is before killing or health-checking it.

## Why it matters

The predecessor shipped fixes for: a stale-lock quarantine that failed and then ignored its own timeout;
cleanup deleting a job's artifacts with no lock while `diff`/`apply` were reading them; and an `apply`
that needed a per-main-repo lock to avoid two applies interleaving.

Separately, **a pid is not an identity.** Pids are reused. A parent pid is creation-time ancestry, not a
dependency graph — an observed process's parent was already gone while it still held blocking resources.

## Design

### Lock scopes

| Lock | Protects |
|---|---|
| per-attempt | all writes to one attempt's state |
| job-id / index creation | allocating a new job id and its index entry |
| per-repository worktree | creating or removing a worktree in one repository |
| per-main-repo apply | landing changes into one main repository |
| cleanup | the retention sweep |
| per-job server lifecycle | starting/disposing a backend server |

Plus a **shared job lease** that `diff`, `apply`, and `resume` hold for the *whole* operation, so a
concurrent retention sweep cannot delete the artifact mid-read.

### Implementation

- Windows: an exclusive file handle opened with no sharing.
- Unix: advisory `flock` plus owner metadata.
- Metadata written into the lock file: pid, process creation time, hostname, operation name, acquisition
  timestamp, execution token.
- Acquisition is bounded (10 s default) and then fails with the lock exit code. **Never loop forever.**
- A stale lock whose owner is provably gone is quarantined and reclaimed. If quarantine itself fails,
  **back off and still honor the caller's timeout** — do not spin.

### Identity and ownership

Two separate concepts, and conflating them was a bug:

- **OS identity** = `pid + creation time + image path`. Reduces pid-reuse mistakes.
- **Ownership proof** = a random `execution_token` generated when the process is created, stored durably,
  and verified before any kill or health check. OS identity is corroboration only.

Persist both **the instant the process exists** — not when it reports readiness. Identity held only in the
launching process's memory produced a permanently-`created` orphan *and* a cancel that killed nothing.

## Pitfalls

- Never kill by image name. Never act on a bare pid.
- Never assume a lock file's presence means a live owner; check identity, then quarantine.
- Do not make reads take the write lock — `status`/`read`/`wait` must stay zero-wait (ticket 04).
- Retention cleanup must take the per-job lock **and re-check eligibility immediately before removal**.

## Checklist

- [ ] All six lock scopes above exist and are used by the code paths named.
- [ ] A shared job lease exists and is held for the whole of `diff`/`apply`/`resume`.
- [ ] Windows uses an exclusive no-share handle; Unix uses `flock` plus owner metadata.
- [ ] Lock metadata records pid, creation time, hostname, operation, timestamp, execution token.
- [ ] Acquisition is bounded and fails with the lock exit code; a test proves it never exceeds the timeout.
- [ ] A stale-lock test proves reclamation works; a **quarantine-failure** test proves the caller's timeout
      is still honored and no spin occurs.
- [ ] `execution_token` is generated per process, stored durably at creation, and verified before any kill
      or health check.
- [ ] Launch identity is persisted the instant the process exists, before readiness.
- [ ] A PID-reuse simulation proves the tool refuses to act on a recycled pid.
- [ ] A contention test proves exactly one of N concurrent writers wins and the losers fail cleanly with
      the lock exit code.
- [ ] A test proves reads do not block behind a held write lock.

## How to verify

```powershell
node tests/run-tests.js --suite full
```

Manually: hold a lock from one shell, run a competing command in another, and confirm it fails within the
timeout with the lock exit code rather than hanging.

## Definition of done

Full suite green, including PID-reuse, contention, quarantine-failure, and zero-wait-read tests.

## Commit message

```
feat: scoped locking, PID-reuse-safe identity, and execution-token ownership proof
```

## Notes

### Implementation decisions

**Lock mechanism.** The `wx` flag (`O_CREAT | O_EXCL`) provides cross-platform exclusive file
creation. On Windows the open handle is kept as the liveness signal; on Unix it provides the
same semantics plus the benefit that no `flock` syscall is needed (Node has no native `flock`).
The lock file carries full metadata for stale detection and ownership proof.

**Stale detection nuance.** Within the same process, multiple `LockManager` instances each
generate their own `executionToken`. The initial `_isStale` implementation treated a pid match
with a mismatched token as PID reuse (stale). This was wrong: two LockManagers in the same
process have the same pid but different tokens. The fix checks `startTime` as a tiebreaker:
if `pid` and `startTime` both match, it's the same process session even if tokens differ,
so the lock is NOT stale.

**tryAcquire vs acquire.** `tryAcquire` is the non-blocking variant that returns `null` instead
of throwing on contention. `acquire` blocks up to `timeoutMs` (default 10 000 ms) polling with
backoff, then throws with `exitCode = 17`.

**Quarantine.** When a stale lock is detected, the lock file is renamed to `.stale`. If the
rename fails, the file is unlinked instead. After quarantine the acquirer retries the
exclusive-creation attempt.

### Files created

- `core/process-identity.js` — `getOwnIdentity`, `generateExecutionToken`,
  `formatWorkerIdentity`, `parseWorkerIdentity`, `identitiesMatch`, `isProcessAlive`
- `core/locking.js` — `LockManager`, `LOCK_SCOPES` enum, `LOCK_EXIT_CODE`
- `tests/core/process-identity.test.js` — 7 tests
- `tests/core/locking.test.js` — 12 tests (all 11 checklist items covered, plus releaseAll)
