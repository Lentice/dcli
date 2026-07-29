# 35 — Codex and Claude adapters must drain streams to close before parsing the result

**Blocked by:** None — can start immediately (coordinate with ticket 32 if both touch
`adapters/codex/adapter.js` concurrently)
**Status:** ready-for-agent
**Read first:** [00-onboarding.md](00-onboarding.md), `AGENTS.md` "The nine mistakes" #2 and #3
(deadlock and bounded-drain mistakes), ticket 07 (deadlines and pipe draining).

---

## Purpose

The codex and claude adapters must wait for their child's stdout/stderr streams to actually close (EOF),
bounded by `POST_EXIT_DRAIN_MS`, before parsing the collected result — not parse immediately on the
process `exit` event.

## Why it matters

`AGENTS.md` is explicit that a "bounded tail" which reads then slices is not actually bounded, and that
every drain has shipped hang/data-loss bugs multiple times in the predecessor. This ticket is the same
class applied to result parsing: Node's child-process `exit` event fires when the process has terminated,
but stdout/stderr pipes can still have buffered data in flight — a descendant temporarily holding a pipe
open, or OS buffering, can mean data arrives *after* `exit`. If parsing starts at `exit` rather than after
stream `close`/EOF, trailing assistant text, a final `usage` event, or a session-id event can be silently
dropped.

## Evidence (verified via code read)

`adapters/codex/adapter.js` (~line 363 process-exit handling, ~line 641 result assembly) and
`adapters/claude/adapter.js` (~line 257, ~line 463) both begin result parsing keyed off the process `exit`
event. Both adapters' `_startBoundedDrain()` implementations are a `setTimeout` that does nothing but
schedule an empty callback (`adapters/codex/adapter.js` ~line 641: `setTimeout(() => { if (this._disposed)
return; }, POST_EXIT_DRAIN_MS).unref();`) — it is not actually waiting for or verifying stream closure, it
is a no-op placeholder.

## Design

- Arm stream-completion tracking (listen for `close`/`end` on stdout and stderr, or track EOF explicitly)
  **before** the process can exit — ideally right after spawn, per the pipe-arming-order rule in `AGENTS.md`
  mistake #2.
- On `exit`, wait for both streams to actually reach `close`/EOF, bounded by `POST_EXIT_DRAIN_MS`. Only
  after that (or the bound elapsing) proceed to parse the accumulated buffer/facts.
- If the bound elapses without both streams closing, proceed with whatever was captured, but **record
  explicit truncation/drain status** (per the "carry an explicit status" principle in mistake #7) rather
  than silently presenting partial output as complete.
- This should replace the no-op `_startBoundedDrain` with an implementation that actually does what its
  name says, in both adapters.

## Pitfalls

- Do not turn this into an unbounded wait — the entire point of `POST_EXIT_DRAIN_MS` is that it *is* the
  bound. If both streams haven't closed by then, move on and report partial/truncated status.
- Do not change the order of stdin-write vs. reader-arming while touching this code — that ordering is
  already correct per mistake #2 and must stay that way.

## Checklist

- [ ] `_startBoundedDrain` (or its replacement) actually waits for stdout/stderr `close`/EOF, bounded by
      `POST_EXIT_DRAIN_MS`, instead of being a no-op timer.
- [ ] Result parsing (`CollectResult`/fact assembly) does not begin until stream draining has completed or
      timed out.
- [ ] If the drain bound elapses before both streams close, the job's result/status carries an explicit
      indication that draining did not fully complete (not silently treated as a clean result).
- [ ] A regression test using a fixture that emits output *after* process exit (see
      `tests/fixtures/grandchild-pipe.js` or a similar delayed-output fixture) confirms the late output is
      still captured within the bound.
- [ ] A regression test confirms the bound is actually enforced (a fixture that never closes its pipe does
      not hang the command past `POST_EXIT_DRAIN_MS`).

## How to verify

```powershell
node tests/run-tests.js --suite full
node tests/core/bounded-tail.test.js
node tests/core/child-process.test.js
```

## Definition of done

Full suite green; a fixture producing output after `exit` has that output correctly captured, and a
fixture that never closes its pipes does not hang the command beyond the bound.

## Commit message

```
fix: codex and claude adapters actually drain streams to close before parsing results
```
