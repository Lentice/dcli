# 58 — OpenCode `_rejectInteraction` rethrows inside the `Observe` loop, hanging the job without a terminal fact

**What to build:** when OpenCode sends an interaction the wrapper must auto-reject (no automation policy, unattended mode), a 5xx/network blip on the reject HTTP call no longer tears down the `Observe` generator. The interaction either gets retried on the next poll (transient) or yields a `stream_closed { reason: 'interaction_reject_failed' }` fact so the engine can move the attempt to terminal via the reducer (ticket 55) instead of hanging until the hard-kill deadline.

**Blocked by:** None — can start immediately (coordinate with ticket 55 — the reducer changes there decide what `interrupted` vs `failed` should be for an unguarded reject failure)

**Status:** ready-for-agent

## Acceptance criteria

- [ ] `adapters/opencode/adapter.js` `_rejectInteraction` (around line 1194-1208) does NOT rethrow non-404 errors out to the `Observe` generator. It either swallows them and emits a marker the polling loop can re-try, or returns a distinct signal (e.g. throws a typed error caught BY the caller with a clear "reject failed" fact consequence).
- [ ] The caller site in the `Observe` loop (around line 999-1007) wraps `_rejectInteraction` in a try/catch that, on a non-404 failure, yields a `stream_closed { reason: 'interaction_reject_failed', detail: {err} }` fact and breaks the loop — so the reducer (ticket 55) sees evidence and reaches a terminal state, instead of the generator silently unwinding with nothing.
- [ ] The 404 case (`interaction already resolved/gone`) continues to be swallowed exactly as today — that's correct (the interaction is no longer pending).
- [ ] Test: a fake opencode adapter whose reject endpoint returns 500 yields `stream_closed` with `reason: 'interaction_reject_failed'` and the attempt reaches a terminal state within the hard-timeout budget, NOT hanging until hard kill.
- [ ] Test: a reject that succeeds removes the interaction from the pending set and polling continues (today's working behaviour preserved).
- [ ] Full suite green.

## Development guidance

- The pattern to copy is the one `core/reducer.js` already uses for other "the adapter could not complete" cases: emit a fact with `reason`, let the reducer decide the terminal state. Do NOT silently `return;` from the generator on a reject failure — that's exactly today's hang.
- A 5xx is typically transient. Consider a short bounded retry (1 retry, ~2s, with a clear timeout) before giving up — but only if the underlying `_transportRequest` doesn't already retry internally. If it does, one attempt then-yield-fact is enough.
- `RequestCancel('session_abort')` (ticket 59) is the cleanup path that runs when the wrapper gives up entirely. The reject path is for "one interaction failed to auto-reject"; the cancel path is for "the whole attempt is being abandoned". Don't merge them.
- The interaction polling loop's other failure modes (SSE reconnect exhausting retries, session-status fetch failing) should follow the same yield-fact-then-break pattern; if they don't today, that's a worthwhile adjacent fix but not strictly required by this ticket. Note in the commit if you fix them too.

## Why it matters

Today: a single 5xx answering an unrelated permission prompt tears down the entire observation, emits no terminal fact, and the job hangs until the hard-kill fires. The user sees an exit-24 timeout for an interaction the wrapper was supposed to silently auto-reject. This is a stealth failure on the very path the wrapper explicitly owns ("auto-reject when no automation policy is configured").

## How to verify

```powershell
node tests/run-tests.js --suite full
```

## Commit message

```
fix(opencode): reject-interaction failures emit stream_closed rather than unwinding Observe
```