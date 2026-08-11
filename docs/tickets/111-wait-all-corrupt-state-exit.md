# 111 — `wait --all` reports corrupt state as a caller timeout (exit 20 instead of 17)

**Status:** done
**Blocked by:** —
**Tier:** Exit 20 tells automation "active work merely exceeded its wait budget"; exit 17 tells
it "state is corrupt, stop waiting". Reporting the former for the latter sends a caller into
retry/wait loops against a condition that cannot clear by waiting. The code's own comment already
states the correct rule.
**Filed from:** 2026-08-11 dual-backend audit (codex F-3; verified with a malformed temp job —
result was `exitCode: 20, timedOut: true, errors: ["... journal.jsonl is missing ..."]`)

---

## Symptom / Goal

`dcli wait --all` handles corruption correctly **during** polling: the loop returns exit 17 with
`timedOut: false` when `listResult.errors.length > 0` (`core/commands/wait.js:65-81`). But the
final post-deadline read (`core/commands/wait.js:106-122`) returns `exitCode: 20, timedOut: true`
unconditionally, copying `listResult.errors` into the response as decoration. When the final read
itself hits an unreadable record, the caller gets 20 (budget elapsed) with an error payload saying
the state is corrupt.

The comment at `:108-110` documents the intended rule: "20 means 'still active, budget elapsed'.
A record we cannot read is not active work — it is corrupt state, which has its own code." The
code does not implement its own comment.

## Root cause

The final read result is not passed through the same corruption branch as the polling iterations —
an oversight between the loop's early-return and the deadline fall-through.

## Binding constraints — quoted, do not go looking for them

`docs/design-spec.md` §7:
"`17` | Lock acquisition or corrupt-state failure"
"`20` | Caller's `wait` timed out; job still active"

## Files to read and trace first

- `core/commands/wait.js` — the whole file: the loop's corruption return (`:65-81`), the
  `allTerminal` return (`:86-101`), and the final read (`:106-122`).
- `core/commands/list.js` — `executeList`: the `errors` array's shape (used by both return
  paths).
- `tests/core/commands/wait.test.js` (or wherever wait is tested) — existing corruption tests.

## What to build

1. **In the final read** (`core/commands/wait.js:106-122`): if `listResult.errors.length > 0`,
   return the same shape as the loop's corruption return — `exitCode: 17`, `timedOut: false`,
   the jobs projection and `errors` as today. Only when the final list is clean and some job is
   still non-terminal, return the existing 20/timeout result.
2. **Test.** A `wait --all` case whose final listing reports an unreadable record (missing
   journal) with a zero wait budget: expect exit 17, `timedOut: false`, `errors` non-empty. Extend
   the existing corruption tests rather than adding a new file.

## Non-goals

- **No change to the polling loop or to `executeWait`** (single-job wait already reads a status,
   not a list).
- **No change to exit 20's meaning or the `timedOut` flag semantics.**

## Acceptance criteria

- [ ] **A.** `wait --all` with an unreadable record in the final listing exits 17 with
  `timedOut: false`.
- [ ] **B.** `wait --all` with readable, still-active jobs after the deadline still exits 20 with
  `timedOut: true`.
- [ ] **Z.** `npm run check` green; the tracker table regenerated.

## Agent checks

```bash
# What this proves: the final read honours the same corruption contract as the loop.
rg -n "exitCode: 17" core/commands/wait.js
# expect: two sites — the loop early-return and the final-read branch

# What this proves: the fix is covered.
npm test -- --grep "wait"   # expect: green, including the corrupt-final-read case
```

## Notes

Implemented 2026-08-11.

**Changed:** `core/commands/wait.js` — the final post-deadline read in
`executeWaitAll` (formerly `:106-122`) now runs the same corruption branch as the
polling loop: when `listResult.errors.length > 0` it returns `exitCode: 17,
timedOut: false` with the jobs projection and `errors`, and only falls through to
the existing exit-20/`timedOut: true` result when the final listing is clean but
some job is still non-terminal. The comment stating that rule moved onto the new
branch. No other file changed.

**Tests:** extended `tests/core/worker-liveness.test.js` with block 6p, reusing
the existing corruption-fixture pattern (garbage appended to `journal.jsonl`).
Two cases: (1) corrupt record with `timeoutSec: 0` — the polling loop never runs,
so the corruption is only ever seen by the final read; expects exit 17,
`timedOut: false`, non-empty `errors`; (2) readable still-active job with
`timeoutSec: 0` in a fresh state root — expects exit 20, `timedOut: true`
(acceptance criterion B). Verified red before the fix (assertion `20 !== 17`),
green after.

**Suite:** `npm run check` green — lint clean; `test:full` 96 files passed
(adapters 32, contract 2, core 58, helpers 1, integration 3), 0 failed.

**Agent checks:**
- `rg -n "exitCode: 17" core/commands/wait.js` → two sites as expected:
  line 69 (loop early-return) and line 113 (final-read branch).
- `npm test -- --grep "wait"` — deviation: this repo's test runner
  (`tests/run-tests.js`) has no `--grep` flag. Covered instead by the full
  suite above (`tests/core/worker-liveness.test.js` passes in it).

**Deviation from ticket:** the "still-active still exits 20" case (criterion B)
needed a separate state root — seeding it into the same store would have
reported the first job's corrupt record, which the ticket's test description
(one corrupt case, one timeout case) implicitly assumed. Also the ticket's
`--grep` agent-check command does not exist in this repo's runner; noted above.
No other deviation.
