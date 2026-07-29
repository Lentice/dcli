# 33 — OpenCode cancellation must escalate through every declared rung

**Blocked by:** None — can start immediately
**Status:** ready-for-agent
**Read first:** [00-onboarding.md](00-onboarding.md), ticket 08 (declared rungs),
`AGENTS.md` "The nine mistakes" #4.

---

## Purpose

`adapters/opencode/adapter.js`'s `RequestCancel` must allow escalation through every declared cancellation
rung (graceful session abort → server dispose → hard kill), and must not report success until the
operation it performed is actually confirmed.

## Why it matters

Today, the **first** call to `RequestCancel` sets an internal `_cancelled = true` flag; every subsequent
call short-circuits and returns immediately without doing anything. If the first rung (graceful
`session_abort`) doesn't actually stop a wedged session or server, there is no way to escalate — the
declared `server_dispose` and `hard_kill` rungs are unreachable code. Combined with the fact that the
HTTP abort call isn't awaited before reporting success, "cancelled" can be recorded while the server is
still fully alive and running.

## Evidence

`adapters/opencode/adapter.js` around line 1363: the guard `if (this._cancelled) return { success: true };`
sets and checks the *same* flag on every rung, so a second, harder call after a first, softer one that
didn't actually work returns early claiming success without attempting anything further. The abort HTTP
call it does make is fired without `await`ing its resolution before returning.

## Design

- Track **which rungs have been attempted and confirmed** separately from a single boolean "cancelled"
  flag — e.g. a small ordered state (`none → abort_requested → abort_confirmed → dispose_requested → ...`)
  so a second call for a *different, harder* rung is not blocked by the first call's flag.
- Make `RequestCancel` properly `async`: await the graceful abort's HTTP call (bounded by a timeout), check
  its actual result, and only report that rung's success if the operation is confirmed — not merely sent.
- If a softer rung doesn't confirm within its bound, the caller (per ticket 08's rung-escalation contract)
  should be able to invoke the next rung, and this adapter must actually perform it: `server_dispose`
  should call the server's dispose/shutdown path; `hard_kill` should fall back to killing the process tree
  via containment, matching what `codex`'s `RequestCancel` already does for its own hard-kill rung.
- Always finish with containment-backed termination if graceful cancellation is unconfirmed — don't leave
  a job "cancelled" while its process/server survives.

## Pitfalls

- Do not let `RequestCancel` itself hang — every await needs a bound.
- Do not regress the case where cancellation legitimately succeeds on the first (graceful) rung — that
  path should stay fast and not force escalation when unnecessary.

## Checklist

- [ ] `RequestCancel` accepts and processes multiple calls for different rungs without a stale flag from an
      earlier rung blocking a later, harder one.
- [ ] The graceful abort HTTP call is awaited, bounded, and its actual result determines whether that rung
      is reported as confirmed.
- [ ] `server_dispose` and `hard_kill` rungs are reachable and actually perform their described action when
      invoked.
- [ ] A regression test simulates a session that does not respond to graceful abort and asserts escalation
      to `hard_kill` actually terminates the process tree.
- [ ] A regression test confirms `RequestCancel` never reports `success: true` for a rung whose operation
      it did not confirm.

## How to verify

```powershell
node tests/run-tests.js --suite full
node tests/core/cancel.test.js
```

## Definition of done

Full suite green; a fixture that ignores graceful abort is provably terminated via escalation to
`hard_kill` in a test, with no rung silently reporting false success.

## Commit message

```
fix: opencode adapter cancellation escalates through every declared rung instead of stopping at the first
```
