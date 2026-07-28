# 08 — Cancellation with adapter-declared rungs

**Blocked by:** 06, 07
**Status:** ready-for-agent
**Read first:** [00-onboarding.md](00-onboarding.md), `AGENTS.md` §4–§5,
[ADR-007](../2026-07-28-architecture-decisions.md#adr-007) item 5.

---

## Purpose

`cancel <job>` stops a job and everything it spawned, trying the gentlest mechanism the backend actually
has before escalating — and `core/` contains no knowledge of what those mechanisms are.

## Why it matters

A fixed escalation ladder in the engine would be a backend conditional in disguise, violating invariant 1.
The ladder genuinely differs:

| Backend | Real rungs |
|---|---|
| opencode | `session_abort` → `server_dispose` → `hard_kill` |
| codex | `hard_kill` — that is all. No graceful API exists. |
| claude | `hard_kill` (native-agent stop only if that extension is ever enabled) |

A four-rung abstraction forced onto Codex would be two no-op rungs plus wasted waiting.

And the predecessor's actual bug: because the kill was gated on `state === 'running'`, cancelling a
`created` job wrote `cancelled` while killing nothing, leaving a live worker that later overwrote the
record.

## Design

```
1. Write cancel.request atomically. Journal it.
2. rungs = adapter.DeclareCancelRungs()
3. For each rung in order:
     adapter.RequestCancel(attempt, rung)
     wait, bounded
     if postcondition satisfied → record the rung and stop
4. If no rung terminated it: hard-kill the contained job (ticket 06).
5. Verify termination by execution token + OS identity.
6. Only then: state = cancelled, with the successful rung recorded.
```

**Never gate the kill on state.** A `created` job may have a live worker; that is exactly the bug above.

The shared promise is the **outcome** — "the job ceases running within bounded escalation" — never the
mechanism. Record which rung worked so `debug` can explain what happened.

## Pitfalls

- `cancelled` must never be written while any contained process is alive. Verify first.
- Each rung's wait is bounded; a backend that accepts an abort and ignores it must not stall the ladder.
- Cancelling an already-terminal job is a **no-op that reports honestly**, not an error.
- Exit code `21` is for "cancellation could not be confirmed" — use it rather than claiming success.
- Do not re-order or skip declared rungs based on backend knowledge in `core/`.

## Checklist

- [ ] `cancel.request` is written atomically and journaled before anything is signalled.
- [ ] The engine walks exactly the rungs the adapter declared, in order, each with a bounded wait and a
      postcondition check.
- [ ] Hard kill is the implicit final rung.
- [ ] Termination is verified by execution token **and** OS identity before `cancelled` is written.
- [ ] The successful rung is recorded in the job record and shown by `debug`.
- [ ] A fake adapter declaring exactly `[hard_kill]` cancels correctly (the Codex/Claude case).
- [ ] A fake adapter declaring three rungs where the first two fail escalates correctly.
- [ ] A fake adapter whose first rung *reports* success but leaves the process alive results in exit `21`,
      not a false `cancelled`.
- [ ] Cancelling a `created` job with a live worker **kills it** — regression test for the predecessor bug.
- [ ] Cancelling a `created` job with no worker works.
- [ ] Cancelling an already-terminal job is a reported no-op.
- [ ] A test asserts `core/` contains no reference to any backend-specific cancellation mechanism.

## How to verify

```powershell
node tests/run-tests.js --suite full
```

Manually: submit a long fake job, cancel it, then confirm no descendant survives and `debug` names the rung.

## Definition of done

Full suite green including the one-rung, three-rung, false-success, and `created`-with-live-worker cases.

## Commit message

```
feat: cancellation via adapter-declared escalation rungs with verified termination
```

## Notes

### Implementation summary

**Files created:**
- `core/cancel.js` — The cancellation orchestrator. Exports `cancelJob()` and default deadline constants.
  Algorithm: write cancel.request atomically → journal cancel_requested_at → walk adapter-declared
  rungs with bounded wait per rung, checking process death as the postcondition → escalate to
  containment.terminate() (hard kill) if no declared rung worked → verify termination → journal
  cancelled state with `cancel_rung_reached` in `backend_state`. Returns `exitCode: 21` if
  termination cannot be confirmed.
- `tests/core/cancel.test.js` — 14 test scenarios covering the full checklist.

**Files modified:**
- `core/job-store.js` — Added public `getJobDir(repoKey, jobId)` method (exposes the existing
  internal `_jobDir` for use by `cancelJob` to write `cancel.request`).
- `adapters/fake/adapter.js` — `RequestCancel` now calls `this._script.behaviors.onCancel(rung)`
  when configured, enabling tests to react to rung calls (e.g. set processAlive = false).

### Design decisions

1. **Postcondition = process death, not adapter return value.** The orchestrator independently
   verifies process death via `isProcessAliveFn(pid)` after each rung. A rung that returns
   `{ success: true }` does not count as "killed the process" unless the process is actually dead.
   This matches the false-success test requirement.

2. **Hard kill as implicit final rung.** The engine calls `containment.terminate()` only when ALL
   declared rungs have been tried without achieving process death. This matches the design spec §14.

3. **isProcessAliveFn is injectable.** Tests provide a custom `isProcessAliveFn` closure to control
   process state. In production it defaults to the real `isProcessAlive` from `process-identity.js`.

4. **No backend-specific conditionals in core/cancel.js.** The orchestrator only calls
   `adapter.DeclareCancelRungs()` and `adapter.RequestCancel(attempt, rung)`. Rung names are opaque
   strings. Verified by architecture test (test 7).

5. **cancel.request atomic write before any signalling.** The orchestrator writes `cancel.request`
   via `writeTextFileAtomic` and journals `cancel_requested_at` before calling the first
   `adapter.RequestCancel()`. Verified by test 8.

6. **Cancelled with `cancel_rung_reached` in `backend_state`.** The rung that killed the process
   is recorded in `status.json.backend_state.cancel_rung_reached` with `schema_version: 1`.
   This is inspectable via `debug`.

### Test coverage

| Test | Checklist item |
|---|---|
| 1. Single rung (`hard_kill`) | Fake adapter with `[hard_kill]` cancels correctly |
| 2. Three rungs, two fail | Escalation through failing rungs to successful kill |
| 3. False success → exit 21 | Rung returns success but process stays alive |
| 4. Created + live worker | Predecessor regression: worker is killed |
| 5. Created + no worker | Cancels cleanly |
| 6. Already-terminal | No-op across all 5 terminal states |
| 6b. All 5 terminal states | done, failed, timed_out, cancelled, interrupted |
| 7. No backend refs in core/ | Architecture scan |
| 8. Atomic cancel.request | File exists before RequestCancel, journal ordered |
| 9. Rung ordering | Rungs called in adapter-declared order |
