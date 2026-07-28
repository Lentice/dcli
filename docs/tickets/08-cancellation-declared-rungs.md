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
