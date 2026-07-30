# 71 — `cancel` can overwrite a real `done`; reducer lets `cancel_requested_at` win over completion evidence

**What to build:** a job that actually completed (`done`) cannot be silently overwritten by a `cancelled` journal entry from a late `cancel` command, and the reducer consults completion evidence (`process_exited`) before declaring `cancelled` just because `cancel_requested_at` is set. Both halves of the "cancelled-while-done" race — the journal preservation rule and the reducer rule order — must hold.

**Blocked by:** Ticket 55 (55 introduces the reducer's terminal-from-facts logic; 71 refines the rule ordering inside it)

**Status:** ready-for-agent

## Acceptance criteria

### A. Journal preservation rule (job-store)
- [ ] `core/job-store.js` preservation rule (around line 121-129): a `done`/`failed` state is NOT overwritten by a later `cancelled` journal entry. Today the rule only protects `cancelled`/`timed_out` from being demoted to `done`/`failed`; it does NOT protect `done` from being overwritten by `cancelled`. Add the symmetric rule: once `done`, only a deliberate `cancelled` with explicit `force: true` detail can overwrite (but normally the cancel caller should detect "already done" and not write).
- [ ] Equivalently safe alternative: the preserve rule ignores any transition that would demote ANY terminal state to ANY other terminal state — only `interrupted` may be promoted to a definitive terminal (`done`/`failed`/`cancelled`) but never the reverse. Pick this if it simplifies — append-only contract allows adding rules, not removing existing ones.

### B. Reducer rule ordering
- [ ] `core/reducer.js` rule #2 (around line 43-51): `cancel_requested_at` no longer UNCONDITIONALLY returns `cancelled` before considering `process_exited`. Add a check: if a `process_exited { code: 0 }` fact is in the set yielding `done`, the reducer returns `done` (or `done_then_cancelled`? — no, Invariant #4 is append-only; pick `done` with a `cancel_received_after_completion: true` detail). The `cancelled` verdict applies only when there's NO positive completion evidence.
- [ ] A `cancel_requested_at` PLUS `process_exited { code: N != 0 }` → the reducer returns `failed` (the process actually failed) OR `cancelled_with_failure` — pick ONE and assert it, with a detail noting both. AGENTS Mistake #5 ("a cancel wrote cancelled while killing nothing"): the truth is what the kill AND the process did.

### C. cancel command
- [ ] `core/cancel.js` (around line 88-102): after the rung-walk kill, before journalling `cancelled`, RE-READ the job status. If it is now terminal (e.g. `done` written by the worker between the cancel's readStatus and its journalTransition), DO NOT journal `cancelled` — or journal a non-state-changing marker like `cancel_after_completion` whose only side effect is setting `cancel_received_after_completion: true`. Either way, the user-visible state remains `done`.

### D. tests
- [ ] Test: job reaches `done` then `cancel` arrives → final state is `done` with `cancel_received_after_completion: true` in the journal. NOT `cancelled`.
- [ ] Test: job still `running` then `cancel` arrives then worker actually writes `process_exited {code:0}` before consuming the cancel → reducer returns `done` with `cancel_received_after_completion: true`.
- [ ] Test: job still `running` then `cancel` arrives and the kill is effective → final state is `cancelled` (today's behaviour preserved for the genuine cancel case).
- [ ] Full suite green.

## Development guidance

- The three rules must compose: reducer is the source of truth for terminal state from facts; the journal preserve rule is the backstop for any path that writes terminal state without going through the reducer (the cancel CLI). Fix all three; the reducer is the most important.
- The contract append-only rule (Invariant #4) means the new `cancel_received_after_completion` becomes a NEW field on status. Don't reuse existing fields.
- Coordinate with ticket 55 (observe-end produces reducer-driven terminal state) — the reducer ordering tests there and here overlap; sequence carefully or merge the reducer edits into one ticket. If you implement 55 first, 71 is "add the cancel-vs-complete precedence rule."
- The `cancel_after_completion` marker can be a NEW journal `kind` — explicitly append-only. Or reuse an existing `kind` with new detail fields. Pick one consistent shape.
- For the run-walk-after-completion case: the rung walk should still fire (the kill ensures a hung half-dead process is gone), but the resulting journal entry must not demote.

## Why it matters

A successfully-completed long-running job that gets a late `cancel` (the user hits Ctrl-C in the parent agent after the result is already written) is recorded as `cancelled` — and the user/agent assume the work didn't happen, even though `result.md` has the answer. The bigger risk is automation: an agent that polls `status` and reacts to `cancelled` by retrying forever-since-actually-completed work.

## How to verify

```powershell
node tests/run-tests.js --suite full
```

## Commit message

```
fix(cancel,reducer,job-store): terminal done survives late cancel; reducer consults completion before cancel_requested_at
```