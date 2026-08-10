# Ticket 81 — opencode polls `unknown` forever, so every opencode job runs to its hard timeout

**Status:** done (2026-08-04)
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
   `docs/reference/opencode-study.md`, and treat any "verified" claim there that disagrees with this
   machine as a stop-and-ask per AGENTS.md).

Case 1 and case 3 have opposite fixes, and guessing wrong produces a job that reports `done` with an
empty result — the exact thing that teaches users to distrust the tool.

## Acceptance criteria

- [x] **A.** A run of a trivial prompt reaches a terminal state on the backend's own timeline, not on the
  hard timeout, and persists `result.md` + `backend-events.jsonl`.
- [x] **B.** `unknown` is never an implicit "keep waiting". Consecutive `unknown` polls are bounded; on
  exhaustion the job goes terminal with an honest `failure_reason` that names the ambiguity — never
  `done`, and never a silent empty result.
- [x] **C.** Heartbeats are written for the life of the job, not once at startup. A frozen heartbeat must
  be distinguishable from a working job in `status.json` alone, because that is all reconciliation and
  `debug` can see.
- [x] **D.** A test drives the non-mocked poll path and asserts termination. Per AGENTS.md, a mocked-out
  path is an uncovered path: every opencode adapter test currently sets `_testMode`, and that is why 30
  minutes of producing nothing was green.
- [x] **E.** `npm run check` green; docs updated in the same commit.

## Notes

- **2026-08-04 root cause determined (the "what to determine first" question):** it was case 1 *and* a
  fourth case the ticket did not list. Case 1 — the session leaving `/session/status` once the turn is
  over — had already been fixed (`_sawLiveStatus` plus `SESSION_REGISTRATION_GRACE_MS`), and a live
  `run` of the ticket's own PONG prompt now returns `PONG`, exit 0, in seconds, with `result.md` and
  `backend-events.jsonl` both present. Not case 2 (the URL and session id are correct) and not case 3
  (the shape in `docs/reference/opencode-study.md` still matches this machine, opencode 1.18.11).
  What remained was the ambiguity itself: any status the parse could not resolve, and any poll that kept
  throwing, still meant "keep waiting" forever. That is now bounded:
  - `unknown` is no longer emitted as a `backend_status` fact at all — `core/fact-types.js` only ever
    allowed `busy|idle|retrying`, so emitting it was already contract-invalid.
  - Consecutive unresolved polls are bounded by count (`UNRESOLVED_STATUS_LIMIT_MS / POLL_INTERVAL_MS`,
    12 at the defaults, floor 2). Counted rather than clocked deliberately: a clock bound is defeated by
    a loop that completes several polls inside one millisecond, which is exactly what the first version
    of the test hit.
  - On exhaustion the adapter emits `backend_error` with `class_hint: backend_status_unresolved`, so the
    reducer decides `failed` with that `failure_reason`. Never `done`, never a silent empty result.
  - A poll that throws now records `statusCache = 'unknown'` instead of leaving the previous cache. That
    was a second, quieter defect: a stale `null` read as "never polled", broke the reconnect loop out
    after one round, and reported a partial turn as clean.
- **C was already in place** — `core/commands/worker.js` heartbeats on an interval, not once.
- **D:** `tests/adapters/opencode/unresolved-status-bound.test.js` drives the real `_fetchSessionStatus`
  parse path (no `_mockSessionStatusResponses`), asserts `Observe()` terminates, asserts the reducer's
  decision for both the unresolved and the healthy case, and pins that a resolved status clears the bound.
- **2026-08-03 local verification:** the installed live backend reported opencode `1.18.11`,
  while onboarding still names `1.18.7`. The live P1–P4 opencode tests passed against the
  installed version; re-check the version pin and endpoint study before closing this ticket.
- **2026-08-04 version pin re-checked, as that condition required.** Installed is now `1.18.12` — the
  backend moved twice during this ticket. The pin that governs behaviour is the adapter's
  `supported_version_range` (`min 1.18.0`, `max 1.19.0`), which covers every version this was verified
  against; no code change is needed. `docs/reference/cli-opencode.md` and the study keep saying "version
  studied: 1.18.7" because that is a record of when the study happened, not a target — but onboarding's
  backend table did read as a target, and now names the range. The study's `/session/status` finding is
  annotated `[verified live, 1.18.10]` and still matches this machine.
- **Both loose ends are now filed, which is what closing this ticket was waiting on:** the null
  `status.json.backend_pid` observation is folded into ticket **84** (nothing in production writes any
  launch identity at all — `backend_pid` is one field of a wider gap), and the all-green `doctor` that
  never launches a backend is ticket **86**.
