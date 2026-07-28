# 07 — Deadlines and concurrent pipe draining

**Blocked by:** 02, 06
**Status:** ready-for-agent
**Read first:** [00-onboarding.md](00-onboarding.md) §7 pitfalls 1–2, and `AGENTS.md` §1–§3.
This ticket makes the tool's headline promise — "it will not wedge your workflow" — actually true.

---

## Purpose

No operation can block forever, and no child process can deadlock the tool by filling an output pipe.

## Why it matters

The predecessor needed **three separate fixes** for unbounded drains (normal exit, doctor probe, and the
concurrent stdin/stdout case), and its single worst incident was an unbounded wait that consumed eight
hours of a user's session. This is not a class of bug that gets fixed once.

## Facts you need

The deadlock: a child can fill its OS stdout pipe before draining its own stdin. If the parent writes
stdin to completion before reading stdout, both block. It reproduces with a ~100 KB prompt — and an
embedded review diff is ~100 KB by design, so this is the *default* path, not an edge case.

## Design

### Deadline table (all configurable, all finite)

| Boundary | Default |
|---|---|
| worker startup sentinel | 30 s (with env override and dead-worker fast-fail) |
| backend first-event watchdog | 120 s |
| backend server health-ready | 30 s |
| job hard timeout | 1800 s (`0` disables, explicitly) |
| post-exit stdout/stderr drain | 5 s |
| HTTP connect / read | 10 s / 60 s |
| event-stream idle (no event, no keepalive) | 120 s |
| lock acquisition | 10 s |
| individual git operation | bounded per call |
| `wait` | caller-defined; finite default for automation |
| doctor live smoke | 120 s |

### Ordering rules — make them structural, not conventional

1. Attach stdout and stderr consumers **before** the first `stdin.write()`. Make the API shape prevent the
   wrong order rather than documenting it.
2. Start the hard-timeout deadline immediately after process start, so a blocked stdin write is inside the
   budget.
3. On timeout or writer failure, tear down in this order: close stdin → kill the contained tree →
   boundedly observe writers/readers → flush partial output → report.

### Long-lived process output

The per-job backend server outlives every short child. Its stdout/stderr must be captured to a
**size-capped rotating log** and drained continuously for its whole lifetime. An undrained pipe on a
verbose server fills its buffer and hangs the server — a never-hang violation inside the never-hang design.

### Bounded reads

A "bounded tail" that reads the whole file and then slices is **not bounded**. Seek to
`max(0, length - maxBytes)` and do one read. Bound maximum line size; an oversized line is truncated with
a recorded marker and remains retrievable, never silently dropped.

### Startup sentinels

A too-tight sentinel flaked under load. The fix has three parts, all required: a wide window, an
environment override, and a **dead-worker fast-fail** so a genuine failure is not slow.

## Pitfalls

- A new `await` without a deadline is a defect. Add a lint or review checklist item.
- `0` must mean "explicitly unbounded", never "default". Reject a missing value.
- Validate a timeout's range **before** converting to milliseconds — a range check after conversion
  overflows first. This was a real bug.
- Malformed JSON lines are logged and never fatal.
- Decode child stdout as **UTF-8 explicitly**; the console code page produced mojibake in the study.

## Checklist

- [ ] Every boundary in the table has a finite, configurable default.
- [ ] The child-process API makes "read before write" structural; a test proves the wrong order is
      impossible or rejected.
- [ ] A backpressure fixture that fills stdout before reading stdin does **not** deadlock, with a ~100 KB
      prompt in the fixture set.
- [ ] The hard-timeout deadline starts immediately after process start; a blocked-write test proves it.
- [ ] Post-exit drain is bounded; a fixture with a surviving grandchild holding a pipe open cannot hang it.
- [ ] Teardown order matches the Design section; a test asserts partial output is still flushed.
- [ ] Long-lived server output is captured, size-capped, rotated, and drained for its whole lifetime; a
      verbose-server fixture proves no wedge.
- [ ] Bounded tail reads seek first; a large-file test asserts allocation is bounded.
- [ ] Oversized lines are truncated with a marker and remain retrievable.
- [ ] Startup sentinel has a wide window, an env override, and a dead-worker fast-fail; all three tested.
- [ ] Range validation precedes unit conversion; an out-of-range timeout is exit `2` with no side effect.
- [ ] `0` means explicitly unbounded; a valueless timeout flag is rejected.
- [ ] Every HTTP call carries an `AbortController` deadline; a hung-socket test surfaces a bounded failure.
- [ ] A non-ASCII fixture asserts no mojibake in captured output.

## How to verify

```powershell
node tests/run-tests.js --suite full
```

Manually: run the hang fixture and confirm the job terminalizes at its bound, with partial output preserved
and the tree gone.

## Definition of done

Full suite green including the backpressure, grandchild-pipe, verbose-server, and hung-socket tests.

## Commit message

```
feat: finite deadlines everywhere and deadlock-free concurrent pipe draining
```

## Notes
