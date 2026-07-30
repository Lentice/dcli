# 67 — Admission and locking liveness ignore PID identity for non-self pids (PID reuse permanent slot leak)

**What to build:** this is the unfinished half of ticket 51 (which only ADDED a doc note about the PID-reuse risk — it didn't change the liveness code). A non-self pid held in an admission slot or lock file is only considered "alive" when its full identity tuple (`pid + creation time + image path`, plus the execution token already stored) matches the recorded owner. The bare `process.kill(pid, 0)` check stays for the self-pid branch (whose `executionToken` already disambiguates) but is replaced by full identity verification for non-self pids.

**Blocked by:** Ticket 51 (only because 51 already documented the gap — implement the actual fix here, don't expand 51)

**Status:** ready-for-agent

## Acceptance criteria

- [ ] A new helper `isSameProcessAlive(identity)` in `core/process-identity.js` — pid + startTime + imagePath, plus the existing `executionToken` for self-pid match — verifies the recorded owner is the same OS process before treating a held slot/lock as live. Reuse the existing comparison primitives in `process-identity.js`.
- [ ] `core/admission.js` `_isSlotAlive` (around line 71-90): for non-self pids, calls `isSameProcessAlive` instead of `process.kill(meta.pid, 0)`. The self-pid path (which already executes the `executionToken` match) is untouched.
- [ ] `core/locking.js` `_isStale` (around line 230-250): same fix for the non-self-pid branch. The self-pid branch (which compares `meta.startTime` against `this._ownIdentity.startTime`) is untouched.
- [ ] The verification call itself is bounded (Invariant #3): `process.kill(pid,0)` plus a `process-identity` lookup is synchronous and fast; ensure no path blocks waiting on a process.
- [ ] Regression test: plant a slot record for a pid, simulate that pid exiting and its pid being reused by an unrelated process (creation time/image path differ), and assert admission does NOT count the reused-pid process as holding the slot — the slot is reclaimed and capacity frees.
- [ ] Same regression for `locking.js`: a lock file pointing at a reused pid is recognized as stale and quarantined.
- [ ] Full suite green.

## Development guidance

- Ticket 51 already documented the gap and explicitly says: "Do not port `_isStale`'s existing behavior into admission unchanged. Instead, build a real `isSameProcessAlive(identity)` helper." Follow that direction.
- On Windows, `creation time` of a process is queryable via `wmic process where processid=<pid> get CreationDate` (slow — avoid), or via `GetProcessTimes` (Win32, fast). A pure-Node portable check via `process.kill(pid, 0)` only gets liveness; consider whether to consult the recorded `startTime` only as an ISO-string-equality check, or to do a real OS query. The contract is "do not trust the bare pid alone"; a cheap improvement today is: keep `process.kill(pid, 0)` as liveness AND refuse to treat the slot as alive unless `meta.executionToken` still resolves to a meaningfully-structured match. For production-quality, lazy-fetch startTime via Win32 (used by ticket 06's containment code) — coordinate if that infra exists.
- The AGENTS rule lists identity as `pid + creation time + image path` plus a random `execution_token` for proof of ownership. The recorded slot/lock file already has all four. The check is "do the recorded values still describe THIS process?" — for a self-pid, the `executionToken` already proves it; for a non-self pid, the `startTime` + `imagePath` do.
- Do NOT, in this ticket, fix the corrupt-lock-file blocking (ticket 68) or the quarantine recursion. Keep this scoped to identity verification only.

## Why it matters

A worker that dies while owning an admission slot has its pid reused by an unrelated process (common on busy Windows machines — pids recycle fast); the slot is counted as held forever, quietly leaking capacity until the operator runs `reconcile` by hand. In the predecessor this silently reduced throughput over days of use (AGENTS §4: "Identity is `pid + creation time + image path`").

## How to verify

```powershell
node tests/run-tests.js --suite full
```

## Commit message

```
fix(admission,locking): non-self pid liveness verifies full identity tuple, preventing pid-reuse slot leaks
```