# 46 — Worker hard timeout is inert and never kills the process tree

**What to build:** a submitted background job whose backend hangs past `--hard-timeout-sec` is forcibly
terminated — its process tree is killed and the job reaches `timed_out` — instead of running unbounded
because the timer merely flipped an internal flag nobody acted on.

**Blocked by:** None — can start immediately

**Status:** ready-for-agent

- [ ] When the hard-timeout deadline fires, the worker actually tears the job down in bounded time:
      close stdin → kill the contained process tree (via the containment context / declared cancel rungs
      using the *real* attempt) → boundedly observe readers → flush partial output → journal `timed_out`.
- [ ] The hard-timeout path passes the **real `attempt` object** to `adapter.RequestCancel`, not an empty
      `{}`. Today `core/commands/worker.js` calls `adapter.RequestCancel({}, rung)`, so the rung never
      reaches the live session/handles.
- [ ] The hard timeout does not rely solely on a flag checked between `await` points. If the adapter is
      blocked inside a single long `Observe()` call (the exact situation a hard timeout exists for), the
      timeout must still force termination — e.g. arm the kill before/alongside `Observe`, or race it.
- [ ] A submitted job with no `--hard-timeout-sec` still cannot hang forever: there is a bounded default
      hard timeout applied to the worker path, and a missing/zero value is rejected or defaulted rather
      than silently meaning "unbounded".
- [ ] Regression test: a fake adapter whose `Observe` never yields a `process_exited` fact is driven
      past the hard timeout; assert the job is `timed_out` (exit 24) within a bounded window and no worker
      process/tree remains alive.
- [ ] Full suite green.

## Notes

This re-opens the predecessor's most expensive incident — the eight-hour stall (AGENTS "nine mistakes"
#1 and #5; `development-guide.md` §1.1, §1.4) — **on the `submit` background path**, which the
predecessor's recipe-style guards were written to prevent. Invariant #3 ("nothing blocks forever") is
violated here today.

Evidence (`core/commands/worker.js`):

- `hardTimeoutTimer` only sets `hardTimedOut = true` and calls `adapter.RequestCancel({}, rung)` with an
  empty object literal — the real `attempt` (declared later) is never captured.
- `hardTimedOut` is checked only between `await` points inside the `for await (Observe)` loop; an adapter
  blocked in one long `Observe()` never observes the flag.
- No containment/`terminate()` call is ever made on hard timeout.
- When `hardTimeoutMs === 0` (no `--hard-timeout-sec`), no timer is set at all and nothing else bounds the
  job.