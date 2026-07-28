# 11 — tail, debug, cleanup, retention

**Blocked by:** 10
**Status:** ready-for-agent
**Read first:** [00-onboarding.md](00-onboarding.md), `AGENTS.md` §3, §6, §8.

---

## Purpose

A user can see what a job is doing right now, get a compact diagnosis of one that went wrong, and reclaim
disk from aged jobs without destroying anything they still need.

## Why it matters

`debug` is what you reach for when a job is behaving strangely — so it must never hang and never need a lock
a running worker holds. `cleanup` is the most destructive command in the tool, and the predecessor found two
real holes in it: an invalid `--repo` filter validated *after* the sweep started, and a retention value of
`0` that wiped every job. It also deleted a job's worktree with no lock while `diff`/`apply` were reading it,
destroying the only artifact needed to retry.

## Design

### `tail <job>`

Bounded tail of the worker log and backend events. Two specifics that were real bugs:

- **A "bounded tail" that reads the whole file and then slices is not bounded.** Seek to
  `max(0, length - maxBytes)`, then one read.
- An **oversized final line** must remain retrievable (a separate flag or a truncation marker pointing at the
  full artifact), never silently dropped.

### `debug <job>`

A compact, single-screen report. Include, at minimum:

- state, phase, attempt number, and — explicitly — **the warning when the process outlives the completion
  evidence**. This is the observed `finalizing`-for-14-minutes condition and it is the single most useful
  line in the report.
- worker and backend identity (pid + creation time + image), execution token presence, liveness verdict.
- containment mode and whether it is **degraded**.
- declared cancel rungs, and which one was used if cancelled.
- timings: created, started, last heartbeat, finished.
- result presence and byte size; `findings_status`.
- last N stderr lines (bounded).

`debug` must be **zero-wait** — it reads the projection and journal, never the write lock.

### `cleanup`

```
cleanup --dry-run                     preview only, deletes nothing
cleanup --older-than <Nd|Nh>          delete aged TERMINAL jobs
cleanup --scrub-session-ids           blank recorded backend session ids
```

Rules, each from a real bug:

1. **Validate every filter and range before any mutation.** An invalid `--repo` must delete nothing.
2. **Retention floor.** A minimum of 1 day (or explicit units ≥ 1). A `0` must never mean "everything".
3. Only **terminal** jobs are eligible.
4. Take the **per-job lock** and **re-check eligibility immediately before removal** — `diff`/`apply` hold a
   lease (ticket 05) and must win.
5. Remove the job's worktree, index entry, and per-job server metadata together; a partial sweep must be
   resumable.
6. **Do not over-count.** Increment counters only after a removal actually succeeded — the predecessor
   reported swept worktrees it had failed to remove.

## Pitfalls

- `--dry-run` must be genuinely inert. Test that the filesystem is unchanged, not just that output looks right.
- Cleanup runs concurrently with jobs. Take the cleanup lock and behave correctly under contention.
- Never delete a job whose lease is held, even if it is past retention.
- Bound every read in `debug` and `tail`; a huge event log must not blow memory.

## Checklist

- [ ] `tail` seeks before reading; a large-file test asserts bounded allocation.
- [ ] An oversized final line is retrievable, with a marker — never silently dropped.
- [ ] `debug` includes every field in the Design list.
- [ ] `debug` surfaces the process-outlives-completion-evidence warning explicitly.
- [ ] `debug` and `tail` are zero-wait; a test with a held write lock proves they still return.
- [ ] `cleanup --dry-run` deletes nothing; a test asserts the filesystem is byte-identical afterwards.
- [ ] Filter and range validation precede all mutation; an invalid `--repo` deletes nothing (regression test).
- [ ] Retention has a floor ≥ 1; a `0` or negative value is exit `2`, not "delete everything" (regression test).
- [ ] Only terminal jobs are eligible.
- [ ] Removal takes the per-job lock and re-checks eligibility immediately before deleting.
- [ ] A job whose lease is held is skipped, even when past retention (regression test with a fake `diff` holding it).
- [ ] Worktree, index entry, and server metadata are removed together; a partial sweep is resumable.
- [ ] Counters increment only after a successful removal (regression test with a removal that fails).
- [ ] `--scrub-session-ids` blanks recorded backend session ids so old jobs stop being resumable.

## How to verify

```powershell
node tests/run-tests.js --suite full
node cli/dcli.js --backend fake cleanup --dry-run
node cli/dcli.js --backend fake cleanup --older-than 30d
node cli/dcli.js --backend fake debug <job-id>
```

## Definition of done

Full suite green, including the four cleanup regression tests (invalid filter, retention floor, held lease,
failed-removal counting).

## Commit message

```
feat: bounded tail, compact debug report, and lease-aware retention cleanup
```

## Notes
