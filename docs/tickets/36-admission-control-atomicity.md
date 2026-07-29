# 36 — Admission control must be atomic and dequeue must actually launch

**Blocked by:** 29 (dequeue's fix only matters once there's a real worker-launch path to hand the
reservation to)
**Status:** ready-for-agent
**Read first:** [00-onboarding.md](00-onboarding.md), `AGENTS.md` "The nine mistakes" #4 and #5
(process identity, launch identity persistence).

---

## Purpose

`core/admission.js` must serialize count-and-reserve so concurrent submissions cannot collectively exceed
configured concurrency limits, must identify slot owners robustly (not by bare PID), and its dequeue path
must hand a freed slot to an actual job launch, not just delete the queue entry.

## Why it matters

Three independent problems compound here:
1. **Race:** if capacity-checking and slot-reservation aren't atomic, multiple concurrent `submit`/`run`
   invocations can each observe free capacity and each proceed, collectively exceeding the configured
   limit.
2. **Dead dequeue:** `tryDequeue()` removes a queue entry and reserves a slot for it, but nothing then
   launches the corresponding job — the queued work is silently dropped once ticket 29 makes `submit`
   capable of real dispatch, unless this is fixed alongside it.
3. **PID reuse:** liveness is checked by bare PID; if the process that held a slot exits and the OS reuses
   that PID for an unrelated process, admission can count that unrelated process as still holding the slot
   forever, permanently starving capacity.

## Evidence (verified via code read)

`core/admission.js`: count-then-create around line 104, dequeue loop around line 151, bare-PID liveness
check around line 67.

## Design

- Serialize the count-check-and-reserve sequence under the same kind of bounded lock used elsewhere in
  `core/locking.js` — acquire, check capacity, write the slot record, release, all under one lock hold, so
  no two callers can both observe the same free capacity.
- Identify slot owners by **pid + creation time + image path + execution token** (the same identity tuple
  used everywhere else per mistake #4), not bare pid, so a reused pid cannot be mistaken for a live owner.
- Change `tryDequeue()` so that removing a queue entry and launching the corresponding job are one
  transaction: do not delete the queue entry until the job's launch identity is durably persisted (mirrors
  ticket 29's "persist identity before it can be lost" requirement). If launch fails, the queue entry must
  either be retried or explicitly failed — never silently vanish.

## Pitfalls

- Do not hold the admission lock for the duration of an actual job launch — reserve the slot under the
  lock, then launch outside it, so a slow launch doesn't block unrelated admission decisions.
- Do not swap bare-PID liveness for a check that itself can block indefinitely — process-identity
  verification must be bounded.

## Checklist

- [ ] Count-and-reserve is atomic under a bounded lock; a concurrency test with many simultaneous
      submissions never exceeds the configured limit.
- [ ] Slot ownership is identified by pid + creation time + image path + execution token, not bare pid.
- [ ] A regression test plants a slot record for a pid, lets that pid exit, lets the OS (simulated in the
      test) reuse the pid for an unrelated process, and asserts admission does *not* count it as still
      held.
- [ ] `tryDequeue()` only removes a queue entry once the corresponding job's launch identity is durably
      persisted; a simulated launch failure leaves the queue entry retryable or explicitly failed, never
      silently gone.

## How to verify

```powershell
node tests/run-tests.js --suite full
node tests/core/admission.test.js
```

## Definition of done

Full suite green; a concurrency stress test against the fake adapter never exceeds configured limits, and
a dequeued job is provably launched (or explicitly and visibly failed), never silently dropped.

## Commit message

```
fix: admission control is atomic, identifies owners robustly, and dequeue actually launches
```
