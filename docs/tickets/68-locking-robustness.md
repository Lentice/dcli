# 68 — Locking robustness: corrupt lock file blocks forever; quarantine recursion can stack-overflow; CPU busy-wait backoff

**What to build:** `core/locking.js` no longer permanently blocks on a corrupt lock file, no longer recurses unboundedly when quarantine fails, and no longer spins a CPU core at 100% during backoff. All three are separate-but-related defects in the same module that become landing-critical at scale (a single corrupt lockfile stalls every later lock attempt; AV temporarily holding the file makes quarantine recurse to stack overflow; contention pins a CPU).

**Blocked by:** None — can start immediately (coordinate with ticket 67 — both touch `core/locking.js` `_isStale` and the identity helpers; sequence 67 first)

**Status:** ready-for-agent

## Acceptance criteria

### A. Corrupt lock file no longer blocks forever
- [ ] `core/locking.js` `_isStale` (around line 233-234): when `_readMetadata` returns `null` (corrupt/unreadable lock), the lock is treated as stale AND quarantine is attempted — NOT treated as a healthy held lock. Today the `return false` on null-metadata blocks `acquire` against the corrupt lock for the entire 10s `_timeoutMs` per attempt.
- [ ] Quarantine itself is bounded: if quarantine fails (AV holds the file, ACL prevents rename), the lock is treated as permanently broken, NOT retried recursively forever.

### B. Quarantine recursion cannot stack-overflow
- [ ] `tryAcquire` (around line 186-189) does NOT recurse on the `EEXIST`-stale branch. Iterative loop with a bounded attempt count (e.g. 3 retries, then give up). If `_quarantine` fails to remove/rename, fail the `acquire` rather than recurse.
- [ ] Test: simulate `_quarantine` failing 1000 times in a row — assert no stack overflow (the iterative loop should exit at the attempt cap, not recurse).

### C. CPU busy-wait removed
- [ ] `core/locking.js` (around line 138) `while (Date.now() - start < delay) {}` is replaced by `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay)` (or `child_process.execSync` sleep). The wait keeps synchronicity without pegging the CPU.
- [ ] `core/job-store.js` (around line 289) has the identical `while (Date.now() - start < delay) {}` busy-wait on the hottest path (`journalTransition` per write). Fix identically.
- [ ] Neither module holds the CPU pegged during contention — a stress test of N concurrent writes to a single lockfile doesn't pin a core (assert via CPU sampling, or a fast-path test that the wait doesn't busy-spin — `Atomics.wait` returns immediately if the value differs; the busy version consumes ~all CPU).

### Other
- [ ] Test: corrupt lockfile (a lock file containing non-JSON garbage) → `acquire` eventually quarantines and proceeds, NOT a 10s-per-attempt hang.
- [ ] Full suite green.

## Development guidance

- The `Atomics.wait` fix requires `SharedArrayBuffer`, which needs `--cross-origin-isolated` headers in a browser context but NOT in plain Node — confirm Node has it enabled by default for non-worker threads (it does since Node 16+). Fallback: spawn `cmd /c ping -n 2 127.0.0.1` or a tiny sleep — but `Atomics.wait` is preferable, no subprocess.
- A bigger refactor — backing off with exponential jitter — would help under contention. Don't scope it here; file a follow-up if interested. This ticket just makes the backoff not peg CPU.
- For the corrupt-lock fix: distinguish "I tried to read metadata and it's absent" (file missing — caller isn't expecting an existing lock, so this is fine) from "I tried to read metadata and the file exists but it's garbage" (corrupt — needs quarantine). Today both return `null` from `_readMetadata` and `_isStale` doesn't tell the two apart. Either return distinct values (`null` vs `CORRUPT`) from `_readMetadata` or check the file's existence separately in `_isStale`.
- The quarantine recursion is the worst of the three (a stack overflow takes down the process); fix it as `for (let attempt = 0; attempt < 3; attempt++) { …; if (quarantine succeeded) return acquired; }`.
- `core/job-store.js:289` is on the JOURNAL path — every `journalTransition` enters the busy-wait under contention. Fixing it improves worker throughput under high journal volume (long-running workers writing heartbeats every few seconds).

## Why it matters

AGENTS §3 ("Nothing blocks forever") and the bug history ("three separate fixes for the same class: the normal-exit drain, the doctor probe's drain, the concurrent stdin/stdout drain") apply directly. The corrupt-lockfile case is the lockholder equivalent of "the predecessor got stuck" — one bad lock file and the entire `dcli` install stops acquiring locks. The CPU busy-wait under contention is exactly the small Rules' "Avoid `Copy-Item -Recurse -Force` over an existing install" in spirit — a "small" implementation choice with outsized impact.

## How to verify

```powershell
node tests/run-tests.js --suite full
```

## Commit message

```
fix(locking): corrupt lockfiles quarantine, recursion is bounded, backoff no longer spins CPU
```