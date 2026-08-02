# Ticket 81 — opencode polls `unknown` forever, so every opencode job runs to its hard timeout

**Status:** open (2026-07-31)
**Tier:** blocker for delegation — opencode is the interactive-capable backend, so this is the one that
blocks per-phase dogfooding review and any delegated verification.
**Sibling:** the codex and Claude adapters already have a bounded exit-wait path, but through a different
mechanism. Do not assume that fix touches this; it does not. `adapters/opencode/adapter.js` has neither
`_liveFactsResolve` nor `_observedExited`.

---

## Symptom

```
$ dcli-opencode run --hard-timeout-sec 240 "Reply with exactly the word PONG and nothing else."
EXIT=24            (hard_timeout)
stdout: 1 byte
```

Job state after: `timed_out`, `failure_reason: hard_timeout`, `result_bytes: 0`, and the attempt
directory contains only `command.json` and `prompt.md` — **no `backend-events.jsonl`, no `result.md`**.

Observed earlier at scale: three submitted jobs ran a full 1800 s each, kept a live opencode process the
whole time, and produced 0 bytes. Their `heartbeat_at` was written exactly once, at T+1 s, and never
again for 30 minutes — so a stalled opencode job and a working one are indistinguishable from
`status.json`.

## Root cause (traced, bounded to 70 s)

The HTTP transport itself is healthy. The server starts, the socket stays up
(`TCPSocketWrap` present throughout), and the first status poll is correct. Then every subsequent poll
degrades to `unknown` and the adapter keeps polling forever:

```
[+5012ms]  resources=[...,"ProcessWrap","TCPSocketWrap","Timeout"]
[+8358ms]  fact backend_status {"state":"busy"}      <- correct, once
[+15524ms] fact backend_status {"state":"unknown"}
[+21579ms] fact backend_status {"state":"unknown"}
[+27634ms] fact backend_status {"state":"unknown"}
...
[+64049ms] fact backend_status {"state":"unknown"}   <- still, at the budget
```

No `process_exited`, no `session_completed`, no `backend_error`. `Observe()` never returns, so
`executeRun` never reaches its `process_exited` branch, so nothing is ever persisted — which is why the
attempt directory has no artifacts at all rather than an empty result.

**`unknown` is being treated as "still working".** That is the same defect class as AGENTS.md mistake #7:
an absent or unparseable answer must not be indistinguishable from a known-good one. Here it is worse
than a misreport — it is an unbounded wait, which is invariant #3.

## What to determine first

The trace shows *that* status goes `busy → unknown`, not *why*. Before writing the fix, establish which
of these it is, and record the answer in this ticket's Notes:

1. The session completes and opencode stops reporting it, so the poll's lookup legitimately finds
   nothing — `unknown` actually means "finished, and you missed it".
2. The poll is hitting a wrong or stale URL/session id after the first success.
3. The response shape changed and the parse silently yields `unknown` (check against
   `docs/2026-07-28-opencode-cli-study.md`, and treat any "verified" claim there that disagrees with this
   machine as a stop-and-ask per AGENTS.md).

Case 1 and case 3 have opposite fixes, and guessing wrong produces a job that reports `done` with an
empty result — the exact thing that teaches users to distrust the tool.

## Acceptance criteria

- [ ] **A.** A run of a trivial prompt reaches a terminal state on the backend's own timeline, not on the
  hard timeout, and persists `result.md` + `backend-events.jsonl`.
- [ ] **B.** `unknown` is never an implicit "keep waiting". Consecutive `unknown` polls are bounded; on
  exhaustion the job goes terminal with an honest `failure_reason` that names the ambiguity — never
  `done`, and never a silent empty result.
- [ ] **C.** Heartbeats are written for the life of the job, not once at startup. A frozen heartbeat must
  be distinguishable from a working job in `status.json` alone, because that is all reconciliation and
  `debug` can see.
- [ ] **D.** A test drives the non-mocked poll path and asserts termination. Per AGENTS.md, a mocked-out
  path is an uncovered path: every opencode adapter test currently sets `_testMode`, and that is why 30
  minutes of producing nothing was green.
- [ ] **E.** `npm run check` green; docs updated in the same commit.

## Notes

- Separately observed and worth fixing wherever it belongs: `status.json.backend_pid` stays `null` even
  after the adapter emits a `started` fact carrying a real pid (confirmed on a *successful* codex run).
  Reconciliation cannot prove a worker's death without it — AGENTS.md mistake #5, "launch identity must
  be persisted before it can be lost". Do not fold this into 81; file it.
- `doctor` reports all-green here while the backend cannot complete a single request, because it never
  starts one (`live_smoke_timeout_sec: null`). A doctor that never launches a backend cannot report that
  launching one does not work. Also its own ticket.
