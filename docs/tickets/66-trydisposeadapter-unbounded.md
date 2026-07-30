# 66 — `tryDisposeAdapter` does not actually bound `Dispose`; a hanging adapter blocks forever

**What to build:** `adapter.Dispose(attempt)` is called through a wrapper that enforces a real bounded timeout — the call is raced against a deadline, and on timeout the wrapper force-clears server processes / temp dirs the engine can provably own, then logs `dispose_exceeded: true`. Today `tryDisposeAdapter` calls `Dispose` synchronously, computes `Date.now() > deadline` AFTER it returns, and merely *reports* `exceeded` — so a `Dispose` that hangs (adapter sends a final HTTP request to a gone backend and waits for socket close) blocks forever. Invariant #3 ("Nothing blocks forever") is violated; this is the documented class.

**Blocked by:** None — can start immediately

**Status:** ready-for-agent

## Acceptance criteria

- [ ] `core/commands/index.js` `tryDisposeAdapter` (around line 374-387) wraps the `adapter.Dispose(attempt)` call in a `Promise.race([DisposePromise, timeoutPromise])`. If `Dispose` returns a Promise, awaiting the race is enough; if `Dispose` is synchronous and can hang, the engine must spawn the dispose work and the timeout in parallel via worker_threads or a child (or, structurally, change `Dispose` to be async-awaitable). The simplest correct shape: declare `Dispose` async in the contract, awaiting any adapter-blocking work inside, and the wrapper awaits with a finite timeout.
- [ ] On timeout, the wrapper:
  - logs `dispose_exceeded: true` (today's behavior — kept) AND
  - takes a bounded corrective action that does NOT depend on the hung adapter (e.g. for opencode: `process.kill(this._backendPid)` the server pid; for codex/claude: `fs.rmSync` their temp dirs) — provided the engine can prove ownership (the execution token / persisted identity). If there's no safe corrective action, the wrapper at minimum records the leak and moves on; do NOT block the calling thread forever.
- [ ] The wait is bounded (`resolveDeadline('DISPOSE_TIMEOUT_MS')` or a new bounded constant, e.g. 5000ms — match today's default).
- [ ] Adapter contract (`docs/2026-07-28-design-spec.md`) is updated to clarify `Dispose` may run async I/O and must return a Promise the engine awaits with a finite budget. Append-only (Invariant #4) — do NOT change the method signature's name.
- [ ] Test: a fake adapter whose `Dispose` never resolves — `tryDisposeAdapter` returns within ~`DISPOSE_TIMEOUT_MS` (use a test override `DCLI_TEST_DISPOSE_TIMEOUT_MS` to keep the suite fast, mirroring `deadlines.js`) and `dispose_exceeded: true` is observable.
- [ ] Test: a fake adapter whose `Dispose` resolves quickly — wrapper returns promptly with `exceeded:false`.
- [ ] Full suite green.

## Development guidance

- A synchronous I/O hang (adapter holds the event loop blocked on a sync socket read) CANNOT be raced by `Promise.race` — the Promise never runs because the event loop is blocked. The structural fix is: `Dispose` MUST be async and the adapter MUST NOT do blocking I/O synchronously. Verify codex/claude/opencode `Dispose` implementations today are async-safe (they call `fs.rmSync` synchronously today — fine, that doesn't hang; the un-awaited HTTP side of opencode (`httpPost` `/global/dispose`) is the suspect — see ticket 59).
- Coordinate with tickets 31 + 59: ticket 31 ensures `Dispose` is called; ticket 59 fixes the un-awaited `/global/dispose`; this ticket fixes the timeout wrapper. Land 59 first, then this, then verify 31 still holds with the new bound.
- Do NOT bake the 5000ms constant twice — `core/deadlines.js` already has `DISPOSE_TIMEOUT_MS` as `5000` (referenced by opencode adapter line 16). Use `resolveDeadline('DISPOSE_TIMEOUT_MS')`.
- The corrective-action fallback (force-kill server pid) is the harder half; if you can't prove ownership safely, ship the timeout + report without the force-kill and file it as a follow-up. The minimum acceptance is "no longer blocks forever" — the force-kill is bonus.

## Why it matters

`AGENTS.md` §3 documents three separate fixes for unbounded drains in the predecessor. This is the dispose-side instance: a real opencode adapter can hang its Dispose end-of-session (socket close waiting on a wedged server), and the engine waits forever. Every terminal path enters `tryDisposeAdapter`, so every job hangs on the way out — `Status` shows the job's done, but the CLI never returns.

## How to verify

```powershell
node tests/run-tests.js --suite full
```
And a live check: run an opencode job, kill the server pid mid-dispose (or stub a hanging Dispose), confirm the CLI returns within ~5s, not indefinitely.

## Commit message

```
fix(core): tryDisposeAdapter races Dispose against a real deadline
```