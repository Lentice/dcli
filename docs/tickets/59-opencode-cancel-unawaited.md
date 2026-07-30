# 59 — OpenCode `RequestCancel` 'session_abort'/'server_dispose' httpPost is un-awaited; `success` returned before the request lands

**What to build:** OpenCode cancellation's `session_abort` and `server_dispose` rungs actually terminate the backend session before reporting success — the `httpPost` call is `await`ed (or `.catch`ed with a failure signal), and `success` is honest about whether the abort reached the server. This is the documented "a cancel wrote cancelled while killing nothing — leaving a live worker that later overwrote the record" failure (`AGENTS.md` Mistake #5).

**Blocked by:** None — can start immediately (coordinate with tickets 33/48 which already cleaned up the rung-walk structure; this is the OpenCode-specific rung that escaped those fixes)

**Status:** ready-for-agent

## Acceptance criteria

- [ ] `adapters/opencode/adapter.js` `RequestCancel` 'session_abort' (around line 1370-1371) and 'server_dispose' (around line 1380-1382) cases `await` the `httpPost` call (or `.catch` it and gate `success` on the outcome).
- [ ] `_cancelled = true` and the `{ success: true }` return are only set after the abort/dispose HTTP confirms success (a 2xx response, or a 4xx we explicitly consider acceptable like 404 "already gone"). On a 5xx or network error, `success` is `false` so the rung-walk caller advances to the next rung (the hard-kill rung), instead of the loop stopping at "success" while the session is still alive.
- [ ] An unhandled rejection does not leak: the await/.catch must settle the promise. Before the fix, `httpPost(...)` returns a Promise that was never awaited and never caught — a 5xx response or socket error becomes an unhandled rejection event.
- [ ] For the `server_dispose` rung: after `_killServer()` runs, null `_serverBaseUrl` so a later `Dispose()` call (ticket 31 already calls Dispose on every terminal path) does NOT re-issue `/global/dispose` to an already-disposed server.
- [ ] Test: a fake server whose abort endpoint returns 500 → `RequestCancel('session_abort')` returns `{success:false}` (so the caller escalates); `_cancelled` is NOT set to true (or is set but the caller has enough signal to escalate — pick one and assert it consistently).
- [ ] Test: a successful abort → `{success:true}`, `_cancelled=true`.
- [ ] Full suite green.

## Development guidance

- The path that already does this correctly is `core/cancel.js:80-86` (the containment fallback kill). Use it as the model: ask politely, then if the polite request fails, escalate to a hard kill. The OpenCode-specific rungs here are the "ask politely" half; the next rung in the ladder (declared by `DeclareCancelRungs`) is the hard-kill half.
- `httpPost` accepts `{ responseTimeout, password }` — keep those bounded. The default for these cancel calls is 5000ms (`responseTimeout: 5000`); preserve it. The rule is invariant #3 — the abort call itself must be bounded.
- Workers must not exit on a synchronous `_cancelled=true` while an un-awaited HTTP is still in flight — that leaves the session alive if the HTTP then fails. Either the caller of `RequestCancel` (the rung-walker) waits for the entire walk to settle before exiting, or `RequestCancel` itself ensures the abort completed before returning. Pick the second: it's localized to the adapter.
- The `server_dispose` rung calls `this._killServer()` after the httpPost — keep that. The fix just adds the await/gate and the `_serverBaseUrl = null` set-after-dispose.
- Do NOT change the rung order (`DeclareCancelRungs` returns the array); only the implementation of each rung.

## Why it matters

A cancel that reports success without killing is the exact bug that made the predecessor "cancel wrote cancelled while killing nothing" (`AGENTS.md` Mistake #5). The job is recorded `cancelled` while the backend keeps working — and on a subsequent `submit` for the same backend session, the live worker overwrites the record. The honest `success: false` path is the only signal the rung-walker has to escalate to hard-kill.

## How to verify

```powershell
node tests/run-tests.js --suite full
```

## Commit message

```
fix(opencode): abort/dispose cancel rungs await their HTTP and report honest success
```