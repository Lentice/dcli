# 49 — Queued jobs are never re-launched by `tryDequeue`

**What to build:** when an admission slot frees, a queued job is actually launched again (a worker is
spawned for it), not merely removed from the queue — a queued job must never sit in `queued` forever with
nothing to wake it.

**Blocked by:** None — can start immediately (this is the unfinished "dequeue must launch" half of ticket
36; commit `8bd5995` completed atomicity and slot-owner identity but not this)

**Status:** ready-for-agent

- [ ] `core/admission.js` `tryDequeue()` does not end at "reserve a slot and delete the queue entry"; it
      hands the dequeued job to a real launch (spawns the same detached worker that `submit` spawns), so
      the reserved slot is bound to a durably-launched worker.
- [ ] A queue entry is only deleted once the corresponding job's launch identity is durably persisted
      (mirrors ticket 29's "persist identity before it can be lost"). On launch failure the entry is
      retried or explicitly failed — never silently vanished.
- [ ] When capacity frees (a slot is released), at least one queued job is re-launched; a queued job does
      not require a new `submit` to start.
- [ ] Regression test: fill the backend limit, submit one more job (it goes `queued` and its worker
      exits), then release a slot; assert the queued job transitions out of `queued` and a worker runs it
      to a terminal state within a bounded window. Assert no queued job is stranded after slots free.
- [ ] Full suite green.

## Notes

Today the queued worker does `admission.enqueueJob(...)` then `process.exit(0)`
(`core/commands/worker.js`), so the job's process is gone. `AdmissionController.releaseSlot()` calls
`tryDequeue()`, which iterates the queue, calls `acquireSlot` for each entry, deletes the queue file, and
increments a counter — but **never spawns a worker**. So a dequeued job is stranded in `queued` forever
("nothing blocks forever" violated in a different shape). The launch leg of ticket 36 was never
implemented; this ticket closes it.