# 51 — Admission liveness counts reused PIDs as live slots

**What to build:** an admission slot is only counted as held when its owner is provably the same process
that acquired it (`pid + creation time + image path`, plus the execution token already stored in the slot
file) — not when its mere PID is alive, so a PID reused by an unrelated process cannot permanently starve
admission capacity.

**Blocked by:** None — can start immediately (this is ticket-36 checklist item 3, never satisfied by
commit `8bd5995`)

**Status:** ready-for-agent

- [ ] `core/admission.js` `_isSlotAlive` verifies the full identity tuple stored in the slot file — pid
      AND creation/start time AND image path AND execution token — for non-self pids, not only
      `process.kill(pid, 0)`.
- [ ] `core/locking.js` `_isStale` has the identical gap for non-self pids (see Notes) — this ticket
      introduces a real identity-verification helper (pid + startTime + imagePath, using
      `core/process-identity.js`'s existing comparison primitives) and both `admission.js` and
      `locking.js` are updated to use it, rather than one being fixed and the other left divergent.
- [ ] Regression test: plant a slot record for a pid, simulate that pid exiting and its pid being reused
      by an unrelated process (creation time/image path differ), and assert admission does **not** count
      the reused-pid process as holding the slot — the slot is reclaimed and capacity frees.
- [ ] The verification call itself is bounded (invariant #3); it never blocks waiting on a process.
- [ ] Full suite green.

## Notes

`core/admission.js` writes startTime, imagePath, hostname, and executionToken into every slot file, and
ticket 36 explicitly required (checklist item 3) a PID-reuse test. But `_isSlotAlive` for a non-self pid
still only runs:

```js
try { process.kill(meta.pid, 0); return true; } catch (err) { if (err.code === 'EPERM') return true; return false; }
```

**Correction (verified against current code, 2026-07-30): `core/locking.js` `_isStale` is *not* a
working model to copy.** It only compares `meta.startTime`/`executionToken` against the holder's own
identity in the *self-pid* branch (`meta.pid === this._ownIdentity.pid`). For a non-self pid — the
reused-pid case this ticket is about — it falls straight through to `isProcessAlive(meta.pid)`, which is
the same bare `process.kill(pid, 0)` check `admission.js` uses. So `locking.js` has the identical
reused-PID gap; it just hasn't been reported as a separate ticket. Leaving either on bare-PID liveness
means a reused pid is counted as live forever — capacity quietly leaks until manual `reconcile`/cleanup.

Do not port `_isStale`'s existing behavior into admission unchanged. Instead, build a real
`isSameProcessAlive(identity)` helper in `core/process-identity.js` (pid + startTime + imagePath,
reusing the module's existing identity-comparison primitives) and have **both** `admission.js`
`_isSlotAlive` and `locking.js` `_isStale` call it for the non-self-pid case. Scope the change so
self-pid checks (`executionToken`/`startTime` match against `this._ownIdentity`) are untouched — only
the non-self bare-`process.kill` fallback is replaced.